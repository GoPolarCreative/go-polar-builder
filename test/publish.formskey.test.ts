import { describe, expect, it } from 'vitest'
import { applyFormsKey, assertNoGoPolarKey } from '../server/lib/web3forms'
import { renderSite } from '../server/lib/render/site'
import { makeFixture } from './fixtures/site'

/**
 * The customer's enquiry key has to reach the page that actually ships.
 *
 * publishJob reads the home page into `const homeHtml`, puts it into `pages[0]`, then walks
 * `pages` swapping Go Polar's Web3Forms key for the customer's. The loop writes
 * `pages[i].html` — a property on a different object — so the const kept pointing at the
 * original string, key and all. Every service page went out with the customer's key and the
 * home page went out with ours.
 *
 * It never leaked, because publishSite's assertNoGoPolarKey caught it. It caught it by
 * throwing, at the last step, after every check had passed: publishing was impossible and the
 * customer got an unhandled exception instead of one of the refusals.
 *
 * These tests are about the aliasing, which is the part no amount of reading the swap loop
 * reveals.
 */

const GO_POLAR = 'gp-0000-1111-2222'
const CUSTOMER = 'cust-3333-4444-5555'

/** The shape publishJob builds: a const for home, and an array it later mutates. */
function pagesAsPublishJobBuildsThem(homeHtml: string, servicePages: string[]) {
  const pages: Array<{ path: string; html: string }> = [{ path: 'index.html', html: homeHtml }]
  servicePages.forEach((html, i) => pages.push({ path: `services/s${i}/index.html`, html }))
  for (const page of pages) {
    const swapped = applyFormsKey(page.html, GO_POLAR, CUSTOMER)
    expect(swapped.clean, page.path).toBe(true)
    page.html = swapped.html
  }
  return pages
}

describe('the published home page carries the customer key', () => {
  const home = `<form><input name="access_key" value="${GO_POLAR}"></form>`
  const service = `<form><input name="access_key" value="${GO_POLAR}"></form>`

  it('THE ALIAS: the captured const is not the swapped page', () => {
    const homeHtml = home
    const pages = pagesAsPublishJobBuildsThem(homeHtml, [service])

    // The swap worked on the array...
    expect(pages[0]!.html).toContain(CUSTOMER)
    expect(pages[0]!.html).not.toContain(GO_POLAR)
    // ...and the const publishJob used to pass still holds the original. This is the bug.
    expect(homeHtml).toContain(GO_POLAR)
    expect(homeHtml).not.toBe(pages[0]!.html)
  })

  it('publishing the const would have thrown, which is why nothing could go live', () => {
    const homeHtml = home
    pagesAsPublishJobBuildsThem(homeHtml, [service])
    expect(() => assertNoGoPolarKey(homeHtml, GO_POLAR)).toThrow(/Refusing to publish/)
  })

  it('publishing what the array holds is accepted, for the home page and every service page', () => {
    const pages = pagesAsPublishJobBuildsThem(home, [service, service])
    for (const page of pages) {
      expect(() => assertNoGoPolarKey(page.html, GO_POLAR), page.path).not.toThrow()
      expect(page.html, page.path).toContain(CUSTOMER)
    }
  })

  it('a real rendered page carries a key at build time, so this was never hypothetical', () => {
    const { plan, facts } = makeFixture({})
    const html = renderSite(plan, facts)
    const keys = [...html.matchAll(/name="access_key" value="([^"]*)"/g)].map((m) => m[1])
    expect(keys.length, 'the home page should have at least one enquiry form').toBeGreaterThan(0)
    // Whatever the build embedded, the swap has to reach every one of them.
    const built = keys[0]!
    const swapped = applyFormsKey(html, built, CUSTOMER)
    expect(swapped.clean).toBe(true)
    expect([...swapped.html.matchAll(/name="access_key" value="([^"]*)"/g)].map((m) => m[1])).toEqual(
      keys.map(() => CUSTOMER),
    )
  })

  it('refuses rather than half-swapping when a page keeps the old key', () => {
    // A page whose key differs by a character is not swapped, and clean says so.
    const odd = `<form><input name="access_key" value="${GO_POLAR}-extra"></form>`
    const swapped = applyFormsKey(odd, GO_POLAR, CUSTOMER)
    expect(swapped.clean).toBe(true)
    // But a document that genuinely still holds the key is caught by the assert.
    expect(() => assertNoGoPolarKey(odd.replace('-extra', ''), GO_POLAR)).toThrow()
  })
})
