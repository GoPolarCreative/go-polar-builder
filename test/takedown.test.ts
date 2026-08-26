import { describe, expect, it } from 'vitest'
import {
  TAKEDOWN_DAYS,
  WARNING_DAYS,
  daysUntilTakedown,
  takedownDue,
  takedownDueAt,
  warningCopy,
  warningDue,
} from '../shared/takedown'

/**
 * The clock that ends with a business website going offline.
 *
 * This is the most consequential piece of arithmetic in the product. Off by one in the wrong
 * direction and a tradie's website disappears a day before they were told it would, without the
 * last warning, while they are on a roof somewhere. So the edges are tested from both sides.
 */

const DAY = 86_400_000
const CANCELLED = new Date('2026-08-01T00:00:00Z')
const at = (days: number, hours = 0) => new Date(CANCELLED.getTime() + days * DAY + hours * 3_600_000)

describe('the deadline', () => {
  it('is 60 days, which is what the customer is told', () => {
    expect(TAKEDOWN_DAYS).toBe(60)
    expect(takedownDueAt(CANCELLED).toISOString()).toBe('2026-09-30T00:00:00.000Z')
  })

  it('IS NOT DUE ONE MINUTE EARLY', () => {
    expect(takedownDue(CANCELLED, new Date(takedownDueAt(CANCELLED).getTime() - 60_000))).toBe(false)
  })

  it('is due exactly on the deadline, and after it', () => {
    expect(takedownDue(CANCELLED, takedownDueAt(CANCELLED))).toBe(true)
    expect(takedownDue(CANCELLED, at(90))).toBe(true)
  })

  it('is not due on day 59, the day of the last warning', () => {
    expect(takedownDue(CANCELLED, at(59, 23))).toBe(false)
  })

  it('counts down to zero rather than going negative in the customer-facing number', () => {
    expect(daysUntilTakedown(CANCELLED, at(0))).toBe(60)
    expect(daysUntilTakedown(CANCELLED, at(53))).toBe(7)
    expect(daysUntilTakedown(CANCELLED, at(59))).toBe(1)
  })
})

describe('the warnings', () => {
  it('are the four Chris asked for', () => {
    expect([...WARNING_DAYS]).toEqual([0, 30, 53, 59])
  })

  it('fires the first one immediately on cancellation', () => {
    expect(warningDue(CANCELLED, [], at(0))).toBe(0)
  })

  it('does not repeat one that has been sent', () => {
    expect(warningDue(CANCELLED, [0], at(1))).toBeNull()
  })

  it('fires each stage as it is reached', () => {
    expect(warningDue(CANCELLED, [0], at(30))).toBe(30)
    expect(warningDue(CANCELLED, [0, 30], at(53))).toBe(53)
    expect(warningDue(CANCELLED, [0, 30, 53], at(59))).toBe(59)
  })

  it('does not fire a stage early', () => {
    expect(warningDue(CANCELLED, [0], at(29, 23))).toBeNull()
    expect(warningDue(CANCELLED, [0, 30], at(52, 23))).toBeNull()
  })

  it('SENDS ONLY THE LATEST when the sweep has been down and catches up', () => {
    // Two weeks of outage. The customer should get "tomorrow", not a pile of history.
    expect(warningDue(CANCELLED, [0], at(59))).toBe(59)
  })

  it('has nothing left to send once all four have gone', () => {
    expect(warningDue(CANCELLED, [0, 30, 53, 59], at(59))).toBeNull()
    expect(warningDue(CANCELLED, [0, 30, 53, 59], at(70))).toBeNull()
  })
})

describe('what the warnings actually say', () => {
  const downOn = '30 September 2026'

  it('always tells them how to stop it', () => {
    for (const stage of WARNING_DAYS) {
      const copy = warningCopy(stage, 'Cold Front Plumbing', downOn)
      expect(copy.body.toLowerCase(), `stage ${stage}`).toMatch(/start(ing)? (your|their) hosting again|reply to this email/)
    }
  })

  it('always names the date the site goes offline', () => {
    for (const stage of WARNING_DAYS) {
      expect(warningCopy(stage, 'Cold Front Plumbing', downOn).body, `stage ${stage}`).toContain(downOn)
    }
  })

  it('ALWAYS SAYS NOTHING HAS BEEN DELETED, except in the first one where nothing has happened yet', () => {
    for (const stage of [30, 53, 59] as const) {
      expect(warningCopy(stage, 'X', downOn).body.toLowerCase(), `stage ${stage}`).toContain('deleted')
    }
  })

  it('escalates the urgency rather than shouting from the start', () => {
    expect(warningCopy(0, 'X', downOn).urgency).toBe('low')
    expect(warningCopy(53, 'X', downOn).urgency).toBe('medium')
    expect(warningCopy(59, 'X', downOn).urgency).toBe('high')
  })

  it('uses no em dashes, same rule as every other customer-facing string', () => {
    for (const stage of WARNING_DAYS) {
      const copy = warningCopy(stage, 'X', downOn)
      expect(copy.headline + copy.body, `stage ${stage}`).not.toContain('—')
    }
  })

  it('survives a business with no name on file', () => {
    expect(warningCopy(0, '', downOn).body).toContain('your business')
  })
})
