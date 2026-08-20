import { Hono } from 'hono'
import { and, desc, eq, sql } from 'drizzle-orm'
import { getDb, schema } from '../db/client.js'
import { buildLink, clearCookie, createBuildToken, exchangeToken, readSession, sessionCookie } from '../lib/auth.js'
import { resendLinkEmail, sendSafely } from '../lib/email.js'
import { getJob, recordEvent } from '../lib/db.js'

const app = new Hono()

/** Exchange the emailed token for a session. Called by /start?t=... on first load. */
app.post('/auth/start', async (c) => {
  const body = await c.req.json<{ token?: string }>().catch(() => ({}) as { token?: string })
  const token = (body.token ?? '').trim()
  if (!token) return c.json({ error: 'bad_request', detail: 'No link token supplied.' }, 400)

  const result = await exchangeToken(token)
  if ('error' in result) return c.json({ error: 'invalid_token', detail: result.error }, 401)

  const job = await getJob(result.jobId)
  await recordEvent(result.jobId, 'session.started')

  return new Response(
    JSON.stringify({
      jobId: result.jobId,
      status: job?.status ?? 'paid',
      currentVersion: job?.currentVersion ?? 0,
      // Returned so scripts and tests can act as this customer without a cookie jar.
      session: result.session,
    }),
    {
      headers: { 'content-type': 'application/json', 'set-cookie': sessionCookie(result.session) },
    },
  )
})

/** Who am I. Used by the app on load to decide where to send someone. */
app.get('/auth/me', async (c) => {
  const session = await readSession(c)
  if (!session) return c.json({ signedIn: false })

  const job = await getJob(session.jobId)
  if (!job) return c.json({ signedIn: false })

  return c.json({
    signedIn: true,
    jobId: job.id,
    status: job.status,
    currentVersion: job.currentVersion,
    editsRemaining: Math.max(0, job.editsAllowed - job.editsUsed),
  })
})

app.post('/auth/signout', () =>
  Promise.resolve(
    new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json', 'set-cookie': clearCookie() },
    }),
  ),
)

/**
 * "Send my link again", keyed on email, so a lost email is self-service and never becomes a
 * support ticket (brief s3a).
 *
 * The response is deliberately identical whether or not the address is known. Telling a stranger
 * which email addresses have bought a website is not something this endpoint should do.
 */
app.post('/auth/resend', async (c) => {
  const body = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string })
  const email = (body.email ?? '').trim().toLowerCase()

  const generic = {
    ok: true,
    detail: 'If that address has a website with us, the link is on its way. Check your junk folder as well.',
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.json({ error: 'bad_request', detail: 'Enter a valid email address.' }, 400)
  }

  const db = await getDb()
  const rows = await db
    .select({ jobId: schema.jobs.id })
    .from(schema.jobs)
    .innerJoin(schema.users, eq(schema.users.id, schema.jobs.userId))
    .where(and(eq(schema.users.email, email), sql`${schema.jobs.status} <> 'discharged'`))
    .orderBy(desc(schema.jobs.createdAt))
    .limit(1)

  if (!rows[0]) {
    await recordEvent(null, 'auth.resend.unknown_email', { email })
    return c.json(generic)
  }

  const token = await createBuildToken(rows[0].jobId)
  const sent = await sendSafely(rows[0].jobId, 'resend_link', {
    ...resendLinkEmail({ link: buildLink(token) }),
    to: email,
  })

  await recordEvent(rows[0].jobId, 'auth.resend', { email, sent })
  return c.json(generic)
})

export default app
