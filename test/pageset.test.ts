import { describe, expect, it } from 'vitest'
import {
  canonicalFor,
  enforcePagesAllowed,
  pagesFor,
  relativeLink,
  robotsTxt,
  sitemapXml,
  slugify,
} from '../server/lib/pages'
import { renderSiteSet } from '../server/lib/render/set'
import { renderServicePage } from '../server/lib/render/servicePage'
import { verifySet } from '../server/lib/verify'
import { runStaticChecks } from '../server/lib/checks/static'
import { makeFixture } from './fixtures/site'

/**
 * The page set.
 *
 * A build used to be one file and is now a set, which turns several checks from "run once" into
 * "run per page". The failure worth guarding hardest: a multi-page build reporting success because
 * the home page passed and nobody looked at the rest.
 */

const oneExtra = makeFixture({ ownPageServices: ['Blocked drains'] })
const twoExtra = makeFixture({ ownPageServices: ['Blocked drains', 'Hot water systems'] })
const onePage = makeFixture()

describe('URL structure', () => {
  it('is human readable, because this is sold as an SEO feature', () => {
    const pages = pagesFor(twoExtra.plan)
    expect(pages.map((p) => p.url)).toEqual([
      '/',
      '/services/blocked-drains/',
      '/services/hot-water-systems/',
    ])
    expect(pages.map((p) => p.path)).toEqual([
      'index.html',
      'services/blocked-drains/index.html',
      'services/hot-water-systems/index.html',
    ])
  })

  it('slugifies service names safely', () => {
    expect(slugify('Tap and toilet repairs')).toBe('tap-and-toilet-repairs')
    expect(slugify('Hot Water Systems')).toBe('hot-water-systems')
    expect(slugify('Drains & Sewers')).toBe('drains-and-sewers')
    expect(slugify('  Leak   detection  ')).toBe('leak-detection')
  })

  it('builds canonicals per page, not one for the whole site', () => {
    const pages = pagesFor(twoExtra.plan)
    expect(canonicalFor('https://example.com.au', pages[0]!)).toBe('https://example.com.au/')
    expect(canonicalFor('https://example.com.au', pages[1]!)).toBe(
      'https://example.com.au/services/blocked-drains/',
    )
  })
})

describe('links work served AND opened from disk', () => {
  // A discharge zip is opened by double clicking index.html. An absolute "/services/x/" points at
  // the filesystem root there, so every link between pages is relative.
  it('links down from the home page and back up from a service page', () => {
    const [home, service] = pagesFor(twoExtra.plan)
    expect(relativeLink(home!, service!)).toBe('services/blocked-drains/index.html')
    expect(relativeLink(service!, home!)).toBe('../../index.html')
  })

  it('links sideways between two service pages', () => {
    const pages = pagesFor(twoExtra.plan)
    expect(relativeLink(pages[1]!, pages[2]!)).toBe('../../services/hot-water-systems/index.html')
  })

  it('the rendered pages contain no root-absolute internal links', () => {
    const set = renderSiteSet(twoExtra.plan, twoExtra.facts)
    for (const page of set.pages) {
      const hrefs = [...page.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!)
      const rootAbsolute = hrefs.filter((h) => h.startsWith('/'))
      expect(rootAbsolute, `${page.path} has root-absolute links`).toEqual([])
    }
  })
})

