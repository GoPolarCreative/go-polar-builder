import { Hono } from 'hono'
import type { Env } from '../env'
import type { GenerationEvent } from '../../shared/types'
import type { ContentPlan } from '../../shared/plan'
import { intakeSchema, type IntakePayload } from '../../shared/intake'
import { EDITS_INCLUDED } from '../../shared/pricing'
import { getIntake, getJob, holdJob, listAssets, nextVersion, recordEvent, setJobStatus } from '../lib/db'
import { id, nowIso } from '../lib/ids'
import { buildFacts } from '../lib/facts'
import { diffPlans, generateEditedPlan, offlineEdit, rebuildFromPlan, summariseDiff } from '../lib/edit'
import { offlineHtml } from '../lib/offline'
import { summarise, verifyAndRepair } from '../lib/verify'

const app = new Hono<{ Bindings: Env }>()

/**
 * Phase 4. The edit loop, version history and rollback.
 *
 * One submitted request is one edit, however many changes it contains (brief s7). Rollback never
 * costs an edit and never destroys a version (DECISIONS.md D4). Passing the allowance escalates
 * rather than blocks (D5).
 */

async function loadPlan(env: Env, jobId: string, version: number): Promise<ContentPlan | null> {
  const row = await env.DB.prepare('SELECT plan_json FROM plans WHERE job_id = ? AND version = ?')
    .bind(jobId, version)
    .first<{ plan_json: string }>()
  return row ? (JSON.parse(row.plan_json) as ContentPlan) : null
}

async function loadHtml(env: Env, jobId: string, version: number): Promise<string | null> {
  const row = await env.DB.prepare('SELECT r2_key FROM builds WHERE job_id = ? AND version = ?')
    .bind(jobId, version)
    .first<{ r2_key: string }>()
  if (!row) return null
  const object = await env.BUCKET.get(row.r2_key)
  return object ? await object.text() : null
}

/** Everything the preview screen needs in one call. */
app.get('/jobs/:jobId/versions', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(c.env, jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const [builds, edits] = await Promise.all([
    c.env.DB.prepare(
      'SELECT version, bytes, passed, repair_passes, created_at FROM builds WHERE job_id = ? ORDER BY version DESC',
    )
      .bind(jobId)
      .all<{ version: number; bytes: number; passed: number; repair_passes: number; created_at: string }>(),
    c.env.DB.prepare(
      'SELECT version_from, version_to, prompt, diff_summary, counted, created_at FROM edits WHERE job_id = ? ORDER BY created_at DESC',
    )
      .bind(jobId)
      .all<{
        version_from: number
        version_to: number
        prompt: string | null
        diff_summary: string | null
        counted: number
        created_at: string
      }>(),
  ])

  return c.json({
    currentVersion: job.current_version,
    editsUsed: job.edits_used,
    editsAllowed: job.edits_allowed,
    // Never negative in the customer's view, even though edits_used keeps counting honestly.
    editsRemaining: Math.max(0, job.edits_allowed - job.edits_used),
    overAllowance: job.edits_used >= job.edits_allowed,
    held: job.held === 1,
    heldReason: job.held_reason,
    builds: builds.results ?? [],
    edits: edits.results ?? [],
  })
})

/**
 * Submit one change request. Streams exactly like generation does, so the customer watches the
 * change land rather than staring at a spinner.
 */
