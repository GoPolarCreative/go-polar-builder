import { Hono } from 'hono'
import type { Env } from '../env'
import type { GenerationEvent } from '../../shared/types'
import { intakeSchema, type IntakePayload } from '../../shared/intake'
import {
  getIntake,
  getJob,
  holdJob,
  listAssets,
  nextVersion,
  recordEvent,
  setJobStatus,
} from '../lib/db'
import { id, nowIso } from '../lib/ids'
import { buildFacts, generateHtml, generatePlan } from '../lib/generate'
import { summarise, verifyAndRepair } from '../lib/verify'

const app = new Hono<{ Bindings: Env }>()

/**
 * Generate a site. Server-sent events all the way, because watching the site assemble is the
 * product (brief s5) and a spinner is not.
 *
 * The stream stays open through planning, building, verification and any repair passes, then
 * closes with a `done` or an `error` event. The client never has to poll.
 */
app.post('/jobs/:jobId/generate', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(c.env, jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const stored = await getIntake(c.env, jobId)
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
  const assets = await listAssets(c.env, jobId)

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()
  let closed = false

  const emit = async (event: GenerationEvent) => {
    if (closed) return
    try {
      await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
    } catch {
      closed = true // client went away, stop trying
    }
  }

  // The work runs detached from the response so the stream starts flowing immediately.
  c.executionCtx.waitUntil(
    (async () => {
      try {
        await setJobStatus(c.env, jobId, 'generating')
        await recordEvent(c.env, jobId, 'generation.started')

        const facts = buildFacts(c.env, intake, assets)

        // ---- Call 1: content plan -------------------------------------------------------
        const plan = await generatePlan(c.env, {
          intake,
          facts,
          assets,
          auditFlags: stored.auditFlags,
          emit,
        })
        await emit({ type: 'plan', plan })

        const version = await nextVersion(c.env, jobId)
        await c.env.DB.prepare(
          'INSERT INTO plans (id, job_id, version, plan_json, created_at) VALUES (?, ?, ?, ?, ?)',
        )
          .bind(id('pln'), jobId, version, JSON.stringify(plan), nowIso())
          .run()

        // ---- Call 2: build --------------------------------------------------------------
        const { html: rawHtml, sectioned } = await generateHtml(c.env, { plan, facts, emit })

        // ---- Verification and repair ----------------------------------------------------
        await emit({ type: 'status', stage: 'verifying', message: 'Checking every line of it' })
        const outcome = await verifyAndRepair(c.env, {
          html: rawHtml,
          facts,
          assets,
          onEvent: async (e) => {
            if (e.type === 'repair') {
              await emit({ type: 'status', stage: 'repairing', message: 'Fixing what did not pass' })
            }
            await emit(e)
          },
        })

        // ---- Store ----------------------------------------------------------------------
        const key = `jobs/${jobId}/builds/v${version}/index.html`
        await c.env.BUCKET.put(key, outcome.html, {
          httpMetadata: { contentType: 'text/html; charset=utf-8' },
          customMetadata: { jobId, version: String(version) },
        })

        await c.env.DB.prepare(
          `INSERT INTO builds (id, job_id, version, r2_key, bytes, checks_json, passed, repair_passes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            id('bld'),
            jobId,
            version,
            key,
            outcome.html.length,
            JSON.stringify(outcome.report),
            outcome.report.passed ? 1 : 0,
            outcome.attempts,
            nowIso(),
          )
          .run()

        await c.env.DB.prepare('UPDATE jobs SET current_version = ?, updated_at = ? WHERE id = ?')
          .bind(version, nowIso(), jobId)
          .run()

        if (outcome.report.passed) {
          await setJobStatus(c.env, jobId, 'preview')
          await recordEvent(c.env, jobId, 'build.complete', {
            version,
            bytes: outcome.html.length,
            sectioned,
            repairPasses: outcome.attempts,
            summary: summarise(outcome.report),
          })
        } else {
          // Brief s6: hold the job, notify Chris, do not show the customer a broken build.
          await setJobStatus(c.env, jobId, 'generating')
          await holdJob(
            c.env,
            jobId,
            `Verification failed after ${outcome.attempts} repair pass(es): ${summarise(outcome.report)}`,
          )
          await recordEvent(c.env, jobId, 'build.held', {
            version,
            summary: summarise(outcome.report),
            // PHASE 6: this event is the GHL webhook trigger. Chris gets the notification there.
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
          passed: outcome.report.passed,
        })
      } catch (err) {
        console.error('generation failed', err)
        const message = err instanceof Error ? err.message : String(err)
        await recordEvent(c.env, jobId, 'generation.failed', { message })
        await setJobStatus(c.env, jobId, 'intake')
        await emit({
          type: 'error',
          message: 'The build did not finish.',
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

export default app
