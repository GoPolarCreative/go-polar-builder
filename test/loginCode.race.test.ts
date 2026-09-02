import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Five attempts has to mean five attempts, however many arrive at once.
 *
 * checkCode read the attempt count, decided whether it was under the limit, then wrote count + 1.
 * There are awaits between those steps, so guesses that arrive together all read the same number,
 * all decide they are under the limit, and all write the same number back. Fifty parallel requests
 * advanced the counter by one and got fifty guesses against a six digit code, inside the ten
 * minutes it lives.
 *
 * The two rate limits are supposed to MULTIPLY - five attempts per code, three codes per fifteen
 * minutes - which is the whole reason six digits is enough. Take the first one away and the
 * arithmetic behind the door changes completely.
 */

let dir: string
let issueCode: typeof import('../server/lib/loginCode').issueCode
let checkCode: typeof import('../server/lib/loginCode').checkCode
let MAX_ATTEMPTS: number

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gopolar-code-'))
  process.env.DEMO_MODE = '1'
  process.env.DATABASE_DRIVER = 'pglite'
  process.env.PGLITE_DIR = join(dir, 'db')
  process.env.STORAGE_DRIVER = 'local'
  process.env.LOCAL_STORAGE_DIR = join(dir, 'blob')
  process.env.APP_SECRET = 'code-race-secret'
  process.env.PUBLIC_APP_URL = 'http://localhost:5173'

  const { setConfigForTests } = await import('../server/config')
  setConfigForTests(null)
  const { migrate } = await import('../server/db/migrate')
  await migrate()
  const mod = await import('../server/lib/loginCode')
  issueCode = mod.issueCode
  checkCode = mod.checkCode
  MAX_ATTEMPTS = mod.MAX_ATTEMPTS
})

/** issueCode returns a refusal or the issued code; these tests always expect the latter. */
const issue = async (email: string) => {
  const out = await issueCode(email)
  if (!out.ok) throw new Error("rate limited in a test that should not be: " + out.reason)
  return out.issued
}

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Every six digit code except the real one, so none of these can succeed by luck. */
const wrongGuesses = (real: string, n: number) => {
  const out: string[] = []
  for (let i = 0; out.length < n; i++) {
    const guess = String(100000 + i)
    if (guess !== real) out.push(guess)
  }
  return out
}

describe('the attempt limit holds against guesses that arrive together', () => {
  it('one at a time, the limit is exactly MAX_ATTEMPTS', async () => {
    const email = 'serial@example.com'
    const issued = await issue(email)
    expect(issued.code).toBeTruthy()

    const results: string[] = []
    for (const guess of wrongGuesses(issued.code!, MAX_ATTEMPTS + 2)) {
      const r = await checkCode(email, guess)
      results.push(r.ok ? 'ok' : r.reason)
    }
    expect(results.filter((r) => r === 'wrong').length).toBeLessThanOrEqual(MAX_ATTEMPTS)
    // Locked, or already burnt: either way the door is shut.
    expect(['locked', 'no_code']).toContain(results.at(-1))

    // And the real code is dead afterwards, which is the point of locking.
    const after = await checkCode(email, issued.code!)
    expect(after.ok).toBe(false)
  })

  it('FIFTY AT ONCE MUST NOT BUY FIFTY GUESSES', async () => {
    const email = 'parallel@example.com'
    const issued = await issue(email)
    const real = issued.code!

    const guesses = wrongGuesses(real, 50)
    const outcomes = await Promise.all(guesses.map((g) => checkCode(email, g)))
    const evaluated = outcomes.filter((r) => !r.ok && (r.reason === 'wrong')).length

    expect(
      evaluated,
      `${evaluated} of 50 parallel guesses were actually checked against the code`,
    ).toBeLessThanOrEqual(MAX_ATTEMPTS)
  })

  it('and the code is spent afterwards, so the real one no longer works', async () => {
    const email = 'parallel2@example.com'
    const issued = await issue(email)
    const real = issued.code!

    await Promise.all(wrongGuesses(real, 50).map((g) => checkCode(email, g)))

    const after = await checkCode(email, real)
    expect(after.ok, 'the correct code must not work after the limit is spent').toBe(false)
  })
})
