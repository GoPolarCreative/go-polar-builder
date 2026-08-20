import { describe, expect, it } from 'vitest'
import { siteObjectKey } from '../server/lib/publish'
import { buildDischargePackage, swapWeb3FormsKey } from '../server/lib/discharge'
import { renderSiteSet } from '../server/lib/render/set'
import { makeFixture } from './fixtures/site'

/**
 * Serving and handing over a page set.
 *
 * Two separate ways a set can be half delivered, both of which look fine from the home page:
 * a live site that 404s on the pages the customer paid for, and a discharge zip containing one
 * file. Both are covered here, along with the key swap that has to reach every page.
 */

describe('resolving a request path to a stored page', () => {
  it('serves the home page at the root, with or without a trailing slash', () => {
    expect(siteObjectKey('example.com.au', '/')).toBe('sites/example.com.au/index.html')
    expect(siteObjectKey('example.com.au', '')).toBe('sites/example.com.au/index.html')
  })

  it('serves a service page whether or not the visitor typed the trailing slash', () => {
    const withSlash = siteObjectKey('example.com.au', '/services/blocked-drains/')
    const without = siteObjectKey('example.com.au', '/services/blocked-drains')
    expect(withSlash).toBe('sites/example.com.au/services/blocked-drains/index.html')
    expect(without).toBe(withSlash)
  })

  it('serves the sitemap and robots at their real names', () => {
    expect(siteObjectKey('example.com.au', '/sitemap.xml')).toBe('sites/example.com.au/sitemap.xml')
    expect(siteObjectKey('example.com.au', '/robots.txt')).toBe('sites/example.com.au/robots.txt')
  })

  it('refuses a traversal attempt rather than normalising it', () => {
    // Normalising is how one gets through. Anything with .. in it is simply not a page.
    expect(siteObjectKey('example.com.au', '/../../etc/passwd')).toBeNull()
    expect(siteObjectKey('example.com.au', '/services/../../secrets')).toBeNull()
    expect(siteObjectKey('example.com.au', '/services/%2e%2e/%2e%2e/x')).toBeNull()
  })

  it('keys are always inside that hostname, so one site cannot read another', () => {
    for (const path of ['/', '/services/x/', '/sitemap.xml', '/deep/nested/page/']) {
      expect(siteObjectKey('a.com.au', path)!.startsWith('sites/a.com.au/')).toBe(true)
    }
  })
})

describe('the Web3Forms key swap reaches every page', () => {
  const GO_POLAR = '11111111-2222-3333-4444-555555555555'
  const CUSTOMER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

  it('swaps the key on a service page, not only the home page', () => {
    const fixture = makeFixture({ ownPageServices: ['Blocked drains'] })
    const set = renderSiteSet(fixture.plan, fixture.facts)

    const service = set.pages.find((p) => p.path !== 'index.html')!
    // The renderer ships with whatever key the config gives it; force the known one in.
    const seeded = service.html.replace(/name="access_key" value="[^"]*"/g, `name="access_key" value="${GO_POLAR}"`)
    expect(seeded).toContain(GO_POLAR)

    const swapped = swapWeb3FormsKey(seeded, GO_POLAR, CUSTOMER)
    expect(swapped.html).not.toContain(GO_POLAR)
    expect(swapped.html).toContain(CUSTOMER)
    expect(swapped.usedPlaceholder).toBe(false)
  })

  it('falls back to a commented placeholder when there is no customer key', () => {
    const html = `<form action="x"><input name="access_key" value="${GO_POLAR}"></form>`
    const swapped = swapWeb3FormsKey(html, GO_POLAR, null)
    expect(swapped.usedPlaceholder).toBe(true)
    expect(swapped.html).not.toContain(GO_POLAR)
    // The comment is the only thing standing between them and silently losing every enquiry.
    expect(swapped.html).toContain('will not send anywhere')
  })

  it('refuses to treat a malformed key as a key', () => {
    const html = `<input name="access_key" value="${GO_POLAR}">`
    // 59 people typed an email address into this field on the old form. That is not a key.
    expect(swapWeb3FormsKey(html, GO_POLAR, 'chris@example.com').usedPlaceholder).toBe(true)
    expect(swapWeb3FormsKey(html, GO_POLAR, '0412 345 678').usedPlaceholder).toBe(true)
    expect(swapWeb3FormsKey(html, GO_POLAR, '').usedPlaceholder).toBe(true)
  })
})

describe('the discharge zip carries the whole set', () => {
  it('lists every page, the sitemap and robots, not just index.html', async () => {
    const fixture = makeFixture({ ownPageServices: ['Blocked drains', 'Hot water systems'] })
    const set = renderSiteSet(fixture.plan, fixture.facts)

    const home = set.pages.find((p) => p.path === 'index.html')!
    const extras = set.pages
      .filter((p) => p.path !== 'index.html')
      .map((p) => ({ path: p.path, html: p.html }))

    const pkg = await buildDischargePackage({
      jobId: 'job_test',
      html: home.html,
      plan: fixture.plan,
      facts: fixture.facts,
      customerWeb3FormsKey: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      extraPages: extras,
      extraFiles: [
        { path: 'sitemap.xml', content: '<urlset/>' },
        { path: 'robots.txt', content: 'User-agent: *' },
      ],
    })

    expect(pkg.files).toContain('index.html')
    expect(pkg.files).toContain('services/blocked-drains/index.html')
    expect(pkg.files).toContain('services/hot-water-systems/index.html')
    expect(pkg.files).toContain('sitemap.xml')
    expect(pkg.files).toContain('robots.txt')
    expect(pkg.files).toContain('READ-ME-FIRST.txt')
    expect(pkg.keySwapped).toBe(true)
  })

  it('names the service pages inside the zip itself, not just in the file list', async () => {
    const fixture = makeFixture({ ownPageServices: ['Blocked drains'] })
    const set = renderSiteSet(fixture.plan, fixture.facts)
    const home = set.pages.find((p) => p.path === 'index.html')!

    const pkg = await buildDischargePackage({
      jobId: 'job_test',
      html: home.html,
      plan: fixture.plan,
      facts: fixture.facts,
      customerWeb3FormsKey: null,
      extraPages: set.pages
        .filter((p) => p.path !== 'index.html')
        .map((p) => ({ path: p.path, html: p.html })),
    })

    // Zip entry names are stored as plain bytes in the local headers, so this reads the archive
    // rather than the summary the packager returned about itself.
    const raw = new TextDecoder('latin1').decode(pkg.zip)
    expect(raw).toContain('services/blocked-drains/index.html')
    expect(pkg.files.filter((f) => f.endsWith('.html')).length).toBeGreaterThan(1)
  })
})
