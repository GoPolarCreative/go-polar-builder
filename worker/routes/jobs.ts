import { Hono } from 'hono'
import type { Env } from '../env'
import { getIntake, getJob, listAssets, recordEvent } from '../lib/db'
import { id, nowIso } from '../lib/ids'

const app = new Hono<{ Bindings: Env }>()

/**
 * Create a job without payment.
 *
 * PHASE 1 ONLY. In production a job is created by the Shopify orders/paid webhook and nowhere
 * else (brief s3a), because a job is the thing $200 buys. This route is how the intake wizard
 * gets something to attach to before auth and payments exist in Phase 6. It refuses to run once
 * a Shopify webhook secret is configured, so it cannot be left switched on by accident.
 */
app.post('/dev/jobs', async (c) => {
  if (c.env.SHOPIFY_WEBHOOK_SECRET) {
    return c.json(
      { error: 'disabled', detail: 'Dev job creation is off once Shopify is configured.' },
      403,
    )
  }

  const body = await c.req
    .json<{ email?: string; name?: string }>()
    .catch(() => ({}) as { email?: string; name?: string })
  const email = (body.email ?? 'test@example.com').trim().toLowerCase()
  const now = nowIso()

  let user = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string }>()

  if (!user) {
    const userId = id('usr')
    await c.env.DB.prepare(
      'INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind(userId, email, body.name ?? null, now)
      .run()
    user = { id: userId }
  }

  const jobId = id('job')
  await c.env.DB.prepare(
    `INSERT INTO jobs (id, user_id, status, created_at, updated_at) VALUES (?, ?, 'paid', ?, ?)`,
  )
    .bind(jobId, user.id, now, now)
    .run()

  await recordEvent(c.env, jobId, 'job.created.dev', { email })
  return c.json({ jobId, userId: user.id }, 201)
})

/** Everything the app needs to render a job: status, intake, audit flags, assets. */
app.get('/jobs/:id', async (c) => {
  const jobId = c.req.param('id')
  const job = await getJob(c.env, jobId)
  if (!job) return c.json({ error: 'not_found', detail: 'No job with that id' }, 404)

  const [intake, assets] = await Promise.all([getIntake(c.env, jobId), listAssets(c.env, jobId)])

  const builds = await c.env.DB.prepare(
    'SELECT version, passed, bytes, created_at FROM builds WHERE job_id = ? ORDER BY version DESC',
  )
    .bind(jobId)
    .all<{ version: number; passed: number; bytes: number; created_at: string }>()

  return c.json({
    job,
    intake: intake?.payload ?? null,
    intakeSubmittedAt: intake?.submittedAt ?? null,
    auditFlags: intake?.auditFlags ?? [],
    assets,
    builds: builds.results ?? [],
  })
})

export default app
