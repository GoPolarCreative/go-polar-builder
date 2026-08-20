import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { getDb, schema } from '../db/client.js'
import { resetUsageMeter, usageReport } from '../lib/anthropic.js'
import type { GenerationEvent } from '../../shared/types.js'
import { intakeSchema, type IntakePayload } from '../../shared/intake.js'
import { getIntake, getJob, holdJob, listAssets, nextVersion, recordEvent, setJobStatus } from '../lib/db.js'
import { id } from '../lib/ids.js'
import { buildFacts, generateHtml, generatePlan } from '../lib/generate.js'
import { summarise, verifyAndRepair } from '../lib/verify.js'
import { persistPageSet } from '../lib/buildSet.js'
import { previewLink, notifyGhlSafely } from '../lib/ghl.js'
import { buildCompleteEmail, sendSafely } from '../lib/email.js'
import { getUserForJob } from '../lib/db.js'

const app = new Hono()

/**
 * Generate a site. Server-sent events all the way, because watching the site assemble is the
 * product (brief s5) and a spinner is not.
 *
 * Runs in a Node function with a long maxDuration (see vercel.json). Generation is the reason
 * this app is not on the Edge runtime.
 */
app.post('/jobs/:jobId/generate', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const stored = await getIntake(jobId)
  if (!stored?.submittedAt) {
    return c.json({ error: 'not_ready', detail: 'Intake has not been submitted for this job' }, 409)
  }

  const parsed = intakeSchema.safeParse(stored.payload)
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid_intake',
        detail: 'The stored intake no longer validates',
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      },
      422,
    )
  }
  const intake = parsed.data as IntakePayload
  const assets = await listAssets(jobId)

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const emit = async (event: GenerationEvent) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          closed = true // client went away
        }
      }

      try {
        const db = await getDb()
        await setJobStatus(jobId, 'generating')
        // Start the meter with the job, so what gets recorded is this build and nothing else.
        resetUsageMeter()
        await recordEvent(jobId, 'generation.started')

        const facts = buildFacts(intake, assets)

        // ---- Call 1: content plan ---------------------------------------------------------
        const plan = await generatePlan({
          intake,
          facts,
          assets,
          auditFlags: stored.auditFlags,
          emit,
          // What they actually bought. The build token includes the home page; each additional
          // page product adds one. See server/lib/orders.ts.
          pagesAllowed: job.pagesAllowed,
        })
        await emit({ type: 'plan', plan })

        const version = await nextVersion(jobId)
        // Upsert, not insert. nextVersion counts BUILDS, so a run that wrote its plan and then
        // failed before writing a build leaves the plan behind and the next attempt asks for the
        // same version again. As a plain insert that is a unique violation, and the job is stuck
        // permanently: every retry dies on the leftovers of the last one. A plan already sitting
        // at this version belongs to an attempt that never finished, so replacing it is right.
        await db
          .insert(schema.plans)
          .values({ id: id('pln'), jobId, version, plan })
          .onConflictDoUpdate({
            target: [schema.plans.jobId, schema.plans.version],
            set: { plan },
          })

        // ---- Call 2: build ----------------------------------------------------------------
        const { html: rawHtml, sectioned } = await generateHtml({ plan, facts, emit })

        // ---- Verification and repair ------------------------------------------------------
        await emit({ type: 'status', stage: 'verifying', message: 'Checking every line of it' })
        const outcome = await verifyAndRepair({
          html: rawHtml,
          facts,
          onEvent: async (e) => {
            if (e.type === 'repair') {
              await emit({ type: 'status', stage: 'repairing', message: 'Fixing what did not pass' })
            }
            await emit(e)
          },
        })

        // ---- Store the whole page set -------------------------------------------------------
        // The home page above, plus one service page per additional page the customer bought.
        // Every page is verified on its own and the version passes only if all of them do.
        const set = await persistPageSet({
          jobId,
          version,
          plan,
          facts,
          homeHtml: outcome.html,
          homeReport: outcome.report,
          repairPasses: outcome.attempts,
        })

        const spend = usageReport()
        await recordEvent(jobId, 'generation.completed', {
          version,
          pages: set.pages.length,
          passed: set.passed,
          repairPasses: outcome.attempts,
          ...spend,
        })

        if (set.pages.length > 1) {
          await emit({
            type: 'status',
            stage: 'verifying',
            message: `Checked all ${set.pages.length} pages`,
          })
        }

        await db
          .update(schema.jobs)
          .set({ currentVersion: version, updatedAt: new Date() })
          .where(eq(schema.jobs.id, jobId))

        if (set.passed) {
          await setJobStatus(jobId, 'preview')
          await recordEvent(jobId, 'build.complete', {
            version,
            bytes: outcome.html.length,
            pageWeightBytes: outcome.report.pageWeightBytes,
            sectioned,
            repairPasses: outcome.attempts,
            summary: summarise(outcome.report),
          })

          const user = await getUserForJob(jobId)
          if (user) {
            await sendSafely(jobId, 'build_complete', {
              ...buildCompleteEmail({
                businessName: intake.businessName,
                previewLink: previewLink(jobId),
              }),
              to: user.email,
            })
            await notifyGhlSafely({
              event: 'build_complete',
              contact: { email: user.email, businessName: intake.businessName },
              jobId,
              customValues: { preview_link: previewLink(jobId) },
            })
          }
        } else {
          // Brief s6: hold the job, notify Chris, do not show the customer a broken build.
          await setJobStatus(jobId, 'generating')
          await holdJob(
            jobId,
            `Verification failed after ${outcome.attempts} repair pass(es): ${summarise(outcome.report)}`,
          )
          await recordEvent(jobId, 'build.held', {
            version,
            summary: summarise(outcome.report),
            notify: 'chris',
          })
          await emit({
            type: 'status',
            stage: 'held',
            message:
              'We have hit a snag on the last few checks. One of our team has been notified and will have this sorted shortly. Nothing you need to do.',
          })
        }

        await emit({
          type: 'done',
          version,
          bytes: outcome.html.length,
          passed: set.passed,
          pageWeightBytes: outcome.report.pageWeightBytes,
        })
      } catch (err) {
        console.error('generation failed', err)
        const message = err instanceof Error ? err.message : String(err)
        await recordEvent(jobId, 'generation.failed', { message })
        await setJobStatus(jobId, 'intake')
        await emit({ type: 'error', message: 'The build did not finish.', detail: message })
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

export default app
