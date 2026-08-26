import { describe, expect, it } from 'vitest'
import { goLiveCartLines, refForCheckout } from '../server/lib/products'

/**
 * The go-live cart, after the domain question moved in front of the payment.
 *
 * These exist because of the failure that reordering makes possible. The domain answer and the
 * payment are now two separate requests with a page load between them. If the browser's copy of
 * "I need a domain" goes missing in that gap - a reload, a back button, a resumed session on
 * another device - the customer pays for hosting, goes live, and has no web address. Nothing
 * downstream catches it: the build passes and the payment clears. It surfaces as a phone call.
 *
 * So the recorded branch, not the client's flag, is what puts the domain in the cart.
 */

const HOSTING = refForCheckout('hosting')
const DOMAIN = refForCheckout('domain')
const EMAIL = refForCheckout('email')

const refs = (lines: Array<{ ref: string }>) => lines.map((l) => l.ref)

describe('hosting is always the thing being bought', () => {
  it('is on the cart with nothing else selected', () => {
    expect(refs(goLiveCartLines({}))).toEqual([HOSTING])
  })

  it('is on the cart once, not twice, when everything is selected', () => {
    const lines = goLiveCartLines({ domainBranch: 'new', domainAddon: true, emailAddon: true })
    expect(lines.filter((l) => l.ref === HOSTING)).toHaveLength(1)
    expect(lines.every((l) => l.quantity === 1)).toBe(true)
  })
})

describe('a recorded "I need a domain" cannot be lost', () => {
  it('THE REAL CASE: branch is new and the client forgot to say so', () => {
    // Exactly what a reload between the two screens produces.
    const lines = goLiveCartLines({ domainBranch: 'new', domainAddon: false })
    expect(refs(lines)).toContain(DOMAIN)
  })

  it('adds it when the branch is new and nothing at all was sent', () => {
    expect(refs(goLiveCartLines({ domainBranch: 'new' }))).toContain(DOMAIN)
  })

  it('does not double it up when both the record and the client agree', () => {
    const lines = goLiveCartLines({ domainBranch: 'new', domainAddon: true })
    expect(lines.filter((l) => l.ref === DOMAIN)).toHaveLength(1)
  })
})

describe('nobody is charged for a domain they already own', () => {
  it('leaves it off for someone who has their own', () => {
    expect(refs(goLiveCartLines({ domainBranch: 'own', domainAddon: false }))).not.toContain(DOMAIN)
  })

  it('leaves it off for a domain they cannot get into, which we recover rather than buy', () => {
    expect(refs(goLiveCartLines({ domainBranch: 'locked' }))).not.toContain(DOMAIN)
  })

  it('leaves it off when they have not reached the domain screen at all', () => {
    expect(refs(goLiveCartLines({ domainBranch: null }))).not.toContain(DOMAIN)
  })

  /*
   * The client CAN still add one. Someone on the 'own' branch who changes their mind is a real
   * person, and the flag is the only way they can say so. The rule is one-way: the record can add
   * the domain, the client can add the domain, neither can remove it.
   */
  it('still honours the client asking for one on the own branch', () => {
    expect(refs(goLiveCartLines({ domainBranch: 'own', domainAddon: true }))).toContain(DOMAIN)
  })
})

describe('the email address stays optional', () => {
  it('is left off unless asked for', () => {
    expect(refs(goLiveCartLines({ domainBranch: 'new' }))).not.toContain(EMAIL)
  })

  it('is added when asked for', () => {
    expect(refs(goLiveCartLines({ emailAddon: true }))).toEqual([HOSTING, EMAIL])
  })
})
