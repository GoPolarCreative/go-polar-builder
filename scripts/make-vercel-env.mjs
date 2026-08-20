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
      { key: 'SHOPIFY_ADMIN_API_TOKEN', needed: 'custom app, read_orders + read_products, DEPLOY.md section 6' },
      { key: 'SHOPIFY_STOREFRONT_TOKEN', needed: 'same custom app, unauthenticated_write_checkouts' },
    ],
  },
  {
    title: 'Email, CRM and domains.',
    vars: [
      { key: 'RESEND_API_KEY', carry: true, needed: 'resend.com, after verifying itscold.com.au' },
      { key: 'EMAIL_FROM', carry: true, fallback: 'Go Polar Creative <hello@itscold.com.au>' },
      { key: 'GHL_WEBHOOK_URL', carry: true, optional: true },
      { key: 'VERCEL_API_TOKEN', needed: 'only for attaching customer domains automatically' },
      { key: 'VERCEL_PROJECT_ID', needed: 'Vercel project settings, once the project exists' },
      { key: 'CRON_SECRET', carry: true, needed: 'any random string; guards the hourly sweep' },
    ],
  },
]

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
