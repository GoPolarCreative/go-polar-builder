import { readFileSync, writeFileSync } from 'node:fs'

/**
 * One-off codemod for the Cloudflare to Vercel migration.
 *
 * Every library function used to take the Worker `env` binding object as its first argument.
 * Configuration now comes from process.env through config(), so that parameter disappears
 * everywhere. It is the same edit in a lot of places, so it is scripted rather than hand-typed.
 *
 * Kept in the repo so the migration commit is legible: this is exactly what was done.
 */

const files = [
  'server/lib/orders.ts',
  'server/lib/sweep.ts',
  'server/lib/discharge.ts',
  'server/lib/generate.ts',
  'server/lib/edit.ts',
  'server/lib/offline.ts',
]

const dropArg = [
  'callMessage', 'streamMessage', 'recordEvent', 'setJobStatus', 'holdJob', 'getJob', 'getIntake',
  'listAssets', 'nextVersion', 'getAsset', 'sendSafely', 'notifyGhlSafely', 'buildLink',
  'createBuildToken', 'builderLoginLink', 'previewLink', 'signClaims', 'readClaims', 'buildFacts',
  'inlineAssets', 'verify', 'verifyAndRepair', 'generatePlan', 'generateHtml', 'generateSectioned',
  'processPaidOrder', 'listPaidOrdersSince', 'notifyGhl', 'runSweep', 'generateEditedPlan',
  'rebuildFromPlan', 'buildDischargePackage', 'web3formsKey', 'offlinePlan',
]

let touched = 0

for (const file of files) {
  let s = readFileSync(file, 'utf8')
  const before = s

  s = s.replace(/import type \{ Env \} from '[^']*env'\r?\n/g, '')
  s = s.replace(/import \{ web3formsKey \} from '\.\.\/env'/g, "import { config, web3formsKey } from '../config'")

  s = s.replace(/\(\s*env: Env,\s*/g, '(')
  s = s.replace(/\(\s*env: Env\s*\)/g, '()')
  s = s.replace(/^[ \t]*env: Env,?\r?\n/gm, '')

  for (const fn of dropArg) {
    s = s.replace(new RegExp('\\b' + fn + '\\(env,\\s*', 'g'), fn + '(')
    s = s.replace(new RegExp('\\b' + fn + '\\(env\\)', 'g'), fn + '()')
    s = s.replace(new RegExp('\\b' + fn + '\\(c\\.env,\\s*', 'g'), fn + '(')
  }

  s = s.replace(/c?\.?env\.DEV_OFFLINE_GENERATION === '1'/g, 'config().offlineGeneration')
  s = s.replace(/env\.SHOPIFY_WEBHOOK_SECRET/g, 'config().shopify.webhookSecret')
  s = s.replace(/env\.PUBLIC_APP_URL \?\? ''/g, 'config().publicAppUrl')
  s = s.replace(/env\.PUBLIC_APP_URL/g, 'config().publicAppUrl')

  if (s !== before) {
    writeFileSync(file, s)
    touched++
    console.log('  rewrote ' + file)
  }
}

console.log(touched + ' file(s) rewritten')

for (const file of files) {
  const s = readFileSync(file, 'utf8')
  const hits = [...s.matchAll(/^.*\bEnv\b.*$|^.*\benv\.[A-Za-z_]+.*$/gm)].map((m) => m[0].trim())
  if (hits.length) console.log('\n' + file + ' still mentions env:\n  ' + hits.join('\n  '))
}
