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

  it('returns all seventeen static checks, with no duplicates', async () => {
    const results = await runStaticChecks(fixture.html, fixture.facts)
    expect(results).toHaveLength(17)
    expect(new Set(results.map((r) => r.id)).size).toBe(17)
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
    mutate: (h) => h.replace('.link-arrow{display:inline-flex', '.link-arrow{color:#c0392b;display:inline-flex'),
  },
  {
    id: 'hex_outside_root',
    name: 'an rgba() outside :root',
    mutate: (h) => h.replace('.quote__who{margin-top:auto', '.quote__who{background:rgba(0,0,0,0.2);margin-top:auto'),
  },
  {
    id: 'hex_outside_root',
    name: 'a named colour outside :root',
    mutate: (h) => h.replace('.form-note{font-size:0.78rem', '.form-note{color:white;font-size:0.78rem'),
  },
  {
    id: 'hex_outside_root',
    name: 'a hex in an inline style attribute',
    mutate: (h) => h.replace('<div class="wrap">', '<div class="wrap" style="border-color:#ff0000">'),
  },
  {
    id: 'no_em_dash',
    name: 'an em dash in body copy',
    mutate: (h) => h.replace('<p class="hero__sub">', '<p class="hero__sub">Fast, fair — and local. '),
  },
  {
    id: 'no_em_dash',
    name: 'an em dash inside a comment',
    mutate: (h) => h.replace('<body>', '<body>\n<!-- built by hand — for testing -->'),
  },
  {
    id: 'no_emoji',
    name: 'an emoji in a heading',
    mutate: (h) => h.replace('<h2>Get in touch</h2>', '<h2>Get in touch \u{1F527}</h2>'),
  },
  {
    id: 'single_h1',
    name: 'a second h1',
    mutate: (h) => h.replace('<h2>Get in touch</h2>', '<h1>Get in touch</h1>'),
  },
  {
    // The real one, seen in production: the header section and the footer section each emit a
    // bar. Both are valid markup on their own, so nothing else in the suite notices, and the
    // page renders one copy clipped behind the fixed header and one in the right place.
    id: 'single_mobile_bar',
    name: 'a second mobile sticky bar emitted after the header',
    mutate: (h) =>
      h.replace(
        '</header>',
        '</header><div class="mobile-bar"><a class="mobile-bar__call" href="tel:+61400000000">Call now</a></div>',
      ),
  },
  {
    id: 'single_mobile_bar',
    name: 'no mobile sticky bar at all',
    mutate: (h) => h.replace('<div class="mobile-bar">', '<div class="not-the-bar">'),
  },
  {
    id: 'heading_hierarchy',
    name: 'an h4 where an h3 belongs',
    mutate: (h) => h.replace('<h3>Blocked drains</h3>', '<h5>Blocked drains</h5>'),
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

describe('render checks 13 to 16, and 22, 23 and 25', () => {
  it('report skipped, never pass, when no browser driver is available', async () => {
    testConfig({ renderDriver: 'none' })
    const report = await verify(fixture.html, fixture.facts)
    expect(report.render).toHaveLength(7)
    expect(report.render.map((r) => r.id)).toEqual([
      'renders_clean',
      'no_horizontal_overflow',
      'images_load',
      'interactions_work',
      'text_not_squeezed',
      'header_closed_at_rest',
      'text_is_visible',
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

/**
 * Check 20, the logo's aspect ratio.
 *
 * The case is Driftwood Building Co: a 565 by 600 mark, very nearly square, declared in the header
 * as 150 by 40. Every other check passed on that page and the customer's branding still rendered
 * squashed, because nothing compared the file against what the document said about it.
 */
describe('the logo is drawn in the shape it actually is', () => {
  const SQUARE = { path: 'assets/logo.webp', fallback: 'assets/logo.png', width: 565, height: 600 }

  const withLogo = (logo: typeof SQUARE | null) => ({ ...fixture.facts, logo })
  const page = (tag: string) => `<!DOCTYPE html><html lang="en-AU"><body>${tag}</body></html>`

  it('fails a near-square logo drawn as a wide wordmark', async () => {
    const html = page('<img src="assets/logo.png" alt="Driftwood logo" width="150" height="40">')
    const r = byId(await runStaticChecks(html, withLogo(SQUARE)), 'logo_aspect')
    expect(r.status).toBe('fail')
    // The detail has to say what to write instead, or it is a complaint rather than a fix.
    expect(r.evidence?.join(' ')).toContain('width must be about 38')
  })

  it('passes when the drawn ratio matches the file', async () => {
    const html = page('<img src="assets/logo.png" alt="Driftwood logo" width="57" height="60">')
    expect(byId(await runStaticChecks(html, withLogo(SQUARE)), 'logo_aspect').status).toBe('pass')
  })

  it('tolerates whole-pixel rounding rather than demanding an exact ratio', async () => {
    // 56/60 is 0.933 against a real 0.942. Rounding, not a squashed logo.
    const html = page('<img src="assets/logo.png" alt="Driftwood logo" width="56" height="60">')
    expect(byId(await runStaticChecks(html, withLogo(SQUARE)), 'logo_aspect').status).toBe('pass')
  })

  it('fails a logo with no dimensions at all', async () => {
    const html = page('<img src="assets/logo.png" alt="Driftwood logo">')
    expect(byId(await runStaticChecks(html, withLogo(SQUARE)), 'logo_aspect').status).toBe('fail')
  })

  it('matches the webp the page actually references, not just the png fallback', async () => {
    const html = page('<img src="assets/logo.webp" alt="Driftwood logo" width="150" height="40">')
    expect(byId(await runStaticChecks(html, withLogo(SQUARE)), 'logo_aspect').status).toBe('fail')
  })

  /*
   * The two skips. Both are "there is nothing to compare", never "we did not look": a business with
   * no artwork gets a CSS wordmark, which has no intrinsic ratio to violate.
   */
  it('skips when no logo was supplied', async () => {
    const html = page('<span class="logotype">LSV Services</span>')
    expect(byId(await runStaticChecks(html, withLogo(null)), 'logo_aspect').status).toBe('skipped')
  })

  it('skips when a logo exists but the build chose a text treatment', async () => {
    const html = page('<span class="logotype">Driftwood</span>')
    expect(byId(await runStaticChecks(html, withLogo(SQUARE)), 'logo_aspect').status).toBe('skipped')
  })
})

/**
 * Check 21, escaped markup showing itself to the reader.
 *
 * Verified against the four pages that actually shipped with it, on Driftwood Building Co and LSV
 * Services, before they were rebuilt. Twenty checks passed on each of those pages.
 */
describe('no tag is shown to the reader as text', () => {
  const page = (body: string) => `<!DOCTYPE html><html lang="en-AU"><body>${body}</body></html>`
  const status = async (body: string) =>
    byId(await runStaticChecks(page(body), fixture.facts), 'no_escaped_markup').status

  it('fails the exact heading that shipped on Driftwood', async () => {
    expect(await status('<h1>Timber decks built for &lt;em&gt;Bass Coast living&lt;/em&gt;</h1>')).toBe('fail')
  })

  it('fails any escaped tag, not just em', async () => {
    expect(await status('<p>Call us &lt;strong&gt;today&lt;/strong&gt;</p>')).toBe('fail')
    expect(await status('<p>A line&lt;br /&gt;and another</p>')).toBe('fail')
    expect(await status('<p>&lt;a href="/x"&gt;here&lt;/a&gt;</p>')).toBe('fail')
  })

  it('names the line so it can be found', async () => {
    const r = byId(
      await runStaticChecks(page('<h1>Decks for &lt;em&gt;the Bass Coast&lt;/em&gt;</h1>'), fixture.facts),
      'no_escaped_markup',
    )
    expect(r.evidence?.[0]).toMatch(/^line \d+:/)
  })

  /*
   * The false positives that would make this check unusable. An escaped ampersand or a bare
   * less-than is ordinary Australian trade copy, not markup.
   */
  it('passes a bare less-than, which is prose', async () => {
    expect(await status('<p>Callbacks in &lt; 2 hours, every time we can manage it.</p>')).toBe('pass')
  })

  it('passes an escaped ampersand', async () => {
    expect(await status('<p>Decks &amp; pergolas built across the Bass Coast.</p>')).toBe('pass')
  })

  it('passes real markup, which is the normal case', async () => {
    expect(await status('<h1>Timber decks built for <em>Bass Coast living</em></h1>')).toBe('pass')
  })

  it('passes the known good document', async () => {
    expect(byId(await runStaticChecks(fixture.html, fixture.facts), 'no_escaped_markup').status).toBe('pass')
  })
})

/**
 * The Google reviews block.
 *
 * We were collecting the review link and the reviewer names and rendering them as anonymous pull
 * quotes, which is the weakest form the same information can take: a reader cannot tell whether we
 * wrote them. The mark, the rating and a link to the profile make the identical words checkable in
 * one tap. See the reference sites Chris supplied, all three of which lead with this.
 */
describe('reviews are attributed to Google when there is a profile', () => {
  const withGoogle = (extra: Record<string, unknown>) =>
    makeFixture({ googleReviewLink: 'https://g.page/r/CdTest/review', ...extra })

  /*
   * THE COUNT IS GONE, THE SCORE AND THE MARK STAY.
   *
   * The about panel counted the testimonials supplied and this badge counted the Google profile,
   * so one page carried two different review numbers. Both were honest about different things
   * and neither said so. The score, the mark and the link to the profile are the checkable part.
   */
  it('renders the rating and the mark, and no count', () => {
    const f = withGoogle({ googleRating: 4.9, googleReviewCount: 87 })
    expect(f.html).toContain('<div class="rating-badge">')
    expect(f.html).toContain('>4.9<')
    expect(f.html).toContain('g-mark')
    expect(f.html).not.toMatch(/d+ reviews/)
  })

  it('still shows the badge when only a score and a link were supplied', () => {
    // The count is no longer printed, so it is no longer a reason to withhold the badge.
    const f = withGoogle({ googleRating: 4.8, googleReviewCount: null })
    expect(f.html).toContain('<div class="rating-badge">')
    expect(f.html).toContain('>4.8<')
  })

  it('links to the profile to read and to leave a review', () => {
    const f = withGoogle({ googleRating: 4.9, googleReviewCount: 87 })
    expect(f.html).toContain('Read our reviews on Google')
    expect(f.html).toContain('Leave a Google review')
    // Three: the hero rating line, and the two buttons under the reviews.
    expect((f.html.match(/g\.page\/r\/CdTest/g) ?? []).length).toBe(3)
  })

  /*
   * THE CASE THAT MUST NEVER RENDER. A score with no profile behind it is exactly the
   * unverifiable claim rule 1 exists to stop, so facts drops the rating unless a link came with
   * it. Tested here rather than trusted, because the failure is silent and looks fine.
   */
  it('refuses to show a rating with no profile to check it against', () => {
    const f = makeFixture({ googleReviewLink: '', googleRating: 4.9, googleReviewCount: 87 })
    expect(f.facts.googleRating).toBeNull()
    expect(f.facts.googleReviewCount).toBeNull()
    expect(f.html).not.toContain('<div class="rating-badge">')
    expect(f.html).not.toContain('Posted on Google')
    expect(f.html).not.toContain('Leave a Google review')
  })

  it('still shows the quotes when there is a link but no rating', () => {
    const f = withGoogle({})
    expect(f.html).not.toContain('<div class="rating-badge">')
    expect(f.html).toContain('Posted on Google')
    expect(f.html).toContain('Leave a Google review')
  })

  it('keeps every Google colour in :root, so check 1 still passes', async () => {
    const f = withGoogle({ googleRating: 4.9, googleReviewCount: 87 })
    expect(byId(await runStaticChecks(f.html, f.facts), 'hex_outside_root').status).toBe('pass')
  })

  it('passes every static check with the block present', async () => {
    const f = withGoogle({ googleRating: 4.9, googleReviewCount: 87 })
    const failed = (await runStaticChecks(f.html, f.facts)).filter((r) => r.status === 'fail')
    expect(failed.map((x) => `${x.id}: ${x.detail}`)).toEqual([])
  })
})

/**
 * Check 23, a closed menu is closed.
 *
 * A fencing site shipped with the Services dropdown hanging open from page load: a white panel
 * under the nav covering the FAQ link beside it and sitting on the hero headline. The model wrote
 * the panel and the hover rule and left out the resting state.
 *
 * Nothing else in the suite saw it. The page is not too wide, no text is squeezed, the markup is
 * valid. It is simply open when it should be shut, which only geometry can see.
 */
describe('nothing in the header hangs open at rest', () => {
  const withDropdown = (extraCss: string) =>
    fixture.html
      .replace('</head>', `<style>.nav-item{position:relative;}${extraCss}</style></head>`)
      .replace(
        /<nav([^>]*)>/i,
        '<nav$1><span class="nav-item"><a href="#services">Services</a>' +
          '<div class="gp-dropdown"><a href="services/fencing/index.html">Fencing</a></div></span>',
      )

  const OPEN = '.gp-dropdown{position:absolute;top:100%;left:0;background:#fff;padding:16px;z-index:60;}'
  const CLOSED = OPEN + '.gp-dropdown{display:none;}.nav-item:hover .gp-dropdown,.nav-item:focus-within .gp-dropdown{display:block;}'

  it('fails the exact fault that shipped', async () => {
    const r = byId(await runRenderChecks(withDropdown(OPEN)), 'header_closed_at_rest')
    expect(r.status).toBe('fail')
    expect(r.evidence?.join(' ')).toMatch(/hangs \d+px below the header at rest/)
  })

  it('tells the repair what to write, not just that it is wrong', async () => {
    const r = byId(await runRenderChecks(withDropdown(OPEN)), 'header_closed_at_rest')
    expect(r.detail).toMatch(/display:none/)
    expect(r.detail).toMatch(/focus-within/)
  })

  it('passes once the dropdown has a resting state', async () => {
    const r = byId(await runRenderChecks(withDropdown(CLOSED)), 'header_closed_at_rest')
    expect(r.status).toBe('pass')
  })

  it('passes the known good document, which has no dropdown at all', async () => {
    const r = byId(await runRenderChecks(fixture.html), 'header_closed_at_rest')
    expect(r.status).toBe('pass')
  })

  /*
   * The overlap with check 14 is the point. A dropdown hanging open is not horizontal overflow,
   * so check 14 passed on the shipped site and would again.
   */
  it('is not something check 14 can see', async () => {
    const rs = await runRenderChecks(withDropdown(OPEN))
    expect(byId(rs, 'no_horizontal_overflow').status).toBe('pass')
    expect(byId(rs, 'header_closed_at_rest').status).toBe('fail')
  })
})
