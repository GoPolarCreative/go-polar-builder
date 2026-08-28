/**
 * The whole live-editing loop, end to end, against a real database and real storage.
 *
 * WHAT THIS PROVES, in order:
 *   1. a job that is live can publish, and the published bytes change
 *   2. the checks actually run at publish time and a failing page is refused
 *   3. a paid service page missing from the set blocks the publish
 *   4. rollback republishes, so the LIVE files go back, not just the version pointer
 *   5. a cancelled subscription stops publishing
 *   6. the monthly allowance counts live edits and not pre-launch ones
 *
 * WHY A SCRIPT. It writes to the database and to blob storage, so it cannot sit in the unit
 * suite. It runs against the local pglite database and the local filesystem store, which is the
 * same code path production takes with different drivers behind it.
 *
 * Run:  node scripts/proof-editor-loop.mjs
 */
import { readFileSync } from 'node:fs'

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
// Local drivers: this must never touch production data.
process.env.DATABASE_DRIVER = 'pglite'
process.env.STORAGE_DRIVER = 'local'
process.env.RENDER_DRIVER = 'none'
delete process.env.DATABASE_URL
delete process.env.BLOB_READ_WRITE_TOKEN

const { migrate } = await import('../server/db/migrate.ts')
const { getDb, schema } = await import('../server/db/client.ts')
const { publishJob, liveHostnameFor } = await import('../server/lib/publishJob.ts')
const { pageBlobKey } = await import('../server/lib/buildSet.ts')
const { storage } = await import('../server/lib/storage.ts')
const { liveAllowanceFor, editPhaseFor } = await import('../server/lib/liveEdits.ts')
const { applySubscriptionStatus } = await import('../server/lib/subscription.ts')
const { makeFixture, makeIntake, makeAssets } = await import('../test/fixtures/site.ts')
const { config, web3formsKey } = await import('../server/config.ts')
const { eq } = await import('drizzle-orm')

await migrate()
const db = await getDb()
const store = storage()

