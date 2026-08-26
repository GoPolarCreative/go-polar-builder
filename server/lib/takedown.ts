import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { getDb, schema } from '../db/client.js'
import { config } from '../config.js'
import {
  TAKEDOWN_DAYS,
  daysUntilTakedown,
  takedownDue,
  takedownDueAt,
  warningCopy,
  warningDue,
} from '../../shared/takedown.js'
import { getUserForJob, recordEvent } from './db.js'
import { trackKlaviyoSafely } from './klaviyo.js'

/**
 * The 60 day clock between a cancellation and a website going dark.
 *
 * RUN FROM THE HOURLY SWEEP. Nothing here happens on a request, because the whole point is that
 * it is slow and predictable. An hourly cadence against day boundaries means a customer is warned
 * within an hour of the right moment, which is close enough for something measured in weeks.
 *
 * EVERY DECISION IS DERIVED FROM ONE FIELD: `golive.hostingEndedAt`. There is no separate
 * takedown table, no scheduled job row and no queue. That is deliberate, because it makes
 * resubscribing trivially correct: clearing that field IS cancelling the takedown, and there is
 * no second place where a stale row could keep counting down.
 *
 * TAKEDOWN FLIPS ONE BOOLEAN AND DELETES NOTHING. `sites.live = false` stops
 * `findSiteByHostname` from answering, so the address stops resolving to a page. The stored
 * documents, the versions, the plan and the images are all untouched, and putting the site back
 * is the same one boolean in the other direction.
 *
 * THE ORDER OF OPERATIONS MATTERS. Warnings are sent BEFORE any takedown is considered, and the
 * day-59 warning therefore always lands before the day-60 takedown even if the sweep has been
 * down and catches up in one pass. A site that went dark without its last warning would be the
 * worst version of this feature.
 */

export interface TakedownReport {
  warned: number
  takenDown: number
  restored: number
  problems: string[]
}

/** Which warning stages have already gone out for this job. */
async function warningsSent(jobId: string): Promise<number[]> {
  const db = await getDb()
  const rows = await db
    .select({ payload: schema.events.payload })
    .from(schema.events)
    .where(and(eq(schema.events.jobId, jobId), eq(schema.events.type, 'hosting.warning_sent')))
  return rows
    .map((r) => (r.payload as { stage?: number } | null)?.stage)
    .filter((s): s is number => typeof s === 'number')
}

function auDate(d: Date): string {
  return d.toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Australia/Brisbane',
  })
}

/**
 * Every job whose hosting has been cancelled and which has not yet been taken down.
 *
 * Joined to `sites` because a cancelled job with no live site has nothing to warn about and
 * nothing to take down. Somebody who cancels before ever going live simply stops being relevant.
 */
async function cancelledLiveJobs() {
  const db = await getDb()
  return db
    .select({
      jobId: schema.golive.jobId,
      endedAt: schema.golive.hostingEndedAt,
      hostname: schema.sites.hostname,
      live: schema.sites.live,
      businessName: schema.jobs.businessName,
    })
    .from(schema.golive)
    .innerJoin(schema.sites, eq(schema.sites.jobId, schema.golive.jobId))
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.golive.jobId))
    .where(and(eq(schema.golive.hostingStatus, 'cancelled'), isNotNull(schema.golive.hostingEndedAt)))
    .orderBy(desc(schema.golive.hostingEndedAt))
    .limit(200)
}

