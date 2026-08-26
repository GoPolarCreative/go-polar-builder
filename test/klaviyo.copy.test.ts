import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PRICING } from '../shared/pricing'

/**
 * The Klaviyo copy, held to the same rules as the rest of the customer-facing writing.
 *
 * This greps the document Chris pastes from. The copy does not live in TypeScript, so nothing
 * else in this repo would ever notice a performance claim creeping into it, and the nurture
 * sequence is exactly where one would creep in: the last two emails are about search and ads,
 * which is the hardest place to describe a product without promising a result.
 *
 * Same FORBIDDEN list as test/pages.copy.test.ts, deliberately duplicated rather than shared.
 * These are two separate approval surfaces and one should not be able to relax the other.
 */

const DOC = readFileSync(new URL('../KLAVIYO-FLOWS.md', import.meta.url), 'utf8')

/*
 * Only the text that reaches a customer or Chris.
 *
 * Scoped to the flows themselves, NOT to the rules block above them. That block has to name the
 * banned words in order to state the rule ("no DNS, SSL, CDN", "never promise live within 24
 * hours"), so scanning it would fail on the instruction that exists to prevent the failure.
 */
const COPY = DOC.slice(DOC.indexOf('# Flow 1: Website Login Code'))

const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\brank(ing|ed|s)?\b/i, why: 'a ranking claim' },
  { pattern: /page one|first page|top of (google|search)/i, why: 'a position claim' },
  { pattern: /\b(we guarantee|guaranteed|guarantees)\b/i, why: 'a guarantee' },
  { pattern: /more (customers|leads|enquiries|traffic|calls)/i, why: 'a volume claim' },
  {
    pattern: /\b(double|triple|increase|boost|grow)\b.{0,20}\b(leads|traffic|enquiries|sales)/i,
    why: 'a growth claim',
  },
  { pattern: /within (days|weeks|months)|in \d+ (days|weeks|months)/i, why: 'a timeframe' },
  { pattern: /\bSEO\b.{0,30}\b(results|success)/i, why: 'an outcome claim' },
  { pattern: /get you found|be found first|outrank/i, why: 'an outcome claim' },
]

/*
 * THE TAKEDOWN FLOW IS SCANNED SEPARATELY, and the reason is worth stating rather than hiding in
 * a slice.
 *
 * The FORBIDDEN list bans timeframes because "results within 30 days" is a promise about the
 * customer’s business that nobody can keep. The takedown emails also contain "in 30 days", and it
 * means something completely different: a deadline for an action WE are taking, on a date we
 * control, which the customer is entitled to know precisely.
 *
 * Refusing to state that date would be the opposite of honest. So the timeframe rule does not
 * apply there, and instead that section gets its own check below for the thing that WOULD be
 * wrong in it: an outcome claim.
 */
const TAKEDOWN_START = COPY.indexOf('# Flow 5: Website Hosting Ending')
const TAKEDOWN_END = COPY.indexOf('# Flow 6: Website Link Requested')
const TAKEDOWN = COPY.slice(TAKEDOWN_START, TAKEDOWN_END)
const COPY_MINUS_TAKEDOWN = COPY.slice(0, TAKEDOWN_START) + COPY.slice(TAKEDOWN_END)

describe('the nurture sequence makes no performance claim', () => {
  for (const { pattern, why } of FORBIDDEN) {
    it(`contains no ${why}`, () => {
      const hit = COPY_MINUS_TAKEDOWN.match(pattern)
      expect(hit, `found ${why}: "${hit?.[0]}"`).toBeNull()
    })
  }
})

describe('the takedown emails state a deadline, and claim nothing else', () => {
  it('is actually present, so this suite cannot pass by scanning an empty string', () => {
    expect(TAKEDOWN_START).toBeGreaterThan(-1)
    expect(TAKEDOWN.length).toBeGreaterThan(500)
  })

  it('makes no claim about their business, which is the rule that still applies', () => {
    for (const { pattern, why } of FORBIDDEN) {
      // Every rule except the timeframe one, which is the whole point of this section.
      if (why === 'a timeframe') continue
      const hit = TAKEDOWN.match(pattern)
      expect(hit, `found ${why} in the takedown copy: "${hit?.[0]}"`).toBeNull()
    }
  })

  it('names the date every time rather than being vague about it', () => {
    expect(TAKEDOWN).toContain('offline_on')
  })

  it('says nothing is deleted, because that is the thing that would frighten somebody', () => {
    expect(TAKEDOWN.toLowerCase()).toContain('deleted')
  })

  it('tells them how to stop it', () => {
    expect(TAKEDOWN.toLowerCase()).toMatch(/start(ing)? your hosting again/)
  })
})

