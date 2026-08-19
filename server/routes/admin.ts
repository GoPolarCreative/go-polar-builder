import { Hono } from 'hono'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { getDb, schema } from '../db/client'
import { requireAdmin } from '../lib/auth'
import { config } from '../config'

const app = new Hono()

/**
 * Operator diagnostics. Guarded by ADMIN_TOKEN, never reachable by a customer.
 *
 * WHY THIS EXISTS. The smoke test after deployment is "buy the build product with a real card and
 * see whether a link arrives in your inbox". When it does arrive, everything worked. When it does
 * not, that single fact says nothing useful: the webhook might never have fired, or fired and been
 * rejected for a bad signature, or been accepted but matched no product, or created the job
 * perfectly and then failed to send the email. Four very different problems with four different
 * fixes, and one symptom.
 *
 * So this walks the same four steps in order and reports each independently, with the reason and
 * the next thing to check. It reads the event log, which every stage of that path already writes
 * to, rather than adding new instrumentation that could itself be wrong.
 */

app.use('/admin/*', requireAdmin)

type StepStatus = 'ok' | 'failed' | 'waiting'

interface TraceStep {
  step: number
  name: string
  status: StepStatus
  detail: string
  /** What to do about it. Only present when something is wrong. */
  fix?: string
  at?: string
}

/** Most recent event of any of these types, optionally for one job. */
async function lastEvent(types: string[], jobId?: string) {
  const db = await getDb()
  const rows = await db
    .select()
    .from(schema.events)
    .where(
      jobId
        ? and(inTypes(types), eq(schema.events.jobId, jobId))
        : inTypes(types),
    )
    .orderBy(desc(schema.events.createdAt))
    .limit(1)
  return rows[0] ?? null
}

function inTypes(types: string[]) {
  return sql`${schema.events.type} in ${types}`
}

/**
 * Walk the purchase-to-build-link path and report every step separately.
 *
 *   GET /api/admin/trace?email=you@example.com
 *
 * The email is the one used at the Shopify checkout. Without it the first two steps still work,
 * because they are about webhooks arriving at all rather than about one order.
 */
