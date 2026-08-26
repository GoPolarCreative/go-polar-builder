import { describe, expect, it } from 'vitest'
import { rewriteAssetPaths } from '../server/lib/publish'
import type { BuildFacts } from '../shared/plan'

/**
 * Publish-time asset rewriting.
 *
 * These exist because the rewrite was a plain substring replace, and two of the four ways this
 * codebase names an asset were being corrupted by it without anything failing:
 *
 *   - `../../assets/x.jpg` on a service page became `../../https://blob.../key`, so every image
 *     on every PAID service page was broken on the published site.
 *   - `https://theirsite.com.au/assets/logo.svg` in the JSON-LD, and now in og:image, became
 *     `https://theirsite.com.au/https://blob.../key`.
 *
 * The build passed and the pages rendered in both cases. Only the pictures were missing.
 */

const facts = {
  assetManifest: {
    'assets/logo.svg': { key: 'k1', bytes: 1, contentType: 'image/svg+xml' },
    'assets/photo-01.jpg': { key: 'k2', bytes: 1, contentType: 'image/jpeg' },
    'assets/photo-01.webp': { key: 'k3', bytes: 1, contentType: 'image/webp' },
    'assets/photo-01-thumb.webp': { key: 'k4', bytes: 1, contentType: 'image/webp' },
  },
} as unknown as BuildFacts

const urlFor = (k: string) => `https://blob.example/${k}`
const run = (html: string) => rewriteAssetPaths(html, facts, urlFor).html

describe('the case it was originally written for still works', () => {
  it('rewrites a bare relative path', () => {
    expect(run('<img src="assets/photo-01.jpg">')).toBe('<img src="https://blob.example/k2">')
  })

  it('still replaces the longer name before the shorter one it contains', () => {
    // photo-01-thumb.webp contains photo-01 but not photo-01.webp; the ordering guard matters
    // when a shorter manifest path is a prefix of a longer one.
    expect(run('<img src="assets/photo-01-thumb.webp">')).toBe('<img src="https://blob.example/k4">')
    expect(run('<img src="assets/photo-01.webp">')).toBe('<img src="https://blob.example/k3">')
  })
})

describe('a service page reference is no longer corrupted', () => {
  it('THE BUG: ../../ is swallowed rather than left in front of an absolute URL', () => {
    expect(run('<img src="../../assets/photo-01.jpg">')).toBe('<img src="https://blob.example/k2">')
  })

  it('handles a single ../ as well as a double', () => {
    expect(run('<img src="../assets/photo-01.jpg">')).toBe('<img src="https://blob.example/k2">')
  })

  it('handles a srcset with two different depths on one line', () => {
    const out = run('<source srcset="../../assets/photo-01.webp" type="image/webp">')
    expect(out).toBe('<source srcset="https://blob.example/k3" type="image/webp">')
  })
})

describe('an absolute URL is replaced whole, not appended to', () => {
  it('THE BUG: og:image does not become site.com.au/https://blob...', () => {
    expect(run('<meta property="og:image" content="https://site.com.au/assets/photo-01.jpg">')).toBe(
      '<meta property="og:image" content="https://blob.example/k2">',
    )
  })

  it('THE BUG: the JSON-LD image field, which has always built its URL this way', () => {
    expect(run('"image": "https://site.com.au/assets/logo.svg"')).toBe(
      '"image": "https://blob.example/k1"',
    )
  })

  it('does not merge two URLs that sit on the same line', () => {
    const out = run(
      '<meta content="https://site.com.au/assets/logo.svg"><meta content="https://site.com.au/assets/photo-01.jpg">',
    )
    expect(out).toBe('<meta content="https://blob.example/k1"><meta content="https://blob.example/k2">')
  })

  it('leaves an unrelated absolute URL completely alone', () => {
    const html = '<a href="https://www.google.com/maps/place/somewhere">Map</a>'
    expect(run(html)).toBe(html)
  })
})

describe('counting', () => {
  it('counts each manifest path it actually replaced', () => {
    const res = rewriteAssetPaths(
      '<img src="assets/photo-01.jpg"><img src="../../assets/logo.svg">',
      facts,
      urlFor,
    )
    expect(res.count).toBe(2)
  })

  it('counts nothing for a page that references no assets', () => {
    expect(rewriteAssetPaths('<p>no pictures here</p>', facts, urlFor).count).toBe(0)
  })
})
