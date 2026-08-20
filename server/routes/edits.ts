import { Hono } from 'hono'
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { getDb, schema } from '../db/client'
import type { GenerationEvent } from '../../shared/types'
import type { ContentPlan } from '../../shared/plan'
import { intakeSchema, type IntakePayload } from '../../shared/intake'
import { EDITS_INCLUDED, EXTRA_EDITS_QUANTITY, PRICING, formatPrice, isPriceSet } from '../../shared/pricing'
import { editCapability } from '../config'
import { getIntake, getJob, holdJob, listAssets, nextVersion, recordEvent, setJobStatus } from '../lib/db'
import { id } from '../lib/ids'
import { buildFacts } from '../lib/facts'
import { diffPlans, generateEditedPlan, rebuildFromPlan, summariseDiff } from '../lib/edit'
import { storage } from '../lib/storage'
import { summarise, verifyAndRepair } from '../lib/verify'
import { persistPageSet } from '../lib/buildSet'

const app = new Hono()

/**
 * Phase 4. The edit loop, version history and rollback.
 *
 * One submitted request is one edit, however many changes it contains (brief s7). Rollback never
 * costs an edit and never destroys a version (DECISIONS.md D4). Passing the allowance escalates
 * rather than blocks (D5).
 */

async function loadPlan(jobId: string, version: number): Promise<ContentPlan | null> {
  const db = await getDb()
  const rows = await db
    .select({ plan: schema.plans.plan })
    .from(schema.plans)
    .where(and(eq(schema.plans.jobId, jobId), eq(schema.plans.version, version)))
    .limit(1)
  return (rows[0]?.plan as ContentPlan | undefined) ?? null
}

async function loadHtml(jobId: string, version: number): Promise<string | null> {
  const db = await getDb()
  const rows = await db
    .select({ blobKey: schema.builds.blobKey })
    .from(schema.builds)
    .where(and(eq(schema.builds.jobId, jobId), eq(schema.builds.version, version)))
    .limit(1)
  if (!rows[0]) return null
  return storage().getText(rows[0].blobKey)
}

/** Everything the preview screen needs in one call. */
app.get('/jobs/:jobId/versions', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const db = await getDb()
  const [builds, edits] = await Promise.all([
    db
      .select({
        version: schema.builds.version,
        bytes: schema.builds.bytes,
        pageWeightBytes: schema.builds.pageWeightBytes,
        passed: schema.builds.passed,
        repairPasses: schema.builds.repairPasses,
        createdAt: schema.builds.createdAt,
      })
      .from(schema.builds)
      .where(eq(schema.builds.jobId, jobId))
      .orderBy(desc(schema.builds.version)),
    db
      .select({
        versionFrom: schema.edits.versionFrom,
        versionTo: schema.edits.versionTo,
        prompt: schema.edits.prompt,
        diffSummary: schema.edits.diffSummary,
        counted: schema.edits.counted,
        createdAt: schema.edits.createdAt,
      })
      .from(schema.edits)
      .where(eq(schema.edits.jobId, jobId))
      .orderBy(desc(schema.edits.createdAt)),
  ])

  // The page set, so the preview can offer a switcher and the customer can see every page they
  // paid for. Derived from the current plan rather than a second source of truth.
  const planRow = await db
    .select({ plan: schema.plans.plan })
    .from(schema.plans)
    .where(and(eq(schema.plans.jobId, jobId), eq(schema.plans.version, job.currentVersion)))
    .limit(1)

  const currentPlan = planRow[0]?.plan as { servicePages?: Array<{ slug: string; service: string }> } | undefined
  const pages = [
    { url: '/', path: 'index.html', service: null as string | null },
    ...(currentPlan?.servicePages ?? []).map((sp) => ({
      url: `/services/${sp.slug}/`,
      path: `services/${sp.slug}/index.html`,
      service: sp.service,
    })),
  ]

  return c.json({
    pages,
    pagesAllowed: job.pagesAllowed,
    currentVersion: job.currentVersion,
    editsUsed: job.editsUsed,
    editsAllowed: job.editsAllowed,
    // Never negative in the customer's view, even though editsUsed keeps counting honestly.
    editsRemaining: Math.max(0, job.editsAllowed - job.editsUsed),
    overAllowance: job.editsUsed >= job.editsAllowed,
    held: job.held,
    heldReason: job.heldReason,
    builds,
    edits,
    // Answered when the panel loads, not after the customer has typed a request and pressed
    // send. An editor that cannot edit has to say so before it takes any typing.
    capability: editCapability(),
  })
})

