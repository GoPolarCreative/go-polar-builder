import { describe, expect, it } from 'vitest'
import { faviconHref, shareImageFor } from '../server/lib/render/headMeta'
import { makeFixture } from './fixtures/site'
import type { BuildFacts } from '../shared/plan'

/**
 * The tab icon and the share card.
 *
 * The failure these guard against is a quiet one: a page that renders perfectly, passes every
 * check, and shows a blank icon in the tab and a blank rectangle when it is pasted into Facebook
 * or a text message. Neither is visible from inside the product.
 */

const fixture = makeFixture()

/** The real fixture facts, with the logo or photos swapped for the case under test. */
function withAssets(over: Partial<Pick<BuildFacts, 'logo' | 'photos'>>): BuildFacts {
  return { ...fixture.facts, ...over } as BuildFacts
}

describe('the rendered home page carries both', () => {
  it('links a favicon, which it never used to', () => {
    expect(fixture.html).toContain('rel="icon"')
  })

  it('never declares a large share card without naming the image', () => {
    if (fixture.html.includes('summary_large_image')) {
      expect(fixture.html).toContain('property="og:image"')
    }
  })

  it('gives og:image an absolute URL, because a relative one does not resolve for a crawler', () => {
    const m = fixture.html.match(/property="og:image" content="([^"]+)"/)
    if (m) expect(m[1]).toMatch(/^https?:\/\//)
  })
})

describe('which file becomes the tab icon', () => {
  it('uses a squarish logo, which is what was asked for', () => {
    const logo = { path: 'assets/logo.png', fallback: null, width: 512, height: 512 }
    expect(faviconHref(withAssets({ logo }))?.href).toBe('assets/logo.png')
  })

  it('prefers an SVG logo, which stays sharp at any size', () => {
    const logo = { path: 'assets/logo.svg', fallback: null, width: 240, height: 200 }
    const icon = faviconHref(withAssets({ logo }))
    expect(icon).toEqual({ href: 'assets/logo.svg', type: 'image/svg+xml' })
  })

  it('prefers the PNG fallback over a WebP original, for home-screen shortcuts', () => {
    const logo = { path: 'assets/logo.webp', fallback: 'assets/logo.png', width: 400, height: 300 }
    expect(faviconHref(withAssets({ logo }))?.href).toBe('assets/logo.png')
  })

  it('REFUSES a wide lockup, which would be an unreadable smear at 16px', () => {
    // 1200x200 is aspect 6, well past the 3.2 the audit already flags.
    const logo = { path: 'assets/logo.png', fallback: null, width: 1200, height: 200 }
    expect(faviconHref(withAssets({ logo }))).toBeNull()
  })

  it('falls back to the generated mark when there is no logo at all', () => {
    expect(faviconHref(withAssets({ logo: null }))).toBeNull()
  })
})

describe('which picture goes in the share card', () => {
  it('prefers a real photo over the logo', () => {
    const share = shareImageFor(fixture.facts)
    expect(share?.path).toMatch(/^assets\/photo-01\.jpg$/)
  })

  it('uses the JPEG, never the WebP, because crawlers do not render WebP reliably', () => {
    const share = shareImageFor(fixture.facts)
    expect(share?.path).not.toMatch(/\.webp$/i)
  })

  it('falls back to a raster logo when there are no photos', () => {
    const logo = { path: 'assets/logo.webp', fallback: 'assets/logo.png', width: 512, height: 512 }
    expect(shareImageFor(withAssets({ photos: [], logo }))?.path).toBe('assets/logo.png')
  })

  it('RETURNS NULL rather than offering an SVG a crawler cannot render', () => {
    const logo = { path: 'assets/logo.svg', fallback: null, width: 240, height: 240 }
    expect(shareImageFor(withAssets({ photos: [], logo }))).toBeNull()
  })

  it('returns null for a build with no images at all', () => {
    expect(shareImageFor(withAssets({ photos: [], logo: null }))).toBeNull()
  })
})
