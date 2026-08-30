import { describe, expect, it } from 'vitest'
import { enforcePlanInvariants } from '../server/lib/generate'
import { planUserMessage } from '../server/prompts/messages'
import { buildFacts } from '../server/lib/facts'
import { offlinePlan } from '../server/lib/offline'
import { pagesDeliveredCheck } from '../server/lib/buildSet'
import { maxServices, unallocatedPages } from '../shared/intake'
import { makeIntake } from './fixtures/site'
import type { ContentPlan } from '../shared/plan'
import { planSchema } from '../shared/plan'

/**
 * The paid-pages path. See DECISIONS.md D55.
 *
 * These exist because a customer could buy three service pages, be charged for three, and receive
 * one, with every check passing. Three things had to be true for that, and each gets a test: the
 * model was never told what was bought, a page the model omitted was silently dropped, and nothing
 * compared the finished set against the entitlement.
 *
 * The base plan comes from the offline fixture because that is a plan already known to satisfy
 * planSchema. Each test then varies only servicePages, which is the thing under test.
 */

function intakeWithPages(services: string[], ownPage: string[]) {
  return { ...makeIntake(), services, primaryService: services[0]!, ownPageServices: ownPage }
}

function basePlan(intake: ReturnType<typeof makeIntake>): ContentPlan {
  const facts = buildFacts(intake, [])
  return planSchema.parse(offlinePlan(intake, facts, [], [])) as ContentPlan
}

describe('the model is told which pages were paid for', () => {
  it('names every paid service and the allowance in the plan message', () => {
    const intake = intakeWithPages(
      ['Blocked drains', 'Hot water', 'Gas fitting'],
      ['Blocked drains', 'Gas fitting'],
    )
    const message = planUserMessage({
      intake,
      facts: buildFacts(intake, []),
      auditFlags: [],
      photoInventory: [],
      usablePhotoCount: 0,
      style: 'modern',
      pagesAllowed: 3,
    })

    expect(message).toContain('# PAGES THEY HAVE PAID FOR')
    expect(message).toContain('- Blocked drains')
    expect(message).toContain('- Gas fitting')
    // Not paid for, so it must not be listed as one.
    expect(message).not.toContain('- Hot water')
    expect(message).toContain('3 page(s) in total')
  })

  it('says so plainly when it is a one page site', () => {
    const intake = intakeWithPages(['Blocked drains', 'Hot water', 'Gas fitting'], [])
    const message = planUserMessage({
      intake,
      facts: buildFacts(intake, []),
      auditFlags: [],
      photoInventory: [],
      usablePhotoCount: 0,
      style: 'modern',
      pagesAllowed: 1,
    })
    expect(message).toContain('Return an empty servicePages array')
  })
})