/**
 * Submit one change request. Streams exactly like generation does, so the customer watches the
 * change land rather than staring at a spinner.
 */
app.post('/jobs/:jobId/edits', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const body = await c.req.json<{ request?: string }>().catch(() => ({}) as { request?: string })
  const request = (body.request ?? '').trim()
  if (request.length < 3) {
    return c.json({ error: 'bad_request', detail: 'Tell us what you would like changed.' }, 400)
  }
  if (request.length > 4000) {
    return c.json(
      { error: 'bad_request', detail: 'That is a lot at once. Send it through in a couple of goes.' },
      400,
    )
  }

  const fromVersion = job.currentVersion
  if (fromVersion < 1) {
    return c.json({ error: 'not_ready', detail: 'There is nothing built to change yet.' }, 409)
  }

  /*
   * Refuse before anything is written.
   *
   * This check used to be missing, and the offline fixture happily accepted the request, wrote a
   * new version that was byte-for-byte the same site, reported success, and charged the customer
   * one of their ten changes. From their seat that is indistinguishable from the product being
   * broken, and they are one round poorer for it.
   *
   * Nothing below this line runs unless a change can actually be applied: no status change, no
   * version, and above all no increment of edits_used.
   */
  const capability = editCapability()
  if (!capability.available) {
    await recordEvent(jobId, 'edit.refused', {
      reason: capability.reason,
      request: request.slice(0, 500),
      editsUsed: job.editsUsed,
      // Stated explicitly in the trail: this refusal cost the customer nothing.
      editCharged: false,
    })
    return c.json(
      {
        error: 'edits_unavailable',
        detail: capability.reason,
        editCharged: false,
        editsRemaining: Math.max(0, job.editsAllowed - job.editsUsed),
      },
      503,
    )
  }

  const db = await getDb()
  const [currentPlan, currentHtml, stored, assets] = await Promise.all([
    loadPlan(jobId, fromVersion),
    loadHtml(jobId, fromVersion),
    getIntake(jobId),
    listAssets(jobId),
  ])

  if (!currentPlan || !currentHtml) {
    return c.json({ error: 'not_found', detail: 'The current version could not be loaded.' }, 404)
  }

  const parsedIntake = intakeSchema.safeParse(stored?.payload)
  if (!parsedIntake.success) {
    return c.json({ error: 'invalid_intake', detail: 'Stored intake does not validate' }, 422)
  }
  const intake = parsedIntake.data as IntakePayload

  const priorEdits = await db
    .select({ prompt: schema.edits.prompt })
    .from(schema.edits)
    .where(and(eq(schema.edits.jobId, jobId), isNotNull(schema.edits.prompt)))
    .orderBy(schema.edits.createdAt)

  const overAllowance = job.editsUsed >= job.editsAllowed
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const emit = async (event: GenerationEvent) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          closed = true
        }
      }

      try {
        await setJobStatus(jobId, 'editing')

        if (overAllowance) {
          // Brief s7: do not hard block. Run it, and make sure Chris knows the same day.
          await recordEvent(jobId, 'edit.overage', {
            editsUsed: job.editsUsed,
            editsAllowed: job.editsAllowed,
            request: request.slice(0, 500),
            notify: 'chris',
          })
        }

        const facts = buildFacts(intake, assets)
        await emit({ type: 'status', stage: 'planning', message: 'Working out what to change' })

        const revisedPlan = await generateEditedPlan({
          plan: currentPlan,
          facts,
          intake,
          assets,
          request,
          previousRequests: priorEdits.map((e) => e.prompt!).filter(Boolean),
        })

        const changes = diffPlans(currentPlan, revisedPlan)
        await emit({ type: 'plan', plan: revisedPlan })

        const toVersion = await nextVersion(jobId)
        await db.insert(schema.plans).values({ id: id('pln'), jobId, version: toVersion, plan: revisedPlan })

        const html = await rebuildFromPlan({
          plan: revisedPlan,
          facts,
          previousHtml: currentHtml,
          changes,
          emit,
        })

        await emit({ type: 'status', stage: 'verifying', message: 'Checking every line of it' })
        const outcome = await verifyAndRepair({
          html,
          facts,
          onEvent: async (e) => {
            if (e.type === 'repair') {
              await emit({ type: 'status', stage: 'repairing', message: 'Fixing what did not pass' })
            }
            await emit(e)
          },
        })

        // The whole set is rebuilt from the revised plan, not just the page the customer named.
        // The plan is the source of truth and the service pages are rendered from it, so a change
        // to the business name or the phone number lands on every page at once. That is also why
        // an edit spanning several pages still costs exactly one round.
        const set = await persistPageSet({
          jobId,
          version: toVersion,
          plan: revisedPlan,
          facts,
          homeHtml: outcome.html,
          homeReport: outcome.report,
          repairPasses: outcome.attempts,
        })

        const diffSummary = summariseDiff(changes)

        await db.insert(schema.edits).values({
          id: id('edt'),
          jobId,
          versionFrom: fromVersion,
          versionTo: toVersion,
          prompt: request,
          diffSummary,
          counted: true,
        })

        // One submitted request is one edit, however many changes it contained.
        await db
          .update(schema.jobs)
          .set({
            editsUsed: sql`${schema.jobs.editsUsed} + 1`,
            currentVersion: toVersion,
            status: 'editing',
            updatedAt: new Date(),
          })
          .where(eq(schema.jobs.id, jobId))

        if (!set.passed) {
          await holdJob(
            jobId,
            `Edit verification failed after ${outcome.attempts} repair pass(es): ${summarise(outcome.report)}`,
          )
          await recordEvent(jobId, 'build.held', {
            version: toVersion,
            summary: summarise(outcome.report),
            notify: 'chris',
          })
          await emit({
            type: 'status',
            stage: 'held',
            message:
              'That change hit a snag on the last few checks. One of our team has been notified. Your previous version is still safe and you can roll back to it.',
          })
        } else {
          await recordEvent(jobId, 'edit.applied', { fromVersion, toVersion, summary: diffSummary })
        }

        await emit({
          type: 'done',
          version: toVersion,
          bytes: outcome.html.length,
          passed: set.passed,
          pageWeightBytes: outcome.report.pageWeightBytes,
        })
      } catch (err) {
        console.error('edit failed', err)
        const message = err instanceof Error ? err.message : String(err)
        await recordEvent(jobId, 'edit.failed', { message, request: request.slice(0, 500) })
        await setJobStatus(jobId, 'editing')
        await emit({
          type: 'error',
          message: 'That change did not go through. Your current version has not been touched.',
          detail: message,
        })
      } finally {
        closed = true
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
})