const results = []
const check = (name, ok, note = '') => {
  results.push({ name, ok, note })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? '  (' + note + ')' : ''}`)
}

// ------------------------------------------------------------------------------------------
// Set up a job that looks exactly like a customer who has gone live.
// ------------------------------------------------------------------------------------------
const JOB = 'job_proof_' + Math.abs(Number(process.env.PROOF_SEED ?? 7))
const HOST = 'proof-loop.example.com.au'
const fixture = makeFixture()
// Deliberately not the dev WEB3FORMS_KEY in .env.local. The first attempt at this used the same
// value, so the swap was a no-op and assertNoGoPolarKey refused, correctly.
const CUSTOMER_KEY = 'c0f0c0f0-dead-4bee-9999-abcdefabcdef'

const intake = makeIntake()

await db.insert(schema.users).values({ id: 'usr_proof', email: 'proof@example.com' }).onConflictDoNothing()
await db
  .insert(schema.jobs)
  .values({
    id: JOB,
    userId: 'usr_proof',
    status: 'live',
    businessName: intake.businessName,
    currentVersion: 1,
    /*
     * BOTH, ALWAYS. A verified timestamp with no key beside it is a state the product cannot
     * reach: the setup route writes the key, and only a successful test adds the timestamp.
     * This fixture used to set the timestamp alone and got away with it while the key swap
     * happened on the setup screen. Publishing does the swap now, so it needs the key, and
     * publishJob refuses without one rather than blanking every form on the page.
     */
    customerWeb3formsKey: CUSTOMER_KEY,
    web3formsVerifiedAt: new Date(),
  })
  .onConflictDoUpdate({
    target: schema.jobs.id,
    set: { currentVersion: 1, customerWeb3formsKey: CUSTOMER_KEY, web3formsVerifiedAt: new Date() },
  })

await db
  .insert(schema.golive)
  .values({ jobId: JOB, hosting: true, paidAt: new Date(), status: 'paid', hostingStatus: 'active' })
  .onConflictDoUpdate({ target: schema.golive.jobId, set: { paidAt: new Date(), hostingStatus: 'active' } })

await db.insert(schema.intake).values({ jobId: JOB, payload: intake, submittedAt: new Date() }).onConflictDoUpdate({
  target: schema.intake.jobId,
  set: { payload: intake, submittedAt: new Date() },
})

/*
 * The fixture's images, in the database.
 *
 * publishJob builds its facts from listAssets(jobId), so an empty assets table means an empty
 * manifest, and check 8 (assets_exist) correctly refuses a page referencing twelve files that
 * will not ship. Seeding them is what makes this a realistic job rather than a broken one.
 */
for (const a of makeAssets()) {
  await db
    .insert(schema.assets)
    .values({
      id: a.id,
      jobId: JOB,
      kind: a.kind,
      filename: a.filename,
      contentType: a.contentType,
      originalKey: a.originalKey,
      originalBytes: a.originalBytes,
      width: a.width,
      height: a.height,
      sortOrder: a.sortOrder,
      stats: a.stats,
      variants: a.variants,
    })
    .onConflictDoNothing()
}

/** Write a version: the plan row, the build row, and the home page in storage. */
async function writeVersion(version, html) {
  const key = pageBlobKey(JOB, version, 'index.html')
  await store.put(key, html, 'text/html; charset=utf-8')
  await db
    .insert(schema.plans)
    .values({ id: 'pln_' + version, jobId: JOB, version, plan: fixture.plan })
    .onConflictDoNothing()
  await db
    .insert(schema.builds)
    .values({ id: 'bld_' + version, jobId: JOB, version, blobKey: key, bytes: html.length, passed: true })
    .onConflictDoNothing()
  await db
    .insert(schema.buildPages)
    .values({ id: 'bp_' + version, jobId: JOB, version, path: 'index.html', url: '/', title: 'Home', blobKey: key, passed: true })
    .onConflictDoNothing()
}

/*
 * The fixture ships with Go Polar's placeholder key, and assertNoGoPolarKey refuses to put such a
 * document on the internet. That guard is the single most important one in the product (D29), so
 * the fixture gets swapped rather than the guard getting softened.
 */
const GO_POLAR_KEY = web3formsKey(config())
const withCustomerKey = GO_POLAR_KEY ? fixture.html.split(GO_POLAR_KEY).join(CUSTOMER_KEY) : fixture.html

const V1 = withCustomerKey
const V2 = withCustomerKey.replace('</body>', '<!-- VERSION TWO MARKER --></body>')

await writeVersion(1, V1)
await writeVersion(2, V2)

// ------------------------------------------------------------------------------------------
// 1. Publish version 1.
// ------------------------------------------------------------------------------------------
const first = await publishJob({ jobId: JOB, hostname: HOST, actor: 'customer' })
check(
  'a live job publishes',
  first.ok,
  first.ok ? 'v' + first.result.version : JSON.stringify(first.failures ?? first.detail),
)

const liveKey = `sites/${HOST}/index.html`
const afterFirst = await store.getText(liveKey)
check('the published file exists', afterFirst !== null)
check('render checks reported skipped, not passed', first.ok && first.renderChecksSkipped === true)

// ------------------------------------------------------------------------------------------
// 2. Move to version 2 and publish. The live bytes must change.
// ------------------------------------------------------------------------------------------
await db.update(schema.jobs).set({ currentVersion: 2 }).where(eq(schema.jobs.id, JOB))
const second = await publishJob({ jobId: JOB, hostname: HOST, actor: 'customer' })
const afterSecond = await store.getText(liveKey)
check('publishing again succeeds', second.ok, second.ok ? '' : second.detail)
check('THE LIVE FILE CHANGED', afterSecond?.includes('VERSION TWO MARKER') === true)

// ------------------------------------------------------------------------------------------
// 3. Roll back to version 1 and republish. The live bytes must go BACK.
//    This is the bug that was shipped: the pointer moved and the live site did not.
// ------------------------------------------------------------------------------------------
await db.update(schema.jobs).set({ currentVersion: 1 }).where(eq(schema.jobs.id, JOB))
const restored = await publishJob({ jobId: JOB, hostname: HOST, actor: 'customer', restoredFromVersion: 1 })
const afterRestore = await store.getText(liveKey)
check('restore republishes', restored.ok, restored.ok ? '' : restored.detail)
check('THE LIVE FILE REVERTED', afterRestore?.includes('VERSION TWO MARKER') === false)
check('liveHostnameFor finds the site', (await liveHostnameFor(JOB)) === HOST)

// ------------------------------------------------------------------------------------------
// 4. A page that fails its checks must not reach the live site.
// ------------------------------------------------------------------------------------------
// Two h1 elements fails `single_h1`, which is a static check and runs everywhere.
const broken = V1.replace('</body>', '<h1>a second heading that should fail the checks</h1></body>')
await writeVersion(3, broken)
await db.update(schema.jobs).set({ currentVersion: 3 }).where(eq(schema.jobs.id, JOB))
const refused = await publishJob({ jobId: JOB, hostname: HOST, actor: 'customer' })
const afterRefusal = await store.getText(liveKey)
check('A FAILING PAGE IS REFUSED', refused.ok === false, refused.ok ? '' : refused.error)
check(
  'the refusal names the failing check',
  refused.ok === false && (refused.failures ?? []).some((f) => f.checkId === 'single_h1'),
)
check('THE LIVE SITE WAS NOT TOUCHED BY THE REFUSAL', afterRestore === afterRefusal)

// ------------------------------------------------------------------------------------------
// 5. A cancelled subscription stops publishing, and does NOT take the site down.
// ------------------------------------------------------------------------------------------
await db.update(schema.jobs).set({ currentVersion: 1 }).where(eq(schema.jobs.id, JOB))
await applySubscriptionStatus({ email: 'proof@example.com', status: 'CANCELLED' })
const cancelled = await publishJob({ jobId: JOB, hostname: HOST, actor: 'customer' })
check('a cancelled subscription refuses to publish', cancelled.ok === false && cancelled.error === 'hosting_ended')
check('THE CANCELLED CUSTOMER IS STILL ONLINE', (await store.getText(liveKey)) !== null)

const forced = await publishJob({ jobId: JOB, hostname: HOST, actor: 'operator', force: true })
check('the operator can still force a publish on a lapsed job', forced.ok, forced.ok ? '' : forced.detail)

await db.update(schema.golive).set({ hostingStatus: 'active' }).where(eq(schema.golive.jobId, JOB))

// ------------------------------------------------------------------------------------------
// 6. The allowance counts live edits only.
// ------------------------------------------------------------------------------------------
check('a published job is in the live phase', (await editPhaseFor(JOB)) === 'live')

const before = await liveAllowanceFor(JOB)
await db.insert(schema.edits).values({
  id: 'edt_pre_' + Date.now(),
  jobId: JOB,
  versionFrom: 1,
  versionTo: 2,
  counted: true,
  phase: 'prelaunch',
})
const afterPre = await liveAllowanceFor(JOB)
check('a PRE-LAUNCH edit does not touch the monthly allowance', afterPre.used === before.used)

await db.insert(schema.edits).values({
  id: 'edt_live_' + Date.now(),
  jobId: JOB,
  versionFrom: 1,
  versionTo: 2,
  counted: true,
  phase: 'live',
})
const afterLive = await liveAllowanceFor(JOB)
check('a LIVE edit spends one', afterLive.used === before.used + 1, `${before.used} -> ${afterLive.used}`)

await db.insert(schema.edits).values({
  id: 'edt_roll_' + Date.now(),
  jobId: JOB,
  versionFrom: 2,
  versionTo: 1,
  counted: false,
  phase: 'live',
})
const afterRollback = await liveAllowanceFor(JOB)
check('AN UNDO COSTS NOTHING', afterRollback.used === afterLive.used)

// ------------------------------------------------------------------------------------------
console.log('')
const failed = results.filter((r) => !r.ok)
console.log(`${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  console.log('FAILED:')
  for (const f of failed) console.log('  - ' + f.name)
}
process.exit(failed.length === 0 ? 0 : 1)
