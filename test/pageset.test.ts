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
import { verifySet } from '../server/lib/verify'
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
  it('all 20 pass on all three pages of a two-page-extra build', async () => {
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
      expect(page.report.static, page.path).toHaveLength(16)
    }
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
