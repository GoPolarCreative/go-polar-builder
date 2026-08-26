import { and, eq, gte } from 'drizzle-orm'
import { getDb, schema } from '../db/client.js'
import { liveAllowance, startOfAwstMonth, type LiveAllowance } from '../../shared/allowance.js'

/**
 * How much of this month's editing allowance a live customer has spent.
 *
 * COUNTED FROM THE EDITS TABLE, never from a column. See shared/allowance.ts for why: a stored
 * counter needs a monthly reset, and a reset can fail to run, run twice, or run against the wrong
 * timezone, and when it drifts nothing notices. Counting rows cannot disagree with the rows.
 *
 * Only rows with `phase = 'live'` and `counted = true` are included, which keeps this completely
 * separate from the lifetime pre-launch ten on `jobs.editsUsed`. A rollback writes
 * `counted: false`, so putting a bad change back never costs anything, on either allowance.
 */
export async function liveEditsThisMonth(jobId: string, now: Date = new Date()): Promise<number> {
  const db = await getDb()
  const rows = await db
    .select({ id: schema.edits.id })
    .from(schema.edits)
    .where(
      and(
        eq(schema.edits.jobId, jobId),
        eq(schema.edits.phase, 'live'),
        eq(schema.edits.counted, true),
        gte(schema.edits.createdAt, startOfAwstMonth(now)),
      ),
    )
  return rows.length
}

export async function liveAllowanceFor(jobId: string, now: Date = new Date()): Promise<LiveAllowance> {
  return liveAllowance(await liveEditsThisMonth(jobId, now), now)
}

/**
 * Which allowance an edit on this job should come out of.
 *
 * The job being LIVE is what decides it, not the job's status text, because status moves through
 * several values after go-live. A row in `sites` marked live is the fact that matters: the public
 * can see this website, so a change to it is a live change.
 */
export async function editPhaseFor(jobId: string): Promise<'prelaunch' | 'live'> {
  const db = await getDb()
  const [site] = await db
    .select({ live: schema.sites.live })
    .from(schema.sites)
    .where(eq(schema.sites.jobId, jobId))
    .limit(1)
  return site?.live ? 'live' : 'prelaunch'
}

/**
 * How many edits this job has run in the last hour, whatever allowance they came from.
 *
 * Counts every counted row, pre-launch and live alike, because the cost being guarded against is
 * the model call and that costs the same either way. Rollbacks are `counted: false` and are
 * excluded: undoing a change must never be rate limited, since the moment somebody most needs to
 * undo is the moment they have just made several changes quickly.
 */
export async function editsInLastHour(jobId: string, now: Date = new Date()): Promise<number> {
  const db = await getDb()
  const since = new Date(now.getTime() - 60 * 60 * 1000)
  const rows = await db
    .select({ id: schema.edits.id })
    .from(schema.edits)
    .where(
      and(
        eq(schema.edits.jobId, jobId),
        eq(schema.edits.counted, true),
        gte(schema.edits.createdAt, since),
      ),
    )
  return rows.length
}
