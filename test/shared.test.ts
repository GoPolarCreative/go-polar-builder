import { describe, expect, it } from 'vitest'
import { formatAbn, isValidAbn, normaliseAbn } from '../shared/abn'
import { formatAuPhone, normaliseAuPhone, phoneKind } from '../shared/phone'
import { PRICING, formatPrice, isPriceSet } from '../shared/pricing'
import { intakeSchema } from '../shared/intake'
import { runGapAudit, statedYearsFromText, isUsablePhoto } from '../worker/lib/audit'
import { hoursLines, openingHoursSpec } from '../worker/lib/facts'
import { assembleSections, enforcePlanInvariants } from '../worker/lib/generate'
import { extractJson, isTruncated, stripCodeFence } from '../worker/lib/anthropic'
import { makeAssets, makeFixture, makeIntake } from './fixtures/site'

describe('ABN', () => {
  it('accepts a valid ABN', () => {
    expect(isValidAbn('51 824 753 556')).toBe(true)
    expect(isValidAbn('51824753556')).toBe(true)
  })

  it('rejects a transposed pair, which is the whole point of the checksum', () => {
    expect(isValidAbn('51824753565')).toBe(false)
  })

  it('rejects the wrong number of digits', () => {
    expect(isValidAbn('5182475355')).toBe(false)
    expect(isValidAbn('518247535566')).toBe(false)
    expect(isValidAbn('')).toBe(false)
  })

  it('normalises and formats', () => {
    expect(normaliseAbn('51-824-753 556')).toBe('51824753556')
    expect(formatAbn('51824753556')).toBe('51 824 753 556')
  })
})

describe('AU phone numbers', () => {
  it('normalises every common way of writing a mobile', () => {
    for (const input of ['0412 345 678', '0412345678', '+61412345678', '+61 412 345 678', '61412345678']) {
      expect(normaliseAuPhone(input), input).toBe('+61412345678')
    }
  })

  it('handles landlines', () => {
    expect(normaliseAuPhone('(07) 3123 4567')).toBe('+61731234567')
    expect(normaliseAuPhone('07 3123 4567')).toBe('+61731234567')
  })

  // 13/1300/1800 carry no trunk zero, so E.164 keeps every digit after the country code.
  // Treating them like an 04 number and stripping a digit produces a number that does not connect.
  it('handles 1300, 1800 and 13 numbers without eating a digit', () => {
    expect(normaliseAuPhone('1300 123 456')).toBe('+611300123456')
    expect(normaliseAuPhone('1800 123 456')).toBe('+611800123456')
    expect(normaliseAuPhone('13 12 34')).toBe('+61131234')
    expect(formatAuPhone('+611300123456')).toBe('1300 123 456')
    expect(formatAuPhone('+61131234')).toBe('13 12 34')
  })

  it('rejects an 8 digit number with no area code rather than guessing a state', () => {
    expect(normaliseAuPhone('31234567')).toBeNull()
  })

  it('rejects rubbish', () => {
    expect(normaliseAuPhone('not a phone')).toBeNull()
    expect(normaliseAuPhone('0512345678')).toBeNull()
  })

  it('formats for display the way an Australian expects', () => {
    expect(formatAuPhone('+61412345678')).toBe('0412 345 678')
    expect(formatAuPhone('+61731234567')).toBe('(07) 3123 4567')
  })

  it('knows a mobile from a landline', () => {
    expect(phoneKind('0412345678')).toBe('mobile')
    expect(phoneKind('0731234567')).toBe('landline')
    expect(phoneKind('nope')).toBe('invalid')
  })
})

describe('pricing', () => {
  it('carries the GST label on every displayed price, because it must', () => {
    expect(formatPrice('build')).toBe('$200 + GST')
    expect(formatPrice('hosting')).toBe('$30/month + GST')
    expect(formatPrice('email')).toBe('$14.95/month + GST')
    expect(formatPrice('discharge')).toBe('$300 + GST')
    expect(formatPrice('domain', { approx: true })).toBe('around $5/month + GST')
  })

  it('refuses to show a price that has not been set', () => {
    expect(PRICING.extraEdits.exGstCents).toBeNull()
    expect(isPriceSet('extraEdits')).toBe(false)
    expect(formatPrice('extraEdits')).toBeNull()
  })
})

