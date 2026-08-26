import { describe, expect, it } from 'vitest'
import { enforcePlanInvariants } from '../server/lib/generate'
import { planUserMessage } from '../server/prompts/messages'
import { buildFacts } from '../server/lib/facts'
import { offlinePlan } from '../server/lib/offline'
import { pagesDeliveredCheck } from '../server/lib/buildSet'
import { unallocatedPages } from '../shared/intake'
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
