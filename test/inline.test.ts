import { afterEach, describe, expect, it } from 'vitest'
import { inlineAssets } from '../server/lib/inline'
import { setStorageForTests } from '../server/lib/storage'
import type { BuildFacts } from '../shared/plan'

/**
 * Inlining is what the preview shows the customer.
 *
 * The preview iframe has no base URL to resolve against, so every image is swapped for a data URI
 * before the page is handed over. That swap was a plain substring replace, which meant a service
 * page reference written `src="../../assets/photo-04.jpg"` came out as
 * `src="../../data:image/jpeg;base64,..."`: a relative URL starting two directories up, pointing
 * at nothing. Every photo on every service page was blank in the preview, for as long as service
 * pages have existed. Nobody caught it because the home page has no prefixes and is what gets
 * looked at.
 */

const bytes = new Uint8Array([1, 2, 3, 4])

function stubStorage() {
  setStorageForTests({
    get: async (key: string) => (key.startsWith('k/') ? bytes : null),
    getText: async () => null,
    put: async () => {},
    del: async () => {},
    list: async () => [],
  } as never)
}

function factsWith(paths: string[]): BuildFacts {
  return {
    assetManifest: Object.fromEntries(
      paths.map((p) => [p, { key: 'k/' + p, contentType: 'image/jpeg', bytes: 4 }]),
    ),
  } as unknown as BuildFacts
}

afterEach(() => setStorageForTests(null))

describe('inlining an asset takes the ../ in front of it too', () => {
  it('a home page reference, which never had a prefix, still works', async () => {
    stubStorage()
    const out = await inlineAssets(
      '<img src="assets/photo-01.jpg">',
      factsWith(['assets/photo-01.jpg']),
    )
    expect(out.inlined).toBe(1)
    expect(out.html).toContain('src="data:image/jpeg;base64,')
    expect(out.html).not.toContain('assets/photo-01.jpg')
  })

  it('A SERVICE PAGE REFERENCE DOES NOT COME OUT AS ../../data:', async () => {
    stubStorage()
    const out = await inlineAssets(
      '<img src="../../assets/photo-04.jpg">',
      factsWith(['assets/photo-04.jpg']),
    )
    expect(out.inlined).toBe(1)
    expect(out.html).not.toContain('../data:')
    expect(out.html).toContain('src="data:image/jpeg;base64,')
  })

  it('one directory up, which is what a page one level down would carry', async () => {
    stubStorage()
    const out = await inlineAssets('<img src="../assets/a.jpg">', factsWith(['assets/a.jpg']))
    expect(out.html).toContain('src="data:image/jpeg;base64,')
    expect(out.html).not.toContain('../data:')
  })

  it('a page carrying both, which is what a service page actually is', async () => {
    stubStorage()
    const out = await inlineAssets(
      '<img src="../../assets/logo.webp"><img src="../../assets/photo-04.jpg">',
      factsWith(['assets/logo.webp', 'assets/photo-04.jpg']),
    )
    expect(out.inlined).toBe(2)
    expect(out.html).not.toContain('../data:')
    expect(out.html.match(/src="data:image\/jpeg;base64,/g)).toHaveLength(2)
  })

  it('leaves a path it has no bytes for alone rather than mangling it', async () => {
    setStorageForTests({
      get: async () => null,
      getText: async () => null,
      put: async () => {},
      del: async () => {},
      list: async () => [],
    } as never)
    const out = await inlineAssets(
      '<img src="../../assets/gone.jpg">',
      factsWith(['assets/gone.jpg']),
    )
    expect(out.inlined).toBe(0)
    expect(out.missing).toEqual(['assets/gone.jpg'])
    expect(out.html).toContain('src="../../assets/gone.jpg"')
  })

  it('a longer path is still replaced before the shorter one it contains', async () => {
    stubStorage()
    const out = await inlineAssets(
      '<img src="../../assets/photo-01-thumb.jpg"><img src="../../assets/photo-01.jpg">',
      factsWith(['assets/photo-01.jpg', 'assets/photo-01-thumb.jpg']),
    )
    expect(out.html).not.toContain('assets/photo-01')
    expect(out.html).not.toContain('../data:')
  })
})