app.get('/admin/trace', async (c) => {
  const db = await getDb()
  const email = (c.req.query('email') ?? '').trim().toLowerCase()
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const steps: TraceStep[] = []

  // --- 1. did a webhook arrive at all -----------------------------------------------------------
  const anyWebhook = await lastEvent([
    'webhook.received',
    'webhook.rejected',
    'webhook.refused',
    'webhook.failed',
  ])

  if (!anyWebhook) {
    steps.push({
      step: 1,
      name: 'Shopify sent the webhook',
      status: 'waiting',
      detail: 'No webhook of any kind has ever reached this deployment.',
      fix: 'Shopify admin, Settings, Notifications, Webhooks. Check the orders/paid webhook exists and points at https://build.itscold.com.au/api/webhooks/shopify. That page also lists recent delivery attempts and their response codes: a 404 means the URL is wrong, a timeout means the deployment is down.',
    })
  } else {
    steps.push({
      step: 1,
      name: 'Shopify sent the webhook',
      status: 'ok',
      detail: `Last webhook activity was "${anyWebhook.type}".`,
      at: anyWebhook.createdAt.toISOString(),
    })
  }

  // --- 2. was it accepted -----------------------------------------------------------------------
  const refused = await lastEvent(['webhook.refused'])
  const rejected = await lastEvent(['webhook.rejected'])
  const received = await lastEvent(['webhook.received'])

  const newest = [refused, rejected, received]
    .filter(Boolean)
    .sort((a, b) => b!.createdAt.getTime() - a!.createdAt.getTime())[0]

  if (!newest) {
    steps.push({
      step: 2,
      name: 'Signature verified',
      status: 'waiting',
      detail: 'Nothing to verify yet, because no webhook has arrived.',
    })
  } else if (newest.type === 'webhook.rejected') {
    steps.push({
      step: 2,
      name: 'Signature verified',
      status: 'failed',
      detail: 'A webhook arrived and its HMAC signature did not match, so it was refused.',
      fix: 'SHOPIFY_WEBHOOK_SECRET in Vercel does not match the signing secret Shopify shows for this webhook. Copy it again from the webhook in Shopify admin, set it in Vercel, and redeploy so the function picks it up.',
      at: newest.createdAt.toISOString(),
    })
  } else if (newest.type === 'webhook.refused') {
    const reason = (newest.payload as { reason?: string } | null)?.reason ?? 'unknown'
    steps.push({
      step: 2,
      name: 'Signature verified',
      status: 'failed',
      detail: `The webhook was refused before verification: ${reason}.`,
      fix:
        reason === 'demo_mode'
          ? 'This deployment is still in demo mode, where webhooks are inert on purpose. Set DEMO_MODE=0 in Vercel and redeploy.'
          : 'SHOPIFY_WEBHOOK_SECRET is not set, so webhooks cannot be verified and are refused rather than trusted. Set it in Vercel and redeploy.',
      at: newest.createdAt.toISOString(),
    })
  } else {
    steps.push({
      step: 2,
      name: 'Signature verified',
      status: 'ok',
      detail: 'A webhook arrived and its signature matched.',
      at: newest.createdAt.toISOString(),
    })
  }

  // --- 3. did it become a user and a job --------------------------------------------------------
  let jobId: string | null = null

  const upstreamOk = steps.every((s) => s.status === 'ok')

  if (!upstreamOk) {
    steps.push({
      step: 3,
      name: 'Job created',
      status: 'waiting',
      detail: 'Nothing got this far, because the webhook did not arrive or was not accepted.',
    })
  } else if (!email) {
    steps.push({
      step: 3,
      name: 'Job created',
      status: 'waiting',
      detail: 'Pass ?email= the address used at the Shopify checkout to check this step.',
    })
  } else {
    const users = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1)
    const user = users[0]
    const jobs = user
      ? await db
          .select()
          .from(schema.jobs)
          .where(eq(schema.jobs.userId, user.id))
          .orderBy(desc(schema.jobs.createdAt))
          .limit(1)
      : []
    jobId = jobs[0]?.id ?? null

    if (jobId) {
      steps.push({
        step: 3,
        name: 'Job created',
        status: 'ok',
        detail: `Job ${jobId} exists for ${email}, status "${jobs[0]!.status}".`,
        at: jobs[0]!.createdAt.toISOString(),
      })
    } else {
      // A webhook that arrived and verified but produced no job means the line items did not match
      // any product this app knows about, which is the interesting failure.
      const unmatched = await lastEvent(['order.unmatched', 'order.unmatched_line'])
      const recentUnmatched =
        unmatched && unmatched.createdAt >= since
          ? (unmatched.payload as { title?: string; ref?: string; reason?: string } | null)
          : null

      steps.push({
        step: 3,
        name: 'Job created',
        status: 'failed',
        detail: recentUnmatched
          ? `No job for ${email}. An order arrived but a line item matched no known product: ${JSON.stringify(recentUnmatched)}.`
          : `No user or job exists for ${email}.`,
        fix: recentUnmatched
          ? 'The purchased product is not one this app recognises. Check the SKU on the Shopify product is exactly build-token, and that its variant id matches what is recorded. See SHOPIFY-SETUP.md.'
          : 'If steps 1 and 2 passed, the order carried a different email to the one given here. Check the order in Shopify. If they passed and the email is right, look at the Vercel function logs for the webhook request.',
      })
    }
  }

  // --- 4. did the build link email go out -------------------------------------------------------
  const sent = await lastEvent(['email.sent'], jobId ?? undefined)
  const failed = await lastEvent(['email.failed'], jobId ?? undefined)
  const newestEmail = [sent, failed]
    .filter(Boolean)
    .sort((a, b) => b!.createdAt.getTime() - a!.createdAt.getTime())[0]

  if (!jobId) {
    steps.push({
      step: 4,
      name: 'Build link emailed',
      status: 'waiting',
      detail: 'No job to send anything for yet.',
    })
  } else if (!newestEmail) {
    steps.push({
      step: 4,
      name: 'Build link emailed',
      status: 'failed',
      detail: 'The job exists but no send was ever attempted for it.',
      fix: 'Look at the Vercel function logs for the webhook request. The job was created, so the failure is after that point.',
    })
  } else if (newestEmail.type === 'email.sent') {
    steps.push({
      step: 4,
      name: 'Build link emailed',
      status: 'ok',
      detail: `Resend accepted the message for ${(newestEmail.payload as { to?: string } | null)?.to ?? email}. If it is not in the inbox, check spam and then check Resend's own delivery log.`,
      at: newestEmail.createdAt.toISOString(),
    })
  } else {
    const payload = newestEmail.payload as { error?: string; kind?: string } | null
    steps.push({
      step: 4,
      name: 'Build link emailed',
      status: 'failed',
      detail: `The send failed: ${payload?.error ?? 'no reason recorded'}`,
      fix: /RESEND_API_KEY/.test(payload?.error ?? '')
        ? 'RESEND_API_KEY is not set in Vercel.'
        : /ENABLE_LIVE_EMAIL/.test(payload?.error ?? '')
          ? 'ENABLE_LIVE_EMAIL is not set to 1, so email is deliberately blocked. Set it in Vercel and redeploy.'
          : 'Usually the sending domain is not verified in Resend. Check the domain on RESEND_FROM is verified there. The hourly sweep retries failed sends, so it may still arrive.',
      at: newestEmail.createdAt.toISOString(),
    })
  }

  // The earliest step that is not ok, which is the one worth acting on. A later step reading
  // "waiting" is a consequence of this one, not a second problem.
  const stopped = steps.find((s) => s.status !== 'ok')

  return c.json({
    email: email || null,
    jobId,
    verdict: !stopped
      ? 'The whole path worked.'
      : stopped.status === 'failed'
        ? `Broke at step ${stopped.step}: ${stopped.name}. ${stopped.fix ?? ''}`.trim()
        : `Stopped at step ${stopped.step}: ${stopped.name}. ${stopped.detail}`,
    steps,
    demoMode: config().demoMode,
  })
})

/**
 * The raw event log, newest first. For anything the trace does not cover.
 *
 *   GET /api/admin/events?limit=50&type=email.failed&job=job_xxx
 */
app.get('/admin/events', async (c) => {
  const db = await getDb()
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200)
  const type = c.req.query('type')
  const job = c.req.query('job')
  const hours = Number(c.req.query('hours') ?? 24)

  const filters = [gte(schema.events.createdAt, new Date(Date.now() - hours * 60 * 60 * 1000))]
  if (type) filters.push(eq(schema.events.type, type))
  if (job) filters.push(eq(schema.events.jobId, job))

  const rows = await db
    .select()
    .from(schema.events)
    .where(and(...filters))
    .orderBy(desc(schema.events.createdAt))
    .limit(limit)

  return c.json({
    count: rows.length,
    events: rows.map((r) => ({
      at: r.createdAt.toISOString(),
      type: r.type,
      jobId: r.jobId,
      payload: r.payload,
    })),
  })
})

export default app
