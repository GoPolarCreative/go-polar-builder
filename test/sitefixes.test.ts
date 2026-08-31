import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LABELS, galleryColumns, navMarkup, renderSite } from '../server/lib/render/site'
import { renderSiteSet } from '../server/lib/render/set'
import { makeFixture } from './fixtures/site'
import type { ContentPlan } from '../shared/plan'

/**
 * The nine things Callum's first full build got wrong.
 *
 * It was the first run with every page turned on, and it surfaced a set of faults that only appear
 * at that size: fourteen links across the nav, a gallery of mismatched tiles, reviews wrapping onto
 * a ragged second row, four invisible headings, and two different review counts on the one page.
 *
 * These are structural assertions on the rendered document. The measurements that needed a real
 * browser, the column counts, the tile geometry and the contrast, were taken with Playwright and
 * are pinned by check 25 and by the numbers recorded in each comment below.
 */

const fixture = makeFixture({
  ownPageServices: ['Blocked drains', 'Hot water systems', 'Gas fitting', 'Leak detection'],
})

const render = (plan: ContentPlan = fixture.plan) => renderSite(plan, fixture.facts)

describe('the nav is a nav, not a sitemap', () => {
  /*
   * Callum's ten page build put fourteen links across the header. They wrapped onto three lines
   * and the logo was squeezed into the corner.
   */
  it('folds the service pages under Services instead of listing them across the top', () => {
    const html = render()
    expect(html).toContain('class="nav__group"')
    expect(html).toContain('class="nav__sub"')

    // Every service page is reachable, just not at the top level.
    for (const sp of fixture.plan.servicePages) {
      expect(html).toContain(`services/${sp.slug}/index.html`)
    }
  })

  it('keeps the top level to a handful of destinations', () => {
    // About, Services, Our work, Areas, FAQ, Contact. The service pages are inside the group.
    const nav = /<nav class="nav"[^>]*>([\s\S]*?)<\/nav>/.exec(render())![1]!
    const topLevel = nav.replace(/<span class="nav__sub">[\s\S]*?<\/span>/g, '')
    expect((topLevel.match(/<a /g) ?? []).length).toBeLessThanOrEqual(7)
  })

  /*
   * A dropdown that is open when nobody asked shipped once already and is what check 23 exists to
   * catch. display:none at rest, not opacity, so there is nothing to hover by accident.
   */
  it('the dropdown is genuinely closed at rest', () => {
    expect(render()).toContain('.nav__sub{display:none;')
  })

  it('a phone gets an indented group, because there is no hover on a phone', () => {
    expect(render()).toContain('class="mobile-panel__sub"')
  })

  it('leaves the nav alone when the site is one page', () => {
    const onePage = makeFixture()
    const html = renderSite(onePage.plan, onePage.facts)
    // The markup, not the stylesheet: the dropdown rules ship either way, unused when there is
    // nothing to put in them.
    const nav = /<nav class="nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)![1]!
    expect(nav).not.toContain('nav__group')
  })
})

describe('the gallery is one size, on two rows', () => {
  /*
   * Measured in Chrome at 1440px: six photos give 2 rows of 3 at 379x284 each, eight give 2 rows
   * of 4 at 281x211, and every tile in a gallery is the same size. At 390px both stack to one
   * column. The mosaic this replaced gave the first tile a different shape to all the others.
   */
  it('picks a column count that lands on two rows', () => {
    expect(galleryColumns(6)).toBe(3)
    expect(galleryColumns(8)).toBe(4)
    expect(galleryColumns(4)).toBe(2)
    expect(galleryColumns(7)).toBe(4)
  })

  it('never goes below two or above four columns', () => {
    expect(galleryColumns(1)).toBe(2)
    expect(galleryColumns(3)).toBe(2)
    expect(galleryColumns(20)).toBe(4)
  })

  it('every tile is the same shape, and one column on a phone', () => {
    const html = render()
    expect(html).toContain('aspect-ratio:4/3')
    expect(html).toContain('.gallery{display:grid;gap:12px;grid-template-columns:1fr;}')
    // No tile is singled out any more.
    expect(html).not.toContain('.gallery figure:nth-child(1){grid-column:span 2;grid-row:span 2;}')
  })

  it('passes the count to the CSS rather than hardcoding it', () => {
    expect(render()).toMatch(/<div class="gallery" style="--cols:\d"/)
  })
})