describe('every check runs on every page', () => {
  it('all 22 pass on all three pages of a two-page-extra build', async () => {
    const set = renderSiteSet(twoExtra.plan, twoExtra.facts)
    const report = await verifySet(
      set.pages.map((p) => ({ path: p.path, url: p.url, title: p.title, html: p.html })),
      twoExtra.facts,
      { runRender: false },
    )

    expect(report.pages).toHaveLength(3)
    expect(report.failures).toEqual([])
    expect(report.passed).toBe(true)
    for (const page of report.pages) {
      expect(page.report.static, page.path).toHaveLength(18)
    }
  })

  /*
   * THE PARAGRAPH THAT SHIPPED TWICE.
   *
   * The hero subtitle rendered intro[0] and the "what it involves" section rendered the whole
   * intro array, so every page whose intro was one paragraph printed its opening sentence
   * twice, a screen apart. It shipped on Driftwood: the same sentence at lines 459 and 505 of
   * services/commercial-carpentry/index.html. The schema now requires two paragraphs and the
   * body starts at the second, so the two uses cannot collide.
   */
  it('never prints the opening paragraph twice', () => {
    const set = renderSiteSet(twoExtra.plan, twoExtra.facts)
    const servicePages = set.pages.filter((p) => p.path !== 'index.html')
    expect(servicePages.length).toBeGreaterThan(0)

    for (const page of servicePages) {
      const content = twoExtra.plan.servicePages.find((sp) => page.path.includes(sp.slug))!
      const first = content.intro[0]!
      const occurrences = page.html.split(first).length - 1
      expect(occurrences, page.path).toBe(1)
    }
  })

  /*
   * CHECK 24, SEEN TO FIRE BEFORE IT IS TRUSTED.
   *
   * The offline plan has no steps, scopeFactors or faqs, which is exactly the shape of a page
   * that fell back to the home page content. The check has to warn on that and pass once the
   * page carries its own, or it is decoration.
   */
  it('warns when a service page falls back to the home page content', async () => {
    const set = renderSiteSet(twoExtra.plan, twoExtra.facts)
    const page = set.pages.find((p) => p.path !== 'index.html')!
    const results = await runStaticChecks(page.html, twoExtra.facts)
    const check = results.find((r) => r.id === 'service_page_substance')!
    expect(check.status).toBe('warn')
    expect(check.evidence?.length).toBe(3)
  })

  it('passes once the page carries its own steps, scope factors and questions', async () => {
    const filled = {
      ...twoExtra.plan,
      servicePages: twoExtra.plan.servicePages.map((sp) => ({
        ...sp,
        steps: [
          { title: 'Mark it out', body: 'We set out the line and check the levels before anything gets dug.' },
          { title: 'Do the work', body: 'The stage where the actual job happens, start to finish, on site.' },
          { title: 'Clean up', body: 'Everything that came out goes away with us and the site is left tidy.' },
        ],
        scopeFactors: [
          { label: 'Access', detail: 'Whether a machine can get in changes how long the job takes.' },
          { label: 'Ground', detail: 'Rock, clay and sand all behave differently once you start digging.' },
          { label: 'Size', detail: 'Length and height drive the materials and the hours more than anything.' },
        ],
        faqs: [
          { q: 'How long does it take?', a: 'It depends on the size and the access, and we will tell you when we look at it.' },
          { q: 'Do I need approval?', a: 'Sometimes, depending on height and where it sits, and we will talk you through it.' },
          { q: 'What about drainage?', a: 'Water sitting behind a wall is what pushes it over, so it gets dealt with properly.' },
        ],
      })),
    }
    const set = renderSiteSet(filled, twoExtra.facts)
    const page = set.pages.find((p) => p.path !== 'index.html')!
    const results = await runStaticChecks(page.html, twoExtra.facts)
    const check = results.find((r) => r.id === 'service_page_substance')!
    expect(check.status, JSON.stringify(check.evidence)).toBe('pass')

    // And the page is no longer mostly the home page.
    expect(page.html).toContain('data-gp="service_process"')
    expect(page.html).toContain('data-gp="service_scope"')
    expect(page.html).toContain('data-gp="service_faq"')
  })

  it('A SET DOES NOT PASS WHEN ONE PAGE FAILS, even if the home page is perfect', async () => {
    // The exact failure being guarded: a multi-page build reporting success because the home page
    // was checked and the service pages were not.
    const set = renderSiteSet(twoExtra.plan, twoExtra.facts)
    const pages = set.pages.map((p) => ({ path: p.path, url: p.url, title: p.title, html: p.html }))

    // Break only the last page, with a second h1.
    pages[2]!.html = pages[2]!.html.replace('<h2>', '<h1>').replace('</h2>', '</h1>')

    const report = await verifySet(pages, twoExtra.facts, { runRender: false })
    expect(report.passed).toBe(false)
    expect(report.pages[0]!.report.passed, 'the home page is still fine').toBe(true)
    expect(report.failures.map((f) => f.path)).toContain('services/hot-water-systems/index.html')
    expect(report.failures.some((f) => f.checkId === 'single_h1')).toBe(true)
  })

  it('each page carries exactly one h1 of its own', () => {
    const set = renderSiteSet(twoExtra.plan, twoExtra.facts)
    for (const page of set.pages) {
      expect((page.html.match(/<h1[\s>]/g) ?? []).length, page.path).toBe(1)
    }
  })

  it('the heaviest page is what the weight budget is measured against', async () => {
    const set = renderSiteSet(twoExtra.plan, twoExtra.facts)
    const report = await verifySet(
      set.pages.map((p) => ({ path: p.path, url: p.url, title: p.title, html: p.html })),
      twoExtra.facts,
      { runRender: false },
    )
    expect(report.heaviestBytes).toBe(Math.max(...report.pages.map((p) => p.report.pageWeightBytes)))
  })
})

