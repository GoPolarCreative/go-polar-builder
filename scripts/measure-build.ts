import { config as loadEnvFiles } from 'dotenv'

/**
 * Where the wall clock actually goes on a real build and a real edit.
 *
 *   npx tsx scripts/measure-build.ts <jobId> [--pages N] [--edit "your request"]
 *
 * TEMPORARY MEASUREMENT HARNESS. It exists to answer "why is this slower than bolt.new" with
 * numbers instead of a theory, and it calls the real Anthropic API through the real pipeline
 * functions rather than the offline fixture, because the offline fixture is exactly the thing
 * that would hide the answer. Every run costs real money.
 *
 * It deliberately does NOT go through the HTTP route. The route adds an SSE frame per chunk and
 * nothing else, and driving it here would mean measuring a network hop to localhost.
 */

loadEnvFiles({ path: '.env.local', quiet: true })
loadEnvFiles({ path: '.env', quiet: true })

// The whole point is the model path. Refuse to report fixture numbers as if they were real.
delete process.env.DEV_OFFLINE_GENERATION
// This harness runs inside an agent shell that exports ANTHROPIC_BASE_URL as an origin. The client
// treats that variable as the FULL endpoint, so inheriting it posts to / and gets a 404.
delete process.env.ANTHROPIC_BASE_URL
process.env.DEMO_MODE = '0'
process.env.RENDER_DRIVER = process.env.RENDER_DRIVER ?? 'playwright'

const { getDb, schema } = await import('../server/db/client.js')
const { eq, and } = await import('drizzle-orm')
const { getIntake, getJob, listAssets } = await import('../server/lib/db.js')
const { buildFacts } = await import('../server/lib/facts.js')
const { generatePlan, generateHtml } = await import('../server/lib/generate.js')
const { generateEditedPlan, rebuildFromPlan, patchSections, diffPlans } = await import('../server/lib/edit.js')
const { planEdit, markedSections, extractSection } = await import('../server/lib/sections.js')
const { verifyAndRepair } = await import('../server/lib/verify.js')
const { runStaticChecks } = await import('../server/lib/checks/static.js')
const { runRenderChecks } = await import('../server/lib/checks/render.js')
const { persistPageSet } = await import('../server/lib/buildSet.js')
const { resetUsageMeter, usageReport } = await import('../server/lib/anthropic.js')
const { intakeSchema } = await import('../shared/intake.js')
const { storage } = await import('../server/lib/storage.js')

const args = process.argv.slice(2)
const jobId = args[0]
if (!jobId) {
  console.error('usage: npx tsx scripts/measure-build.ts <jobId> [--pages N] [--edit "request"]')
  process.exit(1)
}
const pagesArg = args.indexOf('--pages')
const pagesAllowed = pagesArg >= 0 ? Number(args[pagesArg + 1]) : null
const editArg = args.indexOf('--edit')
const editRequest = editArg >= 0 ? args[editArg + 1]! : null

const marks: Array<{ stage: string; ms: number; note?: string }> = []
async function time<T>(stage: string, fn: () => Promise<T>, note?: (v: T) => string): Promise<T> {
  const t0 = performance.now()
  const v = await fn()
  const ms = performance.now() - t0
  marks.push({ stage, ms, note: note ? note(v) : undefined })
  process.stderr.write(`  ${stage.padEnd(34)} ${(ms / 1000).toFixed(1)}s\n`)
  return v
}

const noop = async () => {}

const job = await getJob(jobId)
if (!job) throw new Error('no such job: ' + jobId)
const stored = await getIntake(jobId)
const intake = intakeSchema.parse(stored?.payload)
const assets = await listAssets(jobId)
const facts = buildFacts(intake, assets)
const allowed = pagesAllowed ?? job.pagesAllowed

console.error('')
console.error(`job ${jobId}  |  pagesAllowed ${allowed}  |  model ${process.env.ANTHROPIC_MODEL ?? 'default'}`)
console.error(editRequest ? `EDIT: "${editRequest}"` : 'FRESH BUILD')
console.error('')

resetUsageMeter()
const wall0 = performance.now()

let html: string
let plan: any

