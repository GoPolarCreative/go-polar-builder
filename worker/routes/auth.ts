import { Hono } from 'hono'
import type { Env } from '../env'
import { buildLink, clearCookie, createBuildToken, exchangeToken, readSession, sessionCookie } from '../lib/auth'
import { resendLinkEmail, sendSafely } from '../lib/email'
import { getJob, recordEvent } from '../lib/db'

const app = new Hono<{ Bindings: Env }>()

/**
 * Auth. Token link by email, no passwords (brief s3a).
 */

/** Exchange the emailed token for a session. Called by /start?t=... on first load. */
app.post('/auth/start', async (c) => {
  const body = await c.req.json<{ token?: string }>().catch(() => ({}) as { token?: string })
  const token = (body.token ?? '').trim()
  if (!token) return c.json({ error: 'bad_request', detail: 'No link token supplied.' }, 400)

  const result = await exchangeToken(c.env, token)
  if ('error' in result) return c.json({ error: 'invalid_token', detail: result.error }, 401)

  const job = await getJob(c.env, result.jobId)
  await recordEvent(c.env, result.jobId, 'session.started')

  return new Response(
    JSON.stringify({
      jobId: result.jobId,
      status: job?.status ?? 'paid',
      currentVersion: job?.current_version ?? 0,
      // Returned so scripts and tests can act as this customer without a cookie jar.
      session: result.session,
    }),
    {
      headers: {
        'content-type': 'application/json',
        'set-cookie': sessionCookie(c.env, result.session),
      },
    },
  )
})

/** Who am I. Used by the app on load to decide where to send someone. */
app.get('/auth/me', async (c) => {
  const session = await readSession(c)
  if (!session) return c.json({ signedIn: false }, 200)

  const job = await getJob(c.env, session.jobId)
  if (!job) return c.json({ signedIn: false }, 200)

  return c.json({
    signedIn: true,
    jobId: job.id,
    status: job.status,
    currentVersion: job.current_version,
    editsRemaining: Math.max(0, job.edits_allowed - job.edits_used),
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

  const row = await c.env.DB.prepare(
    `SELECT j.id AS job_id FROM jobs j JOIN users u ON u.id = j.user_id
     WHERE u.email = ? AND j.status != 'discharged'
     ORDER BY j.created_at DESC LIMIT 1`,
  )
    .bind(email)
    .first<{ job_id: string }>()

  if (!row) {
    await recordEvent(c.env, null, 'auth.resend.unknown_email', { email })
    return c.json(generic)
  }

  const token = await createBuildToken(c.env, row.job_id)
  const message = resendLinkEmail({ link: buildLink(c.env, token) })
  const sent = await sendSafely(c.env, row.job_id, 'resend_link', { ...message, to: email })

  await recordEvent(c.env, row.job_id, 'auth.resend', { email, sent })
  return c.json(generic)
})

export default app