describe('intake validation', () => {
  it('accepts the fixture business', () => {
    expect(intakeSchema.safeParse(makeIntake()).success).toBe(true)
  })

  it('rejects a business name typed into years in business', () => {
    const result = intakeSchema.safeParse(makeIntake({ yearsInBusiness: 'Cold Front Plumbing' as never }))
    expect(result.success).toBe(false)
  })

  it('rejects fewer than three services and more than eight', () => {
    expect(intakeSchema.safeParse(makeIntake({ services: ['One', 'Two'], primaryService: 'One' })).success).toBe(false)
    expect(
      intakeSchema.safeParse(
        makeIntake({
          services: ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7', 'h8', 'i9'],
          primaryService: 'a1',
        }),
      ).success,
    ).toBe(false)
  })

  it('rejects a primary service that is not one of the selected services', () => {
    const result = intakeSchema.safeParse(makeIntake({ primaryService: 'Something else entirely' }))
    expect(result.success).toBe(false)
  })

  it('rejects fewer than three service-area suburbs', () => {
    const intake = makeIntake()
    const result = intakeSchema.safeParse({ ...intake, suburbsServiced: intake.suburbsServiced.slice(0, 2) })
    expect(result.success).toBe(false)
  })

  it('rejects a too-short business description', () => {
    expect(intakeSchema.safeParse(makeIntake({ about: 'We do plumbing.' })).success).toBe(false)
  })
})

describe('gap audit', () => {
  it('says nothing when everything is complete', () => {
    const flags = runGapAudit(makeIntake(), makeAssets())
    expect(flags.filter((f) => f.severity === 'attention')).toEqual([])
  })

  it('flags defaulted hours', () => {
    const intake = makeIntake()
    const flags = runGapAudit({ ...intake, hours: { ...intake.hours, isDefault: true } }, makeAssets())
    expect(flags.map((f) => f.code)).toContain('hours_defaulted')
  })

  it('flags too few usable photos and says the gallery will be skipped', () => {
    const flags = runGapAudit(makeIntake(), makeAssets().slice(0, 2))
    const flag = flags.find((f) => f.code === 'photos_insufficient')
    expect(flag).toBeDefined()
    expect(flag?.buildEffect).toContain('gallery section skipped')
  })

  it('flags a logo that looks like a mockup render', () => {
    const assets = makeAssets()
    assets[0] = {
      ...assets[0]!,
      stats: {
        ...assets[0]!.stats!,
        flatRatio: 0.18,
        distinctColours: 240,
        hasTransparency: false,
        photographicScore: 0.81,
      },
    }
    const flags = runGapAudit(makeIntake(), assets)
    expect(flags.map((f) => f.code)).toContain('logo_mockup_render')
    expect(flags.find((f) => f.code === 'logo_mockup_render')?.buildEffect).toContain('css-logotype')
  })

  it('flags a wide horizontal lockup', () => {
    const assets = makeAssets()
    assets[0] = { ...assets[0]!, width: 2000, height: 400, stats: { ...assets[0]!.stats!, aspect: 5 } }
    const flags = runGapAudit(makeIntake(), assets)
    expect(flags.map((f) => f.code)).toContain('logo_wide_lockup')
  })

  it('flags no reviews and promises not to invent any', () => {
    const flags = runGapAudit(makeIntake({ reviews: [] }), makeAssets())
    const flag = flags.find((f) => f.code === 'no_reviews')
    expect(flag?.buildEffect).toContain('omitted')
  })

  it('never blocks: every flag is a message plus a build effect', () => {
    const flags = runGapAudit(makeIntake({ reviews: [], logoAssetId: null }), [])
    expect(flags.length).toBeGreaterThan(0)
    for (const f of flags) {
      expect(f.message.length).toBeGreaterThan(10)
      expect(f.buildEffect.length).toBeGreaterThan(5)
    }
  })

  it('spots a years figure that contradicts the story', () => {
    const flags = runGapAudit(
      makeIntake({ yearsInBusiness: 3, about: 'We have been serving the northside for over 25 years and counting, family owned.' }),
      makeAssets(),
    )
    expect(flags.map((f) => f.code)).toContain('years_contradicts_story')
  })

  it('reads a stated tenure out of free text several ways', () => {
    expect(statedYearsFromText('operating since 2004', 2026)).toBe(22)
    expect(statedYearsFromText('over 20 years in the trade', 2026)).toBe(20)
    expect(statedYearsFromText('two decades of experience', 2026)).toBe(20)
    expect(statedYearsFromText('we do great work', 2026)).toBeNull()
  })

  it('treats a small image as unusable for the gallery', () => {
    const [logo, photo] = makeAssets()
    expect(isUsablePhoto(logo!)).toBe(false)
    expect(isUsablePhoto(photo!)).toBe(true)
    expect(isUsablePhoto({ ...photo!, width: 320, height: 240 })).toBe(false)
  })
})

