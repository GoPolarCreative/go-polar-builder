/**
 * The returning-customer sign-in code, end to end against a real database.
 *
 * Six digits is a million possibilities and a million is nothing to a script. Everything that
 * makes this safe is a constraint, and a constraint that is not tested is a comment. So each one
 * is exercised here as behaviour: the wrong code is refused, the fifth wrong code kills it, a used
 * code cannot be reused, an expired one is dead, the send limit holds, and a verified address can
 * only ever open its own job.
 *
 * Run:  node scripts/proof-login-code.mjs
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
const { MAX_ATTEMPTS, SEND_LIMIT, checkCode, issueCode, jobForEmail } = await import(
  '../server/lib/loginCode.ts'
)
const { eq } = await import('drizzle-orm')

await migrate()
const db = await getDb()

const results = []
const check = (name, ok, note = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? '  (' + note + ')' : ''}`)
}

const MINE = 'mine@example.com'
const THEIRS = 'theirs@example.com'

// Two customers, so "only opens its own job" is a real assertion rather than a vacuous one.
await db.insert(schema.users).values({ id: 'usr_mine', email: MINE }).onConflictDoNothing()
await db.insert(schema.users).values({ id: 'usr_theirs', email: THEIRS }).onConflictDoNothing()
await db
  .insert(schema.jobs)
  .values({ id: 'job_mine', userId: 'usr_mine', status: 'live', businessName: 'Mine' })
  .onConflictDoNothing()
await db
  .insert(schema.jobs)
  .values({ id: 'job_theirs', userId: 'usr_theirs', status: 'live', businessName: 'Theirs' })
  .onConflictDoNothing()

const fresh = async (email) => {
  // Clear the send-limit history so each scenario starts from a known state.
  await db.delete(schema.loginCodes).where(eq(schema.loginCodes.email, email))
  const out = await issueCode(email)
  if (!out.ok) throw new Error('issue refused unexpectedly')
  return out.issued.code
}

// ------------------------------------------------------------------------------------------
console.log('--- the happy path ---')
{
  const code = await fresh(MINE)
  const ok = await checkCode(MINE, code)
  check('a correct code is accepted', ok.ok === true)
  check('it returns the verified address', ok.ok && ok.email === MINE)
}

// ------------------------------------------------------------------------------------------
console.log('--- single use ---')
{
  const code = await fresh(MINE)
  await checkCode(MINE, code)
  const again = await checkCode(MINE, code)
  check('A USED CODE CANNOT BE USED TWICE', again.ok === false, again.ok ? '' : again.reason)
}

// ------------------------------------------------------------------------------------------
console.log('--- wrong codes and the lockout ---')
{
  const code = await fresh(MINE)
  const wrong = code === '000000' ? '111111' : '000000'

  let lastReason = null
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const r = await checkCode(MINE, wrong)
    lastReason = r.ok ? 'accepted' : r.reason
  }
  check(`the code is dead after ${MAX_ATTEMPTS} wrong tries`, lastReason === 'locked', String(lastReason))

  const afterLock = await checkCode(MINE, code)
  check('THE RIGHT CODE NO LONGER WORKS ONCE LOCKED', afterLock.ok === false, afterLock.ok ? '' : afterLock.reason)
}

// ------------------------------------------------------------------------------------------
console.log('--- expiry ---')
{
  const code = await fresh(MINE)
  await db
    .update(schema.loginCodes)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(schema.loginCodes.email, MINE))
  const r = await checkCode(MINE, code)
  check('AN EXPIRED CODE IS REFUSED', r.ok === false && r.reason === 'expired')
}

// ------------------------------------------------------------------------------------------
console.log('--- the send limit ---')
{
  await db.delete(schema.loginCodes).where(eq(schema.loginCodes.email, MINE))
  let refused = null
  for (let i = 0; i < SEND_LIMIT + 2; i++) {
    const out = await issueCode(MINE)
    if (!out.ok) {
      refused = i
      break
    }
  }
  check(`sending is refused after ${SEND_LIMIT} codes`, refused === SEND_LIMIT, `refused at ${refused}`)
}

// ------------------------------------------------------------------------------------------
console.log('--- one address cannot hold two live codes ---')
{
  await db.delete(schema.loginCodes).where(eq(schema.loginCodes.email, MINE))
  const first = (await issueCode(MINE)).issued.code
  const second = (await issueCode(MINE)).issued.code
  const oldOne = await checkCode(MINE, first)
  check('THE PREVIOUS CODE IS KILLED WHEN A NEW ONE IS SENT', oldOne.ok === false)
  const newOne = await checkCode(MINE, second)
  check('the newest code still works', newOne.ok === true)
}

// ------------------------------------------------------------------------------------------
console.log('--- a code only opens its own job ---')
{
  check('an address resolves to its own job', (await jobForEmail(MINE)) === 'job_mine')
  check('and to nobody else’s', (await jobForEmail(THEIRS)) === 'job_theirs')
  check('an unknown address resolves to nothing', (await jobForEmail('nobody@example.com')) === null)

  // The important one: a code minted for one address cannot be checked against another.
  await db.delete(schema.loginCodes).where(eq(schema.loginCodes.email, MINE))
  const mineCode = (await issueCode(MINE)).issued.code
  const crossed = await checkCode(THEIRS, mineCode)
  check('A CODE SENT TO ONE ADDRESS DOES NOT WORK FOR ANOTHER', crossed.ok === false, crossed.ok ? '' : crossed.reason)
}

// ------------------------------------------------------------------------------------------
console.log('--- a lapsed original link is irrelevant ---')
{
  // The returning customer case: their build token expired months ago. Nothing in this path
  // consults it, so the only thing that matters is that a fresh code still opens the job.
  await db.delete(schema.loginCodes).where(eq(schema.loginCodes.email, MINE))
  await db.delete(schema.tokens).where(eq(schema.tokens.jobId, 'job_mine'))
  const code = (await issueCode(MINE)).issued.code
  const r = await checkCode(MINE, code)
  check('SOMEBODY WITH NO VALID TOKEN AT ALL CAN STILL GET IN', r.ok === true && (await jobForEmail(MINE)) === 'job_mine')
}

console.log('')
const failed = results.filter((r) => !r.ok)
console.log(`${results.length - failed.length}/${results.length} passed`)
for (const f of failed) console.log('  FAILED: ' + f.name)
process.exit(failed.length === 0 ? 0 : 1)
