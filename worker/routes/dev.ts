import { Hono } from 'hono'
import type { Env } from '../env'
import type { CheckId } from '../../shared/types'
import { intakeSchema, type IntakePayload } from '../../shared/intake'
import { getIntake, listAssets } from '../lib/db'
import { buildFacts } from '../lib/facts'
import { runStaticChecks } from '../lib/checks/static'

const app = new Hono<{ Bindings: Env }>()

/**
 * Verification self-test. DEVELOPMENT ONLY.
 *
 * A check that never fails is not a check. This takes a passing build, breaks it in twelve
 * specific ways, and asserts that the matching static check catches each one and that nothing
 * else fires by accident. It is how we know the Phase 3 suite is doing its job rather than
 * quietly returning "pass" on everything.
 *
 * GET /api/dev/selftest/:jobId/:version
 */

interface Mutation {
  expect: CheckId
  what: string
  apply: (html: string) => string
  /** Set when the mutation needs a different fact set rather than different HTML. */
  factsOverride?: 'no-free-quotes'
}

const MUTATIONS: Mutation[] = [
  {
    expect: 'hex_outside_root',
    what: 'a literal hex colour used in a rule instead of a token',
    apply: (h) => h.replace('.card__link{font-weight:600', '.card__link{color:#c0392b;font-weight:600'),
  },
  {
    expect: 'no_em_dash',
    what: 'an em dash in body copy',
    apply: (h) => h.replace('<p class="lead">', '<p class="lead">Fast, fair — and local. '),
  },
  {
    expect: 'no_emoji',
    what: 'an emoji in a heading',
    apply: (h) => h.replace('<h2>Our services</h2>', '<h2>Our services \u{1F527}</h2>'),
  },
  {
    expect: 'single_h1',
    what: 'a second h1',
    apply: (h) => h.replace('<h2>Our services</h2>', '<h1>Our services</h1>'),
  },
  {
    expect: 'heading_hierarchy',
    what: 'an h4 where an h3 belongs',
    apply: (h) => h.replace('<h2>Get in touch</h2>', '<h4>Get in touch</h4>'),
  },
  {
    expect: 'footer_credit',
    what: 'the Go Polar credit reworded',
    apply: (h) => h.replace('Website by Go Polar Creative', 'Site by Go Polar'),
  },
  {
    expect: 'jsonld_valid',
    what: 'a trailing comma in the JSON-LD',
    apply: (h) => h.replace('"@context": "https://schema.org",', '"@context": "https://schema.org",,'),
  },
  {
    expect: 'form_action',
    what: 'a form posting somewhere else',
    apply: (h) => h.replace('action="https://api.web3forms.com/submit"', 'action="/thanks"'),
  },
  {
    expect: 'img_alt',
    what: 'an image with an empty alt',
    apply: (h) => h.replace(/alt="[^"]*"/, 'alt=""'),
  },
  {
    expect: 'lang_attr',
    what: 'the wrong lang attribute',
    apply: (h) => h.replace('<html lang="en-AU">', '<html lang="en">'),
  },
  {
    expect: 'assets_exist',
    what: 'an image pointing at a file that will not ship',
    apply: (h) => h.replace(/src="assets\/photo-01\.[a-z]+"/, 'src="assets/stock-plumber.jpg"'),
  },
  {
    expect: 'free_quote_absent',
    what: '"free quote" on a site for a business that does not offer them',
    apply: (h) => h,
    factsOverride: 'no-free-quotes',
  },
]

app.get('/dev/selftest/:jobId/:version', async (c) => {
  if (c.env.SHOPIFY_WEBHOOK_SECRET) {
    return c.json({ error: 'disabled', detail: 'Self-test is off once Shopify is configured.' }, 403)
  }

  const jobId = c.req.param('jobId')
  const version = Number(c.req.param('version'))

  const row = await c.env.DB.prepare('SELECT r2_key FROM builds WHERE job_id = ? AND version = ?')
    .bind(jobId, version)
    .first<{ r2_key: string }>()
  if (!row) return c.json({ error: 'not_found', detail: 'No such build' }, 404)

  const object = await c.env.BUCKET.get(row.r2_key)
  if (!object) return c.json({ error: 'not_found', detail: 'Build missing from storage' }, 404)
  const html = await object.text()

  const stored = await getIntake(c.env, jobId)
  const parsed = intakeSchema.safeParse(stored?.payload)
  if (!parsed.success) return c.json({ error: 'invalid_intake' }, 422)
  const assets = await listAssets(c.env, jobId)
  const facts = buildFacts(c.env, parsed.data as IntakePayload, assets)

  // Baseline: the unmutated build must pass everything.
  const baseline = await runStaticChecks(html, facts)
  const baselineFailures = baseline.filter((r) => r.status === 'fail')

  const results = []
  for (const mutation of MUTATIONS) {
    const mutatedHtml = mutation.apply(html)
    const mutatedFacts =
      mutation.factsOverride === 'no-free-quotes' ? { ...facts, freeQuotes: false } : facts

    const applied = mutation.factsOverride ? true : mutatedHtml !== html
    const checks = applied ? await runStaticChecks(mutatedHtml, mutatedFacts) : []
    const failed = checks.filter((r) => r.status === 'fail').map((r) => r.id)

    results.push({
      expect: mutation.expect,
      what: mutation.what,
      // A mutation that did not change anything means the fixture moved and the test is lying.
      mutationApplied: applied,
      caught: failed.includes(mutation.expect),
      collateral: failed.filter((f) => f !== mutation.expect),
      detail: checks.find((r) => r.id === mutation.expect)?.detail ?? null,
    })
  }

  const missed = results.filter((r) => !r.mutationApplied || !r.caught)

  return c.json({
    jobId,
    version,
    baselinePasses: baselineFailures.length === 0,
    baselineFailures: baselineFailures.map((f) => ({ id: f.id, detail: f.detail })),
    total: results.length,
    caught: results.filter((r) => r.caught).length,
    ok: baselineFailures.length === 0 && missed.length === 0,
    results,
  })
})

export default app