describe('sitemap and robots', () => {
  it('are not written for a one-page build, because they would say nothing', () => {
    const set = renderSiteSet(onePage.plan, onePage.facts)
    expect(set.pages).toHaveLength(1)
    expect(set.files).toEqual([])
  })

  it('are written once there is a set, and list every page', () => {
    const set = renderSiteSet(twoExtra.plan, twoExtra.facts)
    const sitemap = set.files.find((f) => f.path === 'sitemap.xml')!
    const robots = set.files.find((f) => f.path === 'robots.txt')!

    expect(sitemap.content).toContain('/services/blocked-drains/')
    expect(sitemap.content).toContain('/services/hot-water-systems/')
    expect((sitemap.content.match(/<url>/g) ?? []).length).toBe(3)
    expect(robots.content).toContain('Sitemap:')
  })

  it('the sitemap is valid XML with absolute URLs', () => {
    const pages = pagesFor(twoExtra.plan)
    const xml = sitemapXml('https://coldfront.com.au', pages, '2026-08-20')
    expect(xml.startsWith('<?xml')).toBe(true)
    expect(xml).toContain('<loc>https://coldfront.com.au/services/blocked-drains/</loc>')
    expect(xml).not.toContain('<loc>/')
    expect(robotsTxt('https://coldfront.com.au')).toContain(
      'Sitemap: https://coldfront.com.au/sitemap.xml',
    )
  })
})

describe('schema on a service page', () => {
  const set = renderSiteSet(twoExtra.plan, twoExtra.facts)
  const servicePage = set.pages[1]!

  it('carries a real BreadcrumbList, home then the service', () => {
    expect(servicePage.html).toContain('"@type": "BreadcrumbList"')
    expect(servicePage.html).toContain('"position": 1')
    expect(servicePage.html).toContain('"position": 2')
  })

  it('carries a Service tied back to the LocalBusiness rather than floating free', () => {
    expect(servicePage.html).toContain('"@type": "Service"')
    expect(servicePage.html).toMatch(/"provider":\s*\{\s*"@id":/)
  })

  it('declares the same areaServed shape as the home page', () => {
    const home = set.pages[0]!.html
    const homeMode = home.includes('GeoCircle') ? 'GeoCircle' : 'City'
    expect(servicePage.html).toContain(homeMode)
  })

  it('has its own canonical, not the home page one', () => {
    const canonical = servicePage.html.match(/rel="canonical" href="([^"]+)"/)?.[1]
    expect(canonical).toContain('/services/blocked-drains/')
  })
})

