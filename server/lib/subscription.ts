import { desc, eq } from 'drizzle-orm'
import { getDb, schema } from '../db/client.js'
import { config } from '../config.js'
import { getJob, getUserForJob, recordEvent } from './db.js'
import { trackKlaviyoSafely } from './klaviyo.js'
import { TAKEDOWN_DAYS, takedownDueAt } from '../../shared/takedown.js'

/**
 * Hosting subscriptions, and what happens when one stops.
 *
 * NOTHING CONSUMED THESE EVENTS UNTIL NOW. A customer could cancel their hosting and keep the
 * site, keep editing it, and keep costing money indefinitely. While the site was a static thing
 * Chris published by hand that was a slow leak. With a self-serve editor it becomes somebody
 * actively using a product they stopped paying for, which is a different problem.
 *
 * WHAT THIS DOES: refuses editing and publishing once the subscription ends, and tells Chris.
 * WHAT THIS DELIBERATELY DOES NOT DO: take the website down.
 *
 * Pulling a tradie's website offline the hour a card bounces is not a decision a webhook should
 * make. Cards expire, banks decline things for no reason, and the customer standing to lose is
 * the one whose phone number is on the site. Chris gets told, `/ops` shows it, and a person
 * decides. The policy question, how long a cancelled site stays up and what replaces it, is
 * flagged in DECISIONS.md D63 and is Chris's to answer.
 *
 * THE STATUS IS 'unknown' UNTIL A WEBHOOK SAYS OTHERWISE. Absence of a cancellation is not
 * evidence of a payment, but it is also not evidence of a cancellation, and the only safe reading
 * for every customer who predates this column is "carry on". Only an explicit cancellation locks
 * anything.
 */

/** Shopify subscription contract statuses that mean the money has stopped. */
const ENDED = new Set(['CANCELLED', 'EXPIRED', 'FAILED'])

export type HostingStatus = 'active' | 'cancelled' | 'unknown'

/**
 * Find the job a subscription belongs to.
 *
 * THE EMAIL IS NOT IN THE PAYLOAD, AND NEVER WAS.
 *
 * This used to match on the customer's email, and the comment here claimed that was "the only
 * identifier that survives the trip from a subscription contract back to a job". It is not an
 * identifier that arrives at all. Shopify's subscription_contracts/* body is the contract:
 *
 *   { id, customer_id, admin_graphql_api_customer_id, status,
 *     origin_order_id, admin_graphql_api_origin_order_id, billing_policy, ... }
 *
 * No email, nested or otherwise. So the route read '' every time, this returned null on the
 * empty-string guard, and every real cancellation would have been recorded as
 * `subscription.unmatched` and done nothing: no lock, no takedown clock, no operator alert. The
 * customer keeps the site and stops paying, which is the exact thing this module exists to catch.
 * It has never fired in production only because nobody is on paid hosting yet.
 *
 * Both real identifiers are already on the orders table, written for every order we process:
 *
 *   origin_order_id  -> orders.shopifyOrderId    the checkout that created this contract
 *   customer_id      -> orders.shopifyCustomerId the buyer
 *
 * The order is tried first because it is exact: it names the one purchase this contract bills
 * for. The customer id is the fallback, newest job first, for a contract whose origin order we
 * never recorded. Matching on either also fixes the second half of the old bug, an unordered
 * `limit(1)` over an email that gave an arbitrary job to anyone who had bought twice.
 */
async function jobForSubscription(args: {
  originOrderId?: string | null
  customerId?: string | null
}): Promise<{ jobId: string; matchedOn: 'origin_order' | 'customer' } | null> {
  const db = await getDb()

  if (args.originOrderId) {
    const [row] = await db
      .select({ jobId: schema.orders.jobId })
      .from(schema.orders)
      .where(eq(schema.orders.shopifyOrderId, args.originOrderId))
      .limit(1)
    if (row?.jobId) return { jobId: row.jobId, matchedOn: 'origin_order' }
  }

  if (args.customerId) {
    // Newest first: a customer with two sites gets the one they most recently bought, and the
    // choice is at least deterministic rather than whatever Postgres happened to return.
    const [row] = await db
      .select({ jobId: schema.orders.jobId })
      .from(schema.orders)
      .where(eq(schema.orders.shopifyCustomerId, args.customerId))
      .orderBy(desc(schema.orders.createdAt))
      .limit(1)
    if (row?.jobId) return { jobId: row.jobId, matchedOn: 'customer' }
  }

  return null
}

