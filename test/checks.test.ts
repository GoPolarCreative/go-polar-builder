import { describe, expect, it } from 'vitest'
import type { CheckId, CheckResult } from '../shared/types'
import {
  PAGE_WEIGHT_FAIL,
  PAGE_WEIGHT_WARN,
  measurePageWeight,
  runStaticChecks,
} from '../server/lib/checks/static'
import { renderChecksSkipped, runRenderChecks } from '../server/lib/checks/render'
import { verify, failingChecks, reportPassed, summarise } from '../server/lib/verify'
import { makeFixture, testConfig } from './fixtures/site'

/**
 * The verification checks. Brief s6 gives 16; check 17, page weight, was added with the move to
 * Vercel, where bandwidth is billed.
 *
 * Checks 1 to 12 and 17 are tested both ways: the known-good document passes every one, and each
 * deliberately broken document trips the specific check that owns that fault.
 *
 * Checks 13 to 16 need a headless browser, which a unit test has no business launching. What is
 * tested is the property that actually protects a customer: with no driver they report "skipped"
 * and never "pass".
 */

const fixture = makeFixture()

function byId(results: CheckResult[], id: CheckId): CheckResult {
  const found = results.find((r) => r.id === id)
  if (!found) throw new Error(`No check with id ${id}`)
  return found
}

describe('a known good document', () => {
  it('passes every static check', async () => {
    const results = await runStaticChecks(fixture.html, fixture.facts)
    const failed = results.filter((r) => r.status === 'fail')
    expect(failed.map((f) => `${f.id}: ${f.detail} ${JSON.stringify(f.evidence ?? [])}`)).toEqual([])
  })

  it('returns all thirteen static checks, with no duplicates', async () => {
    const results = await runStaticChecks(fixture.html, fixture.facts)
    expect(results).toHaveLength(13)
    expect(new Set(results.map((r) => r.id)).size).toBe(13)
  })

  it('uses picture elements with a webp source and a jpeg fallback', () => {
    expect(fixture.html).toContain('<source type="image/webp"')
    expect(fixture.html).toMatch(/srcset="assets\/photo-01\.webp"/)
    expect(fixture.html).toMatch(/src="assets\/photo-01\.jpg"/)
  })

  it('uses thumbnails in the gallery, not full width files', () => {
    expect(fixture.html).toContain('assets/photo-01-thumb.webp')
  })
})

const BREAKAGES: Array<{ id: CheckId; name: string; mutate: (html: string) => string }> = [
  {
    id: 'hex_outside_root',
    name: 'a literal hex in a rule outside :root',
    mutate: (h) => h.replace('.card__link{font-weight:600', '.card__link{color:#c0392b;font-weight:600'),
  },
  {
    id: 'hex_outside_root',
    name: 'an rgba() outside :root',
    mutate: (h) => h.replace('.quote__who{font-weight:600', '.quote__who{background:rgba(0,0,0,0.2);font-weight:600'),
  },
  {
    id: 'hex_outside_root',
    name: 'a named colour outside :root',
    mutate: (h) => h.replace('.form-note{font-size:0.85rem', '.form-note{color:white;font-size:0.85rem'),
  },
  {
    id: 'hex_outside_root',
    name: 'a hex in an inline style attribute',
    mutate: (h) => h.replace('<div class="wrap">', '<div class="wrap" style="border-color:#ff0000">'),
  },
  {
    id: 'no_em_dash',
    name: 'an em dash in body copy',
    mutate: (h) => h.replace('<p class="lead">', '<p class="lead">Fast, fair — and local. '),
  },
  {
    id: 'no_em_dash',
    name: 'an em dash inside a comment',
    mutate: (h) => h.replace('<body>', '<body>\n<!-- built by hand — for testing -->'),
  },
  {
    id: 'no_emoji',
    name: 'an emoji in a heading',
    mutate: (h) => h.replace('<h2>Our services</h2>', '<h2>Our services \u{1F527}</h2>'),
  },
  {
    id: 'single_h1',
    name: 'a second h1',
    mutate: (h) => h.replace('<h2>Our services</h2>', '<h1>Our services</h1>'),
  },
  {
    id: 'heading_hierarchy',
    name: 'an h4 where an h3 belongs',
    mutate: (h) => h.replace('<h2>Get in touch</h2>', '<h4>Get in touch</h4>'),
  },
  {
    id: 'footer_credit',
    name: 'the credit reworded',
    mutate: (h) => h.replace('Website by Go Polar Creative', 'Site by Go Polar'),
  },
  {
    id: 'footer_credit',
    name: 'the credit missing target=_blank',
    mutate: (h) =>
      h.replace(
        '<a href="https://www.itscold.com.au" target="_blank" rel="noopener">',
        '<a href="https://www.itscold.com.au" rel="noopener">',
      ),
  },
  {
    id: 'jsonld_valid',
    name: 'a trailing comma in the JSON-LD',
    mutate: (h) => h.replace('"@context": "https://schema.org",', '"@context": "https://schema.org",,'),
  },
  {
    id: 'jsonld_valid',
    name: 'FAQ schema that does not match the page copy',
    mutate: (h) =>
      h.replace('"name": "What suburbs do you cover?"', '"name": "Do you offer a lifetime warranty?"'),
  },
  {
    id: 'form_action',
    name: 'a form posting somewhere else',
    mutate: (h) => h.replace('action="https://api.web3forms.com/submit"', 'action="/thanks"'),
  },
  {
    id: 'img_alt',
    name: 'an image with an empty alt',
    mutate: (h) => h.replace(/alt="[^"]*"/, 'alt=""'),
  },
  {
    id: 'lang_attr',
    name: 'the wrong language',
    mutate: (h) => h.replace('<html lang="en-AU">', '<html lang="en">'),
  },
  {
    id: 'assets_exist',
    name: 'an image that will not ship',
    mutate: (h) => h.replace('src="assets/photo-01.jpg"', 'src="assets/stock-plumber.jpg"'),
  },
  {
    id: 'assets_exist',
    name: 'a picture source pointing at a file that will not ship',
    mutate: (h) => h.replace('srcset="assets/photo-01.webp"', 'srcset="assets/not-generated.webp"'),
  },
]

