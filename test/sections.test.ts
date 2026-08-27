import { describe, expect, it } from 'vitest'
import {
  SECTION_IDS,
  extractJsonLd,
  extractSection,
  extractStylesheet,
  fragmentIsComplete,
  jsonLdIsComplete,
  PLAN_KEY_SECTIONS,
  keyIsDeclared,
  markedSections,
  planEdit,
  sectionRange,
  spliceInto,
  unwrapFragment,
  type SectionId,
} from '../server/lib/sections'
import { renderSite } from '../server/lib/render/site'
import { offlinePlan } from '../server/lib/offline'
import { buildFacts } from '../server/lib/facts'
import { makeIntake } from './fixtures/site'
import { planSchema, type ContentPlan } from '../shared/plan'

/**
 * Patching one section instead of rewriting the document.
 *
 * THE PROPERTY THAT MATTERS IS NOT SPEED. It is that a customer who asks for one thing gets one
 * thing. The old edit re-emitted all 63KB on every request, so every section was rewritten from
 * scratch whether it had been mentioned or not, and a change to the headline could quietly reword
 * the FAQ. That is not a hypothetical: the production edit trail for job_03b9657cf7f24757828ab158
 * shows "make my emails go to X" reporting `faq: contents changed; stats: contents changed;
 * whyUs: contents changed; gallery.items: contents changed` on every single round.
 *
 * These tests run against the deterministic renderer rather than the model, on purpose. The
 * property under test is the splice, and a test that needed a model call could not assert byte
 * equality on anything.
 */

const intake = makeIntake()
const facts = buildFacts(intake, [])
const plan = planSchema.parse(offlinePlan(intake, facts, [], [])) as ContentPlan
const html = renderSite(plan, facts)

describe('the renderer marks every section it emits', () => {
  it('marks all fifteen', () => {
    const found = markedSections(html)
    // gallery and testimonials are switched off in some fixtures; everything else is mandatory.
    const optional = new Set<SectionId>(['gallery', 'testimonials'])
    for (const id of SECTION_IDS) {
      if (optional.has(id)) continue
      expect(found.has(id), `no data-gp marker for ${id}`).toBe(true)
    }
  })

  it('marks each section exactly once', () => {
    for (const id of markedSections(html)) {
      const hits = html.split(`data-gp="${id}"`).length - 1
      expect(hits, `${id} appears ${hits} times`).toBe(1)
    }
  })
})

describe('a section can be found and cut out whole', () => {
  it('returns balanced markup for every marked section', () => {
    for (const id of markedSections(html)) {
      const cut = extractSection(html, id)
      expect(cut, `${id} could not be extracted`).toBeTruthy()
      const tag = /^<([a-z]+)/.exec(cut!)![1]!
      const opens = (cut!.match(new RegExp(`<${tag}\\b`, 'gi')) ?? []).length
      const closes = (cut!.match(new RegExp(`</${tag}\\s*>`, 'gi')) ?? []).length
      expect(opens, `${id} opening and closing ${tag} tags do not balance`).toBe(closes)
    }
  })

  /*
   * THE NESTED FOOTER CASE, which is why this walks a tag stack instead of matching a closing tag.
   * Testimonial cards render their attribution inside a <footer>, so the first "</footer>" after
   * the site footer's opening tag belongs to a testimonial and a naive match cuts the page in
   * half.
   */
  it('does not stop at a nested element of the same name', () => {
    const footer = extractSection(html, 'footer')
    expect(footer).toBeTruthy()
    expect(footer!.startsWith('<footer')).toBe(true)
    expect(footer!.trimEnd().endsWith('</footer>')).toBe(true)
    // The site footer must not have swallowed the contact section that sits above it.
    expect(footer!).not.toContain('data-gp="contact"')
  })

  it('refuses a section that is not there rather than guessing', () => {
    expect(sectionRange(html, 'trust_strip' as SectionId)).toBeTruthy()
    expect(extractSection('<html><body><p>nothing here</p></body></html>', 'hero')).toBeNull()
  })
})

