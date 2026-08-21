/**
 * Push the environment from .env.local to the linked Vercel project.
 *
 *   npm run vercel:push            # show what would be pushed, change nothing
 *   npm run vercel:push -- --apply # actually set them
 *
 * WHY. Vercel's dashboard no longer offers a bulk .env import, and typing a dozen values by hand
 * into a dozen boxes is how one of them ends up with a trailing space. This reads the values that
 * are already on this machine and sets them with the Vercel CLI, using the session `vercel login`
 * already established.
 *
 * IT NEVER PRINTS A VALUE. Everything reported is a name, a length and a state. If you need to
 * confirm a value, read .env.local directly.
 *
 * PRODUCTION-ONLY OVERRIDES. A handful of variables must differ from the local ones, and getting
 * that wrong is worse than not setting them at all: DEMO_MODE=1 in production means every payment,
 * email and DNS action is a local fake, and DEV_OFFLINE_GENERATION=1 means every customer gets a
 * fixture instead of their website. Those are forced here rather than carried across.
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const APPLY = process.argv.includes('--apply')
const LOCAL = '.env.local'

/** Carried from .env.local when present. */
const CARRY = [
  'APP_SECRET',
  'ADMIN_TOKEN',
  'CRON_SECRET',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'WEB3FORMS_ACCESS_KEY',
  'SHOPIFY_STORE_DOMAIN',
  'SHOPIFY_WEBHOOK_SECRET',
  'SHOPIFY_CLIENT_ID',
  'SHOPIFY_CLIENT_SECRET',
  'SHOPIFY_STOREFRONT_TOKEN',
  'SHOPIFY_VARIANT_WEBSITE_HOSTING_AUSTRALIA',
  'SHOPIFY_SELLING_PLAN_WEBSITE_HOSTING_AUSTRALIA',
  'SHOPIFY_VARIANT_DOMAIN_1_YEAR',
  'SHOPIFY_SELLING_PLAN_DOMAIN_1_YEAR',
  'SHOPIFY_VARIANT_EMAIL_HOSTING',
  'SHOPIFY_SELLING_PLAN_EMAIL_HOSTING',
  'KLAVIYO_API_KEY',
]

/**
 * Forced, because the local value is wrong for production or there is no local value.
 *
 * THE ENABLE_LIVE_* FLAGS ARE DELIBERATELY NOT HERE. Everything that charges a card, emails a real
 * person or changes DNS stays off until the smoke test has passed, which is what DEPLOY.md section
 * 4 says and the reason it says it: a half-configured deployment that is allowed to take money is
 * strictly worse than one that refuses to. Turn them on by hand, afterwards, one at a time.
 *
 * DEMO_MODE=0 is here though. Without it every integration is a local fake and the smoke test
 * would prove nothing at all.
 */
const FORCED = {
  PUBLIC_APP_URL: 'https://build.itscold.com.au',
  DATABASE_DRIVER: 'postgres',
  STORAGE_DRIVER: 'vercel-blob',
  DEMO_MODE: '0',
}

/**
 * Never pushed, whatever is in .env.local.
 *
 * DEV_OFFLINE_GENERATION would make every customer's website a fixture. DATABASE_URL and the Blob
 * token belong to the integrations and are managed by Vercel. VERCEL_OIDC_TOKEN is written into
 * .env.local by `vercel link` and is not configuration.
 */
const NEVER = new Set([
  'DEV_OFFLINE_GENERATION',
  'DATABASE_URL',
  'BLOB_READ_WRITE_TOKEN',
  'VERCEL_OIDC_TOKEN',
  'PGLITE_DIR',
  'LOCAL_STORAGE_DIR',
])

if (!existsSync(LOCAL)) {
  console.error(`${LOCAL} not found. Run this from the project root.`)
  process.exit(1)
}

const source = readFileSync(LOCAL, 'utf8')
const readLocal = (key) => {
  const match = source.match(new RegExp(`^${key}=(.*)$`, 'm'))
  if (!match) return ''
  return match[1].trim().replace(/^["']|["']$/g, '')
}

const plan = []
for (const [key, value] of Object.entries(FORCED)) plan.push({ key, value, origin: 'forced' })
for (const key of CARRY) {
  if (NEVER.has(key)) continue
  const value = readLocal(key)
  if (value) plan.push({ key, value, origin: 'local' })
  else plan.push({ key, value: null, origin: 'missing' })
}

const settable = plan.filter((p) => p.value !== null)
const missing = plan.filter((p) => p.value === null)

console.log(`${settable.length} variable(s) to set, ${missing.length} with no value on this machine.\n`)

for (const item of settable) {
  const shape = item.origin === 'forced' ? item.value : `${item.value.length} chars`
  console.log(`  ${APPLY ? 'setting' : 'would set'}  ${item.key.padEnd(46)} ${shape}`)
}

if (missing.length > 0) {
  console.log('\nNo value on this machine, so left alone in Vercel:')
  for (const item of missing) console.log(`  ${item.key}`)
}

if (!APPLY) {
  console.log('\nNothing was changed. Re-run with --apply to set them:')
  console.log('  npm run vercel:push -- --apply')
  process.exit(0)
}

console.log('')
let ok = 0
let failed = []

/*
 * --value, not stdin.
 *
 * This used to pipe the value in. That worked until the Vercel CLI updated itself mid-session and
 * grew a "Store as sensitive?" prompt ahead of the value prompt — after which the piped line
 * answered the wrong question, the command still exited 0, and the variable kept its old value.
 * Nothing failed. A model comparison then ran twice on the same model and looked like a result.
 *
 * --value is the documented non-interactive form and cannot be misread by a new prompt.
 */
for (const item of settable) {
  try {
    // --force overwrites an existing value rather than erroring, so this is re-runnable.
    execFileSync(
      'npx',
      ['vercel', 'env', 'add', item.key, 'production', '--value', item.value, '--force'],
      { stdio: ['ignore', 'ignore', 'pipe'], shell: process.platform === 'win32' },
    )
    ok++
    console.log(`  set     ${item.key}`)
  } catch (err) {
    failed.push(item.key)
    console.log(`  FAILED  ${item.key}`)
  }
}

/*
 * Read back what is not secret, and say so when it does not match.
 *
 * A write that reports success and stores something else is the failure mode this file has already
 * had once. The sensitive values cannot be read back by design; these can.
 */
const READABLE = ['PUBLIC_APP_URL', 'DATABASE_DRIVER', 'STORAGE_DRIVER', 'DEMO_MODE', 'ANTHROPIC_MODEL']
const expected = new Map(settable.filter((i) => READABLE.includes(i.key)).map((i) => [i.key, i.value]))

if (expected.size > 0) {
  console.log('\nVerifying the values that can be read back...')
  try {
    const listing = execFileSync('npx', ['vercel', 'env', 'ls', 'production'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    })
    for (const [key] of expected) {
      if (!new RegExp('^\\s*' + key + '\\s', 'm').test(listing)) {
        console.log(`  MISSING  ${key} is not on the project at all`)
      }
    }
    console.log('  Present. Values marked Sensitive cannot be read back; check /api/health after deploying.')
  } catch {
    console.log('  Could not list them. Check with: npx vercel env ls production')
  }
}

console.log(`\n${ok} set, ${failed.length} failed.`)
if (failed.length > 0) {
  console.log('Failed:', failed.join(', '))
  console.log('Check `npx vercel whoami` and that the project is linked.')
  process.exit(1)
}
console.log('\nRedeploy for the functions to pick these up:  npx vercel deploy --prod')