describe('navigation and the sticky bar carry across pages', () => {
  const set = renderSiteSet(twoExtra.plan, twoExtra.facts)

  it('the home page links to every service page, in the nav and the mobile panel', () => {
    const home = set.pages[0]!.html
    const nav = home.match(/<nav class="nav"[\s\S]*?<\/nav>/)?.[0] ?? ''
    const panel = home.match(/<div class="mobile-panel"[\s\S]*?<\/div>/)?.[0] ?? ''
    for (const slug of ['blocked-drains', 'hot-water-systems']) {
      expect(nav, `desktop nav is missing ${slug}`).toContain(`services/${slug}/index.html`)
      expect(panel, `mobile panel is missing ${slug}`).toContain(`services/${slug}/index.html`)
    }
  })

  it('every page keeps the sticky mobile call bar', () => {
    for (const page of set.pages) {
      expect(page.html, page.path).toContain('class="mobile-bar"')
      expect(page.html, page.path).toContain('Call now')
    }
  })

  it('every page shares one design system', () => {
    // Same stylesheet function, so the token block is byte identical across the set. A page set
    // that looked like two different studios would be worse than one page.
    const roots = set.pages.map((p) => p.html.match(/:root\{[\s\S]*?\}/)?.[0])
    expect(new Set(roots).size).toBe(1)
  })
})

describe('the allowance is enforced on the plan, server side', () => {
  it('drops pages beyond the allowance and says which', () => {
    const { plan, dropped } = enforcePagesAllowed(twoExtra.plan, 2)
    expect(plan.servicePages).toHaveLength(1)
    expect(dropped).toEqual(['Hot water systems'])
  })

  it('a one-page allowance means no service pages at all', () => {
    const { plan, dropped } = enforcePagesAllowed(twoExtra.plan, 1)
    expect(plan.servicePages).toEqual([])
    expect(dropped).toHaveLength(2)
  })

  it('never drops a page the customer paid for', () => {
    const { plan, dropped } = enforcePagesAllowed(twoExtra.plan, 3)
    expect(plan.servicePages).toHaveLength(2)
    expect(dropped).toEqual([])
  })

  it('a generous allowance does not invent pages', () => {
    const { plan } = enforcePagesAllowed(oneExtra.plan, 8)
    expect(plan.servicePages).toHaveLength(1)
  })
})

/**
 * Scroll motion, and the one way it must never fail.
 *
 * Sections rise in as they arrive, and the hero photo drifts on styles that use parallax. Both are
 * worth having and neither is worth a blank website, so the hidden state is set by the SCRIPT and
 * every rule that hides anything sits behind an attribute only the script writes.
 *
 * The test that matters is the last one: with the markup alone, nothing is hidden. If someone
 * later moves the hiding into the stylesheet "to avoid a flash", that test fails, and it should.
 */
