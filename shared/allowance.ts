/**
 * The monthly editing allowance for a live website.
 *
 * TWO ALLOWANCES EXIST AND THEY ARE NOT THE SAME THING. Conflating them would be the easiest
 * mistake here and the most expensive:
 *
 *   PRE-LAUNCH   `jobs.editsUsed` / `jobs.editsAllowed`. Ten rounds, LIFETIME, spent while the
 *                site is being built and before a cent of hosting is charged. Running out
 *                escalates to buying more (D5). It never resets.
 *
 *   LIVE         Ten per CALENDAR MONTH, included in the $42.90 hosting tier. This file. It
 *                resets on the first of the month and has nothing to do with the ten above.
 *
 * A customer who spent all ten pre-launch rounds and then went live has a full monthly allowance
 * on day one. That is the promise the landing page makes: "Ten changes a month included."
 *
 * IT IS COUNTED, NOT STORED. There is no `liveEditsUsed` column and no job that resets one on the
 * first of the month. The count is a query over the edits already in the table, filtered to
 * `phase = 'live'` and the current month. A stored counter needs a reset that can fail to run,
 * can run twice, or can run in the wrong timezone, and when it drifts nothing notices. A count
 * cannot drift from the rows it is counting.
 *
 * AWST BECAUSE THAT IS THE STORE'S TIMEZONE. `shared/pricing.ts` says AWST and Chris is in
 * Queensland. The whole point of a fixed offset is that the boundary is the same date for
 * everyone: a customer in Perth and one in Brisbane get their reset at the same instant, and
 * nobody gets eleven changes because a server rolled over in UTC first.
 */

/** Australian Western Standard Time. UTC+8, and it has never observed daylight saving. */
export const AWST_OFFSET_MINUTES = 8 * 60

/** Ten changes a month on the hosting tier. Matches the landing page and D54. */
export const LIVE_EDITS_PER_MONTH = 10

/**
 * The instant the current AWST month began, as a UTC Date.
 *
 * Worked out by shifting into AWST, truncating to the first of that month, and shifting back.
 * Done with UTC getters throughout so the machine's own timezone cannot change the answer, which
 * matters because this runs on a server in Sydney and a laptop in Queensland.
 */
export function startOfAwstMonth(now: Date = new Date()): Date {
  const shifted = new Date(now.getTime() + AWST_OFFSET_MINUTES * 60_000)
  const firstOfMonthInAwst = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1, 0, 0, 0, 0)
  return new Date(firstOfMonthInAwst - AWST_OFFSET_MINUTES * 60_000)
}

/** The instant the next AWST month begins. What a customer is told they are waiting for. */
export function startOfNextAwstMonth(now: Date = new Date()): Date {
  const shifted = new Date(now.getTime() + AWST_OFFSET_MINUTES * 60_000)
  const firstOfNext = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1, 0, 0, 0, 0)
  return new Date(firstOfNext - AWST_OFFSET_MINUTES * 60_000)
}

/** "August" / "September". Used in the sentence that tells them when they get more. */
export function awstMonthName(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + AWST_OFFSET_MINUTES * 60_000)
  return [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ][shifted.getUTCMonth()]!
}

export interface LiveAllowance {
  used: number
  allowed: number
  remaining: number
  /** True when the next edit would be over the line. */
  exhausted: boolean
  /** ISO instant the allowance refills. */
  resetsAt: string
  /** The month it refills into, for a sentence a person reads. */
  resetsIntoMonth: string
}

export function liveAllowance(usedThisMonth: number, now: Date = new Date()): LiveAllowance {
  const allowed = LIVE_EDITS_PER_MONTH
  const used = Math.max(0, usedThisMonth)
  return {
    used,
    allowed,
    // Never negative in the customer's view, even though the count keeps counting honestly.
    remaining: Math.max(0, allowed - used),
    exhausted: used >= allowed,
    resetsAt: startOfNextAwstMonth(now).toISOString(),
    resetsIntoMonth: awstMonthName(startOfNextAwstMonth(now)),
  }
}

/**
 * The per hour ceiling, on top of the monthly one. Generous by design: it is a guard against a
 * stuck customer looping, not a throttle on somebody working through a list of changes.
 *
 * TEN, WHICH IS THE SAME AS THE MONTHLY LIVE ALLOWANCE, AND THAT IS DELIBERATE. It was six, and
 * six is a number somebody working through a real list of changes can reach in an afternoon; the
 * first person to hit it was Chris, testing.
 *
 * At ten it no longer bites first for a LIVE customer, because the monthly ten stops them before
 * the hour does. It still does its job where the looping actually happens: before launch, where
 * the pre-launch allowance deliberately does not hard block, this is the only thing standing
 * between a stuck customer and an unbounded run of paid model calls.
 */
export const EDITS_PER_HOUR = 10
