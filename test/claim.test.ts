import { describe, expect, it } from 'vitest'
import { orderNumberOf } from '../server/lib/orders.js'

/**
 * Claiming a build with the details on the receipt.
 *
 * Getting into the builder used to depend entirely on an email arriving. It did not arrive, for a
 * whole day, because of a DNS record on someone else's domain. A product whose only door is an
 * email stops existing when that happens, so there is now a second door: the email they paid with
 * plus the order number they can read off their confirmation.
 */

describe('the order number a customer can actually read', () => {
  it('prefers order_number, which is the one on the receipt', () => {
    expect(orderNumberOf({ id: 999, order_number: 1234 })).toBe('1234')
  })

  it('falls back to name, and strips the hash', () => {
    expect(orderNumberOf({ id: 999, name: '#1234' })).toBe('1234')
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
