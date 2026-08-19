import { describe, expect, it } from 'vitest'
import { formatAbn, isValidAbn, normaliseAbn } from '../shared/abn'
import { formatAuPhone, normaliseAuPhone, phoneKind } from '../shared/phone'
import {
  PRICING,
  ProductNotOnStoreError,
  checkoutRef,
  exGstCents,
  formatPrice,
  isPriceSet,
  productConfigProblems,
  sellingPlanEnvKey,
  variantEnvKey,
  variantIdFor,
} from '../shared/pricing'
import { STEP_SCHEMAS, intakeSchema } from '../shared/intake'
import { runGapAudit, statedYearsFromText, isUsablePhoto } from '../server/lib/audit'
import { hoursLines, openingHoursSpec } from '../server/lib/facts'
import { assembleSections, enforcePlanInvariants } from '../server/lib/generate'
import { extractJson, isTruncated, stripCodeFence } from '../server/lib/anthropic'
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
  it('shows the number the customer is actually charged, labelled inc GST', () => {
    expect(formatPrice('build')).toBe('$220 inc GST')
    expect(formatPrice('hosting')).toBe('$33/month inc GST')
    expect(formatPrice('email')).toBe('$14.95/month inc GST')
    expect(formatPrice('discharge')).toBe('$330 inc GST')
    expect(formatPrice('domain')).toBe('$5.50/month inc GST')
  })

  it('refuses to show a price that has not been set', () => {
    expect(PRICING.extraEdits.incGstCents).toBeNull()
    expect(isPriceSet('extraEdits')).toBe(false)
    expect(formatPrice('extraEdits')).toBeNull()
  })

  it('prices the recurring products monthly, as decided', () => {
    for (const key of ['hosting', 'domain'] as const) {
      expect(PRICING[key].recurrence, key).toBe('monthly')
      expect(formatPrice(key)).toMatch(/\/month inc GST$/)
    }
  })

  it('never shows a "+ GST" price, because the store does not charge that way', () => {
    // Advertising "$30 + GST" and then charging $33.00 at the Shopify checkout is the mismatch a
    // tradie reads as a bait and switch. One number, the real one.
    for (const key of Object.keys(PRICING) as Array<keyof typeof PRICING>) {
      const price = formatPrice(key)
      if (price) expect(price, key).not.toMatch(/\+ GST/)
    }
  })

  it('keeps the ex-GST figure for the order records without ever showing it', () => {
    expect(exGstCents('hosting')).toBe(3_000)
    expect(exGstCents('domain')).toBe(500)
    expect(exGstCents('build')).toBe(20_000)
    expect(exGstCents('email')).toBe(1_359)
  })

  it('carries the real identifiers from the store, not the ones in the brief', () => {
    expect(PRICING.hosting.ref).toBe('website-hosting-australia')
    expect(PRICING.domain.ref).toBe('domain-1-year')
    expect(PRICING.email.ref).toBe('email-hosting')
  })
})

describe('the email price, now decided', () => {
  it('is $14.95 inc GST, and can be sold', () => {
    // Decided on shelf price rather than margin: $14.95 inc GST is $13.59 ex. The store already
    // charges exactly this and needed no change. See DECISIONS.md D34.
    expect(PRICING.email.incGstCents).toBe(1_495)
    expect(exGstCents('email')).toBe(1_359)
    expect(formatPrice('email')).toBe('$14.95/month inc GST')
    expect(isPriceSet('email')).toBe(true)
    expect(checkoutRef('email')).toBe('email-hosting')
  })
})

describe('how a product is identified', () => {
  // The three one-off products were created with deliberate SKUs, and Shopify auto-generated their
  // handles from titles nobody here chose ("DIY Website Build"). Guessing a handle from a title is
  // how you produce a checkout link that 404s in front of a paying customer.
  it('uses the SKU for the products whose handles we have never seen', () => {
    for (const key of ['build', 'postLiveEdit', 'discharge'] as const) {
      expect(PRICING[key].refKind, key).toBe('sku')
      expect(PRICING[key].ref, key).toBe(PRICING[key].proposedRef)
    }
    expect(checkoutRef('build')).toBe('build-token')
    expect(checkoutRef('postLiveEdit')).toBe('post-live-edit')
    expect(checkoutRef('discharge')).toBe('discharge')
  })

  it('uses the handle for the three subscriptions, which are known', () => {
    for (const key of ['hosting', 'domain', 'email'] as const) {
      expect(PRICING[key].refKind, key).toBe('handle')
    }
    expect(checkoutRef('hosting')).toBe('website-hosting-australia')
    expect(checkoutRef('domain')).toBe('domain-1-year')
  })

  it('carries the verified variant ids, so a checkout works before any env var is pasted in', () => {
    expect(PRICING.build.variantId).toBe('62852208328863')
    expect(PRICING.postLiveEdit.variantId).toBe('62852208361631')
    expect(PRICING.discharge.variantId).toBe('62852208394399')
    expect(variantIdFor('build-token', {})).toBe('62852208328863')
  })

  it('still lets the environment override a recorded id', () => {
    expect(variantIdFor('build-token', { SHOPIFY_VARIANT_BUILD_TOKEN: '999' })).toBe('999')
  })

  it('knows nothing about the ids for products that do not exist', () => {
    expect(variantIdFor('extra-edits', {})).toBeNull()
  })
})