describe('THE PROPERTY: everything not patched is byte-identical', () => {
  it('leaves every other section untouched when the hero is replaced', () => {
    const before = new Map<SectionId, string>()
    for (const id of markedSections(html)) before.set(id, extractSection(html, id)!)

    const replacement = extractSection(html, 'hero')!.replace(/<h1([^>]*)>[\s\S]*?<\/h1>/, '<h1$1>A brand new headline</h1>')
    const after = spliceInto(html, [{ target: 'hero', markup: replacement }])

    expect(after).toContain('A brand new headline')

    for (const [id, was] of before) {
      if (id === 'hero') continue
      expect(extractSection(after, id), `${id} changed and should not have`).toBe(was)
    }
  })

  it('leaves the stylesheet byte-identical, because a patch cannot add CSS', () => {
    const replacement = extractSection(html, 'about')!.replace(/<p>/, '<p>Changed. ')
    const after = spliceInto(html, [{ target: 'about', markup: replacement }])
    expect(extractStylesheet(after)).toBe(extractStylesheet(html))
  })

  it('changes only the bytes inside the patched range', () => {
    const original = extractSection(html, 'process')!
    const replacement = original.replace('</section>', '<p>extra</p></section>')
    const after = spliceInto(html, [{ target: 'process', markup: replacement }])

    // Everything before the section starts, and after it ends, is carried across verbatim.
    const r = sectionRange(html, 'process')!
    expect(after.slice(0, r.start)).toBe(html.slice(0, r.start))
    expect(after.slice(after.length - (html.length - r.end))).toBe(html.slice(r.end))
  })

  it('applies several patches at once without corrupting each other’s offsets', () => {
    const a = extractSection(html, 'hero')!.replace(/<h1([^>]*)>[\s\S]*?<\/h1>/, '<h1$1>First</h1>')
    const b = extractSection(html, 'contact')!.replace('</section>', '<p>Second</p></section>')
    const after = spliceInto(html, [
      { target: 'hero', markup: a },
      { target: 'contact', markup: b },
    ])
    expect(after).toContain('First')
    expect(after).toContain('Second')
    expect(extractSection(after, 'about')).toBe(extractSection(html, 'about'))
    expect(extractSection(after, 'faq')).toBe(extractSection(html, 'faq'))
  })
})

describe('deciding whether an edit can be patched at all', () => {
  const decide = (changes: string[], request: string) => planEdit({ changes, request, html })

  it('patches a change confined to one section', () => {
    const d = decide(['hero.headline'], 'change the headline to Emergency plumbing')
    expect(d.mode).toBe('patch')
    if (d.mode === 'patch') expect(d.targets).toEqual(['hero'])
  })

  it('carries the JSON-LD along with any FAQ change, because a check compares them word for word', () => {
    const d = decide(['faq.items.0.answer'], 'reword the second FAQ answer')
    expect(d.mode).toBe('patch')
    if (d.mode === 'patch') expect(d.targets).toContain('jsonld')
  })

  it('REBUILDS for a colour change, rather than pretending it is local', () => {
    expect(decide(['tokens.primary'], 'make the buttons green').mode).toBe('rebuild')
    // Even when the plan diff looks narrow, the words give it away.
    expect(decide(['hero.headline'], 'can the whole site feel more modern').mode).toBe('rebuild')
  })

  it('REBUILDS when the plan did not move, because there is nothing to localise to', () => {
    expect(decide([], 'make it nicer').mode).toBe('rebuild')
  })

  it('REBUILDS when the business name changes, which reaches the head and every section', () => {
    expect(decide(['brand.businessName'], 'we renamed the business').mode).toBe('rebuild')
  })

  it('REBUILDS a document with no markers, so old builds still work', () => {
    const old = '<html><body><section id="hero"><h1>Old</h1></section></body></html>'
    const d = planEdit({ changes: ['hero.headline'], request: 'new headline', html: old })
    expect(d.mode).toBe('rebuild')
    expect(d.reason).toMatch(/markers/i)
  })

  it('REBUILDS rather than patching most of the page', () => {
    const many = ['hero.x', 'about.x', 'services.x', 'process.x', 'contact.x', 'whyUs.x', 'stats.x']
    expect(decide(many, 'update all the wording').mode).toBe('rebuild')
  })

  it('ignores plan keys that change nothing a visitor sees', () => {
    expect(decide(['servicePages.0.intro', 'assumptions.0'], 'tweak').mode).toBe('rebuild')
  })
})

describe('the JSON-LD block is addressable on its own', () => {
  it('finds it and puts it back without touching the rest', () => {
    const ld = extractJsonLd(html)
    expect(ld).toBeTruthy()
    expect(ld!.startsWith('<script')).toBe(true)
    const after = spliceInto(html, [{ target: 'jsonld', markup: ld! }])
    expect(after).toBe(html)
  })
})

