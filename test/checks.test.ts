import { describe, expect, it } from 'vitest'
import type { CheckId, CheckResult } from '../shared/types'
import { runStaticChecks } from '../worker/lib/checks/static'
import { renderChecksSkipped } from '../worker/lib/checks/render'
import { verify, failingChecks, reportPassed, summarise } from '../worker/lib/verify'
import { makeFixture, TEST_ENV } from './fixtures/site'

/**
 * The 16 verification checks from brief section 6.
 *
 * Checks 1 to 12 are tested both ways: the known-good document must pass every one, and each
 * deliberately broken document must trip the specific check that owns that fault.
 *
 * Checks 13 to 16 need Browser Rendering, which cannot exist in a unit test. What is tested is
 * the property that actually protects a customer: with no binding they report "skipped" and
 * never "pass".
 */

const fixture = makeFixture()

function byId(results: CheckResult[], id: CheckId): CheckResult {
  const found = results.find((r) => r.id === id)
  if (!found) throw new Error(`No check with id ${id}`)
  return found
}

describe('a known good document', () => {
  it('passes all twelve static checks', async () => {
    const results = await runStaticChecks(fixture.html, fixture.facts)
    const failed = results.filter((r) => r.status === 'fail')
    expect(
      failed.map((f) => `${f.id}: ${f.detail} ${JSON.stringify(f.evidence ?? [])}`),
    ).toEqual([])
  })

  it('returns exactly the twelve static checks', async () => {
    const results = await runStaticChecks(fixture.html, fixture.facts)
    expect(results).toHaveLength(12)
    expect(new Set(results.map((r) => r.id)).size).toBe(12)
  })
})

// Each entry: a mutation, and the check that must catch it.
const BREAKAGES: Array<{
  id: CheckId
  name: string
  mutate: (html: string) => string
  factsOverride?: Partial<typeof fixture.facts>
}> = [
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
      h.replace(
        '"name": "What suburbs do you cover?"',
        '"name": "Do you offer a lifetime warranty on all work?"',
      ),
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
    mutate: (h) => h.replace(/src="assets\/photo-01\.[a-z]+"/, 'src="assets/stock-plumber.jpg"'),
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
    // and the whole document is still clean
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
  it('report skipped, never pass, when there is no Browser Rendering binding', async () => {
    const report = await verify(TEST_ENV, fixture.html, fixture.facts, fixture.assets)
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
  })

  it('a skip carries a reason and never counts as a pass', () => {
    const skipped = renderChecksSkipped('binding missing')
    expect(skipped.every((c) => c.status === 'skipped')).toBe(true)
    expect(skipped.some((c) => c.status === 'pass')).toBe(false)
  })
})

describe('the report as a whole', () => {
  it('passes overall when nothing failed, even with skips', async () => {
    const report = await verify(TEST_ENV, fixture.html, fixture.facts, fixture.assets)
    expect(report.passed).toBe(true)
    expect(failingChecks(report)).toEqual([])
    expect(summarise(report)).toContain('passed')
  })

  it('fails overall when any single check fails', async () => {
    const broken = fixture.html.replace('<html lang="en-AU">', '<html lang="en">')
    const report = await verify(TEST_ENV, broken, fixture.facts, fixture.assets)
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
})