describe('each broken document trips the right check', () => {
  for (const breakage of BREAKAGES) {
    it(`${breakage.id}: catches ${breakage.name}`, async () => {
      const mutated = breakage.mutate(fixture.html)
      // A mutation that changed nothing means the fixture moved and this test is lying.
      expect(mutated, 'mutation did not apply, the fixture has changed').not.toBe(fixture.html)

      const results = await runStaticChecks(mutated, fixture.facts)
      const check = byId(results, breakage.id)
      expect(check.status, `${breakage.id} did not fail. detail: ${check.detail}`).toBe('fail')
      expect(check.detail).toBeTruthy()
    })
  }
})

describe('check 17: page weight', () => {
  it('passes a normally sized site and reports the number', async () => {
    const check = byId(await runStaticChecks(fixture.html, fixture.facts), 'page_weight')
    expect(check.status).toBe('pass')
    expect(check.detail).toMatch(/total/)
  })

  it('keeps a processed site well under the 2MB target', async () => {
    const report = await verify(fixture.html, fixture.facts, { runRender: false })
    expect(report.pageWeightBytes).toBeGreaterThan(0)
    expect(report.pageWeightBytes).toBeLessThan(2 * 1024 * 1024)
  })

  it('counts the webp variants, not the jpeg fallbacks, because that is what a browser fetches', async () => {
    const report = await verify(fixture.html, fixture.facts, { runRender: false })
    const everyFile = Object.values(fixture.facts.assetManifest).reduce((sum, m) => sum + m.bytes, 0)
    expect(report.pageWeightBytes).toBeLessThan(everyFile)
  })

  it('warns above the warning line', async () => {
    const heavy = weighPageAt(PAGE_WEIGHT_WARN * 1.1)
    const check = byId(await runStaticChecks(fixture.html, heavy), 'page_weight')
    expect(check.status).toBe('warn')
    expect(check.evidence?.length).toBeGreaterThan(0)
  })

  it('fails above the hard limit', async () => {
    const check = byId(await runStaticChecks(fixture.html, weighPageAt(PAGE_WEIGHT_FAIL * 1.2)), 'page_weight')
    expect(check.status).toBe('fail')
  })

  it('a warning does not fail the build, a failure does', async () => {
    const warned = await verify(fixture.html, weighPageAt(PAGE_WEIGHT_WARN * 1.1), { runRender: false })
    expect(warned.passed).toBe(true)

    const failed = await verify(fixture.html, weighPageAt(PAGE_WEIGHT_FAIL * 1.2), { runRender: false })
    expect(failed.passed).toBe(false)
  })
})

/**
 * Build a facts object whose page weight lands at roughly  bytes.
 *
 * The count of files a page actually fetches is not obvious (JPEG fallbacks inside a picture are
 * never fetched, and not every processed file is referenced), so it is measured with a probe
 * rather than assumed.
 */
function weighPageAt(target: number): typeof fixture.facts {
  const PROBE = 1_000_000
  const probeWeight = measurePageWeight(fixture.html, inflateManifest(fixture.facts, PROBE))
  const htmlBytes = new TextEncoder().encode(fixture.html).byteLength
  const filesFetched = Math.max(1, Math.round((probeWeight - htmlBytes) / PROBE))
  return inflateManifest(fixture.facts, Math.ceil((target - htmlBytes) / filesFetched))
}

function inflateManifest(facts: typeof fixture.facts, bytesEach: number): typeof fixture.facts {
  return {
    ...facts,
    assetManifest: Object.fromEntries(
      Object.entries(facts.assetManifest).map(([path, meta]) => [path, { ...meta, bytes: bytesEach }]),
    ),
  }
}