export async function applySubscriptionStatus(args: {
  /** Shopify's `origin_order_id`: the checkout that created this contract. */
  originOrderId?: string | null
  /** Shopify's `customer_id`. */
  customerId?: string | null
  status: string
  /** Whatever the provider called it, kept for the event trail. */
  raw?: unknown
}): Promise<{ handled: boolean; jobId: string | null; hostingStatus: HostingStatus }> {
  const match = await jobForSubscription(args)
  const jobId = match?.jobId ?? null
  const status = (args.status ?? '').toUpperCase()
  const hostingStatus: HostingStatus = ENDED.has(status) ? 'cancelled' : status === 'ACTIVE' ? 'active' : 'unknown'

  if (!jobId) {
    // Worth recording even unmatched: a subscription with no job behind it is itself a thing
    // Chris would want to know about, and a silent drop teaches nobody anything.
    await recordEvent(null, 'subscription.unmatched', {
      originOrderId: args.originOrderId ?? null,
      customerId: args.customerId ?? null,
      status,
    })
    return { handled: false, jobId: null, hostingStatus }
  }

  if (hostingStatus === 'unknown') {
    await recordEvent(jobId, 'subscription.ignored', { status })
    return { handled: false, jobId, hostingStatus }
  }

  /*
   * RESUBSCRIBING UNDOES EVERYTHING, with no human in the loop.
   *
   * cancelTakedown clears hostingEndedAt, which is the field every date in the countdown is
   * derived from, and puts sites.live back if the site had already gone dark. A customer who
   * starts paying again has done the only thing that was being asked of them.
   */
  if (hostingStatus === 'active') {
    const { cancelTakedown } = await import('./takedown.js')
    const out = await cancelTakedown(jobId)
    await recordEvent(jobId, 'subscription.active', { status, matchedOn: match?.matchedOn ?? null, siteRestored: out.restored })
    return { handled: true, jobId, hostingStatus }
  }

  const db = await getDb()
  await db
    .update(schema.golive)
    .set({
      hostingStatus,
      hostingEndedAt: hostingStatus === 'cancelled' ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(schema.golive.jobId, jobId))

  await recordEvent(jobId, 'subscription.cancelled', { status, matchedOn: match?.matchedOn ?? null, notify: 'chris' })

  if (hostingStatus === 'cancelled') {
    const cfg = config()
    const job = await getJob(jobId)
    const user = await getUserForJob(jobId)
    await trackKlaviyoSafely({
      metric: 'operator_alert',
      profile: { email: cfg.operatorEmail },
      jobId,
      properties: {
        alert: 'hosting_cancelled',
        business_name: job?.businessName ?? 'Unnamed business',
        customer_email: user?.email ?? 'unknown',
        job_id: jobId,
        subscription_status: status,
        ops_link: `${cfg.publicAppUrl.replace(/\/$/, '')}/ops#job-${jobId}`,
        // Stated in the alert because it is the thing Chris has to decide, and the system is
        // deliberately not deciding it.
        takedown_on: takedownDueAt(new Date()).toISOString(),
        note: `Editing and publishing are now refused. Their website STAYS ONLINE for ${TAKEDOWN_DAYS} days, then comes down automatically. They get warned at 0, 30, 53 and 59 days. Resubscribing before then puts everything back with no intervention.`,
      },
    })
  }

  return { handled: true, jobId, hostingStatus }
}

/**
 * Is this job allowed to change its live website?
 *
 * Called by the edit and publish paths. Returns a reason rather than a boolean, because a refusal
 * a customer cannot understand is a support call.
 */
export async function hostingBlock(jobId: string): Promise<{ blocked: boolean; detail: string } | null> {
  const db = await getDb()
  const [row] = await db
    .select({ hostingStatus: schema.golive.hostingStatus })
    .from(schema.golive)
    .where(eq(schema.golive.jobId, jobId))
    .limit(1)

  if (row?.hostingStatus !== 'cancelled') return null

  return {
    blocked: true,
    detail:
      'Your hosting subscription has ended, so changes are switched off. Your website is still online. Reply to any of our emails and we will get you going again.',
  }
}
