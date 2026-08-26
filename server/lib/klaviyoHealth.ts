import { desc, inArray } from 'drizzle-orm'
import { getDb, schema } from '../db/client.js'
import { KLAVIYO_METRICS, type KlaviyoMetric } from './klaviyo.js'

/**
 * Which Klaviyo metrics have ever fired, and when they last did.
 *
 * THE FAILURE THIS EXISTS TO MAKE VISIBLE. The app fires an event, Klaviyo answers 202, and the
 * app records a success. If no flow is listening to that metric, the 202 is still a 202 and
 * nothing anywhere is wrong. The customer simply never gets the email.
 *
 * Nine of the eleven flows do not exist today. A paid discharge sends no download link, a
 * returning customer gets no sign-in code, and every log says it worked. There is no alert for
 * this and no way to notice it except a customer complaining, which is a terrible detector.
 *
 * WHAT THIS CAN AND CANNOT TELL YOU, stated plainly because the difference matters:
 *
 *   CAN   whether this app has ever emitted a metric, and when it last did. A metric that has
 *         NEVER fired definitely has no working flow, because Klaviyo will not even offer it in
 *         the trigger picker until one event of that name arrives.
 *
 *   CANNOT  whether a flow exists, or whether an email was delivered. Only Klaviyo knows that.
 *
 * So this is a "what is definitely broken" panel, not a "what is definitely working" one, and the
 * UI says so rather than implying a green tick means delivery.
 */

export type MetricState = 'never' | 'recent' | 'quiet' | 'failing'

export interface MetricHealth {
  key: KlaviyoMetric
  /** The exact string typed into Klaviyo. Shown so it can be copied. */
  name: string
  state: MetricState
  lastFiredAt: string | null
  lastFailedAt: string | null
  /** Sends recorded in the window below. */
  recentSends: number
  recentFailures: number
  /** Plain sentence for the operator. */
  detail: string
}

/** How far back "recent" looks. Long enough that a quiet week is not alarming. */
const WINDOW_DAYS = 30

export async function klaviyoHealth(now: Date = new Date()): Promise<{
  window: string
  neverFired: number
  failing: number
  metrics: MetricHealth[]
}> {
  const db = await getDb()
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000)

  /*
   * Every klaviyo.sent and klaviyo.failed row, newest first.
   *
   * Deliberately NOT filtered by date: "has this ever fired" is the most important question on
   * the panel and a 30 day filter would answer it wrongly for a metric that fired once in June.
   * The window only narrows the counts.
   */
  const rows = await db
    .select({ type: schema.events.type, payload: schema.events.payload, createdAt: schema.events.createdAt })
    .from(schema.events)
    .where(inArray(schema.events.type, ['klaviyo.sent', 'klaviyo.failed']))
    .orderBy(desc(schema.events.createdAt))
    .limit(5000)

  const metrics: MetricHealth[] = (Object.keys(KLAVIYO_METRICS) as KlaviyoMetric[]).map((key) => {
    const name = KLAVIYO_METRICS[key]
    const mine = rows.filter((r) => (r.payload as { metric?: string } | null)?.metric === name)

    const sends = mine.filter((r) => r.type === 'klaviyo.sent')
    const fails = mine.filter((r) => r.type === 'klaviyo.failed')

    const lastFired = sends[0]?.createdAt ?? null
    const lastFailed = fails[0]?.createdAt ?? null
    const recentSends = sends.filter((r) => r.createdAt >= since).length
    const recentFailures = fails.filter((r) => r.createdAt >= since).length

    /*
     * A metric that is FAILING outranks one that is merely quiet. A failure means the call to
     * Klaviyo itself was rejected, which is a different and worse problem than a missing flow:
     * the event never arrived at all.
     */
    let state: MetricState
    let detail: string

    if (lastFailed && (!lastFired || lastFailed > lastFired)) {
      state = 'failing'
      detail = `The last attempt FAILED. The event never reached Klaviyo, so no flow could have run. Check /api/admin/events.`
    } else if (!lastFired) {
      state = 'never'
      detail = `Never fired. Klaviyo will not offer this metric in the flow picker until one event arrives, so a flow cannot exist yet.`
    } else if (recentSends > 0) {
      state = 'recent'
      detail = `${recentSends} sent in the last ${WINDOW_DAYS} days. This app's side is working; whether a flow picked them up is only visible in Klaviyo.`
    } else {
      state = 'quiet'
      detail = `Fired before, but nothing in the last ${WINDOW_DAYS} days. Normal for a rare event, worth a look for a common one.`
    }

    return {
      key,
      name,
      state,
      lastFiredAt: lastFired?.toISOString() ?? null,
      lastFailedAt: lastFailed?.toISOString() ?? null,
      recentSends,
      recentFailures,
      detail,
    }
  })

  /*
   * Ordered by how much they should worry somebody: failing first, then never fired, then quiet,
   * then working. An operator opening this should not have to hunt for the bad news.
   */
  const rank: Record<MetricState, number> = { failing: 0, never: 1, quiet: 2, recent: 3 }
  metrics.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name))

  return {
    window: `${WINDOW_DAYS} days`,
    neverFired: metrics.filter((m) => m.state === 'never').length,
    failing: metrics.filter((m) => m.state === 'failing').length,
    metrics,
  }
}