describe('the reviews sit on one row', () => {
  const withReviews = (n: number): ContentPlan => ({
    ...fixture.plan,
    testimonials: {
      ...fixture.plan.testimonials,
      enabled: true,
      items: Array.from({ length: n }, (_, i) => ({
        ...fixture.plan.testimonials.items[0]!,
        name: `Client ${i + 1}`,
      })),
    },
  })

  it('is a rail, not a grid that wraps onto a ragged second row', () => {
    const html = render(withReviews(5))
    expect(html).toContain('class="reviews-rail"')
    expect(html).toContain('class="reviews-track"')
  })

  /*
   * The clone is what makes the loop seamless: the track travels exactly half its width. It is
   * aria-hidden so the same five reviews are not read out twice.
   */
  it('scrolls, and only once there is enough to be worth moving', () => {
    expect(render(withReviews(5))).toContain('<div class="reviews-track" data-marquee>')
    expect(render(withReviews(5))).toContain('class="reviews-clone" aria-hidden="true"')
    // Three reviews fit on screen. A rail sliding half a card back and forth looks broken.
    expect(render(withReviews(3))).toContain('<div class="reviews-track">')
    // The markup again, not the one line of CSS that lays the clone out.
    expect(render(withReviews(3))).not.toContain('class="reviews-clone"')
  })

  it('stops for anyone who has asked their machine to stop things moving', () => {
    expect(render()).toContain('@media (prefers-reduced-motion:reduce){.reviews-track[data-marquee]{animation:none;}}')
  })
})

describe('text is never the colour of what is behind it', () => {
  /*
   * The four why-choose-us headings shipped white on white. ".section--dark h3" painted them for
   * the dark ground and reached inside the light cards standing on it, and a rule beats
   * inheritance. Measured at 1.00:1 by check 25 with this line removed.
   */
  it('the card heading carries its own colour rather than inheriting it', () => {
    expect(render()).toContain('.card h3{margin-bottom:0.55rem;color:var(--card-fg);}')
  })
})

describe('the page does not print two different review counts', () => {
  it('never puts a review count in the about figures', () => {
    const plan: ContentPlan = {
      ...fixture.plan,
      stats: [
        { value: 12, suffix: '', label: 'Years in business', source: 'yearsInBusiness' },
        { value: 5, suffix: '', label: 'Customer Reviews', source: 'reviews supplied' },
        { value: 9, suffix: '', label: 'Suburbs serviced', source: 'suburbsServiced' },
      ],
    }
    const figures = /<dl class="about__figures">([\s\S]*?)<\/dl>/.exec(render(plan))![1]!
    expect(figures).not.toMatch(/review/i)
    // The honest ones are untouched.
    expect(figures).toContain('Years in business')
    expect(figures).toContain('Suburbs serviced')
  })

  it('the house rules stop it being written in the first place', async () => {
    // Rule 2 lives in the plan prompt: the stats are written there, not at build time.
    const { PLAN_SYSTEM } = await import('../server/prompts/houseRules')
    expect(PLAN_SYSTEM).toContain('NEVER a review count')
  })
})

describe('the hero', () => {
  it('centres the subheading box, not just the words inside it', () => {
    // Measured in Chrome: the box was 78px left of centre on a centred hero before this.
    expect(render()).toContain('.hero--centred .hero__sub{margin-inline:auto;}')
  })

  it('gives the logo room to be a logo, and lets them ask for more', () => {
    // 60 was hardcoded in the stylesheet, so "make the logo bigger" had nowhere to land.
    expect(render()).toContain('--logo-h:60px;')
    const big = render({ ...fixture.plan, layout: { logoHeight: 96 } })
    expect(big).toContain('--logo-h:96px;')
    // The footer follows, so one request moves both.
    expect(big).toContain('--logo-h-footer:89px;')
  })

  it('the hero ticks have a colour of their own', () => {
    expect(render()).toContain('--hero-tick:' + fixture.plan.tokens.accent + ';')
    const green = render({
      ...fixture.plan,
      tokens: { ...fixture.plan.tokens, heroTick: '#16A34A' },
    })
    expect(green).toContain('--hero-tick:#16A34A;')
    expect(green).toContain('--accent:' + fixture.plan.tokens.accent + ';')
  })
})

