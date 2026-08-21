import { describe, expect, it } from 'vitest'
import { orderNumberOf, orderNumberForms } from '../server/lib/orders.js'

/**
 * Claiming a build with the details on the receipt.
 *
 * Getting into the builder used to depend entirely on an email arriving. It did not arrive, for a
 * whole day, because of a DNS record on someone else's domain. A product whose only door is an
 * email stops existing when that happens, so there is now a second door: the email they paid with
 * plus the order number they can read off their confirmation.
 *
 * That second door was itself broken on the first real attempt, in a way worth keeping tests
 * around: this store numbers its orders "#GPC1258", not "#1258".
 */

describe('the order number a customer can actually read', () => {
  it('prefers name over order_number, because the prefix is part of what they see', () => {
    // The bug this exists to prevent: order_number is the bare integer, name carries the store's
    // prefix, and only name matches what is printed on the receipt. Storing 1258 made a real paid
    // order permanently unclaimable, because nobody would ever type 1258.
    expect(orderNumberOf({ id: 999, order_number: 1258, name: '#GPC1258' })).toBe('GPC1258')
  })

  it('falls back to order_number when there is no name', () => {
    expect(orderNumberOf({ id: 999, order_number: 1234 })).toBe('1234')
  })

  it('strips the hash', () => {
    expect(orderNumberOf({ id: 999, name: '#1234' })).toBe('1234')
    expect(orderNumberOf({ id: 999, name: '  #GPC1258  ' })).toBe('GPC1258')
  })

  it('never returns the internal id, which the customer has never seen', () => {
    // id and order_number are different numbers. Matching on id would fail every real claim.
    expect(orderNumberOf({ id: 5544332211, order_number: 1234 })).toBe('1234')
    expect(orderNumberOf({ id: 5544332211 })).toBeNull()
  })

  it('handles the string forms Shopify sends', () => {
    expect(orderNumberOf({ id: 1, order_number: '1234' })).toBe('1234')
    expect(orderNumberOf({ id: 1, order_number: ' 1234 ' })).toBe('1234')
    expect(orderNumberOf({ id: 1, name: '  #1234  ' })).toBe('1234')
  })

  it('returns null rather than an empty string when there is nothing', () => {
    // An empty string would be stored and would then match an empty submission.
    expect(orderNumberOf({ id: 1, order_number: '', name: '' })).toBeNull()
    expect(orderNumberOf({ id: 1, order_number: null, name: null })).toBeNull()
  })
})

describe('what the same order might be typed as', () => {
  it('accepts the prefixed form, with or without the hash, in any case', () => {
    for (const typed of ['GPC1258', '#GPC1258', 'gpc1258', '  #gpc1258  ']) {
      expect(orderNumberForms(typed)).toContain('gpc1258')
    }
  })

  it('also accepts the digits alone, because the prefix reads as decoration', () => {
    expect(orderNumberForms('#GPC1258')).toContain('1258')
  })

  it('leaves a plain number alone rather than duplicating it', () => {
    expect(orderNumberForms('1234')).toEqual(['1234'])
  })

  it('produces nothing to match on when given nothing', () => {
    // An empty list must not become a query that matches every row.
    expect(orderNumberForms('')).toEqual([])
    expect(orderNumberForms('   #  ')).toEqual([])
  })
})