export async function runTakedownSweep(now: Date = new Date()): Promise<TakedownReport> {
  const report: TakedownReport = { warned: 0, takenDown: 0, restored: 0, problems: [] }
  const cfg = config()
  const db = await getDb()

  let rows: Awaited<ReturnType<typeof cancelledLiveJobs>>
  try {
    rows = await cancelledLiveJobs()
  } catch (err) {
    report.problems.push(`Could not read cancelled jobs: ${err instanceof Error ? err.message : String(err)}`)
    return report
  }

  for (const row of rows) {
    if (!row.endedAt) continue
    const downOn = auDate(takedownDueAt(row.endedAt))

    try {
      // ---- Warnings first, always. ----------------------------------------------------------
      const sent = await warningsSent(row.jobId)
      const stage = warningDue(row.endedAt, sent, now)

      if (stage !== null) {
        const user = await getUserForJob(row.jobId)
        const copy = warningCopy(stage, row.businessName ?? '', downOn)

        if (user?.email) {
          await trackKlaviyoSafely({
            metric: 'hosting_ending',
            profile: { email: user.email, businessName: row.businessName },
            jobId: row.jobId,
            properties: {
              stage,
              urgency: copy.urgency,
              headline: copy.headline,
              body: copy.body,
              business_name: row.businessName ?? '',
              hostname: row.hostname,
              site_url: `https://${row.hostname}`,
              offline_on: downOn,
              days_left: Math.max(0, daysUntilTakedown(row.endedAt, now)),
            },
          })
        }

        // Recorded whether or not the email went, so a Klaviyo outage cannot cause the same
        // warning to be re-sent every hour once it recovers.
        await recordEvent(row.jobId, 'hosting.warning_sent', { stage, downOn, to: user?.email ?? null })
        report.warned++
      }

      // ---- Then, and only then, the takedown. -----------------------------------------------
      if (row.live && takedownDue(row.endedAt, now)) {
        await db
          .update(schema.sites)
          .set({ live: false, updatedAt: new Date() })
          .where(eq(schema.sites.jobId, row.jobId))

        await recordEvent(row.jobId, 'site.taken_down', {
          hostname: row.hostname,
          cancelledAt: row.endedAt.toISOString(),
          afterDays: TAKEDOWN_DAYS,
          // Stated in the log because somebody reading it in a year will want to know.
          note: 'Nothing was deleted. The build, every version and the images are all still stored.',
          notify: 'chris',
        })

        await trackKlaviyoSafely({
          metric: 'operator_alert',
          profile: { email: cfg.operatorEmail },
          jobId: row.jobId,
          properties: {
            alert: 'site_taken_down',
            business_name: row.businessName ?? 'Unnamed business',
            hostname: row.hostname,
            job_id: row.jobId,
            note: `Offline after ${TAKEDOWN_DAYS} days. Nothing deleted. Restarting their hosting puts it straight back.`,
            ops_link: `${cfg.publicAppUrl.replace(/\/$/, '')}/ops#job-${row.jobId}`,
          },
        })

        report.takenDown++
      }
    } catch (err) {
      report.problems.push(`${row.jobId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return report
}

/**
 * Undo everything, because they started paying again.
 *
 * Called from the subscription handler when a contract goes back to ACTIVE. Clearing
 * `hostingEndedAt` is what cancels the countdown, since every date in this file is derived from
 * it. Putting `sites.live` back is what returns the address to the internet.
 *
 * NO INTERVENTION AND NO APPROVAL. A customer who resubscribes has done the only thing that was
 * being asked of them, and making them wait for a human to notice would be a strange way to
 * thank them for it.
 */
export async function cancelTakedown(jobId: string): Promise<{ restored: boolean }> {
  const db = await getDb()

  await db
    .update(schema.golive)
    .set({ hostingStatus: 'active', hostingEndedAt: null, updatedAt: new Date() })
    .where(eq(schema.golive.jobId, jobId))

  const [site] = await db
    .select({ live: schema.sites.live, hostname: schema.sites.hostname })
    .from(schema.sites)
    .where(eq(schema.sites.jobId, jobId))
    .limit(1)

  if (!site) return { restored: false }

  if (!site.live) {
    await db
      .update(schema.sites)
      .set({ live: true, updatedAt: new Date() })
      .where(eq(schema.sites.jobId, jobId))
    await recordEvent(jobId, 'site.restored', {
      hostname: site.hostname,
      reason: 'hosting resubscribed',
      notify: 'chris',
    })
    return { restored: true }
  }

  await recordEvent(jobId, 'hosting.resubscribed', { hostname: site.hostname })
  return { restored: false }
}
