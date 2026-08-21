/**
 * Produce a paste-ready environment block for the Vercel project.
 *
 *   node scripts/make-vercel-env.mjs
 *
 * Vercel's project settings take a whole .env pasted at once, which is far less error prone than
 * typing twenty variables into twenty boxes. This writes `vercel-env.txt` (gitignored) containing:
 *
 *   - every value already settled in .env.local, carried across as it is
 *   - every value that must differ in production, set to the production value
 *   - every secret that is not on this machine, left blank with a note saying where it comes from
 *
 * It never invents a secret and never guesses one. A blank line in the output is a real gap and is
 * listed at the end, so nothing is missed by scrolling past it.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const LOCAL = '.env.local'
const OUT = 'vercel-env.txt'

const local = existsSync(LOCAL) ? readFileSync(LOCAL, 'utf8') : ''
const read = (key) => {
  const match = local.match(new RegExp(`^${key}=(.*)$`, 'm'))
  const value = match ? match[1].trim() : ''
  return value
}

/**
 * `carry` takes whatever is on this machine. `fixed` overrides it, for the handful of values that
 * must be different in production. `needed` is a secret that only exists somewhere else.
 */
const SECTIONS = [
  {
    title: 'Core. Nothing works without these.',
    vars: [
      { key: 'PUBLIC_APP_URL', fixed: 'https://build.itscold.com.au' },
      { key: 'APP_SECRET', carry: true, note: 'signs customer sessions' },
      { key: 'ADMIN_TOKEN', carry: true, note: 'guards /api/admin/*' },
      { key: 'ANTHROPIC_API_KEY', carry: true, note: 'plain variable, never VITE_ prefixed' },
      { key: 'ANTHROPIC_MODEL', carry: true, fallback: 'claude-sonnet-5' },
      { key: 'WEB3FORMS_ACCESS_KEY', carry: true, note: 'Go Polar account, preview and editing only' },
    ],
  },
  {
    title: 'Mode. These are what make it real.',
    vars: [
      { key: 'DEMO_MODE', fixed: '0', note: 'at 1, nothing is real' },
      { key: 'DEV_OFFLINE_GENERATION', fixed: '', note: 'MUST be empty, or every build is a fixture' },
      { key: 'ENABLE_LIVE_PAYMENTS', fixed: '1' },
      { key: 'ENABLE_LIVE_EMAIL', fixed: '1' },
      { key: 'ENABLE_LIVE_DOMAINS', fixed: '1' },
    ],
  },
  {
    title: 'Shopify. The six ids are already known; the three secrets are not.',
    vars: [
      { key: 'SHOPIFY_STORE_DOMAIN', carry: true, fallback: 'itscold.myshopify.com' },
      { key: 'SHOPIFY_VARIANT_WEBSITE_HOSTING_AUSTRALIA', carry: true },
      { key: 'SHOPIFY_SELLING_PLAN_WEBSITE_HOSTING_AUSTRALIA', carry: true },
      { key: 'SHOPIFY_VARIANT_DOMAIN_1_YEAR', carry: true },
      { key: 'SHOPIFY_SELLING_PLAN_DOMAIN_1_YEAR', carry: true },
      { key: 'SHOPIFY_VARIANT_EMAIL_HOSTING', carry: true },
      { key: 'SHOPIFY_SELLING_PLAN_EMAIL_HOSTING', carry: true },
      { key: 'SHOPIFY_WEBHOOK_SECRET', needed: 'shown once when you create the webhook, DEPLOY.md section 7' },
      { key: 'SHOPIFY_CLIENT_ID', needed: 'Dev Dashboard app, Settings page, DEPLOY.md section 6' },
      { key: 'SHOPIFY_CLIENT_SECRET', needed: 'Dev Dashboard app, Settings page. Keep it secret' },
      { key: 'SHOPIFY_STOREFRONT_TOKEN', needed: 'DEPLOY.md section 6, unauthenticated_write_checkouts' },
    ],
  },
  {
    title: 'Email and domains. Klaviyo sends every customer email.',
    vars: [
      { key: 'KLAVIYO_API_KEY', needed: 'Klaviyo, Settings, API Keys, private key with write access to events' },
      { key: 'VERCEL_API_TOKEN', needed: 'only for attaching customer domains automatically' },
      { key: 'VERCEL_PROJECT_ID', needed: 'Vercel project settings, once the project exists' },
      { key: 'CRON_SECRET', carry: true, needed: 'any random string; guards the hourly sweep' },
    ],
  },
]