describe('hours', () => {
  it('groups identical consecutive days into one line', () => {
    const lines = hoursLines(makeIntake())
    expect(lines[0]).toBe('Monday to Friday: 6:30am to 5pm')
    expect(lines).toContain('Saturday: 7am to 12pm')
    expect(lines).toContain('Sunday: Closed')
  })

  it('says by appointment instead of inventing a window', () => {
    const intake = makeIntake()
    const byAppt = { ...intake, hours: { ...intake.hours, byAppointment: true } }
    expect(hoursLines(byAppt)).toEqual(['By appointment'])
    expect(openingHoursSpec(byAppt)).toEqual([])
  })

  it('produces schema.org opening hours grouped by identical times', () => {
    const spec = openingHoursSpec(makeIntake())
    expect(spec).toContainEqual({
      days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
      opens: '06:30',
      closes: '17:00',
    })
    expect(spec.some((s) => s.days.includes('Sunday'))).toBe(false)
  })
})

describe('server-authoritative plan overrides', () => {
  const { plan, facts, assets } = makeFixture()
  const usablePhotos = assets.filter(isUsablePhoto)

  it('deletes fabricated testimonials when no reviews were supplied', () => {
    const intake = makeIntake({ reviews: [] })
    const fabricated = {
      ...plan,
      testimonials: {
        enabled: true,
        heading: 'What our customers say',
        items: [{ quote: 'Absolutely brilliant, best plumber in Brisbane', name: 'Sarah', suburb: 'Nundah' }],
      },
    }
    const out = enforcePlanInvariants(fabricated, intake, facts, usablePhotos)
    expect(out.testimonials.enabled).toBe(false)
    expect(out.testimonials.items).toEqual([])
  })

  it('uses the supplied reviews verbatim and refuses any others', () => {
    const intake = makeIntake()
    const tampered = {
      ...plan,
      testimonials: {
        enabled: true,
        heading: 'Reviews',
        items: [
          { quote: 'A punchier version of what Marion said', name: 'Marion', suburb: 'Aspley' },
          { quote: 'An entirely invented second review', name: 'Greg', suburb: 'Chermside' },
        ],
      },
    }
    const out = enforcePlanInvariants(tampered, intake, facts, usablePhotos)
    expect(out.testimonials.items).toHaveLength(1)
    expect(out.testimonials.items[0]!.quote).toBe(intake.reviews[0]!.quote)
  })

  it('switches the gallery off below three usable photos and asks for more', () => {
    const intake = makeIntake()
    const out = enforcePlanInvariants(plan, intake, facts, usablePhotos.slice(0, 2))
    expect(out.gallery.enabled).toBe(false)
    expect(out.gallery.items).toEqual([])
    expect(out.clientToSupply.join(' ')).toMatch(/photo/i)
  })

  it('drops stats that do not correspond to a number in the intake', () => {
    const intake = makeIntake()
    const inflated = {
      ...plan,
      stats: [
        { value: 5000, suffix: '+', label: 'Happy customers', source: 'invented' },
        { value: 99, suffix: '%', label: 'Satisfaction', source: 'invented' },
        { value: 24, suffix: '/7', label: 'Always open', source: 'invented' },
      ],
    }
    const out = enforcePlanInvariants(inflated, intake, facts, usablePhotos)
    expect(out.stats.map((s) => s.value)).not.toContain(5000)
    for (const stat of out.stats) {
      expect([intake.yearsInBusiness, intake.suburbsServiced.length, intake.services.length, intake.reviews.length]).toContain(
        stat.value,
      )
    }
  })

  it('replaces the suburb list with exactly what the customer picked', () => {
    const intake = makeIntake()
    const padded = { ...plan, serviceAreas: { ...plan.serviceAreas, suburbs: ['Chermside', 'Sydney', 'Perth'] } }
    const out = enforcePlanInvariants(padded, intake, facts, usablePhotos)
    expect(out.serviceAreas.suburbs).toEqual(intake.suburbsServiced.map((s) => s.name))
  })

  it('uses a GeoCircle for a statewide business and City objects otherwise', () => {
    const metro = enforcePlanInvariants(plan, makeIntake(), facts, usablePhotos)
    expect(metro.schema.areaServed.mode).toBe('city')

    const statewide = enforcePlanInvariants(plan, makeIntake({ travelRadius: 'statewide' }), facts, usablePhotos)
    expect(statewide.schema.areaServed.mode).toBe('geocircle')
  })

  it('scrubs "free quote" from the plan when the business does not offer them', () => {
    const intake = makeIntake({ freeQuotes: false })
    const slipped = { ...plan, hero: { ...plan.hero, ctaSecondary: { label: 'Get a free quote', href: '#contact' } } }
    const out = enforcePlanInvariants(slipped, intake, facts, usablePhotos)
    expect(JSON.stringify(out).toLowerCase()).not.toContain('free quote')
  })
})

