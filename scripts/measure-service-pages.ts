/**
 * How much of a service page is about its own service.
 *
 * The number that started this: two service pages off a real Driftwood build were 480 words of
 * visible text, 350 of them identical to each other and 130 about the actual service. This
 * renders the same two-service fixture with and without the per-page steps, scope factors and
 * FAQ, and prints the same comparison, so the claim is measured rather than asserted.
 *
 * THE CONTENT VARIES BY SERVICE, and it has to. A first version of this script reused one body
 * across both pages and duly reported almost no improvement, because content that is identical on
 * both pages IS boilerplate, whoever wrote it. The model writes a different page per service; a
 * measurement that does not is measuring the wrong thing.
 *
 *   npx tsx scripts/measure-service-pages.ts
 */
import { makeFixture } from '../test/fixtures/site.js'
import { renderSiteSet } from '../server/lib/render/set.js'
import type { ContentPlan } from '../shared/plan.js'

/** Visible text, split into the blocks a reader actually sees. */
function blocks(html: string): string[] {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, '\n')
    .split(/\n+/)
    .map((s) => s.replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((s) => s.split(' ').length > 3)
}

const words = (arr: string[]) => arr.join(' ').split(/\s+/).filter(Boolean).length

function compare(label: string, plan: ContentPlan, facts: Parameters<typeof renderSiteSet>[1]) {
  const set = renderSiteSet(plan, facts)
  const pages = set.pages.filter((p) => p.path !== 'index.html')
  const a = blocks(pages[0]!.html)
  const b = new Set(blocks(pages[1]!.html))

  const shared = a.filter((s) => b.has(s))
  const unique = a.filter((s) => !b.has(s))
  const pct = Math.round((words(unique) / words(a)) * 100)

  console.log('\n' + label)
  console.log('  visible text            ' + words(a) + ' words')
  console.log('  identical on both pages ' + words(shared) + ' words')
  console.log('  about this service      ' + words(unique) + ' words  (' + pct + '%)')
  return { unique: words(unique), total: words(a) }
}

const fixture = makeFixture({ ownPageServices: ['Blocked drains', 'Hot water systems'] })

const before = compare('WITHOUT its own steps, scope factors and FAQ', fixture.plan, fixture.facts)

const filled: ContentPlan = {
  ...fixture.plan,
  servicePages: fixture.plan.servicePages.map((sp) => {
    const it = sp.service.toLowerCase()
    return {
      ...sp,
      steps: [
        { title: 'Look at the job', body: 'We come out, look at the ' + it + ' and tell you what that work involves before anyone commits to anything.' },
        { title: 'Set up on site', body: 'Access is sorted and everything a ' + it + ' job needs is on site before any of the work starts.' },
        { title: 'The work itself', body: 'The ' + it + ' gets done in the order it needs doing, and you hear about anything we find along the way.' },
        { title: 'Test and tidy', body: 'We test the ' + it + ', walk you through what was done, and everything that came out goes away with us.' },
      ],
      scopeFactors: [
        { label: 'Access', detail: 'Whether we can get gear to the ' + it + ' or have to carry it in by hand changes the hours more than anything else.' },
        { label: 'What is already there', detail: 'An existing ' + it + ' setup takes longer than a fresh one, because it has to be opened up and assessed first.' },
        { label: 'Size of the job', detail: 'How much ' + it + ' there is drives both the materials and the time, and it gets measured on site rather than guessed.' },
        { label: 'What we find', detail: 'Some of a ' + it + ' job is only visible once it is opened up, which is why the price is confirmed and not assumed.' },
      ],
      faqs: [
        { q: 'How long does ' + it + ' take?', a: 'It depends on the size of the ' + it + ' job and how easy it is to reach. We give you a realistic answer once we have looked at it rather than a number over the phone.' },
        { q: 'Do you look at the ' + it + ' first?', a: 'For anything beyond the simplest ' + it + ' job, yes. Looking at it is the only honest way to quote it, and it costs you nothing.' },
        { q: 'What if the ' + it + ' turns up something else?', a: 'We stop and tell you before doing anything about it. Nothing extra gets done on the ' + it + ' and nothing extra gets charged without you saying so first.' },
        { q: 'Do you clean up after the ' + it + '?', a: 'Yes. Everything that comes out of the ' + it + ' goes away with us, and the area is left in a state you would happily walk through.' },
      ],
    }
  }),
}

const after = compare('WITH them', filled, fixture.facts)

console.log(
  '\n  unique content per page: ' + before.unique + ' words -> ' + after.unique + ' words  (' +
    (after.unique / before.unique).toFixed(1) + 'x)\n',
)
