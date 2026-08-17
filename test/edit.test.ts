import { describe, expect, it } from 'vitest'
import { diffPlans, summariseDiff } from '../server/lib/edit'
import { makeFixture } from './fixtures/site'

const { plan } = makeFixture()

describe('plan diffing', () => {
  it('reports nothing when nothing changed', () => {
    expect(diffPlans(plan, structuredClone(plan))).toEqual([])
    expect(summariseDiff([])).toBe('No change to the content plan')
  })

  it('names the field that changed and shows both values', () => {
    const after = structuredClone(plan)
    after.hero.h1 = 'Emergency plumbers in Chermside'
    const changes = diffPlans(plan, after)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toContain('hero.h1')
    expect(changes[0]).toContain('Emergency plumbers in Chermside')
  })

  it('reports a colour token change', () => {
    const after = structuredClone(plan)
    after.tokens.primary = '#101820'
    const changes = diffPlans(plan, after)
    expect(changes.join(' ')).toContain('tokens.primary')
  })

  it('reports an array changing length', () => {
    const after = structuredClone(plan)
    after.services = after.services.slice(0, 3)
    const changes = diffPlans(plan, after)
    expect(changes.join(' ')).toMatch(/services: \d+ items became 3/)
  })

  it('reports a section being switched off', () => {
    const after = structuredClone(plan)
    after.gallery.enabled = false
    expect(diffPlans(plan, after).join(' ')).toContain('gallery.enabled')
  })

  it('picks up several changes from one request, because one request is one edit', () => {
    const after = structuredClone(plan)
    after.hero.h1 = 'Blocked drains sorted today'
    after.tokens.accent = '#c1440e'
    after.contact.heading = 'Get in touch with us'
    expect(diffPlans(plan, after)).toHaveLength(3)
  })

  it('summarises long change lists without dumping all of them', () => {
    const summary = summariseDiff(['a: 1 became 2', 'b: 1 became 2', 'c: 1 became 2', 'd: 1 became 2', 'e: 1 became 2', 'f: 1 became 2'])
    expect(summary).toContain('and 2 more')
  })
})