app.post('/jobs/:jobId/edits', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(c.env, jobId)
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

  const fromVersion = job.current_version
  if (fromVersion < 1) {
    return c.json({ error: 'not_ready', detail: 'There is nothing built to change yet.' }, 409)
  }

  const [currentPlan, currentHtml, stored, assets] = await Promise.all([
    loadPlan(c.env, jobId, fromVersion),
    loadHtml(c.env, jobId, fromVersion),
    getIntake(c.env, jobId),
    listAssets(c.env, jobId),
  ])

  if (!currentPlan || !currentHtml) {
    return c.json({ error: 'not_found', detail: 'The current version could not be loaded.' }, 404)
  }

  const parsedIntake = intakeSchema.safeParse(stored?.payload)
  if (!parsedIntake.success) {
    return c.json({ error: 'invalid_intake', detail: 'Stored intake does not validate' }, 422)
  }
  const intake = parsedIntake.data as IntakePayload

  const priorEdits = await c.env.DB.prepare(
    'SELECT prompt FROM edits WHERE job_id = ? AND prompt IS NOT NULL ORDER BY created_at',
  )
    .bind(jobId)
    .all<{ prompt: string }>()

  const overAllowance = job.edits_used >= job.edits_allowed

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()
  let closed = false

  const emit = async (event: GenerationEvent) => {
    if (closed) return
    try {
      await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
    } catch {
      closed = true
    }
  }

  c.executionCtx.waitUntil(
    (async () => {
      try {
        await setJobStatus(c.env, jobId, 'editing')

        if (overAllowance) {
          // Brief s7: do not hard block. Run it, and make sure Chris knows the same day.
          await recordEvent(c.env, jobId, 'edit.overage', {
            editsUsed: job.edits_used,
            editsAllowed: job.edits_allowed,
            request: request.slice(0, 500),
            notify: 'chris',
          })
        }

        const facts = buildFacts(c.env, intake, assets)

        await emit({ type: 'status', stage: 'planning', message: 'Working out what to change' })

        const revisedPlan =
          c.env.DEV_OFFLINE_GENERATION === '1'
            ? offlineEdit(currentPlan, request)
            : await generateEditedPlan(c.env, {
                plan: currentPlan,
                facts,
                intake,
                assets,
                request,
                previousRequests: (priorEdits.results ?? []).map((e) => e.prompt),
              })

        const changes = diffPlans(currentPlan, revisedPlan)
        await emit({ type: 'plan', plan: revisedPlan })

        const toVersion = await nextVersion(c.env, jobId)
        await c.env.DB.prepare(
          'INSERT INTO plans (id, job_id, version, plan_json, created_at) VALUES (?, ?, ?, ?, ?)',
        )
          .bind(id('pln'), jobId, toVersion, JSON.stringify(revisedPlan), nowIso())
          .run()

        let html: string
        if (c.env.DEV_OFFLINE_GENERATION === '1') {
          await emit({
            type: 'status',
            stage: 'building',
            message: 'Applying your changes (offline fixture, no Anthropic key configured)',
          })
          html = offlineHtml(revisedPlan, facts)
          for (let i = 0; i < html.length; i += 2000) {
            await emit({ type: 'html_chunk', text: html.slice(i, i + 2000) })
          }
        } else {
          html = await rebuildFromPlan(c.env, {
            plan: revisedPlan,
            facts,
            previousHtml: currentHtml,
            changes,
            emit,
          })
        }

        await emit({ type: 'status', stage: 'verifying', message: 'Checking every line of it' })
        const outcome = await verifyAndRepair(c.env, {
          html,
          facts,
          assets,
          onEvent: async (e) => {
            if (e.type === 'repair') {
              await emit({ type: 'status', stage: 'repairing', message: 'Fixing what did not pass' })
            }
            await emit(e)
          },
        })

        const key = `jobs/${jobId}/builds/v${toVersion}/index.html`
        await c.env.BUCKET.put(key, outcome.html, {
          httpMetadata: { contentType: 'text/html; charset=utf-8' },
          customMetadata: { jobId, version: String(toVersion) },
        })

        const diffSummary = summariseDiff(changes)

        await c.env.DB.batch([
          c.env.DB.prepare(
            `INSERT INTO builds (id, job_id, version, r2_key, bytes, checks_json, passed, repair_passes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            id('bld'),
            jobId,
            toVersion,
            key,
            outcome.html.length,
            JSON.stringify(outcome.report),
            outcome.report.passed ? 1 : 0,
            outcome.attempts,
            nowIso(),
          ),
          c.env.DB.prepare(
            `INSERT INTO edits (id, job_id, version_from, version_to, prompt, diff_summary, counted, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
          ).bind(id('edt'), jobId, fromVersion, toVersion, request, diffSummary, nowIso()),
          // One submitted request is one edit, however many changes it contained.
          c.env.DB.prepare(
            'UPDATE jobs SET edits_used = edits_used + 1, current_version = ?, status = ?, updated_at = ? WHERE id = ?',
          ).bind(toVersion, 'editing', nowIso(), jobId),
        ])

        if (!outcome.report.passed) {
          await holdJob(
            c.env,
            jobId,
            `Edit verification failed after ${outcome.attempts} repair pass(es): ${summarise(outcome.report)}`,
          )
          await recordEvent(c.env, jobId, 'build.held', {
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
          await recordEvent(c.env, jobId, 'edit.applied', {
            fromVersion,
            toVersion,
            summary: diffSummary,
          })
        }

        await emit({
          type: 'done',
          version: toVersion,
          bytes: outcome.html.length,
          passed: outcome.report.passed,
        })
      } catch (err) {
        console.error('edit failed', err)
        const message = err instanceof Error ? err.message : String(err)
        await recordEvent(c.env, jobId, 'edit.failed', { message, request: request.slice(0, 500) })
        // The previous version is untouched, which is the thing the customer cares about.
        await setJobStatus(c.env, jobId, 'editing')
        await emit({
          type: 'error',
          message: 'That change did not go through. Your current version has not been touched.',
          detail: message,
        })
      } finally {
        closed = true
        await writer.close().catch(() => undefined)
      }
    })(),
  )

  return new Response(readable, {
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
 * version stays in R2, so rolling forward again works too.
 */
app.post('/jobs/:jobId/rollback', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(c.env, jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const body = await c.req.json<{ version?: number }>().catch(() => ({}) as { version?: number })
  const version = Number(body.version)
  if (!Number.isInteger(version) || version < 1) {
    return c.json({ error: 'bad_request', detail: 'Which version would you like to go back to?' }, 400)
  }

  const target = await c.env.DB.prepare(
    'SELECT version, passed FROM builds WHERE job_id = ? AND version = ?',
  )
    .bind(jobId, version)
    .first<{ version: number; passed: number }>()
  if (!target) return c.json({ error: 'not_found', detail: 'There is no version with that number.' }, 404)

  const from = job.current_version

  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE jobs SET current_version = ?, held = 0, held_reason = NULL, updated_at = ? WHERE id = ?').bind(
      version,
      nowIso(),
      jobId,
    ),
    c.env.DB.prepare(
      `INSERT INTO edits (id, job_id, version_from, version_to, prompt, diff_summary, counted, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, 0, ?)`,
    ).bind(id('edt'), jobId, from, version, `Rolled back to version ${version}`, nowIso()),
  ])

  await recordEvent(c.env, jobId, 'version.rolled_back', { from, to: version })

  return c.json({ ok: true, currentVersion: version, editsCharged: 0 })
})

/**
 * What to offer when the included edits are used up (brief s7).
 * The extra-edits price is not in the brief, so while it is unset this returns
 * available: false and the UI offers to put them in touch instead of showing a made-up number.
 */
app.get('/jobs/:jobId/edits/extra', async (c) => {
  const { PRICING, EXTRA_EDITS_QUANTITY, formatPrice, isPriceSet } = await import('../../shared/pricing')
  return c.json({
    available: isPriceSet('extraEdits'),
    quantity: EXTRA_EDITS_QUANTITY,
    price: formatPrice('extraEdits'),
    handle: PRICING.extraEdits.handle,
    included: EDITS_INCLUDED,
    detail: isPriceSet('extraEdits')
      ? null
      : 'The price for extra edits has not been set yet, so we will sort it out with you directly rather than guess.',
  })
})

export default app
