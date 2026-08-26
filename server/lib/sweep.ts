import { and, eq, inArray, lt, notExists, or, sql } from 'drizzle-orm'
import { runTakedownSweep } from './takedown.js'
import { getDb, schema } from '../db/client.js'
import { recordEvent } from './db.js'
import { createBuildToken } from './auth.js'
import { builderLoginLink, previewLink, trackKlaviyoSafely } from './klaviyo.js'
import { listPaidOrdersSince, ShopifyConfigError } from './shopify.js'
import { processPaidOrder } from './orders.js'

/**
 * The scheduled sweep. Vercel Cron, hourly (DECISIONS.md D12).
 *
 * Four jobs, each of which exists because something goes missing silently otherwise:
 *   1. paid Shopify orders with no matching job, because webhooks get dropped
 *   2. jobs that are paid but whose build link never actually sent
 *   3. intake abandoned for 24 hours, the warmest lead in the business
 *   4. stalled in editing for 72 hours
 *
 * Nothing here throws. A sweep that dies on its first bad row is a sweep that stops fixing
 * anything, so every step is wrapped and reported.
 */

export interface SweepReport {
  ranAt: string
  reconciledOrders: number
  resentLinks: number
  abandonedIntake: number
  stalledEditing: number
  /** The 60 day cancellation clock. See server/lib/takedown.ts. */
  hostingWarned: number
  sitesTakenDown: number
  problems: string[]
}

const HOUR = 3_600_000

export async function runSweep(): Promise<SweepReport> {
  const report: SweepReport = {
    ranAt: new Date().toISOString(),
    reconciledOrders: 0,
    resentLinks: 0,
    abandonedIntake: 0,
    stalledEditing: 0,
    hostingWarned: 0,
    sitesTakenDown: 0,
    problems: [],
  }

  await reconcileOrders(report)
  await retryMissingLinks(report)
  await flagAbandonedIntake(report)
  await flagStalledEditing(report)

  /*
   * THE CANCELLATION CLOCK. Last, and deliberately not wrapped in the same try as the others:
   * runTakedownSweep collects its own problems per job, so one bad row cannot stop the rest of
   * the list being warned. A customer missing their day 59 email because somebody else’s job
   * threw is not an acceptable failure for something that ends with a website going offline.
   */
  const takedown = await runTakedownSweep()
  report.hostingWarned = takedown.warned
  report.sitesTakenDown = takedown.takenDown
  report.problems.push(...takedown.problems)

  await recordEvent(null, 'sweep.ran', report)
  return report
}

/**
 * Brief s3a: a job polls for paid orders with no matching job and repairs the gap. Repair goes
 * through the same processPaidOrder the webhook uses, so there is one code path and one set of
 * bugs.
 */
