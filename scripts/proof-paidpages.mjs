/**
 * Proof that a paying customer receives the service pages they bought, on the REAL model path.
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST. It spends money and needs a network, so it cannot live in
 * the suite. But the bug it guards against was hidden precisely because everything was checked
 * against the offline fixture: the fixture always returned service pages, so the code looked
 * correct while the real model returned an empty array and the customer got nothing.
 *
 * Run:  node scripts/proof-paidpages.mjs
 *
 * It calls generatePlan for real, with two paid pages requested, and reports what came back.
 * It also exercises pagesDeliveredCheck at 2-of-2, 1-of-2 and 0-of-3 so the guard is proven to
 * fail and not merely to exist.
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'

// The key lives in .env.local, which dotenv does not read by default.
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}

// A Claude Code shell sets this to a proxy base that the SDK path here does not expect. Clearing
// it makes the run use the real Anthropic endpoint, which is the entire point of this script.
delete process.env.ANTHROPIC_BASE_URL

const { generatePlan } = await import('../server/lib/generate.ts')
const { pagesDeliveredCheck } = await import('../server/lib/buildSet.ts')
const { buildFacts } = await import('../server/lib/facts.ts')
const { makeIntake } = await import('../test/fixtures/site.ts')

const PAID = ['Blocked drains', 'Gas fitting']

const intake = {
  ...makeIntake(),
  services: ['Blocked drains', 'Hot water', 'Gas fitting'],
  primaryService: 'Blocked drains',
  ownPageServices: PAID,
}

console.log('=== REAL MODEL PATH ===')
console.log('model      :', process.env.ANTHROPIC_MODEL ?? '(default from config)')
console.log('paid pages :', PAID.join(', '))
console.log('allowance  : 3 (home + 2)')
console.log('')

const facts = buildFacts(intake, [])
let plan
try {
  plan = await generatePlan({
    intake,
    facts,
    assets: [],
    auditFlags: [],
    // The real signature streams progress. Nothing to show here, so it is swallowed.
    emit: async () => {},
    pagesAllowed: 3,
  })
} catch (err) {
  console.error('REAL MODEL CALL FAILED:', err?.message ?? err)
  console.error('\nRESULT: NOT PROVEN. Do not report this as verified.')
  process.exit(1)
}

const got = (plan.servicePages ?? []).map((p) => p.service)
console.log('servicePages returned:', JSON.stringify(got))

const missing = PAID.filter((s) => !got.includes(s))
const planOk = missing.length === 0
console.log(planOk ? 'PLAN: PASS, every paid page present' : `PLAN: FAIL, missing ${missing.join(', ')}`)

// Did the model write them, or did the fallback synthesise them? Both are acceptable outcomes,
// but they are different facts and the report should say which.
for (const p of plan.servicePages ?? []) {
  console.log(`  - ${p.service}: h1="${p.h1}" intro=${p.intro.length} para, included=${p.included.length}`)
}

console.log('')
console.log('=== CHECK 19, PROVEN FAILING NOT JUST EXISTING ===')
const paths = (svcs) => ['index.html', ...svcs.map((s) => `services/${s.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/index.html`)]

const full = pagesDeliveredCheck(PAID, paths(PAID))
console.log(`2 of 2 -> ${full.status.toUpperCase()}  ${full.detail}`)

const short = pagesDeliveredCheck(PAID, paths(['Blocked drains']))
console.log(`1 of 2 -> ${short.status.toUpperCase()}  ${short.detail}`)

const none = pagesDeliveredCheck([...PAID, 'Hot water'], ['index.html'])
console.log(`0 of 3 -> ${none.status.toUpperCase()}  evidence=${JSON.stringify(none.evidence)}`)

const checkOk = full.status === 'pass' && short.status === 'fail' && none.status === 'fail'
console.log('')
console.log('PLAN PATH :', planOk ? 'PROVEN' : 'FAILED')
console.log('CHECK 19  :', checkOk ? 'PROVEN (passes when complete, fails when short)' : 'FAILED')
process.exit(planOk && checkOk ? 0 : 1)
