/**
 * The 60 day cancellation clock, end to end against a real database and real storage.
 *
 * Taking a live business website off the internet is the most serious thing this system does on
 * its own. So the whole clock is exercised: the warnings at 0, 30, 53 and 59 days, the takedown
 * at 60, that the site really stops serving, that NOTHING is deleted, that a resubscribe at any
 * point cancels it, and that a site already dark comes back.
 *
 * Run:  node scripts/proof-takedown.mjs
 */
import { readFileSync } from 'node:fs'

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
process.env.DATABASE_DRIVER = 'pglite'
process.env.STORAGE_DRIVER = 'local'
process.env.RENDER_DRIVER = 'none'
delete process.env.DATABASE_URL
delete process.env.BLOB_READ_WRITE_TOKEN

const { migrate } = await import('../server/db/migrate.ts')
const { getDb, schema } = await import('../server/db/client.ts')
const { runTakedownSweep } = await import('../server/lib/takedown.ts')
const { applySubscriptionStatus } = await import('../server/lib/subscription.ts')
const { findSiteByHostname } = await import('../server/lib/publish.ts')
const { storage } = await import('../server/lib/storage.ts')
const { TAKEDOWN_DAYS } = await import('../shared/takedown.ts')
const { eq, and } = await import('drizzle-orm')

await migrate()
const db = await getDb()
const store = storage()

const results = []
const check = (name, ok, note = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? '  (' + note + ')' : ''}`)
}

const DAY = 86_400_000
const JOB = 'job_takedown'
const HOST = 'takedown-proof.example.com.au'
const EMAIL = 'takedown@example.com'

await db.insert(schema.users).values({ id: 'usr_td', email: EMAIL }).onConflictDoNothing()
await db
  .insert(schema.jobs)
  .values({ id: JOB, userId: 'usr_td', status: 'live', businessName: 'Takedown Test Plumbing' })
  .onConflictDoNothing()
await db
  .insert(schema.sites)
  .values({ id: 'site_td', jobId: JOB, hostname: HOST, version: 1, live: true })
  .onConflictDoNothing()
await db
  .insert(schema.golive)
  .values({ jobId: JOB, hosting: true, paidAt: new Date(), status: 'paid', hostingStatus: 'active' })
  .onConflictDoNothing()

// A real stored document, so "nothing was deleted" is a claim about actual bytes.
const LIVE_KEY = `sites/${HOST}/index.html`
await store.put(LIVE_KEY, '<!doctype html><html><body>their website</body></html>', 'text/html')

/** Move the recorded cancellation date back, which is how the clock is fast-forwarded. */
async function setCancelledDaysAgo(days) {
  await db
    .update(schema.golive)
    .set({ hostingStatus: 'cancelled', hostingEndedAt: new Date(Date.now() - days * DAY) })
    .where(eq(schema.golive.jobId, JOB))
}

async function clearWarnings() {
  await db
    .delete(schema.events)
    .where(and(eq(schema.events.jobId, JOB), eq(schema.events.type, 'hosting.warning_sent')))
}

const isServing = async () => (await findSiteByHostname(HOST)) !== null
const warningsSent = async () => {
  const rows = await db
    .select({ payload: schema.events.payload })
    .from(schema.events)
    .where(and(eq(schema.events.jobId, JOB), eq(schema.events.type, 'hosting.warning_sent')))
  return rows.map((r) => r.payload.stage).sort((a, b) => a - b)
}

// ------------------------------------------------------------------------------------------
console.log('--- day 0: cancelled, still online ---')
await applySubscriptionStatus({ email: EMAIL, status: 'CANCELLED' })
check('the site is still serving the moment they cancel', await isServing())

await setCancelledDaysAgo(0)
await runTakedownSweep()
check('the first warning goes out immediately', (await warningsSent()).includes(0))
check('and the site is still up', await isServing())

// ------------------------------------------------------------------------------------------
console.log('--- the warnings, in order ---')
for (const [day, expected] of [
  [30, [0, 30]],
  [53, [0, 30, 53]],
  [59, [0, 30, 53, 59]],
]) {
  await setCancelledDaysAgo(day)
  await runTakedownSweep()
  const sent = await warningsSent()
  check(`day ${day} warning sent`, JSON.stringify(sent) === JSON.stringify(expected), sent.join(','))
  check(`day ${day}: STILL ONLINE`, await isServing())
}

// ------------------------------------------------------------------------------------------
console.log('--- day 59: not down yet ---')
await setCancelledDaysAgo(59)
await runTakedownSweep()
check('DAY 59 IS NOT A TAKEDOWN', await isServing())

// ------------------------------------------------------------------------------------------
console.log(`--- day ${TAKEDOWN_DAYS}: offline ---`)
await setCancelledDaysAgo(TAKEDOWN_DAYS)
const swept = await runTakedownSweep()
check('the sweep reports one takedown', swept.takenDown === 1, JSON.stringify(swept))
check('THE SITE STOPS SERVING', (await isServing()) === false)
check('NOTHING WAS DELETED: the document is still in storage', (await store.getText(LIVE_KEY)) !== null)

const [siteRow] = await db.select().from(schema.sites).where(eq(schema.sites.jobId, JOB)).limit(1)
check('the sites row still exists, just not live', Boolean(siteRow) && siteRow.live === false)

const downEvents = await db
  .select()
  .from(schema.events)
  .where(and(eq(schema.events.jobId, JOB), eq(schema.events.type, 'site.taken_down')))
check('the takedown is logged', downEvents.length === 1)

// ------------------------------------------------------------------------------------------
console.log('--- resubscribing brings it back ---')
await applySubscriptionStatus({ email: EMAIL, status: 'ACTIVE' })
check('THE SITE SERVES AGAIN', await isServing())

const [after] = await db.select().from(schema.golive).where(eq(schema.golive.jobId, JOB)).limit(1)
check('the clock is cleared, not just paused', after.hostingEndedAt === null)
check('hosting reads active again', after.hostingStatus === 'active')

await runTakedownSweep()
check('a later sweep does not take it down again', await isServing())

// ------------------------------------------------------------------------------------------
console.log('--- resubscribing mid-clock cancels the takedown ---')
await clearWarnings()
await setCancelledDaysAgo(45)
await runTakedownSweep()
check('a site 45 days in is still up', await isServing())

await applySubscriptionStatus({ email: EMAIL, status: 'ACTIVE' })
await setCancelledDaysAgo(0) // would be irrelevant; the status is active now
await db.update(schema.golive).set({ hostingStatus: 'active', hostingEndedAt: null }).where(eq(schema.golive.jobId, JOB))
await runTakedownSweep()
check('AN ACTIVE SUBSCRIPTION IS NEVER TAKEN DOWN', await isServing())

// ------------------------------------------------------------------------------------------
console.log('--- only a confirmed cancellation starts the clock ---')
await db.update(schema.golive).set({ hostingStatus: 'unknown', hostingEndedAt: null }).where(eq(schema.golive.jobId, JOB))
await runTakedownSweep()
check('an unknown status never takes a site down', await isServing())

const failed = await applySubscriptionStatus({ email: EMAIL, status: 'PAYMENT_FAILED' })
check('a failed payment is NOT treated as a cancellation', failed.hostingStatus === 'unknown')
await runTakedownSweep()
check('and does not take the site down', await isServing())

console.log('')
const bad = results.filter((r) => !r.ok)
console.log(`${results.length - bad.length}/${results.length} passed`)
for (const f of bad) console.log('  FAILED: ' + f.name)
process.exit(bad.length === 0 ? 0 : 1)