/*
 * Every key emitted here must be one the app actually reads.
 *
 * An early version of this file emitted variable names the app does not read. They would have been
 * pasted into Vercel, looked completely correct
 * in the dashboard, and done nothing at all. That is the exact failure this file exists to
 * prevent, so it now checks itself against the one thing that decides: server/config.ts.
 */
const sources = ['server/config.ts', 'shared/pricing.ts'].map((f) => readFileSync(f, 'utf8')).join('\n')

// A name counts as read if it appears literally in either file. That covers env('X'),
// process.env.X and bare string keys without having to model each one.
const literal = (key) => sources.includes(key)

/*
 * The six subscription ids are built at runtime from the product ref, so no whole name appears in
 * either file. Rather than loosen the check, rebuild the exact same names the app builds: take
 * every kebab-case string in pricing.ts and apply the transform from variantEnvKey and
 * sellingPlanEnvKey. If a name is not in this set, the app will never look for it.
 */
const refs = [...sources.matchAll(/'([a-z][a-z0-9]*(?:-[a-z0-9]+)+)'/g)].map((m) => m[1])
const derivedNames = new Set(
  refs.flatMap((ref) => {
    const suffix = ref.replace(/-/g, '_').toUpperCase()
    return [`SHOPIFY_VARIANT_${suffix}`, `SHOPIFY_SELLING_PLAN_${suffix}`]
  }),
)
const derived = (key) => derivedNames.has(key)

// Read by their own libraries rather than by our config: Drizzle and Vercel Blob.
const readElsewhere = new Set(['DATABASE_URL', 'BLOB_READ_WRITE_TOKEN'])

const unknown = SECTIONS.flatMap((section) => section.vars)
  .map((spec) => spec.key)
  .filter((key) => !literal(key) && !derived(key) && !readElsewhere.has(key))

if (unknown.length > 0) {
  console.error('These variables are not read anywhere in server/config.ts:')
  for (const key of unknown) console.error(`  ${key}`)
  console.error('\nEither the name is wrong, or the app never reads it. Setting it would do nothing.')
  process.exit(1)
}

const lines = []
const gaps = []

lines.push('# Go Polar Website Builder, production environment.')
lines.push('# Paste into Vercel: Project -> Settings -> Environment Variables -> the .env import.')
lines.push('# Generated from .env.local. Blank values are listed at the bottom of this file.')
lines.push('')

for (const section of SECTIONS) {
  lines.push(`# --- ${section.title}`)
  for (const spec of section.vars) {
    const value = spec.fixed !== undefined ? spec.fixed : read(spec.key) || spec.fallback || ''
    if (spec.note) lines.push(`# ${spec.note}`)
    lines.push(`${spec.key}=${value}`)
    if (!value && !spec.optional && spec.fixed === undefined) {
      gaps.push(`${spec.key} — ${spec.needed ?? 'no value on this machine'}`)
    }
  }
  lines.push('')
}

if (gaps.length > 0) {
  lines.push('# ------------------------------------------------------------------')
  lines.push(`# ${gaps.length} value(s) still needed. Each one is blank above.`)
  for (const gap of gaps) lines.push(`#   ${gap}`)
} else {
  lines.push('# Nothing outstanding. Every variable above has a value.')
}

writeFileSync(OUT, lines.join('\n') + '\n')

console.log(`Wrote ${OUT}`)
console.log(gaps.length === 0 ? '  Nothing outstanding.' : `  ${gaps.length} value(s) still needed:`)
for (const gap of gaps) console.log(`    ${gap}`)
console.log('\n  This file contains real credentials. It is gitignored. Delete it once pasted.')
