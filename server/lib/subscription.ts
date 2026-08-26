import { eq } from 'drizzle-orm'
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
 * Matched on the customer's email, because that is the only identifier that survives the trip
 * from a subscription contract back to a job. The job id is on the original build order, not on
 * the hosting subscription that was created weeks later from a different checkout.
 */
async function jobForEmail(email: string): Promise<string | null> {
  if (!email) return null
  const db = await getDb()
  const [row] = await db
    .select({ jobId: schema.jobs.id })
    .from(schema.jobs)
    .innerJoin(schema.users, eq(schema.users.id, schema.jobs.userId))
    .where(eq(schema.users.email, email.trim().toLowerCase()))
    .limit(1)
  return row?.jobId ?? null
}

export async function applySubscriptionStatus(args: {
  email: string
  status: string
  /** Whatever the provider called it, kept for the event trail. */
  raw?: unknown
}): Promise<{ handled: boolean; jobId: string | null; hostingStatus: HostingStatus }> {
  const jobId = await jobForEmail(args.email)
  const status = (args.status ?? '').toUpperCase()
  const hostingStatus: HostingStatus = ENDED.has(status) ? 'cancelled' : status === 'ACTIVE' ? 'active' : 'unknown'

  if (!jobId) {
    // Worth recording even unmatched: a subscription with no job behind it is itself a thing
    // Chris would want to know about, and a silent drop teaches nobody anything.
    await recordEvent(null, 'subscription.unmatched', { email: args.email, status })
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
    await recordEvent(jobId, 'subscription.active', { status, email: args.email, siteRestored: out.restored })
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

  await recordEvent(jobId, 'subscription.cancelled', { status, email: args.email, notify: 'chris' })

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
        customer_email: user?.email ?? args.email,
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