describe('navMarkup', () => {
  const items = [
    { href: '#about', label: 'About' },
    { href: '#services', label: 'Services' },
    { href: '#contact', label: 'Contact' },
  ]
  const services = [{ href: 'services/decks/index.html', label: 'Decks' }]

  it('leaves every other item exactly as it was', () => {
    const out = navMarkup(items, services)
    expect(out).toContain('<a href="#about">About</a>')
    expect(out).toContain('<a href="#contact">Contact</a>')
  })

  it('is a plain list when there are no service pages', () => {
    expect(navMarkup(items, [])).not.toContain('nav__group')
  })

  it('escapes what it is given', () => {
    const out = navMarkup(items, [{ href: 'services/x/index.html', label: 'Decks & Patios' }])
    expect(out).toContain('Decks &amp; Patios')
  })
})

/**
 * AN EDIT REDRAWS THE PAGE. IT DOES NOT ASK A MODEL TO REWRITE IT.
 *
 * Callum sent nine changes at once and got "The rebuild came back incomplete", after minutes of
 * streaming, on a request that never needed a model to write markup. renderSite replaced the
 * model's build call and this path was left behind, so an edit was the one operation that could
 * throw the template away and hand back something else.
 *
 * These read the source. The behaviour is a route that streams, spends real money on a model call
 * and writes to storage, and the property worth pinning is structural: which functions the edit
 * path is allowed to reach for.
 */
describe('the edit path renders rather than rewriting', () => {
  const route = readFileSync(new URL('../server/routes/edits.ts', import.meta.url), 'utf8')

  it('builds the page with the renderer', () => {
    expect(route).toContain('const html = renderSite(revisedPlan, facts)')
  })

  it('no longer reaches for the model to write markup', () => {
    expect(route).not.toContain('rebuildFromPlan')
    expect(route).not.toContain('patchSections')
    expect(route).not.toContain('planEdit')
  })

  /*
   * Same reason as the build route: repair rewrites a template rather than fixing it, so a failing
   * check is a renderer bug to fix once rather than something to patch over on one customer.
   */
  it('does not let repair loose on template output', () => {
    expect(route).toContain('allowRepair: false')
  })

  /*
   * The old message told a customer to name a section and say what to do to it, which is now a
   * promise the editor cannot keep for anything the template decides. Nine of Callum's requests
   * were layout, not content.
   */
  it('tells the customer what an edit can and cannot change', () => {
    expect(route).toContain('The layout itself is fixed')
    expect(route).toContain('your words, your photos, your colours and your fonts')
  })

  it('the machinery that wrote markup is gone rather than left lying around', async () => {
    const edit = await import('../server/lib/edit')
    expect('patchSections' in edit).toBe(false)
    expect('rebuildFromPlan' in edit).toBe(false)

    const prompts = await import('../server/prompts/edit')
    expect('editBuildUserMessage' in prompts).toBe(false)
    expect('PATCH_SYSTEM' in prompts).toBe(false)
  })
})

/**
 * THE DROPDOWN THAT OPENED AS AN EMPTY WHITE BOX.
 *
 * The panel rules sat above ".nav a", which paints header links near-white for the dark header
 * and has exactly the same specificity, so it won on source order and every link in the dropdown
 * rendered white on white. It shipped, in the code written an hour earlier to fix invisible card
 * headings, which says plenty about relying on where a rule sits in the sheet.
 *
 * Check 25 reported a pass, because a closed dropdown is display:none and the probe skipped
 * anything with a zero box. A closed dropdown is exactly where invisible text hides: nobody sees
 * it until they hover, and by then it is on a customer's site. The probe now reads computed
 * colours whether or not the element is laid out, and fails at 1.00:1 with this reverted.
 */
describe('the services dropdown is readable when it opens', () => {
  it('wins on specificity rather than on source order', () => {
    const html = render()
    expect(html).toContain('.nav .nav__sub a{')
    expect(html).not.toContain("'.nav__sub a{")
  })

  it('the probe no longer skips text that is hidden at rest', async () => {
    const probe = readFileSync(new URL('../server/lib/checks/render.ts', import.meta.url), 'utf8')
    const contrast = probe.slice(probe.indexOf('const invisible = []'))
    // The element's own choice to hide is respected; a zero box no longer excludes it.
    expect(contrast).toContain("if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue")
    expect(contrast).not.toContain('if (r.width === 0 || r.height === 0) continue')
  })
})