describe('sections rise in as they arrive', () => {
  const render = (style: 'industrial' | 'modern' | 'established' | 'direct') => {
    const f = makeFixture({ ownPageServices: ['Blocked drains'] })
    const plan = { ...f.plan, style: { chosen: style, resolved: style, reason: 't', constraints: [] } }
    const pages = pagesFor(plan)
    const page = pages.find((p) => p.depth > 0)!
    return renderServicePage({ plan, facts: f.facts, page, pages, baseUrl: 'https://x.com.au' })
  }

  it('NOTHING IS HIDDEN BY THE MARKUP ALONE, so a page whose script never ran still reads', () => {
    const html = render('industrial')
    // The attribute the hiding hangs off must not be in the document as written.
    expect(html).not.toMatch(/<html[^>]*data-reveal/)
    expect(html).not.toMatch(/<html[^>]*data-parallax/)
    // And no section may carry the reveal class until the script adds it.
    expect(html).not.toMatch(/class="[^"]*\breveal\b[^"]*"/)
  })

  it('hides only under the attribute the script sets', () => {
    const html = render('industrial')
    expect(html).toContain('[data-reveal] .reveal{opacity:0')
    expect(html).toContain('[data-reveal] .reveal.is-in{opacity:1')
  })

  it('gives somebody who asked for less movement the finished state outright', () => {
    const html = render('industrial')
    expect(html).toMatch(/@media \(prefers-reduced-motion:reduce\)\{\n\[data-reveal\] \.reveal\{opacity:1/)
  })

  it('does not run the observer at all under reduced motion', () => {
    expect(render('industrial')).toContain("matchMedia('(prefers-reduced-motion: reduce)')")
  })

  /*
   * Parallax stays a property of the style rather than something every site gets, because it is
   * one of the things that makes the four look different. Making it universal dropped established
   * and modern to 7.9% apart against an 8% floor, and test/styles.test.ts caught it.
   */
  it('carries parallax on a style that uses it', () => {
    const html = render('industrial')
    expect(html).toContain('parallax-layer')
    expect(html).toContain('[data-parallax] .hero__bg img')
  })

  /*
   * EVERY STYLE, NOT SOME. It shipped on two of the four, so half of Chris's builds would never
   * have had the thing he asked for twice. The four stay distinct through their fonts, colour,
   * section order, hero shape and how a tinted band meets its neighbour; a drifting hero photo is
   * not what was telling them apart.
   */
  it('is on for every style, because a customer on any of them asked for it', () => {
    for (const style of ['industrial', 'modern', 'established', 'direct'] as const) {
      expect(render(style), style).toContain('[data-parallax] .hero__bg img')
    }
  })

  it('never uses background-attachment, which iOS Safari has never supported', () => {
    expect(render('industrial')).not.toContain('background-attachment:fixed')
  })
})

/**
 * A relative path has to resolve from the page carrying it.
 *
 * Callum's build shipped ten service pages whose header logo and favicon pointed at
 * `assets/logo.webp` and `favicon.svg` from two directories down, so every one of them 404'd and
 * showed a blank logo. It passed eighteen checks, because `assets_exist` stripped the leading
 * `../` before looking the file up: `assets/x` and `../../assets/x` were the same string to it,
 * so it could not tell a working path from a broken one. The photos on the same pages were
 * correct, which is exactly why a rule in the renderer was never going to be enough.
 */
describe('assets resolve from the page that references them', () => {
  const set = renderSiteSet(
    makeFixture({ ownPageServices: ['Blocked drains', 'Hot water systems'] }).plan,
    makeFixture({ ownPageServices: ['Blocked drains', 'Hot water systems'] }).facts,
  )
  const refsIn = (html: string) =>
    [...html.matchAll(/(?:src|href)="((?:\.\.\/)*(?:assets\/|favicon\.svg)[^"]*)"/g)].map((m) => m[1] ?? '')

  it('a service page points two directories up, for the logo and the favicon as well as the photos', () => {
    const page = set.pages.find((p) => p.path !== 'index.html')!
    const refs = refsIn(page.html)
    expect(refs.length).toBeGreaterThan(3)
    const wrong = refs.filter((r) => !r.startsWith('../../'))
    expect(wrong, `${page.path} references these without going up two: ${wrong.join(', ')}`).toEqual([])
  })

  it('the home page points at them directly, because it sits beside them', () => {
    const home = set.pages.find((p) => p.path === 'index.html')!
    expect(refsIn(home.html).filter((r) => r.startsWith('../'))).toEqual([])
  })

  it('THE CHECK CATCHES IT, which is the part that was missing', async () => {
    const { facts } = makeFixture({ ownPageServices: ['Blocked drains', 'Hot water systems'] })
    const page = set.pages.find((p) => p.path !== 'index.html')!

    const clean = await runStaticChecks(page.html, facts)
    expect(clean.find((r) => r.id === 'assets_exist')?.status).toBe('pass')

    // The exact bug: a root-relative logo on a page two directories down.
    const broken = page.html.replace('src="../../assets/logo', 'src="assets/logo')
    expect(broken).not.toEqual(page.html)
    const after = await runStaticChecks(broken, facts)
    const result = after.find((r) => r.id === 'assets_exist')!
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('do not resolve from this page')
  })
})

/**
 * An eyebrow on a card takes the card's colour, not the colour of the section around it.
 *
 * The enquiry card sits inside the hero, and `.hero .eyebrow` paints for the hero's dark photo.
 * The card is white, so "Start a conversation" rendered white on white at 1.00:1 on every page of
 * Callum's build, the home page included. A tag in the selector rather than another class, so it
 * also beats the per-section tints appended at the end of the sheet.
 */
describe('the label on the enquiry card is readable', () => {
  const { plan, facts } = makeFixture({})
  const set = renderSiteSet(plan, facts)

  it('paints it from the card ground rather than inheriting the section', () => {
    for (const page of set.pages) {
      expect(page.html, page.path).toContain('.card-form span.eyebrow{color:var(--eyebrow-on-card);}')
      expect(page.html, page.path).toMatch(/--eyebrow-on-card:#[0-9a-f]{3,8};/i)
    }
  })

  it('the card colour is not simply the on-dark one, which is what made it invisible', () => {
    const home = set.pages[0]!.html
    const onCard = /--eyebrow-on-card:([^;]+);/.exec(home)?.[1]
    const onDark = /--eyebrow-on-dark:([^;]+);/.exec(home)?.[1]
    const onLight = /--eyebrow-color:([^;]+);/.exec(home)?.[1]
    expect(onCard).toBeTruthy()
    // A light card takes the light colour. Only an outlined-dark card may match the dark one.
    expect(Boolean(onCard) && (onCard === onLight || onCard === onDark)).toBe(true)
  })
})

/**
 * A ghost button takes the colour of the ground it is standing on.
 *
 * `.btn--ghost` was `color: var(--white)` unconditionally, because four of its five uses sit on
 * something dark: the hero over its photo, and the closing band. The fifth is "Leave a Google
 * review" beneath the reviews, on the ordinary light page. That button was white on white on
 * every build this template has produced — a real, correctly linked control that nobody could
 * see. Screenshotting the element returned a blank white rectangle.
 */
describe('ghost buttons are readable on a light section', () => {
  const { plan, facts } = makeFixture({})
  const withReviews = { ...facts, googleReviewLink: 'https://g.page/r/example/review' }
  const html = renderSiteSet(plan, withReviews).pages[0]!.html

  it('defaults to the page colour rather than white', () => {
    expect(html).toContain('.btn--ghost{background:transparent;color:var(--page-fg);')
  })

  it('still goes white inside the hero, the closing band and any dark section', () => {
    expect(html).toContain('.hero .btn--ghost,.cta-band .btn--ghost,.section--dark .btn--ghost')
    expect(html).toMatch(/\.section--dark \.btn--ghost\{color:var\(--white\);/)
  })

  it('the review button, which is the one that was invisible, is on the light page', () => {
    expect(html).toContain('Leave a Google review')
    // Not inside the hero or the closing band, so it takes the default above.
    const band = html.slice(html.indexOf('Leave a Google review') - 2000, html.indexOf('Leave a Google review'))
    expect(band).not.toContain('class="cta-band')
  })
})

/**
 * The lightbox has to fit on the screen.
 *
 * `.lightbox img` was `max-width:100%;max-height:100%`, which reads as "never bigger than its
 * container" and is not one. The overlay is a grid whose track is sized BY the image, so 100% of
 * that track is the image's own height and constrains nothing. Width happened to survive because
 * the track was capped by the viewport; height had nothing pushing back on it.
 *
 * Measured in Chrome: a 2000x1500 photo on a 1280x800 window came out 1232x924, so 148 pixels of
 * it sat below the bottom of the screen with no way to scroll to them. After the fix the same
 * photo is 1003x752 there, and it fits at 390x844, 1440x620 and 820x1180 as well.
 */
describe('a photo opened in the lightbox fits the window', () => {
  const { plan, facts } = makeFixture({})
  const html = renderSiteSet(plan, facts).pages[0]!.html
  const rule = /\.lightbox img\{([^}]*)\}/.exec(html)?.[1] ?? ''

  it('constrains against the window, not against a box the image itself sizes', () => {
    expect(rule, 'no .lightbox img rule found').not.toEqual('')
    expect(rule).toContain('100vw')
    expect(rule).toContain('100vh')
    // The exact pair that did nothing.
    expect(rule).not.toContain('max-height:100%')
  })

  it('keeps the aspect ratio rather than squashing the photo', () => {
    expect(rule).toContain('object-fit:contain')
  })

  it('leaves the padding clear on both axes', () => {
    // 24px of padding either side, so the image may take the viewport less 48.
    expect(rule).toContain('calc(100vw - 48px)')
    expect(rule).toContain('calc(100vh - 48px)')
  })

  it('uses dvh where the browser has it, because 100vh lies on a phone', () => {
    expect(html).toContain('@supports (height:100dvh)')
    expect(html).toContain('calc(100dvh - 48px)')
  })
})