describe('a paid page is never dropped', () => {
  it('synthesises an entry the model omitted, rather than losing it', () => {
    const intake = intakeWithPages(
      ['Blocked drains', 'Hot water', 'Gas fitting'],
      ['Blocked drains', 'Gas fitting'],
    )
    const facts = buildFacts(intake, [])

    // The exact failure that shipped: a valid plan whose servicePages array is empty.
    const modelPlan: ContentPlan = { ...basePlan(intake), servicePages: [] }

    const out = enforcePlanInvariants(modelPlan, intake, facts, [], { pagesAllowed: 3 })

    expect(out.servicePages.map((p) => p.service)).toEqual(['Blocked drains', 'Gas fitting'])
    // Synthesised entries satisfy the same schema as model output, or they break the renderer.
    expect(() => planSchema.parse(out)).not.toThrow()
    for (const page of out.servicePages) {
      expect(page.included.length).toBeGreaterThanOrEqual(3)
      expect(page.metaDescription.length).toBeGreaterThanOrEqual(70)
      expect(page.intro.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('keeps the model version when the model did write the page', () => {
    const intake = intakeWithPages(['Blocked drains', 'Hot water', 'Gas fitting'], ['Blocked drains'])
    const facts = buildFacts(intake, [])
    const base = basePlan(intake)
    const written = {
      ...base.servicePages[0]!,
      slug: 'blocked-drains',
      service: 'Blocked drains',
      h1: 'Blocked drain clearing',
    }

    const out = enforcePlanInvariants({ ...base, servicePages: [written] }, intake, facts, [], {
      pagesAllowed: 2,
    })
    expect(out.servicePages).toHaveLength(1)
    expect(out.servicePages[0]!.h1).toBe('Blocked drain clearing')
  })

  it('still refuses to build a page nobody paid for', () => {
    const withPage = intakeWithPages(['Blocked drains', 'Hot water', 'Gas fitting'], ['Hot water'])
    const base = basePlan(withPage)
    const modelPage = base.servicePages[0]

    // Same plan, but this customer bought no pages at all.
    const intake = intakeWithPages(['Blocked drains', 'Hot water', 'Gas fitting'], [])
    const facts = buildFacts(intake, [])
    const out = enforcePlanInvariants(
      { ...basePlan(intake), servicePages: modelPage ? [modelPage] : [] },
      intake,
      facts,
      [],
      { pagesAllowed: 1 },
    )
    expect(out.servicePages).toEqual([])
  })
})

describe('check 19: a short build cannot reach a customer', () => {
  it('passes when every paid page is in the set', () => {
    const r = pagesDeliveredCheck(
      ['Blocked drains', 'Gas fitting'],
      ['index.html', 'services/blocked-drains/index.html', 'services/gas-fitting/index.html'],
      3,
    )
    expect(r.status).toBe('pass')
    expect(r.detail).toContain('2 additional page(s) paid for, 2 built')
  })

  it('FAILS when a paid page is missing, and names it', () => {
    const r = pagesDeliveredCheck(
      ['Blocked drains', 'Gas fitting'],
      ['index.html', 'services/blocked-drains/index.html'],
      3,
    )
    expect(r.status).toBe('fail')
    expect(r.evidence).toContain('Gas fitting')
    expect(r.detail).toContain('PAID FOR BUT NOT BUILT: Gas fitting')
    expect(r.detail).toContain('must not be published')
  })

  it('FAILS the exact bug that shipped: paid for pages, built none', () => {
    const r = pagesDeliveredCheck(['Blocked drains', 'Gas fitting', 'Hot water'], ['index.html'], 4)
    expect(r.status).toBe('fail')
    expect(r.evidence).toContain('Blocked drains')
  })

  it('passes for a one page site, where nothing was paid for', () => {
    expect(pagesDeliveredCheck([], ['index.html'], 1).status).toBe('pass')
  })
})

/*
 * THE SECOND FAILURE, AND THE ONE THE TESTS ABOVE WERE BLIND TO.
 *
 * Production job job_03b9657cf7f24757828ab158, 26 August 2026. The customer bought four
 * additional pages, was shown the picker, scrolled past it, and submitted with nothing chosen.
 * pagesAllowed was 5 and ownPageServices was empty, so the plan correctly built one page and
 * check 19 compared the delivered set against an empty list of requirements and PASSED. He was
 * charged for five pages, received one, and every gate reported success.
 *
 * The test suite above did not catch it because every case populates paidPageServices. The one
 * case that passes an empty array also passes an allowance of one, where empty is the right
 * answer. Nothing anywhere asserted on the combination that actually shipped: empty choice, and
 * an allowance greater than one.
 */
describe('pages bought and never allocated', () => {
  it('FAILS an empty choice when the customer paid for extra pages', () => {
    const r = pagesDeliveredCheck([], ['index.html'], 5)
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('PAID FOR BUT NEVER CHOSEN: 4 of 4')
    expect(r.detail).toContain('must not be published')
    expect(r.evidence).toContain('unallocated:4')
  })

  it('FAILS a partial choice, even when every page chosen was built', () => {
    const r = pagesDeliveredCheck(
      ['Blocked drains'],
      ['index.html', 'services/blocked-drains/index.html'],
      5,
    )
    // Nothing is MISSING. The one page they picked exists. Three were still bought and lost.
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('PAID FOR BUT NEVER CHOSEN: 3 of 4')
  })

  it('reports both problems at once rather than only the first', () => {
    const r = pagesDeliveredCheck(['Blocked drains', 'Gas fitting'], ['index.html'], 5)
    expect(r.detail).toContain('PAID FOR BUT NOT BUILT')
    expect(r.detail).toContain('PAID FOR BUT NEVER CHOSEN: 2 of 4')
  })
})

describe('unallocatedPages, the rule the browser and the server share', () => {
  it('counts what is left to choose', () => {
    expect(unallocatedPages(5, [], ['A', 'B', 'C'])).toBe(4)
    expect(unallocatedPages(5, ['A'], ['A', 'B', 'C'])).toBe(3)
    expect(unallocatedPages(3, ['A', 'B'], ['A', 'B', 'C'])).toBe(0)
  })

  it('is zero for a one page site, which is the normal case', () => {
    expect(unallocatedPages(1, [], ['A', 'B', 'C'])).toBe(0)
    expect(unallocatedPages(0, undefined, [])).toBe(0)
  })

  it('gives a page back when the service it was pointed at is deselected', () => {
    // They allocated their extra page to "Gas fitting", then removed gas fitting from the list.
    // The page is theirs and is now unassigned, so it must be counted as owed again rather than
    // stranded against a service that will never be built.
    expect(unallocatedPages(2, ['Gas fitting'], ['Blocked drains', 'Hot water'])).toBe(1)
  })

  it('never returns a negative when more were chosen than are owed', () => {
    expect(unallocatedPages(2, ['A', 'B', 'C'], ['A', 'B', 'C'])).toBe(0)
  })
})

/**
 * The four caps that have to agree, or a customer is sold something the system cannot deliver.
 *
 * A page per service is a product Chris sells, so the ceilings on services, on the allocation, on
 * the plan and on the grant have to describe the same maximum job. They did not: services and
 * ownPageServices allowed ten, the plan allowed eight, and the grant route allowed a TOTAL of ten
 * pages, which is nine service pages because the home page takes one. So the largest job the
 * picker would offer was two pages larger than the largest plan the schema would accept and one
 * larger than the biggest grant that could fund it.
 *
 * Pest-Aside Sydney is the job that found it: ten pest types, a page for each, eleven pages.
 */
describe('the page caps describe one coherent maximum job', () => {
  const TEN = [
    'Cockroach Control',
    'Rodent Control',
    'Spider Control',
    'Ant Control',
    'Wasp Control',
    'Bee Control',
    'Flea Control',
    'Silverfish Control',
    'Mosquito Control',
    'Bed Bug Control',
  ]

  it('a page for every service leaves nothing unallocated', () => {
    // Eleven pages: the home page plus one per service. Nothing left over, nothing short.
    expect(unallocatedPages(11, TEN, TEN)).toBe(0)
  })

  it('ten service pages satisfy the plan schema', () => {
    const plan = basePlan(intakeWithPages(TEN, TEN))
    const withPages: ContentPlan = {
      ...plan,
      services: TEN.map((name) => ({
        name,
        blurb: `${name} across Sydney and the surrounding suburbs.`,
        iconHint: 'shield',
      })),
      servicePages: TEN.map((service) => ({
        slug: service.toLowerCase().replace(/\s+/g, '-'),
        service,
        title: `${service} | Pest-Aside Sydney`,
        metaDescription: `${service} across Sydney and NSW. Safe, effective treatments with long lasting results, and same day service when it is urgent.`,
        h1: `${service} across Sydney`,
        intro: [`We handle ${service.toLowerCase()} for homes and businesses right across Sydney.`],
        included: ['Inspection first.', 'Treatment tailored to the property.', 'Advice on prevention.'],
      })),
    }
    const parsed = planSchema.safeParse(withPages)
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true)
  })

  it('the delivered set matches the entitlement at the old maximum', () => {
    const delivered = ['index.html', ...TEN.map((s) => `services/${s.toLowerCase().replace(/\s+/g, '-')}/index.html`)]
    const check = pagesDeliveredCheck(TEN, delivered, 11)
    expect(check.status, check.detail).toBe('pass')
  })

  /*
   * THE MAXIMUM JOB THE STOREFRONT CAN SELL, END TO END.
   *
   * The stepper goes to twenty additional pages, so twenty-one is the largest job that can be
   * bought, and every cap in the chain has to reach it or the customer pays for pages that
   * nothing downstream will accept. There were five separate caps of ten and they had to move
   * together: the intake ceiling, ownPageServices, the plan's services array, the plan's
   * servicePages array, and the support route's grant ceiling.
   *
   * The failure this pins is not hypothetical arithmetic. With the intake still at ten, a
   * customer who bought twenty pages could allocate at most ten of them, unallocatedPages would
   * never reach zero, and the submit route refuses on exactly that: they would have paid seven
   * hundred and twenty dollars and been unable to submit the intake at all.
   */
  const TWENTY = [
    ...TEN,
    'Termite Inspections',
    'Termite Treatment',
    'Possum Removal',
    'Bird Proofing',
    'Tick Control',
    'Moth Control',
    'Carpet Beetle Control',
    'Borer Treatment',
    'Rodent Proofing',
    'End of Lease Pest Control',
  ]

  it('twenty services is what a twenty-one page job is allowed to name', () => {
    expect(TWENTY).toHaveLength(20)
    expect(maxServices(21)).toBe(TWENTY.length)
  })

  it('a page for every one of twenty services leaves nothing unallocated', () => {
    expect(unallocatedPages(21, TWENTY, TWENTY)).toBe(0)
  })

  it('twenty service pages satisfy the plan schema', () => {
    const plan = basePlan(intakeWithPages(TWENTY, TWENTY))
    const withPages: ContentPlan = {
      ...plan,
      services: TWENTY.map((name) => ({
        name,
        blurb: `${name} across Sydney and the surrounding suburbs.`,
        iconHint: 'shield',
      })),
      servicePages: TWENTY.map((service) => ({
        slug: service.toLowerCase().replace(/\s+/g, '-'),
        service,
        title: `${service} | Pest-Aside`,
        metaDescription: `${service} across Sydney and NSW. Safe, effective treatments with long lasting results, and same day service when it is urgent.`,
        h1: `${service} across Sydney`,
        intro: [`We handle ${service.toLowerCase()} for homes and businesses right across Sydney.`],
        included: ['Inspection first.', 'Treatment tailored to the property.', 'Advice on prevention.'],
      })),
    }
    const parsed = planSchema.safeParse(withPages)
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true)
  })

  it('the delivered set matches the entitlement at twenty-one pages', () => {
    const delivered = [
      'index.html',
      ...TWENTY.map((s) => `services/${s.toLowerCase().replace(/\s+/g, '-')}/index.html`),
    ]
    const check = pagesDeliveredCheck(TWENTY, delivered, 21)
    expect(check.status, check.detail).toBe('pass')
  })

  /*
   * And the guard still bites at the top of the range. One page short of what was paid for is
   * the failure the whole entitlement chain exists to catch, and a bigger maximum must not be a
   * place where it quietly stops working.
   */
  it('nineteen pages built against twenty paid for still fails', () => {
    const short = TWENTY.slice(0, 19)
    const delivered = [
      'index.html',
      ...short.map((s) => `services/${s.toLowerCase().replace(/\s+/g, '-')}/index.html`),
    ]
    const check = pagesDeliveredCheck(short, delivered, 21)
    expect(check.status).toBe('fail')
    expect(check.detail).toContain('never assigned')
  })
})

/**
 * Markup never survives into a plan.
 *
 * The model wrote "<em>" inside h1, which is a plain text field. The renderer escaped it, exactly
 * as it must, and four service pages across Driftwood Building Co and LSV Services shipped showing
 * a reader the angle brackets. Every check passed: the HTML was valid, it just said something
 * silly. The fix is at the schema boundary so it covers every field rather than that one.
 */
describe('plan text is stripped of markup on the way in', () => {
  const withH1 = (h1: string) => {
    const plan = basePlan(intakeWithPages(['A one', 'B two', 'C three'], ['A one']))
    return {
      ...plan,
      servicePages: [
        {
          slug: 'a-one',
          service: 'A one',
          title: 'A one service page for the tests',
          metaDescription:
            'A meta description that comfortably clears the seventy character minimum this schema asks for.',
          h1,
          intro: ['An introduction paragraph that is comfortably past the forty character minimum.'],
          included: ['Inspection first.', 'Treatment tailored to it.', 'Advice on prevention.'],
        },
      ],
    }
  }

  it('strips the exact heading that shipped on Driftwood', () => {
    const r = planSchema.safeParse(withH1('Timber decks built for <em>Bass Coast living</em>'))
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.servicePages[0]!.h1).toBe('Timber decks built for Bass Coast living')
  })

  it('strips markup that has already been escaped into text', () => {
    const r = planSchema.safeParse(withH1('Timber decks built for &lt;em&gt;Bass Coast living&lt;/em&gt;'))
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.servicePages[0]!.h1).toBe('Timber decks built for Bass Coast living')
  })

  it('strips markup everywhere, not just in servicePages', () => {
    const plan = basePlan(intakeWithPages(['A one', 'B two', 'C three'], []))
    const r = planSchema.safeParse({
      ...plan,
      hero: { ...plan.hero, h1: 'Decking done <strong>properly</strong> in Wonthaggi' },
      faq: [{ q: 'Do you do <b>decks</b>?', a: plan.faq[0]!.a }, ...plan.faq.slice(1)],
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.hero.h1).toBe('Decking done properly in Wonthaggi')
      expect(r.data.faq[0]!.q).toBe('Do you do decks?')
    }
  })

  it('leaves a bare less-than alone, because that is prose not markup', () => {
    const plan = basePlan(intakeWithPages(['A one', 'B two', 'C three'], []))
    const r = planSchema.safeParse({
      ...plan,
      trustStrip: [
        { label: 'Callbacks < 2 hours', detail: plan.trustStrip[0]!.detail },
        ...plan.trustStrip.slice(1),
      ],
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.trustStrip[0]!.label).toBe('Callbacks < 2 hours')
  })

  it('rejects rather than ships when stripping takes a field under its minimum', () => {
    // A heading only long enough because of its tags is not long enough.
    expect(planSchema.safeParse(withH1('<em>Decks</em>')).success).toBe(false)
  })

  it('does not damage a hex colour, a slug or a url', () => {
    const plan = basePlan(intakeWithPages(['A one', 'B two', 'C three'], ['A one']))
    const r = planSchema.safeParse(withH1('A heading with no markup in it at all'))
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.tokens.primary).toBe(plan.tokens.primary)
      expect(r.data.servicePages[0]!.slug).toBe('a-one')
    }
  })
})