describe('sectioned build assembly', () => {
  it('closes the document even when the last part forgot to', () => {
    const html = assembleSections(['<!DOCTYPE html><html lang="en-AU"><head></head><body>', '<main>hi</main>'])
    expect(html).toContain('</body>')
    expect(html).toContain('</html>')
  })

  it('does not double up closing tags', () => {
    const html = assembleSections(['<html><body>', '<footer>x</footer>', '</body></html>'])
    expect(html.match(/<\/body>/g)).toHaveLength(1)
    expect(html.match(/<\/html>/g)).toHaveLength(1)
  })
})

describe('model output handling', () => {
  it('detects truncation from the stop reason and from a missing close tag', () => {
    expect(isTruncated('<html>...</html>', 'end_turn')).toBe(false)
    expect(isTruncated('<html>...</html>', 'max_tokens')).toBe(true)
    expect(isTruncated('<html><body><section>half a', 'end_turn')).toBe(true)
  })

  it('strips a code fence, including an unclosed one from truncated output', () => {
    expect(stripCodeFence('```html\n<p>hi</p>\n```')).toBe('<p>hi</p>')
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(stripCodeFence('```html\n<p>cut off')).toBe('<p>cut off')
    expect(stripCodeFence('<p>no fence</p>')).toBe('<p>no fence</p>')
  })

  it('extracts a JSON object even with commentary around it', () => {
    expect(JSON.parse(extractJson('Here you go:\n{"a":{"b":2}}\nHope that helps'))).toEqual({ a: { b: 2 } })
  })

  it('does not stop at a brace inside a string', () => {
    expect(JSON.parse(extractJson('{"a":"a } brace","b":1}'))).toEqual({ a: 'a } brace', b: 1 })
  })
})
