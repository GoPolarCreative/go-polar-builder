import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '../db/client'
import type { CheckId } from '../../shared/types'
import { intakeSchema, type IntakePayload } from '../../shared/intake'
import { config } from '../config'
import { getIntake, listAssets } from '../lib/db'
import { buildFacts } from '../lib/facts'
import { runStaticChecks } from '../lib/checks/static'
import { storage } from '../lib/storage'

const app = new Hono()

/**
 * Verification self-test. DEVELOPMENT ONLY.
 *
 * A check that never fails is not a check. This takes a passing build, breaks it in specific
 * ways, and asserts that the matching static check catches each one and that nothing else fires
 * by accident. It is how we know the check suite is doing its job rather than quietly returning
 * "pass" on everything.
 *
 * GET /api/dev/selftest/:jobId/:version
 */

interface Mutation {
  expect: CheckId
  what: string
  apply: (html: string) => string
  factsOverride?: 'no-free-quotes' | 'huge-images'
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
    apply: (h) => h.replace(/src="assets\/photo-01\.jpg"/, 'src="assets/stock-plumber.jpg"'),
  },
  {
    expect: 'free_quote_absent',
    what: '"free quote" on a site for a business that does not offer them',
    apply: (h) => h,
    factsOverride: 'no-free-quotes',
  },
  {
    expect: 'page_weight',
    what: 'images heavy enough to blow the page weight budget',
    apply: (h) => h,
    factsOverride: 'huge-images',
  },
]

app.get('/dev/selftest/:jobId/:version', async (c) => {
  if (config().shopify.webhookSecret) {
    return c.json({ error: 'disabled', detail: 'Self-test is off once Shopify is configured.' }, 403)
  }

  const jobId = c.req.param('jobId')
  const version = Number(c.req.param('version'))

  const db = await getDb()
  const rows = await db
    .select({ blobKey: schema.builds.blobKey })
    .from(schema.builds)
    .where(and(eq(schema.builds.jobId, jobId), eq(schema.builds.version, version)))
    .limit(1)
  if (!rows[0]) return c.json({ error: 'not_found', detail: 'No such build' }, 404)

  const html = await storage().getText(rows[0].blobKey)
  if (html === null) return c.json({ error: 'not_found', detail: 'Build missing from storage' }, 404)

  const stored = await getIntake(jobId)
  const parsed = intakeSchema.safeParse(stored?.payload)
  if (!parsed.success) return c.json({ error: 'invalid_intake' }, 422)
  const assets = await listAssets(jobId)
  const facts = buildFacts(parsed.data as IntakePayload, assets)

  // Baseline: the unmutated build must pass everything.
  const baseline = await runStaticChecks(html, facts)
  const baselineFailures = baseline.filter((r) => r.status === 'fail')

  const results = []
  for (const mutation of MUTATIONS) {
    const mutatedHtml = mutation.apply(html)

    let mutatedFacts = facts
    if (mutation.factsOverride === 'no-free-quotes') {
      mutatedFacts = { ...facts, freeQuotes: false }
    } else if (mutation.factsOverride === 'huge-images') {
      // Pretend every shipped file is 3MB. Cheaper than generating a 20MB fixture, and it is the
      // manifest the check reads.
      mutatedFacts = {
        ...facts,
        assetManifest: Object.fromEntries(
          Object.entries(facts.assetManifest).map(([path, meta]) => [path, { ...meta, bytes: 3_000_000 }]),
        ),
      }
    }

    const applied = mutation.factsOverride ? true : mutatedHtml !== html
    const checks = applied ? await runStaticChecks(mutatedHtml, mutatedFacts) : []
    const failed = checks.filter((r) => r.status === 'fail').map((r) => r.id)

    results.push({
      expect: mutation.expect,
      what: mutation.what,
      // A mutation that changed nothing means the fixture moved and the test is lying.
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
