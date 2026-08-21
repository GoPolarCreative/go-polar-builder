import { Hono } from 'hono'
import { and, desc, eq, or, sql } from 'drizzle-orm'
import { getDb, schema } from '../db/client.js'
import {
  SESSION_TTL_DAYS,
  buildLink,
  clearCookie,
  createBuildToken,
  exchangeToken,
  readSession,
  sessionCookie,
} from '../lib/auth.js'
import { signClaims } from '../lib/signing.js'
import { trackKlaviyoSafely } from '../lib/klaviyo.js'
import { getJob, recordEvent } from '../lib/db.js'
import { orderNumberForms } from '../lib/orders.js'

const app = new Hono()

/**
 * Claim a build with the details on the receipt.
 *
 *   POST /api/auth/claim   { email, orderNumber }
 *
 * WHY THIS EXISTS. Getting into the builder used to depend entirely on an email arriving. It did
 * not arrive, for a whole day, for reasons that had nothing to do with this app: a sending domain
 * that had never authorised the sender. A product whose only door is an email is a product that
 * stops working when a DNS record is wrong somewhere else.
 *
 * So the customer can also just knock. They type the email they paid with and the order number
 * from the Shopify confirmation still on their screen, and if a paid build order matches both,
 * they are in. Nothing has to be delivered.
 *
 * TWO FACTORS, DELIBERATELY. Email alone would let anyone who knows a customer's address walk into
 * their account and their website. The order number is on their receipt and nobody else's. Neither
 * half is secret on its own; together they are evidence of a purchase.
 *
 * THE EMAIL PATH STILL WORKS. This is a second door, not a replacement, because somebody coming
 * back a fortnight later will not have the order number to hand.
 */
app.post('/auth/claim', async (c) => {
  const body = await c.req
    .json<{ email?: string; orderNumber?: string }>()
    .catch(() => ({}) as { email?: string; orderNumber?: string })

  const email = (body.email ?? '').trim().toLowerCase()
  const orderNumber = (body.orderNumber ?? '').trim()

  /*
   * The forms are computed here, before the guard, because an empty list is a security problem
   * rather than a validation one. Drizzle's or() with no arguments is undefined, and an undefined
   * inside and() is dropped silently: the order number would stop being a condition at all and
   * email alone would open somebody's website. A submission of "#" is enough to do it.
   *
   * So the guard tests what will actually be matched on, not what was typed.
   */
  const forms = orderNumberForms(orderNumber)

  if (!email.includes('@') || forms.length === 0) {
    return c.json(
      {
        error: 'bad_request',
        detail: 'Enter the email you paid with and the order number from your confirmation.',
      },
      400,
    )
  }

  const db = await getDb()

  /*
   * One query, both factors. Matching on email first and then checking the number would let the
   * response time say whether an address has an account, which is the thing the resend flow goes
   * out of its way not to reveal.
   */
  const rows = await db
    .select({ jobId: schema.orders.jobId })
    .from(schema.orders)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.orders.jobId))
    .innerJoin(schema.users, eq(schema.users.id, schema.jobs.userId))
    .where(
      and(
        eq(schema.users.email, email),
        // Any form the same order could be typed as. On a store with a custom prefix the receipt
        // says "#GPC1258", and people type "GPC1258", "#gpc1258", or just "1258" because the
        // prefix reads as decoration. Folded on both sides, and the digits alone accepted.
        //
        // The confirmation number is accepted too. Shopify's thank-you page prints it larger than
        // the order number and calls the page a confirmation, so it is the one people reach for.
        or(
          ...forms.flatMap((form) => [
            sql`lower(${schema.orders.shopifyOrderNumber}) = ${form}`,
            sql`regexp_replace(coalesce(${schema.orders.shopifyOrderNumber}, ''), '[^0-9]', '', 'g') = ${form}`,
            sql`lower(${schema.orders.shopifyConfirmationNumber}) = ${form}`,
          ]),
        ),
        eq(schema.orders.kind, 'build'),
        eq(schema.orders.status, 'paid'),
      ),
    )
    .limit(1)

  const jobId = rows[0]?.jobId
  if (!jobId) {
    /*
     * The customer gets one message either way. The log does not.
     *
     * "No match" has two very different causes: they mistyped, or we never stored the number
     * against their order. The second is our fault and is invisible from the outside, which is
     * exactly how a null column survived a deploy and made a paid order unclaimable. So find out
     * which it was, and write it down where an operator will see it.
     */
    const paidBuilds = await db
      .select({ stored: schema.orders.shopifyOrderNumber })
      .from(schema.orders)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.orders.jobId))
      .innerJoin(schema.users, eq(schema.users.id, schema.jobs.userId))
      .where(
        and(
          eq(schema.users.email, email),
          eq(schema.orders.kind, 'build'),
          eq(schema.orders.status, 'paid'),
        ),
      )

    const reason =
      paidBuilds.length === 0
        ? 'no_paid_build_for_email'
        : paidBuilds.every((row) => !row.stored)
          ? 'order_number_never_stored'
          : 'order_number_mismatch'

    await recordEvent(null, 'auth.claim.failed', {
      email,
      orderNumber,
      reason,
      paidBuilds: paidBuilds.length,
      stored: paidBuilds.map((row) => row.stored),
      notify: reason === 'order_number_never_stored' ? 'chris' : undefined,
    })
    return c.json(
      {
        error: 'no_match',
        detail:
          'We could not match that. Check the email is the one you paid with, and that the order number is from the website build order. If it still will not work, email hello@itscold.com.au and we will sort it out.',
      },
      404,
    )
  }

  const session = await signClaims({
    kind: 'session',
    jobId,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_DAYS * 86_400,
  })

  await recordEvent(jobId, 'auth.claim', { email, orderNumber })

  return new Response(JSON.stringify({ ok: true, jobId }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': sessionCookie(session) },
  })
})

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

  // Klaviyo sends it, not this app. This is the path a customer takes when they have lost the
  // link, so it is the second most important email in the product and it used to go nowhere: it
  // was wired to a Resend transport that was never configured, and the generic reply below meant
  // nobody could tell the difference between sent and silently discarded.
  const sent = await trackKlaviyoSafely({
    metric: 'link_requested',
    profile: { email },
    jobId: rows[0].jobId,
    properties: { builder_login_link: buildLink(token) },
  })

  await recordEvent(rows[0].jobId, 'auth.resend', { email, sent })
  return c.json(generic)
})

export default app