/**
 * THE WORDS THE TEMPLATE HAD SWALLOWED.
 *
 * renderSite hardcoded eleven eyebrows and five section headings and blurbs. They are the same on
 * every site, which felt like the point of a template, and they are also WORDS ON A CUSTOMER'S
 * WEBSITE that the customer is paying for ten rounds of changes to.
 *
 * Chris asked four times to change the label above a heading. Every edit reported success and
 * charged a round, because the model dutifully changed something in the plan, and the label never
 * moved because the label was not in the plan. Reporting success while delivering less than was
 * asked for is the failure this codebase keeps returning to.
 */
describe('every label on the page can be changed', () => {
  const withCopy = (sectionCopy: ContentPlan['sectionCopy']): ContentPlan => ({
    ...fixture.plan,
    sectionCopy,
  })

  it('uses the built-in wording when the plan says nothing', () => {
    const html = render()
    expect(html).toContain('>What we do<')
    expect(html).toContain('>Why choose us<')
    expect(html).toContain('>Get in touch<')
  })

  it('an eyebrow the plan sets replaces it', () => {
    const html = render(withCopy({ services: { eyebrow: 'The work we take on' } }))
    expect(html).toContain('>The work we take on<')
    expect(html).not.toContain('>What we do<')
  })

  it('a heading and a blurb too', () => {
    const html = render(
      withCopy({ services: { heading: 'Fencing, walls and turf', blurb: 'Across the coast.' } }),
    )
    // Headings pass through twoTone, which puts the tail in an em, so match the rendered shape.
    const h2 = /<section[^>]*id="services"[\s\S]*?<h2>([\s\S]*?)<\/h2>/.exec(html)![1]!
    expect(h2.replace(/<[^>]+>/g, '')).toBe('Fencing, walls and turf')
    expect(html).toContain('Across the coast.')
    expect(html).not.toContain('and how we work')
  })

  it('covers every section that carries a label', () => {
    // The ids the renderer reads. A section missing from this list is one a customer cannot edit.
    for (const section of [
      'hero',
      'about',
      'services',
      'gallery',
      'why_us',
      'process',
      'service_areas',
      'testimonials',
      'faq',
      'cta_band',
      'contact',
    ]) {
      const html = render(withCopy({ [section]: { eyebrow: 'MARKER ' + section } }))
      expect(html, section).toContain('MARKER ' + section)
    }
  })

  /*
   * The hero enquiry card only exists on the styles that carry one, so it needs a plan whose
   * resolved style has it rather than the fixture default.
   */
  it('covers the hero enquiry card, on a style that has one', () => {
    const html = render({
      ...fixture.plan,
      style: { ...fixture.plan.style, chosen: 'direct', resolved: 'direct' },
      sectionCopy: { hero_form: { eyebrow: 'Tell us about the job' } },
    })
    expect(html).toContain('Tell us about the job')
  })

  it('no label is left hardcoded in the markup', () => {
    const source = readFileSync(new URL('../server/lib/render/site.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/eyebrow: '[A-Z]/)
    expect(source).not.toMatch(/class="eyebrow">[A-Z]/)
  })

  /*
   * The eyebrow is the one place the accent lands on a photo or a dark band, which is where a
   * customer is most likely to want it plain white. It falls back to the accent, which is what it
   * always was.
   */
  it('the eyebrow colour can be set without moving the whole accent', () => {
    expect(render()).toContain('--eyebrow-color:' + fixture.plan.tokens.accent + ';')
    const white = render({ ...fixture.plan, tokens: { ...fixture.plan.tokens, eyebrow: '#FFFFFF' } })
    expect(white).toContain('--eyebrow-color:#FFFFFF;')
    // And the accent itself is untouched, so buttons and links do not follow it.
    expect(white).toContain('--eyebrow-color:#FFFFFF;')
    expect(white).toContain(fixture.plan.tokens.accent)
  })

  it('the model is told the field exists, in both places it reads', async () => {
    const { PLAN_SYSTEM } = await import('../server/prompts/houseRules')
    expect(PLAN_SYSTEM).toContain('THE SECTION LABELS ARE YOURS TO WRITE, AND THEIRS TO CHANGE')
    const skeleton = readFileSync(new URL('../server/prompts/messages.ts', import.meta.url), 'utf8')
    expect(skeleton).toContain('"sectionCopy"')
  })
})

/**
 * A FIELD NOBODY CAN REACH IS NOT EDITABLE, WHATEVER THE SCHEMA SAYS.
 *
 * sectionCopy was added, the renderer read it, the build prompt described it, and the next edit
 * still did nothing. The edit step sends the model the CURRENT PLAN and nothing else, and
 * Callum's plan was written before the field existed, so the field simply was not in what the
 * model could see. It changed faq, stats, whyUs and gallery instead, which is a reasonable thing
 * to do when asked to change a label you cannot find.
 *
 * Two things had to be true and only one was: the model has to know the field exists, and the
 * route has to keep it when the model sends it back.
 */
describe('the editor can reach everything the page renders', () => {
  it('the edit prompt names the fields a plan may not contain yet', async () => {
    const { editPlanUserMessage } = await import('../server/prompts/edit')
    const msg = editPlanUserMessage({
      plan: fixture.plan,
      facts: fixture.facts,
      request: 'change the text above the headline to white',
      previousRequests: [],
    })
    expect(msg).toContain('FIELDS THAT MAY BE MISSING FROM THE PLAN ABOVE')
    expect(msg).toContain('sectionCopy')
    expect(msg).toContain('tokens.eyebrow')
    // The point it has to land: absence is not unavailability.
    expect(msg).toContain('does not mean it is unavailable')
  })

  it('the route keeps sectionCopy instead of dropping it as undeclared', async () => {
    const { keyIsDeclared } = await import('../server/lib/edit')
    // A label change on the services section declares 'services'.
    expect(keyIsDeclared('sectionCopy', new Set(['services']))).toBe(true)
    expect(keyIsDeclared('sectionCopy', new Set(['hero']))).toBe(true)
    expect(keyIsDeclared('sectionCopy', new Set(['global']))).toBe(true)
    /*
     * And with no declaration at all, because it is not a section.
     *
     * This asserted false until fourteen real requests were driven through the chain and four
     * failed here: a gallery column count declared nothing, a footer heading declared 'footer'
     * when labels was mapped to a list that did not include it. The declaration exists to stop
     * the model rewriting sections nobody asked about, and none of these IS a section, so asking
     * which one they belong to has no answer worth losing a customer's edit over.
     */
    expect(keyIsDeclared('sectionCopy', new Set([]))).toBe(true)
    expect(keyIsDeclared('labels', new Set([]))).toBe(true)
    expect(keyIsDeclared('layout', new Set([]))).toBe(true)
    // A real section still has to be named.
    expect(keyIsDeclared('hero', new Set([]))).toBe(false)
    expect(keyIsDeclared('faq', new Set(['hero']))).toBe(false)
  })

  it('every section the renderer reads a label for is declarable', async () => {
    const { keyIsDeclared } = await import('../server/lib/edit')
    for (const section of [
      'hero',
      'about',
      'services',
      'gallery',
      'why_us',
      'process',
      'service_areas',
      'testimonials',
      'faq',
      'cta_band',
      'contact',
    ]) {
      expect(keyIsDeclared('sectionCopy', new Set([section])), section).toBe(true)
    }
  })
})

/**
 * FOUR MORE THINGS ON THE PAGE THAT NOTHING COULD CHANGE.
 *
 * Asked to link the service cards to their pages, make the hero button green, set the gallery to
 * three by three and drop the review counts, the editor changed faq, stats, whyUs and gallery
 * items instead. Not one of the four was reachable: two were literals in the renderer, one was
 * derived from the photo count, and the button followed the accent along with every label and
 * link on the site.
 */
describe('the rest of what a customer points at is reachable', () => {
  it('a service card links to the page they paid for', () => {
    const html = render()
    const page = fixture.plan.servicePages[0]!
    expect(html).toContain(`href="services/${page.slug}/index.html"`)
  })

  it('and still points at the form for a service with no page', () => {
    const onePage = makeFixture()
    const html = renderSite(onePage.plan, onePage.facts)
    expect(html).toContain('href="#contact">Request a quote')
  })

  /*
   * The about panel counted the quotes supplied and the Google line counted the profile, so one
   * page carried two different review numbers. The score and the link are the checkable part.
   */
  it('no review count is printed anywhere', () => {
    expect(render()).not.toMatch(/from \d+ reviews/)
    /*
     * The rating line only renders for a business with a profile link AND a score, which this
     * fixture has neither of, so the source is what says the count is gone rather than a page
     * that was never going to show it.
     */
    const source = readFileSync(new URL('../server/lib/render/site.ts', import.meta.url), 'utf8')
    expect(source).toContain('<span>rated on Google</span>')
    expect(source).not.toMatch(/googleReviewCount \? `? ?from \$\{/)
  })

  it('the button has its own colour, falling back to the accent', () => {
    expect(render()).toContain('--btn-bg:' + fixture.plan.tokens.accent + ';')
    const green = render({
      ...fixture.plan,
      tokens: { ...fixture.plan.tokens, button: '#16A34A' },
    })
    expect(green).toContain('--btn-bg:#16A34A;')
    // The accent has not moved, so labels and links stay where they were.
    expect(green).toContain('--accent:' + fixture.plan.tokens.accent + ';')
  })

  it('the gallery shape can be asked for rather than only derived', () => {
    // Nine photos derive four across. A customer wanting three rows of three had no way to say so.
    expect(galleryColumns(9)).toBe(4)
    const three = render({ ...fixture.plan, layout: { galleryColumns: 3 } })
    expect(three).toMatch(/--cols:3"/)
  })

  it('the edit prompt names all of them', async () => {
    const { editPlanUserMessage } = await import('../server/prompts/edit')
    const msg = editPlanUserMessage({
      plan: fixture.plan,
      facts: fixture.facts,
      request: 'make the call now button green',
      previousRequests: [],
    })
    expect(msg).toContain('tokens.button')
    expect(msg).toContain('layout.galleryColumns')
  })

  /*
   * The declaration vocabulary is section ids, and an edit meaning to change the figures declared
   * ['services', 'stats']. stats is a plan key, so it mapped to ['about'], nothing matched, and
   * the change was dropped without anybody being told.
   */
  it('a declaration that names the plan key is accepted', async () => {
    const { keyIsDeclared } = await import('../server/lib/edit')
    expect(keyIsDeclared('stats', new Set(['services', 'stats']))).toBe(true)
    expect(keyIsDeclared('layout', new Set(['gallery']))).toBe(true)
    // And an unrelated declaration still does not let a key through.
    expect(keyIsDeclared('stats', new Set(['faq']))).toBe(false)
  })
})

/**
 * NOTHING ON THE PAGE IS BEYOND REACH.
 *
 * This is the check that stops the last three days repeating. Chris found four separate things a
 * customer could see and no edit could change: the section labels, the button colour, the gallery
 * shape, the review count. Each was found the same way, by him, one at a time, after a customer
 * had spent a round asking for it.
 *
 * So: render a page with every label and every section label replaced by a marker, then read the
 * words a visitor actually sees. Anything left that is not traceable to the plan or the facts is
 * a literal in the renderer, which means nobody can change it. The allowlist below is the only
 * text allowed to be beyond reach, and every entry has a reason.
 */
describe('every word on the page can be reached from the editor', () => {
  const marked = (): ContentPlan => ({
    ...fixture.plan,
    labels: Object.fromEntries(Object.keys(DEFAULT_LABELS).map((k) => [k, 'ZZLABEL'])),
    sectionCopy: Object.fromEntries(
      [
        'hero',
        'hero_form',
        'about',
        'services',
        'gallery',
        'why_us',
        'process',
        'service_areas',
        'testimonials',
        'faq',
        'cta_band',
        'contact',
        'included',
        'detail',
        'scope',
      ].map((s) => [s, { eyebrow: 'ZZEYEBROW', heading: 'ZZHEADING', blurb: 'ZZBLURB' }]),
    ),
  })

  /*
   * Text that is allowed to be fixed, and why.
   *
   * The footer credit is contractual and check 7 fails the build without it. The copyright line
   * is assembled from the year and the business name. "and surrounding suburbs" is built from the
   * placename. The rest are composed from plan values at render time rather than written down.
   */
  /*
   * ONE ENTRY. The footer credit is contractual and check 7 fails the build without it; it is
   * the only text on the page a customer cannot change, and that is on purpose rather than an
   * oversight. Everything else, including the composed lines, now comes from labels.
   */
  const ALLOWED = ['Website by Go Polar Creative']

  const visible = (html: string) =>
    html
      .replace(/<script[\s\S]*?<\/script>/g, ' ')
      .replace(/<style[\s\S]*?<\/style>/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, '\n')
      .split(/\n+/)
      .map((s) => s.replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 2)

  it('leaves nothing hardcoded but the credit and the composed lines', () => {
    const plan = marked()
    /*
     * VALUES ONLY. This compared against JSON.stringify(plan), which includes the KEY NAMES, so
     * "About", "Services", "Gallery", "FAQ" and "Contact" all looked traceable while being
     * literals in the nav markup. The test passed and five of six nav labels were unreachable.
     * A key name is not a word on the page.
     */
    const values: string[] = []
    const walk = (v: unknown): void => {
      if (typeof v === 'string') values.push(v.toLowerCase())
      else if (typeof v === 'number') values.push(String(v))
      else if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') Object.values(v).forEach(walk)
    }
    walk(plan)
    walk(fixture.facts)
    const haystack = values.join('  ')
    const set = renderSiteSet(plan, fixture.facts)

    const orphans: string[] = []
    for (const page of set.pages) {
      for (const text of new Set(visible(page.html))) {
        if (haystack.includes(text.toLowerCase())) continue
        if (ALLOWED.some((a) => text.includes(a))) continue
        // A marker in the line means the words around it came from the plan.
        if (text.includes('ZZ')) continue
        // Numbers composed from a stat value and its suffix, e.g. "14+".
        if (/^\d+\+?$/.test(text)) continue
        orphans.push(page.path + ': ' + text)
      }
    }

    expect(orphans, 'unreachable text:\n' + orphans.join('\n')).toEqual([])
  })

  it('every default label is actually wired to something', () => {
    // A key nobody reads is a promise the editor cannot keep.
    const plain = renderSiteSet(fixture.plan, fixture.facts).pages.map((p) => p.html).join('')
    for (const [key, text] of Object.entries(DEFAULT_LABELS)) {
      // A placeholder is substituted at render time, so match the part either side of it.
      // Any placeholder is substituted at render time, so match the longest literal run.
      const fixed = text.split(/{[a-z]+}/i).map((p) => p.trim()).sort((x, y) => y.length - x.length)[0]!
      expect(plain, key).toContain(fixed)
    }
  })
})

/**
 * THREE MORE, AND THE FIRST ONE IS THE INSTRUCTIVE ONE.
 *
 * "change the More on text to just say LEARN MORE" DID work, and produced "Learn more concrete
 * sleeper retaining walls", because the label was a PREFIX with the service name glued on after
 * it. The customer changed the only part they were given and got a worse sentence than they
 * started with. Making a thing editable is not the same as making it changeable.
 */
describe('the last three things on the page that could not be changed', () => {
  it('the card link is a whole label, not a prefix', () => {
    const whole = render({
      ...fixture.plan,
      labels: { 'services.cardPageCta': 'LEARN MORE' },
    })
    expect(whole).toMatch(/link-arrow" href="services[^>]*>LEARN MORE</)
    // The service name is not glued on the end of it any more.
    expect(whole).not.toMatch(/LEARN MORE blocked drains/)
  })

  it('and still reads per card by default', () => {
    expect(render()).toMatch(/link-arrow" href="services[^>]*>More on blocked drains</)
  })

  it('{service} is substituted wherever it is put', () => {
    const html = render({
      ...fixture.plan,
      labels: { 'services.cardPageCta': '{service} explained' },
    })
    expect(html).toContain('blocked drains explained')
  })

  /*
   * tokens.eyebrow paints every label at once, which is right until somebody wants two of them
   * black and the other ten left alone.
   */
  it('an eyebrow colour can be set for one section without moving the rest', () => {
    const html = render({
      ...fixture.plan,
      sectionCopy: { faq: { eyebrowColor: '#000000' } },
    })
    expect(html).toContain('--eyebrow-faq:#000000;')
    expect(html).toContain('[data-gp="faq"] .eyebrow{color:var(--eyebrow-faq);}')
    // The site-wide one is untouched, so every other label stays where it was.
    expect(html).toContain('--eyebrow-color:' + fixture.plan.tokens.accent + ';')
  })

  it('the tint is a token in :root, because check 1 rejects a hex anywhere else', async () => {
    const { runStaticChecks } = await import('../server/lib/checks/static')
    const html = render({
      ...fixture.plan,
      sectionCopy: { faq: { eyebrowColor: '#000000' }, service_areas: { eyebrowColor: '#000000' } },
    })
    const failed = (await runStaticChecks(html, fixture.facts)).filter((r) => r.status === 'fail')
    expect(failed.map((f) => f.id)).toEqual([])
  })

  it('the photo behind the closing call to action can be turned off', () => {
    const marker = '<div class="band__bg">'
    expect(render()).toContain(marker)
    expect(render({ ...fixture.plan, layout: { ctaBandPhoto: false } })).not.toContain(marker)
  })
})