describe("Chris's voice", () => {
  it('uses no em dashes anywhere, including the reference tables', () => {
    const hit = DOC.match(/—/)
    expect(hit, 'found an em dash').toBeNull()
  })

  it('uses none of the jargon on the banned list', () => {
    const banned = [
      /\bDNS\b/,
      /\bSSL\b/,
      /\bCDN\b/,
      /\buptime\b/i,
      /\bcPanel\b/i,
      /\bpatching\b/i,
      /\bresponsive\b/i,
      /\bnameservers?\b/i,
    ]
    for (const rx of banned) {
      const hit = COPY.match(rx)
      expect(hit, `found banned jargon: "${hit?.[0]}"`).toBeNull()
    }
  })

  it('mentions SEO only as a rule about what not to write, never as customer copy', () => {
    // The word appears once, in the constraints list. If it turns up in an email body it has
    // become jargon aimed at a tradie.
    const inEmails = COPY.slice(COPY.indexOf('# Flow 9: Website Is Live'))
    expect(inEmails).not.toMatch(/\bSEO\b/)
  })
})

describe('the one promise the copy is allowed to make', () => {
  it('promises contact within one business day', () => {
    expect(COPY).toMatch(/within one business day/i)
  })

  it('NEVER promises the site is live or connected within 24 hours', () => {
    // The dangerous shape: any 24 hour / 24hr claim attached to being live or connected.
    const hit = COPY.match(/(live|connected|online)[^.]{0,40}24\s*(hours?|hrs?)/i)
    expect(hit, `found a 24 hour connection promise: "${hit?.[0]}"`).toBeNull()
  })

  it('says plainly that the connection timing is not ours to control', () => {
    expect(COPY).toMatch(/not up to us/i)
  })

  it('explains why a Friday night press does not mean Saturday', () => {
    expect(COPY).toMatch(/Friday/i)
  })
})

describe('value comes before selling, and the gap is real', () => {
  const dayOf = (n: number) => {
    const m = COPY.match(new RegExp(`### Email ${n}\\.[^]*?\\*\\*Timing:\\*\\* ([^\\n]+)`))
    if (!m) return null
    if (/immediately/i.test(m[1]!)) return 0
    const d = m[1]!.match(/(\d+) days?/)
    return d ? Number(d[1]) : null
  }

  it('runs seven emails', () => {
    expect(COPY.match(/### Email \d\./g)).toHaveLength(7)
  })

  it('front-loads the free advice into the first two weeks', () => {
    expect(dayOf(1)).toBe(0)
    expect(dayOf(4)).toBeLessThanOrEqual(15)
  })

  it('LEAVES A REAL GAP before the first thing that costs money', () => {
    const lastValue = dayOf(4)
    const firstSell = dayOf(5)
    expect(lastValue).not.toBeNull()
    expect(firstSell).not.toBeNull()
    // Two clear weeks. One email of pleasantries before the pitch is what this guards against.
    expect(firstSell! - lastValue!).toBeGreaterThanOrEqual(14)
  })

  /*
   * PRICES COME FROM THE REGISTRY, NOT FROM THIS TEST.
   *
   * The first version of this hardcoded $16.50 for the email address, which is not what
   * shared/pricing.ts says. The copy was wrong and the test agreed with it, so the test was
   * pinning the mistake instead of catching it. D31 says one number everywhere, and the registry
   * is the everywhere.
   *
   * If Chris changes a price, this fails and tells him the Klaviyo copy is now stale, which is
   * exactly the failure that matters: Klaviyo templates live outside this repo and nothing else
   * would ever notice.
   */
  /*
   * The DOLLAR FIGURE has to match the registry. The words around it do not: formatPrice renders
   * "$14.95/month inc GST", which is right for a price table and wrong in a sentence a person
   * reads. The copy says "a month" and that is deliberate. The number is what must not drift.
   */
  const dollars = (key: 'email' | 'additionalPage') => {
    const cents = PRICING[key].incGstCents
    if (cents === null) throw new Error(key + ' has no price set in shared/pricing.ts')
    const money = (cents / 100).toFixed(2)
    // $25.00 reads as $25 in a sentence, $14.95 keeps its cents.
    return '$' + (money.endsWith('.00') ? money.slice(0, -3) : money)
  }

  it('quotes the registry price for the email address, not a remembered one', () => {
    const five = COPY.indexOf('### Email 5')
    const six = COPY.indexOf('### Email 6')
    expect(COPY.slice(five, six)).toContain(dollars('email'))
  })

  it('quotes the registry price for an additional page', () => {
    const six = COPY.indexOf('### Email 6')
    const seven = COPY.indexOf('### Email 7')
    expect(COPY.slice(six, seven)).toContain(dollars('additionalPage'))
  })

  it('sells the cheapest thing first', () => {
    const five = COPY.indexOf('### Email 5')
    const six = COPY.indexOf('### Email 6')
    const seven = COPY.indexOf('### Email 7')
    expect(five).toBeGreaterThan(-1)
    expect(six).toBeGreaterThan(five)
    expect(seven).toBeGreaterThan(six)
  })

  it('gives an easy no on every paid email', () => {
    const sell = COPY.slice(COPY.indexOf('### Email 5'))
    expect(sell).toMatch(/that is completely fine|probably is not for you|I will say so/i)
  })
})

describe('the document stays honest about the code', () => {
  it('warns that Website Is Live fires on every publish', () => {
    expect(DOC).toMatch(/fires on every publish/i)
  })

  it('flags that the copy is not approved', () => {
    expect(DOC).toMatch(/not approved/i)
  })
})