describe('products that do not exist on the store', () => {
  // Only one left. The other three were created on 2026-08-19.
  const NOT_CREATED = ['extraEdits'] as const

  it('have no identifier at all, so nothing can quietly use one', () => {
    for (const key of NOT_CREATED) {
      expect(PRICING[key].ref, key).toBeNull()
      expect(PRICING[key].store.exists, key).toBe(false)
    }
  })

  it('throw by name when something tries to buy them', () => {
    for (const key of NOT_CREATED) {
      expect(() => checkoutRef(key), key).toThrow(ProductNotOnStoreError)
    }
  })

  it('do not quote a price for the one that has no price', () => {
    try {
      checkoutRef('extraEdits')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as Error).message).toMatch(/does not exist on the Shopify store/)
      expect((err as Error).message).toContain('extra-edits')
      expect((err as Error).message).not.toMatch(/\$\d/)
    }
  })
})

describe('the three products created in draft', () => {
  const DRAFTED = ['build', 'postLiveEdit', 'discharge'] as const

  it('are on the store, priced, and flagged as drafts', () => {
    for (const key of DRAFTED) {
      expect(PRICING[key].store.exists, key).toBe(true)
      expect(PRICING[key].store.draft, key).toBe(true)
      expect(PRICING[key].incGstCents, key).toBeGreaterThan(0)
    }
  })

  it('are reported as blocking, because a draft cannot be bought by anybody', () => {
    const problems = productConfigProblems({})
    for (const key of DRAFTED) {
      const draft = problems.find((p) => p.key === key && /still a draft/.test(p.missing))
      expect(draft, key).toBeDefined()
      expect(draft!.needsShopify).toBe(true)
    }
  })

  it('are still sellable as far as this file is concerned, because the store decides that', () => {
    // checkoutRef deliberately does not check the draft flag: the live store check does, so
    // publishing a product takes effect immediately with no code change.
    for (const key of DRAFTED) expect(() => checkoutRef(key), key).not.toThrow()
  })
})

describe('the startup configuration report', () => {
  it('names what is missing, product by product', () => {
    const problems = productConfigProblems({})
    const missing = problems.map((p) => p.missing)

    // The one product that still does not exist.
    expect(missing.some((m) => m.includes('extra-edits'))).toBe(true)
    // The three that exist but are still drafts, which nobody can buy.
    for (const title of ['DIY Website Build', 'Website Update', 'Website Discharge']) {
      expect(missing.some((m) => m.includes(title)), title).toBe(true)
    }
    // And a selling plan id for each subscription, because Shopify refuses the line without one.
    expect(missing).toContain('SHOPIFY_VARIANT_WEBSITE_HOSTING_AUSTRALIA')
    expect(missing).toContain('SHOPIFY_SELLING_PLAN_WEBSITE_HOSTING_AUSTRALIA')
    expect(missing).toContain('SHOPIFY_SELLING_PLAN_DOMAIN_1_YEAR')
    expect(missing).toContain('SHOPIFY_SELLING_PLAN_EMAIL_HOSTING')
  })

  it('does not ask for variant ids it already knows from the store', () => {
    // The three created products carry verified variant ids, so they are not reported as missing
    // even with an empty environment.
    const missing = productConfigProblems({}).map((p) => p.missing)
    expect(missing).not.toContain('SHOPIFY_VARIANT_BUILD_TOKEN')
    expect(missing).not.toContain('SHOPIFY_VARIANT_POST_LIVE_EDIT')
    expect(missing).not.toContain('SHOPIFY_VARIANT_DISCHARGE')
  })

  it('says what each gap costs, rather than just that it is missing', () => {
    for (const problem of productConfigProblems({})) {
      expect(problem.breaks.length, problem.missing).toBeGreaterThan(20)
    }
  })

  it('demands a selling plan id for every product the store will not sell without one', () => {
    const env: Record<string, string> = {}
    for (const product of Object.values(PRICING)) {
      if (product.ref) env[variantEnvKey(product.ref)] = '12345'
    }
    // Variant ids alone are not enough. requiresSellingPlan means Shopify rejects the line.
    const missing = productConfigProblems(env).map((p) => p.missing)
    expect(missing).toContain('SHOPIFY_SELLING_PLAN_WEBSITE_HOSTING_AUSTRALIA')
    expect(missing).toContain('SHOPIFY_SELLING_PLAN_DOMAIN_1_YEAR')
    expect(missing).toContain('SHOPIFY_SELLING_PLAN_EMAIL_HOSTING')

    const plan = productConfigProblems(env).find((p) => p.missing.startsWith('SHOPIFY_SELLING_PLAN'))!
    expect(plan.breaks).toMatch(/rejected outright/i)
  })

  it('reduces to what only Chris can answer once every id is supplied', () => {
    const env: Record<string, string> = {}
    for (const product of Object.values(PRICING)) {
      if (!product.ref) continue
      env[variantEnvKey(product.ref)] = '12345'
      if (product.requiresSellingPlan) env[sellingPlanEnvKey(product.ref)] = '67890'
    }

    const problems = productConfigProblems(env)

    // Everything left is Chris's to do, not ours: publish three drafts, and price extra-edits.
    expect(problems.every((p) => p.needsShopify || p.needsDecision)).toBe(true)
    expect(problems.filter((p) => p.needsDecision).map((p) => p.key)).toEqual(['extraEdits'])
    expect(problems.filter((p) => /still a draft/.test(p.missing))).toHaveLength(3)
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

  it('will not let the wizard past step 5 without a design style picked', () => {
    const { designStyle, ...withoutStyle } = makeIntake()
    void designStyle
    const result = STEP_SCHEMAS[4]!.safeParse(withoutStyle)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'designStyle')).toBe(true)
    }
  })

  it('still parses a stored payload written before design styles existed', () => {
    // Records created before this feature must keep loading, so the payload schema defaults where
    // the wizard demands. A default here would be wrong; a hard failure there would be worse.
    const { designStyle, ...withoutStyle } = makeIntake()
    void designStyle
    const result = intakeSchema.safeParse(withoutStyle)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.designStyle).toBe('auto')
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
