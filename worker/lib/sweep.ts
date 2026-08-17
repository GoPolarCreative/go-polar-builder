import type { Env } from '../env'
import { recordEvent } from './db'
import { buildLink, createBuildToken } from './auth'
import { buildLinkEmail, sendSafely } from './email'
import { builderLoginLink, notifyGhlSafely, previewLink } from './ghl'
import { listPaidOrdersSince, ShopifyConfigError } from './shopify'
import { processPaidOrder } from './orders'

/**
 * The scheduled sweep. Runs hourly (DECISIONS.md D12).
 *
 * Four jobs, each of which exists because something silently goes missing otherwise:
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
  problems: string[]
}

const HOUR = 3_600_000

export async function runSweep(env: Env): Promise<SweepReport> {
  const report: SweepReport = {
    ranAt: new Date().toISOString(),
    reconciledOrders: 0,
    resentLinks: 0,
    abandonedIntake: 0,
    stalledEditing: 0,
    problems: [],
  }

  await reconcileOrders(env, report)
  await retryMissingLinks(env, report)
  await flagAbandonedIntake(env, report)
  await flagStalledEditing(env, report)

  await recordEvent(env, null, 'sweep.ran', report)
  return report
}

/**
 * Brief s3a: "If a webhook is missed, a nightly job polls Shopify for paid orders with no
 * matching job and repairs the gap." Repair goes through the same processPaidOrder the webhook
 * uses, so there is one code path and one set of bugs.
 */
async function reconcileOrders(env: Env, report: SweepReport): Promise<void> {
  try {
    // A 48 hour window is generous for a retry storm and cheap to scan.
    const since = new Date(Date.now() - 48 * HOUR).toISOString()
    const orders = await listPaidOrdersSince(env, since)

    for (const order of orders) {
      try {
        const known = await env.DB.prepare('SELECT id FROM orders WHERE shopify_order_id = ? LIMIT 1')
          .bind(String(order.id))
          .first<{ id: string }>()
        if (known) continue

        const result = await processPaidOrder(env, order)
        if (result.handled.length > 0) {
          report.reconciledOrders++
          await recordEvent(env, result.jobId, 'order.reconciled', {
            orderId: result.orderId,
            handled: result.handled,
            // This means a webhook went missing. Worth knowing if it starts happening often.
            source: 'sweep',
          })
        }
      } catch (err) {
        report.problems.push(
          `Order ${order.id}: ${err instanceof Error ? err.message : 'failed to process'}`,
        )
      }
    }
  } catch (err) {
    // No Admin token is a configuration state, not a fault. Report it and carry on.
    report.problems.push(
      err instanceof ShopifyConfigError
        ? err.message
        : `Order reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * A paid job whose build link never sent. The single worst failure in this system, so it gets
 * its own sweep rather than relying on the Resend retry.
 */
async function retryMissingLinks(env: Env, report: SweepReport): Promise<void> {
  try {
    const rows = await env.DB.prepare(
      `SELECT j.id AS job_id, u.email
       FROM jobs j
       JOIN users u ON u.id = j.user_id
       WHERE j.status = 'paid'
         AND j.created_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM events e
           WHERE e.job_id = j.id AND e.type = 'email.sent' AND e.payload_json LIKE '%build_link%'
         )
       LIMIT 25`,
    )
      .bind(new Date(Date.now() - HOUR).toISOString())
      .all<{ job_id: string; email: string }>()

    for (const row of rows.results ?? []) {
      const token = await createBuildToken(env, row.job_id)
      const message = buildLinkEmail({ link: buildLink(env, token) })
      const sent = await sendSafely(env, row.job_id, 'build_link', { ...message, to: row.email })
      if (sent) {
        report.resentLinks++
        await notifyGhlSafely(env, {
          event: 'payment_received',
          contact: { email: row.email },
          jobId: row.job_id,
          customValues: { builder_login_link: builderLoginLink(env, token) },
          data: { recovered: true },
        })
      }
    }
  } catch (err) {
    report.problems.push(`Link retry failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Brief s12: intake abandoned, no submission after 24h. Currently nothing catches these. */
async function flagAbandonedIntake(env: Env, report: SweepReport): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 24 * HOUR).toISOString()
    const rows = await env.DB.prepare(
      `SELECT j.id AS job_id, u.email, j.business_name
       FROM jobs j
       JOIN users u ON u.id = j.user_id
       WHERE j.status IN ('paid','intake')
         AND j.created_at < ?
         AND j.current_version = 0
         AND NOT EXISTS (SELECT 1 FROM intake i WHERE i.job_id = j.id AND i.submitted_at IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM events e WHERE e.job_id = j.id AND e.type = 'intake.abandoned')
       LIMIT 50`,
    )
      .bind(cutoff)
      .all<{ job_id: string; email: string; business_name: string | null }>()

    for (const row of rows.results ?? []) {
      await recordEvent(env, row.job_id, 'intake.abandoned', { email: row.email })
      await notifyGhlSafely(env, {
        event: 'intake_abandoned',
        contact: { email: row.email, businessName: row.business_name },
        jobId: row.job_id,
        customValues: { builder_login_link: previewLink(env, row.job_id) },
      })
      report.abandonedIntake++
    }
  } catch (err) {
    report.problems.push(`Abandoned intake sweep failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Brief s12: stalled in editing 72h or more, recovery sequence. */
async function flagStalledEditing(env: Env, report: SweepReport): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 72 * HOUR).toISOString()
    const rows = await env.DB.prepare(
      `SELECT j.id AS job_id, u.email, j.business_name
       FROM jobs j
       JOIN users u ON u.id = j.user_id
       WHERE j.status IN ('preview','editing')
         AND j.updated_at < ?
         AND NOT EXISTS (SELECT 1 FROM events e WHERE e.job_id = j.id AND e.type = 'editing.stalled')
       LIMIT 50`,
    )
      .bind(cutoff)
      .all<{ job_id: string; email: string; business_name: string | null }>()

    for (const row of rows.results ?? []) {
      await recordEvent(env, row.job_id, 'editing.stalled', { email: row.email })
      await notifyGhlSafely(env, {
        event: 'editing_stalled',
        contact: { email: row.email, businessName: row.business_name },
        jobId: row.job_id,
        customValues: { preview_link: previewLink(env, row.job_id) },
      })
      report.stalledEditing++
    }
  } catch (err) {
    report.problems.push(`Stalled editing sweep failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
