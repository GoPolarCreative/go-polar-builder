import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { getDb, schema } from '../db/client.js'
import { config } from '../config.js'
import { createUserAndJob, getIntake, getJob, listAssets, recordEvent } from '../lib/db.js'
import { SESSION_TTL_DAYS, buildLink, createBuildToken, sessionCookie } from '../lib/auth.js'
import { signClaims } from '../lib/signing.js'

const app = new Hono()

/**
 * Create a job without payment.
 *
 * DEVELOPMENT AND DEMO ONLY. In production a job is created by the Shopify orders/paid webhook
 * and nowhere else (brief s3a), because a job is the thing $200 buys. This route refuses to run
 * once a Shopify webhook secret is configured, so it cannot be left switched on by accident.
 */
app.post('/dev/jobs', async (c) => {
  const cfg = config()
  if (cfg.shopify.webhookSecret) {
    return c.json({ error: 'disabled', detail: 'Dev job creation is off once Shopify is configured.' }, 403)
  }

  const body = await c.req
    .json<{ email?: string; name?: string }>()
    .catch(() => ({}) as { email?: string; name?: string })
  const email = (body.email ?? 'test@example.com').trim().toLowerCase()

  const { jobId, userId } = await createUserAndJob({ email, name: body.name ?? null })
  await recordEvent(jobId, 'job.created.dev', { email })

  // A session comes back with it, since every job route is behind auth. The cookie covers the
  // browser; the raw session is returned so scripts and curl can act as this customer. A real
  // build token is minted too, so a browser can sign in the same way a paying customer does.
  const session = await signClaims({
    kind: 'session',
    jobId,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_DAYS * 86_400,
  })
  const token = await createBuildToken(jobId)

  return new Response(JSON.stringify({ jobId, userId, session, startLink: buildLink(token) }), {
    status: 201,
    headers: { 'content-type': 'application/json', 'set-cookie': sessionCookie(session) },
  })
})

/** Everything the app needs to render a job: status, intake, audit flags, assets, builds. */
app.get('/jobs/:id', async (c) => {
  const jobId = c.req.param('id')
  const job = await getJob(jobId)
  if (!job) return c.json({ error: 'not_found', detail: 'No job with that id' }, 404)

  const db = await getDb()
  const [intake, assets, builds] = await Promise.all([
    getIntake(jobId),
    listAssets(jobId),
    db
      .select({
        version: schema.builds.version,
        passed: schema.builds.passed,
        bytes: schema.builds.bytes,
        pageWeightBytes: schema.builds.pageWeightBytes,
        createdAt: schema.builds.createdAt,
      })
      .from(schema.builds)
      .where(eq(schema.builds.jobId, jobId))
      .orderBy(desc(schema.builds.version)),
  ])

  return c.json({
    job,
    intake: intake?.payload ?? null,
    intakeSubmittedAt: intake?.submittedAt ?? null,
    auditFlags: intake?.auditFlags ?? [],
    assets,
    builds,
  })
})

export default app