describe('a fragment is checked as a fragment, not as a document', () => {
  it('accepts a complete section', () => {
    expect(fragmentIsComplete('<section data-gp="hero"><h1>Hi</h1></section>')).toBe(true)
  })

  /*
   * THE BUG THIS PINS. isTruncated asks whether the text ends with a closing html tag, which no
   * section ever does, so it reported every patch as truncated. The first real patch run threw
   * "the stats patch came back incomplete", threw away six good sections and fell back to a full
   * rebuild after spending 144 seconds avoiding one.
   */
  it('does not require a closing html tag, which a section never has', () => {
    const realSection = extractSection(html, 'process')!
    expect(realSection.includes('</html>')).toBe(false)
    expect(fragmentIsComplete(realSection)).toBe(true)
  })

  it('rejects a section cut off mid-way', () => {
    expect(fragmentIsComplete('<section data-gp="hero"><h1>Hi</h1>')).toBe(false)
    expect(fragmentIsComplete('<section data-gp="hero"><div><p>half')).toBe(false)
  })

  it('counts nested elements of the same name', () => {
    expect(fragmentIsComplete('<footer><footer>card</footer></footer>')).toBe(true)
    expect(fragmentIsComplete('<footer><footer>card</footer>')).toBe(false)
  })

  it('rejects anything that is not markup', () => {
    expect(fragmentIsComplete('Here is the updated section:')).toBe(false)
    expect(fragmentIsComplete('')).toBe(false)
  })

  it('accepts JSON-LD only when the JSON inside it parses', () => {
    expect(jsonLdIsComplete('<script type="application/ld+json">{"a":1}</script>')).toBe(true)
    expect(jsonLdIsComplete('<script type="application/ld+json">{"a":1</script>')).toBe(false)
    expect(jsonLdIsComplete('<script type="application/ld+json">{"a":1}')).toBe(false)
  })

  it('accepts the real JSON-LD out of a real document', () => {
    expect(jsonLdIsComplete(extractJsonLd(html)!)).toBe(true)
  })
})

describe('a reply with a sentence in front of the markup', () => {
  /*
   * FROM A REAL RUN. Asked to patch testimonials for a request about the process section, the
   * model answered "The requested change belongs to the process section, not testimonials. This
   * part <section...>...</section>". That is a correct and helpful thing to say, and the strict
   * parser threw the entire patch away over it, losing six good sections to a full rebuild.
   */
  it('finds the element after a line of commentary', () => {
    const out = unwrapFragment(
      'The requested change belongs to the process section, not testimonials. This part\n<section data-gp="testimonials">x</section>',
      'section',
    )
    expect(out).toBe('<section data-gp="testimonials">x</section>')
    expect(fragmentIsComplete(out!)).toBe(true)
  })

  it('returns null when there is no markup at all, which means leave it alone', () => {
    expect(unwrapFragment('Nothing in this section needs to change.', 'section')).toBeNull()
  })

  it('anchors on the expected tag rather than the first tag it sees', () => {
    const out = unwrapFragment('Here <em>is</em> it: <section data-gp="faq">q</section>', 'section')
    expect(out).toBe('<section data-gp="faq">q</section>')
  })
})

describe('the declaration is enforced, not requested', () => {
  /*
   * THE THIRD TIME IN THIS PROJECT that someone received something other than what they asked
   * for, and the third time the cause was trusting the shape of what a model returned. A request
   * that said only "add a line to the process section" came back having also rewritten faq,
   * stats, whyUs, gallery and testimonials, twice, through two rounds of increasingly emphatic
   * prompting. So it is constrained instead.
   */
  it('accepts a key whose section was declared', () => {
    expect(keyIsDeclared('hero', new Set(['hero']))).toBe(true)
    expect(keyIsDeclared('faq', new Set(['faq', 'process']))).toBe(true)
  })

  it('REJECTS a key whose section was not declared', () => {
    expect(keyIsDeclared('faq', new Set(['process']))).toBe(false)
    expect(keyIsDeclared('stats', new Set(['process']))).toBe(false)
    expect(keyIsDeclared('testimonials', new Set(['hero']))).toBe(false)
  })

  it('rejects everything when nothing was declared', () => {
    for (const key of Object.keys(PLAN_KEY_SECTIONS)) {
      expect(keyIsDeclared(key, new Set()), key).toBe(false)
    }
  })

  it('lets a declared global change reach the head and the stylesheet', () => {
    for (const key of ['tokens', 'style', 'brand', 'meta', 'schema', 'hero']) {
      expect(keyIsDeclared(key, new Set(['global'])), key).toBe(true)
    }
  })

  it('REJECTS head-only keys unless global was declared, since they have no section', () => {
    for (const key of ['tokens', 'style', 'brand', 'meta', 'schema']) {
      expect(keyIsDeclared(key, new Set(['hero', 'faq'])), key).toBe(false)
    }
  })

  it('rejects a key the plan does not have a mapping for', () => {
    expect(keyIsDeclared('somethingInvented', new Set(['hero']))).toBe(false)
  })
})

describe('a marker that appears twice is not addressable', () => {
  /*
   * A real build at BUILD_EFFORT=medium emitted data-gp="header" three times. sectionRange takes
   * the first match, so a patch would have rewritten the wrong element. Dropping the id costs
   * that section its fast path and nothing else.
   */
  const doubled =
    '<header data-gp="header">one</header><section data-gp="hero">h</section><header data-gp="header">two</header>'

  it('drops a duplicated id and keeps the clean ones', () => {
    const found = markedSections(doubled)
    expect(found.has('header')).toBe(false)
    expect(found.has('hero')).toBe(true)
  })

  it('makes planEdit rebuild rather than patch the wrong element', () => {
    const d = planEdit({ changes: ['brand.businessName'], request: 'new name', html: doubled })
    expect(d.mode).toBe('rebuild')
  })
})