describe('free quote suppression', () => {
  it('is skipped when the business does offer free quotes', async () => {
    const results = await runStaticChecks(fixture.html, fixture.facts)
    expect(byId(results, 'free_quote_absent').status).toBe('skipped')
  })

  it('fails when free quotes is No and the phrase is on the page', async () => {
    const results = await runStaticChecks(fixture.html, { ...fixture.facts, freeQuotes: false })
    const check = byId(results, 'free_quote_absent')
    expect(check.status).toBe('fail')
    expect(check.evidence?.length).toBeGreaterThan(0)
  })

  it('passes for a business with free quotes off when the site never says it', async () => {
    const noQuotes = makeFixture({ freeQuotes: false })
    const results = await runStaticChecks(noQuotes.html, noQuotes.facts)
    expect(byId(results, 'free_quote_absent').status).toBe('pass')
    expect(results.filter((r) => r.status === 'fail')).toEqual([])
  })

  it('catches it in any casing', async () => {
    const mutated = fixture.html.replace('<h2>Our services</h2>', '<h2>Our services and FREE Quote</h2>')
    const results = await runStaticChecks(mutated, { ...fixture.facts, freeQuotes: false })
    expect(byId(results, 'free_quote_absent').status).toBe('fail')
  })
})

describe('checks that must not produce false positives', () => {
  it('allows a literal hex in the theme-color meta, which cannot take a var()', async () => {
    expect(fixture.html).toMatch(/<meta name="theme-color" content="#[0-9a-f]{6}">/i)
    const results = await runStaticChecks(fixture.html, fixture.facts)
    expect(byId(results, 'hex_outside_root').status).toBe('pass')
  })

  it('allows the copyright symbol, which shares a Unicode property with emoji', async () => {
    expect(fixture.html).toContain('&copy;')
    const withChar = fixture.html.replace('&copy;', '©')
    const results = await runStaticChecks(withChar, fixture.facts)
    expect(byId(results, 'no_emoji').status).toBe('pass')
  })

  it('allows external font and anchor links in the asset check', async () => {
    expect(fixture.html).toContain('fonts.googleapis.com')
    expect(fixture.html).toContain('href="#contact"')
    const results = await runStaticChecks(fixture.html, fixture.facts)
    expect(byId(results, 'assets_exist').status).toBe('pass')
  })

  it('does not treat going back up from h3 to h2 as a skipped level', async () => {
    const results = await runStaticChecks(fixture.html, fixture.facts)
    expect(byId(results, 'heading_hierarchy').status).toBe('pass')
  })
})

describe('render checks 13 to 16', () => {
  it('report skipped, never pass, when no browser driver is available', async () => {
    testConfig({ renderDriver: 'none' })
    const report = await verify(fixture.html, fixture.facts)
    expect(report.render).toHaveLength(4)
    expect(report.render.map((r) => r.id)).toEqual([
      'renders_clean',
      'no_horizontal_overflow',
      'images_load',
      'interactions_work',
    ])
    for (const check of report.render) {
      expect(check.status).toBe('skipped')
      expect(check.detail).toBeTruthy()
    }
    expect(report.renderSkipped).toBe(true)
    testConfig()
  })

  it('a hosted driver with no endpoint skips with a reason rather than throwing', async () => {
    testConfig({ renderDriver: 'hosted', browserlessUrl: undefined })
    const results = await runRenderChecks(fixture.html)
    expect(results.every((r) => r.status === 'skipped')).toBe(true)
    expect(results[0]?.detail).toContain('BROWSERLESS_URL')
    testConfig()
  })

  it('a skip carries a reason and never counts as a pass', () => {
    const skipped = renderChecksSkipped('driver missing')
    expect(skipped.every((c) => c.status === 'skipped')).toBe(true)
    expect(skipped.some((c) => c.status === 'pass')).toBe(false)
  })
})

describe('the report as a whole', () => {
  it('passes overall when nothing failed, even with skips', async () => {
    const report = await verify(fixture.html, fixture.facts, { runRender: false })
    expect(report.passed).toBe(true)
    expect(failingChecks(report)).toEqual([])
    expect(summarise(report)).toContain('passed')
  })

  it('fails overall when any single check fails', async () => {
    const broken = fixture.html.replace('<html lang="en-AU">', '<html lang="en">')
    const report = await verify(broken, fixture.facts, { runRender: false })
    expect(report.passed).toBe(false)
    expect(failingChecks(report).map((c) => c.id)).toContain('lang_attr')
    expect(summarise(report)).toContain('failed')
  })

  it('treats a skipped check as not a failure', () => {
    expect(
      reportPassed(
        [{ id: 'lang_attr', label: 'lang', status: 'pass' }],
        [{ id: 'images_load', label: 'images', status: 'skipped' }],
      ),
    ).toBe(true)
  })

  it('treats a warning as not a failure', () => {
    expect(reportPassed([{ id: 'page_weight', label: 'weight', status: 'warn' }], [])).toBe(true)
  })
})
