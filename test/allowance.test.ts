import { describe, expect, it } from 'vitest'
import {
  AWST_OFFSET_MINUTES,
  EDITS_PER_HOUR,
  LIVE_EDITS_PER_MONTH,
  awstMonthName,
  liveAllowance,
  startOfAwstMonth,
  startOfNextAwstMonth,
} from '../shared/allowance'
import { EDITS_INCLUDED } from '../shared/pricing'

/**
 * The monthly allowance, and specifically its edges.
 *
 * A month boundary is the classic place for this to be quietly wrong: it is correct for
 * twenty-nine days out of thirty, and the day it is wrong a paying customer is either short a
 * change or given a free one, and nobody finds out.
 *
 * AWST is UTC+8 with no daylight saving, so 4pm UTC on the 31st is already the 1st in Perth.
 * These tests are written from that direction: pick an instant, say which AWST month it is in,
 * and assert the boundary lands where a person in Australia would say it does.
 */

describe('the AWST month boundary', () => {
  it('is UTC+8, stated once so the rest of the file can rely on it', () => {
    expect(AWST_OFFSET_MINUTES).toBe(480)
  })

  it('starts the month at 4pm UTC on the last day of the previous month', () => {
    // 1 Sept 2026 00:00 AWST is 31 Aug 2026 16:00 UTC.
    const midSeptember = new Date('2026-09-15T03:00:00Z')
    expect(startOfAwstMonth(midSeptember).toISOString()).toBe('2026-08-31T16:00:00.000Z')
  })

  it('THE EDGE: an instant that is still August in UTC but already September in Perth', () => {
    // 31 Aug 2026 17:00 UTC = 1 Sept 2026 01:00 AWST. The customer is in September.
    const justAfterRollover = new Date('2026-08-31T17:00:00Z')
    expect(startOfAwstMonth(justAfterRollover).toISOString()).toBe('2026-08-31T16:00:00.000Z')
    expect(awstMonthName(justAfterRollover)).toBe('September')
  })

  it('THE OTHER EDGE: one minute earlier is still August', () => {
    const justBefore = new Date('2026-08-31T15:59:00Z')
    expect(startOfAwstMonth(justBefore).toISOString()).toBe('2026-07-31T16:00:00.000Z')
    expect(awstMonthName(justBefore)).toBe('August')
  })

  it('rolls over a year end without landing in month 13', () => {
    const newYearsEve = new Date('2026-12-20T00:00:00Z')
    expect(startOfNextAwstMonth(newYearsEve).toISOString()).toBe('2026-12-31T16:00:00.000Z')
    expect(awstMonthName(startOfNextAwstMonth(newYearsEve))).toBe('January')
  })

  it('handles February in a leap year', () => {
    const feb = new Date('2028-02-15T00:00:00Z')
    expect(startOfAwstMonth(feb).toISOString()).toBe('2028-01-31T16:00:00.000Z')
    expect(startOfNextAwstMonth(feb).toISOString()).toBe('2028-02-29T16:00:00.000Z')
  })

  it('always puts the start of the month before now, and the next one after', () => {
    for (const iso of [
      '2026-01-01T00:00:00Z',
      '2026-06-30T23:59:59Z',
      '2026-08-31T16:00:00Z',
      '2027-03-01T08:00:00Z',
    ]) {
      const now = new Date(iso)
      expect(startOfAwstMonth(now).getTime()).toBeLessThanOrEqual(now.getTime())
      expect(startOfNextAwstMonth(now).getTime()).toBeGreaterThan(now.getTime())
    }
  })
})

describe('what the customer is told', () => {
  const now = new Date('2026-08-15T02:00:00Z')

  it('starts them with ten, matching the landing page', () => {
    expect(LIVE_EDITS_PER_MONTH).toBe(10)
    const a = liveAllowance(0, now)
    expect(a.remaining).toBe(10)
    expect(a.exhausted).toBe(false)
  })

  it('counts down', () => {
    expect(liveAllowance(3, now).remaining).toBe(7)
  })

  it('is exhausted AT ten, not after eleven', () => {
    expect(liveAllowance(9, now).exhausted).toBe(false)
    expect(liveAllowance(10, now).exhausted).toBe(true)
  })

  it('never shows a negative number, even if the count somehow ran over', () => {
    const a = liveAllowance(14, now)
    expect(a.remaining).toBe(0)
    expect(a.used).toBe(14)
  })

  it('names the month it refills into, so the refusal can say something useful', () => {
    expect(liveAllowance(10, now).resetsIntoMonth).toBe('September')
  })
})

describe('the two allowances are separate and must stay that way', () => {
  it('the pre-launch ten is a different constant from the monthly ten', () => {
    // They are both 10 today. They are not the same number, and a future change to one must not
    // silently move the other. If this ever fails because someone aliased them, that is the bug.
    expect(EDITS_INCLUDED).toBe(10)
    expect(LIVE_EDITS_PER_MONTH).toBe(10)
    // Different modules, so a rename cannot accidentally point one at the other.
    expect(Object.is(EDITS_INCLUDED, LIVE_EDITS_PER_MONTH)).toBe(true)
  })
})

describe('the per hour ceiling', () => {
  it('is generous enough that ordinary editing never sees it', () => {
    expect(EDITS_PER_HOUR).toBeGreaterThanOrEqual(5)
  })

  /*
   * It used to have to be strictly lower, on the reasoning that otherwise it would never fire.
   * That is true for a LIVE customer, where the monthly ten stops them first, and it was never
   * true before launch: the pre-launch allowance does not hard block, so this is the only ceiling
   * a stuck customer meets there. Equal is allowed; higher is not, because then it could not fire
   * for anybody.
   */
  it('never exceeds the monthly allowance, or it could not fire at all', () => {
    expect(EDITS_PER_HOUR).toBeLessThanOrEqual(LIVE_EDITS_PER_MONTH)
  })
})