/**
 * Roll back to an earlier version. Costs nothing, destroys nothing: the pointer moves and every
 * version stays in storage, so rolling forward again works too.
 */
app.post('/jobs/:jobId/rollback', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const body = await c.req.json<{ version?: number }>().catch(() => ({}) as { version?: number })
  const version = Number(body.version)
  if (!Number.isInteger(version) || version < 1) {
    return c.json({ error: 'bad_request', detail: 'Which version would you like to go back to?' }, 400)
  }

  const db = await getDb()
  const target = await db
    .select({ version: schema.builds.version })
    .from(schema.builds)
    .where(and(eq(schema.builds.jobId, jobId), eq(schema.builds.version, version)))
    .limit(1)
  if (!target[0]) {
    return c.json({ error: 'not_found', detail: 'There is no version with that number.' }, 404)
  }

  const from = job.currentVersion

  await db
    .update(schema.jobs)
    .set({ currentVersion: version, held: false, heldReason: null, updatedAt: new Date() })
    .where(eq(schema.jobs.id, jobId))

  await db.insert(schema.edits).values({
    id: id('edt'),
    jobId,
    versionFrom: from,
    versionTo: version,
    prompt: null,
    diffSummary: `Rolled back to version ${version}`,
    counted: false,
  })

  await recordEvent(jobId, 'version.rolled_back', { from, to: version })
  return c.json({ ok: true, currentVersion: version, editsCharged: 0 })
})

/**
 * What to offer when the included edits are used up (brief s7).
 * The extra-edits price is not in the brief, so while it is unset this returns available: false
 * and the UI offers to put them in touch instead of showing a made-up number.
 */
app.get('/jobs/:jobId/edits/extra', (c) =>
  c.json({
    available: isPriceSet('extraEdits'),
    quantity: EXTRA_EDITS_QUANTITY,
    price: formatPrice('extraEdits'),
    handle: PRICING.extraEdits.ref,
    included: EDITS_INCLUDED,
    detail: isPriceSet('extraEdits')
      ? null
      : 'The price for extra edits has not been set yet, so we will sort it out with you directly rather than guess.',
  }),
)

export default app