if (editRequest) {
  const [planRow] = await getDb().then((db) =>
    db
      .select({ plan: schema.plans.plan })
      .from(schema.plans)
      .where(and(eq(schema.plans.jobId, jobId), eq(schema.plans.version, job.currentVersion)))
      .limit(1),
  )
  const [buildRow] = await getDb().then((db) =>
    db
      .select({ blobKey: schema.builds.blobKey })
      .from(schema.builds)
      .where(and(eq(schema.builds.jobId, jobId), eq(schema.builds.version, job.currentVersion)))
      .limit(1),
  )
  const currentPlan = planRow!.plan as any
  const currentHtml = (await storage().getText(buildRow!.blobKey))!
  console.error(`  (editing version ${job.currentVersion}, ${(currentHtml.length / 1024).toFixed(0)}KB of HTML)`)

  const editedOut = await time('1. edit plan call (model)', () =>
    generateEditedPlan({
      plan: currentPlan,
      facts,
      intake,
      assets,
      request: editRequest,
      previousRequests: [],
    }),
  )
  const revised = editedOut.plan
  plan = revised
  console.error(`  declared: ${editedOut.declaredSections.join(", ") || "none"}  |  dropped: ${editedOut.droppedKeys.join(", ") || "none"}`)
  const changes = diffPlans(currentPlan, revised)

  // The same decision production makes, so the harness measures the real path and not a wish.
  const decision = planEdit({ changes, request: editRequest, html: currentHtml })
  console.error(`  decision: ${decision.mode.toUpperCase()} - ${decision.reason}`)
  console.error(`  markers in current doc: ${[...markedSections(currentHtml)].join(', ') || 'NONE'}`)

  if (decision.mode === 'patch') {
    html = await time(
      `2. patch call (model, ${decision.targets.join('+')})`,
      () =>
        patchSections({
          plan: revised,
          facts,
          previousHtml: currentHtml,
          targets: decision.targets,
          request: editRequest,
          emit: noop,
        }),
      (h) => `${(h.length / 1024).toFixed(0)}KB out, ${(currentHtml.length / 1024).toFixed(0)}KB in`,
    )
  } else {
    html = await time(
      '2. rebuild call (model)',
      () =>
        rebuildFromPlan({
          plan: revised,
          facts,
          previousHtml: currentHtml,
          changes,
          request: editRequest,
          emit: noop,
        }),
      (h) => `${(h.length / 1024).toFixed(0)}KB out, ${(currentHtml.length / 1024).toFixed(0)}KB in`,
    )
  }

  // THE PROPERTY, measured on a real edit rather than a fixture: what did NOT change.
  {
    const untouched: string[] = []
    const changed: string[] = []
    for (const id of markedSections(currentHtml)) {
      const before = extractSection(currentHtml, id)
      const after = extractSection(html, id)
      ;(before === after ? untouched : changed).push(id)
    }
    marks.push({
      stage: 'sections byte-identical after edit',
      ms: 0,
      note: `unchanged: ${untouched.length} (${untouched.join(', ') || 'none'})  |  changed: ${changed.join(', ') || 'none'}`,
    })
  }
} else {
  plan = await time('1. plan call (model)', () =>
    generatePlan({ intake, facts, assets, auditFlags: stored?.auditFlags ?? [], emit: noop, pagesAllowed: allowed }),
  )
  const r = await time(
    '2. build call (model)',
    () => generateHtml({ plan, facts, emit: noop }),
    (v) => `${(v.html.length / 1024).toFixed(0)}KB, sectioned=${v.sectioned}`,
  )
  html = r.html
}

// Split the verification so the browser half is visible separately from the cheap half.
await time('3a. static checks alone', async () => runStaticChecks(html, facts), (c: any) => `${c.length} checks`)
await time('3b. render checks alone (browser)', async () => {
  try {
    return await runRenderChecks(html)
  } catch (e) {
    return [{ note: 'render unavailable: ' + String(e).slice(0, 60) }] as any
  }
}, (c: any) => `${c.length} checks`)

const repairLog: string[] = []
const outcome = await time(
  '4. verifyAndRepair (real path)',
  () =>
    verifyAndRepair({
      html,
      facts,
      onEvent: async (e: any) => {
        if (e.type === 'repair') repairLog.push('attempt ' + e.attempt + ': ' + e.failing.join(' | '))
      },
    }),
  (o) => `${o.attempts} repair pass(es)`,
)

const set = await time(
  '5. persistPageSet (render + checks + storage)',
  () =>
    persistPageSet({
      jobId,
      version: 9000 + Math.floor(performance.now() % 900),
      plan,
      facts,
      homeHtml: outcome.html,
      homeReport: outcome.report,
      repairPasses: outcome.attempts,
      paidPageServices: (intake.ownPageServices ?? []).filter((n: string) => intake.services.includes(n)),
      pagesAllowed: allowed,
    }),
  (s) => `${s.pages.length} page(s) written`,
)

const wall = performance.now() - wall0
const spend = usageReport()

console.error('')
console.log('='.repeat(74))
console.log(editRequest ? 'EDIT' : `BUILD (pagesAllowed ${allowed}, ${set.pages.length} pages written)`)
console.log('='.repeat(74))
for (const m of marks) {
  const pct = wall > 0 ? ((m.ms / wall) * 100).toFixed(0).padStart(3) : '  -'
  console.log(
    `${m.stage.padEnd(40)} ${(m.ms / 1000).toFixed(1).padStart(7)}s  ${pct}%  ${m.note ?? ''}`,
  )
}
console.log('-'.repeat(74))
console.log(`${'TOTAL WALL CLOCK'.padEnd(40)} ${(wall / 1000).toFixed(1).padStart(7)}s`)
console.log('')
console.log('tokens: ' + JSON.stringify(spend))
if (repairLog.length) { console.log(''); console.log('REPAIR PASSES FIXED:'); for (const r of repairLog) console.log('  ' + r) }
else console.log('no repair passes')
console.log('markers present: ' + [...markedSections(outcome.html)].join(', '))
console.log('')
process.exit(0)