/**
 * A section that is switched off does not need a heading.
 *
 * gallery.heading and testimonials.heading were both min(3) unconditionally. A business with no
 * photos and no reviews has both sections off, the model returns empty headings for sections that
 * will never render, and the plan failed validation three times in a row. LSV Services died that
 * way: "Content plan did not validate after 3 attempts. gallery.heading: String must contain at
 * least 3 character(s)".
 *
 * No photos and no reviews is not an edge case. It is the ordinary state of a tradie who has not
 * sent us anything, which is most of them.
 */
describe('headings are only required for sections that render', () => {
  const base = () => basePlan(intakeWithPages(['A one', 'B two', 'C three'], []))

  it('accepts an empty gallery heading when the gallery is off', () => {
    const plan = base()
    const r = planSchema.safeParse({ ...plan, gallery: { enabled: false, heading: '', items: [] } })
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3))).toBe(true)
  })

  it('accepts an empty testimonials heading when testimonials are off', () => {
    const plan = base()
    const r = planSchema.safeParse({ ...plan, testimonials: { enabled: false, heading: '', items: [] } })
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3))).toBe(true)
  })

  it('accepts the exact combination that killed the LSV build', () => {
    const plan = base()
    const r = planSchema.safeParse({
      ...plan,
      gallery: { enabled: false, heading: '', items: [] },
      testimonials: { enabled: false, heading: '', items: [] },
    })
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3))).toBe(true)
  })

  it('still demands a heading when the gallery is switched ON', () => {
    const plan = base()
    const r = planSchema.safeParse({ ...plan, gallery: { enabled: true, heading: '', items: [] } })
    expect(r.success).toBe(false)
  })

  it('still demands a heading when testimonials are switched ON', () => {
    const plan = base()
    const r = planSchema.safeParse({
      ...plan,
      testimonials: { enabled: true, heading: '', items: [] },
    })
    expect(r.success).toBe(false)
  })
})