async function reconcileOrders(report: SweepReport): Promise<void> {
  try {
    const db = await getDb()
    // A 48 hour window is generous for a retry storm and cheap to scan.
    const orders = await listPaidOrdersSince(new Date(Date.now() - 48 * HOUR).toISOString())

    for (const order of orders) {
      try {
        const known = await db
          .select({ id: schema.orders.id })
          .from(schema.orders)
          .where(eq(schema.orders.shopifyOrderId, String(order.id)))
          .limit(1)
        if (known.length > 0) continue

        const result = await processPaidOrder(order)
        if (result.handled.length > 0) {
          report.reconciledOrders++
          await recordEvent(result.jobId, 'order.reconciled', {
            orderId: result.orderId,
            handled: result.handled,
            // This means a webhook went missing. Worth knowing if it starts happening often.
            source: 'sweep',
          })
        }
      } catch (err) {
        report.problems.push(`Order ${order.id}: ${err instanceof Error ? err.message : 'failed to process'}`)
      }
    }
  } catch (err) {
    // No admin token is a configuration state, not a fault. Report it and carry on.
    report.problems.push(
      err instanceof ShopifyConfigError
        ? err.message
        : `Order reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * A paid job whose build link never sent. The single worst failure in this system, so it gets its
 * own sweep rather than relying on the email provider's retry.
 */
async function retryMissingLinks(report: SweepReport): Promise<void> {
  try {
    const db = await getDb()
    /*
     * "Already sent" means a klaviyo.sent event for the build-purchased metric. This used to
     * look for the Resend-era event (email.sent, kind build_link), which the Klaviyo path never
     * writes, so after D48 the guard matched nothing and every job sitting in "paid" for over an
     * hour was re-sent its build link on every sweep. The legacy event is still honoured so
     * pre-D48 jobs do not suddenly resend.
     */
    const sent = db
      .select({ one: sql`1` })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.jobId, schema.jobs.id),
          or(
            and(
              eq(schema.events.type, 'klaviyo.sent'),
              sql`${schema.events.payload}->>'metric' = 'Website Build Purchased'`,
            ),
            and(
              eq(schema.events.type, 'email.sent'),
              sql`${schema.events.payload}->>'kind' = 'build_link'`,
            ),
          ),
        ),
      )

    const rows = await db
      .select({ jobId: schema.jobs.id, email: schema.users.email })
      .from(schema.jobs)
      .innerJoin(schema.users, eq(schema.users.id, schema.jobs.userId))
      .where(
        and(
          eq(schema.jobs.status, 'paid'),
          lt(schema.jobs.createdAt, new Date(Date.now() - HOUR)),
          notExists(sent),
        ),
      )
      .limit(25)

    for (const row of rows) {
      const token = await createBuildToken(row.jobId)
      const sentOk = await trackKlaviyoSafely({
        metric: 'build_purchased',
        profile: { email: row.email },
        jobId: row.jobId,
        properties: { builder_login_link: builderLoginLink(token), recovered: true },
      })
      if (sentOk) report.resentLinks++
    }
  } catch (err) {
    report.problems.push(`Link retry failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Brief s12: intake abandoned, no submission after 24h. Currently nothing catches these. */
async function flagAbandonedIntake(report: SweepReport): Promise<void> {
  try {
    const db = await getDb()

    const submitted = db
      .select({ one: sql`1` })
      .from(schema.intake)
      .where(and(eq(schema.intake.jobId, schema.jobs.id), sql`${schema.intake.submittedAt} is not null`))

    const alreadyFlagged = db
      .select({ one: sql`1` })
      .from(schema.events)
      .where(and(eq(schema.events.jobId, schema.jobs.id), eq(schema.events.type, 'intake.abandoned')))

    const rows = await db
      .select({ jobId: schema.jobs.id, email: schema.users.email, businessName: schema.jobs.businessName })
      .from(schema.jobs)
      .innerJoin(schema.users, eq(schema.users.id, schema.jobs.userId))
      .where(
        and(
          inArray(schema.jobs.status, ['paid', 'intake']),
          lt(schema.jobs.createdAt, new Date(Date.now() - 24 * HOUR)),
          eq(schema.jobs.currentVersion, 0),
          notExists(submitted),
          notExists(alreadyFlagged),
        ),
      )
      .limit(50)

    for (const row of rows) {
      await recordEvent(row.jobId, 'intake.abandoned', { email: row.email })
      await trackKlaviyoSafely({
        metric: 'intake_abandoned',
        profile: { email: row.email, businessName: row.businessName },
        jobId: row.jobId,
        properties: { builder_login_link: previewLink(row.jobId) },
      })
      report.abandonedIntake++
    }
  } catch (err) {
    report.problems.push(`Abandoned intake sweep failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Brief s12: stalled in editing 72h or more, recovery sequence. */
async function flagStalledEditing(report: SweepReport): Promise<void> {
  try {
    const db = await getDb()

    const alreadyFlagged = db
      .select({ one: sql`1` })
      .from(schema.events)
      .where(and(eq(schema.events.jobId, schema.jobs.id), eq(schema.events.type, 'editing.stalled')))

    const rows = await db
      .select({ jobId: schema.jobs.id, email: schema.users.email, businessName: schema.jobs.businessName })
      .from(schema.jobs)
      .innerJoin(schema.users, eq(schema.users.id, schema.jobs.userId))
      .where(
        and(
          inArray(schema.jobs.status, ['preview', 'editing']),
          lt(schema.jobs.updatedAt, new Date(Date.now() - 72 * HOUR)),
          notExists(alreadyFlagged),
        ),
      )
      .limit(50)

    for (const row of rows) {
      await recordEvent(row.jobId, 'editing.stalled', { email: row.email })
      await trackKlaviyoSafely({
        metric: 'editing_stalled',
        profile: { email: row.email, businessName: row.businessName },
        jobId: row.jobId,
        properties: { preview_link: previewLink(row.jobId) },
      })
      report.stalledEditing++
    }
  } catch (err) {
    report.problems.push(`Stalled editing sweep failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
