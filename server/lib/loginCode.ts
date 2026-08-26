import { and, desc, eq, gte, isNull } from 'drizzle-orm'
import { getDb, schema } from '../db/client.js'
import { id } from './ids.js'
import { recordEvent } from './db.js'

/**
 * Six digit sign-in codes for a returning customer.
 *
 * THE THREAT THIS IS ACTUALLY DEFENDING AGAINST. Six digits is one million possibilities, which a
 * script exhausts in seconds if nothing stops it. Everything below exists because of that number,
 * and none of it is optional:
 *
 *   MAX_ATTEMPTS      Five wrong guesses kills the code. One in two hundred thousand, per code.
 *   SEND_LIMIT        A new code cannot be minted on demand, so an attacker cannot simply ask for
 *                     a fresh million-guess budget. It is also what stops this being a tool for
 *                     mail bombing somebody else's inbox.
 *   TTL_MINUTES       Ten minutes. A stolen code is worthless by the time it is found.
 *   single use        consumedAt. A code that has worked cannot work again.
 *   constant time     The comparison leaks nothing about how nearly right a guess was.
 *   bound to email    The code opens jobs belonging to the address it was sent to and no other.
 *
 * PREVIOUS CODES ARE KILLED WHEN A NEW ONE IS SENT. Otherwise five outstanding codes means five
 * times the guessing budget, and a person who pressed the button twice has two working codes,
 * which is confusing as well as weaker.
 *
 * ROWS ARE NEVER DELETED, only consumed. The send limit counts recent rows for an address, so
 * deleting them would reset the limit and hand an attacker an unlimited mail bomb.
 */

export const CODE_LENGTH = 6
export const TTL_MINUTES = 10
export const MAX_ATTEMPTS = 5
/** How many codes one address can be sent in the window below. */
export const SEND_LIMIT = 3
export const SEND_WINDOW_MINUTES = 15

export function normaliseEmail(raw: string): string {
  return (raw ?? '').trim().toLowerCase()
}

/**
 * Six digits from the cryptographic random source, never Math.random.
 *
 * Rejection sampling rather than a modulo. `n % 1_000_000` over a 32 bit range is very slightly
 * biased toward low codes, and while the bias is too small to matter in practice, "too small to
 * matter" is not a thing worth writing down in an auth path when the correct version is three
 * lines longer.
 */
export function generateCode(): string {
  const max = 1_000_000
  // Largest multiple of max that fits in 2^32, so anything above it is redrawn.
  const limit = Math.floor(0xffffffff / max) * max
  const buf = new Uint32Array(1)
  let n: number
  do {
    crypto.getRandomValues(buf)
    n = buf[0]!
  } while (n >= limit)
  return String(n % max).padStart(CODE_LENGTH, '0')
}

async function hashCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Compare two hex digests without leaking where they first differ.
 *
 * Both are hashes rather than the codes themselves, so a timing leak here is not directly a code
 * leak. It is still written properly: `===` on strings short-circuits, and an auth comparison that
 * short-circuits is a habit worth not having.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export interface IssuedCode {
  code: string
  expiresAt: Date
}

export type SendRefusal = { ok: false; reason: 'rate_limited'; retryAfterMinutes: number }
export type SendOk = { ok: true; issued: IssuedCode }

/**
 * Mint a code for an address, subject to the send limit.
 *
 * Says nothing about whether the address has an account. The caller emails only if there is
 * something to open, and returns the same generic answer either way, so this cannot be used to
 * find out who is a customer.
 */
export async function issueCode(email: string, now: Date = new Date()): Promise<SendRefusal | SendOk> {
  const db = await getDb()
  const addr = normaliseEmail(email)
  const windowStart = new Date(now.getTime() - SEND_WINDOW_MINUTES * 60_000)

  const recent = await db
    .select({ id: schema.loginCodes.id })
    .from(schema.loginCodes)
    .where(and(eq(schema.loginCodes.email, addr), gte(schema.loginCodes.createdAt, windowStart)))

  if (recent.length >= SEND_LIMIT) {
    await recordEvent(null, 'auth.code_rate_limited', { email: addr, sent: recent.length })
    return { ok: false, reason: 'rate_limited', retryAfterMinutes: SEND_WINDOW_MINUTES }
  }

  // Kill anything outstanding first, so one address never has two live codes.
  await db
    .update(schema.loginCodes)
    .set({ consumedAt: now })
    .where(and(eq(schema.loginCodes.email, addr), isNull(schema.loginCodes.consumedAt)))

  const code = generateCode()
  const expiresAt = new Date(now.getTime() + TTL_MINUTES * 60_000)

  await db.insert(schema.loginCodes).values({
    id: id('lc'),
    email: addr,
    codeHash: await hashCode(code),
    expiresAt,
  })

  return { ok: true, issued: { code, expiresAt } }
}

export type CheckResult =
  | { ok: true; email: string }
  | { ok: false; reason: 'no_code' | 'expired' | 'locked' | 'wrong'; attemptsLeft?: number }

/**
 * Check a submitted code.
 *
 * EVERY FAILURE COSTS AN ATTEMPT, including one against an expired code. Otherwise an attacker
 * learns which of their guesses were merely late, which is information about the code's lifetime
 * they should not get for free.
 */
export async function checkCode(email: string, submitted: string, now: Date = new Date()): Promise<CheckResult> {
  const db = await getDb()
  const addr = normaliseEmail(email)
  const digits = (submitted ?? '').trim()

  const [row] = await db
    .select()
    .from(schema.loginCodes)
    .where(and(eq(schema.loginCodes.email, addr), isNull(schema.loginCodes.consumedAt)))
    .orderBy(desc(schema.loginCodes.createdAt))
    .limit(1)

  if (!row) return { ok: false, reason: 'no_code' }

  if (row.attempts >= MAX_ATTEMPTS) {
    // Burn it rather than leaving a dead row that keeps answering "locked".
    await db.update(schema.loginCodes).set({ consumedAt: now }).where(eq(schema.loginCodes.id, row.id))
    await recordEvent(null, 'auth.code_locked', { email: addr, attempts: row.attempts })
    return { ok: false, reason: 'locked' }
  }

  const attempts = row.attempts + 1
  await db.update(schema.loginCodes).set({ attempts }).where(eq(schema.loginCodes.id, row.id))

  if (row.expiresAt.getTime() < now.getTime()) {
    return { ok: false, reason: 'expired' }
  }

  if (!constantTimeEqual(await hashCode(digits), row.codeHash)) {
    const left = Math.max(0, MAX_ATTEMPTS - attempts)
    if (left === 0) {
      await db.update(schema.loginCodes).set({ consumedAt: now }).where(eq(schema.loginCodes.id, row.id))
      await recordEvent(null, 'auth.code_locked', { email: addr, attempts })
      return { ok: false, reason: 'locked' }
    }
    return { ok: false, reason: 'wrong', attemptsLeft: left }
  }

  // Single use: spend it the moment it works.
  await db.update(schema.loginCodes).set({ consumedAt: now }).where(eq(schema.loginCodes.id, row.id))
  return { ok: true, email: addr }
}

/**
 * The job a verified address should land on.
 *
 * A LIVE SITE WINS over an unfinished build, because "edit your existing website" is what brought
 * them here. Beyond that, most recently touched. Almost every customer has exactly one job; this
 * only has to be sensible for the handful who bought twice.
 *
 * THE EMAIL IS THE WHOLE AUTHORISATION. Nothing else is consulted, and no job id is accepted from
 * the caller, so a verified code can only ever open a job belonging to the address it was sent to.
 */
export async function jobForEmail(email: string): Promise<string | null> {
  const db = await getDb()
  const addr = normaliseEmail(email)

  const rows = await db
    .select({ jobId: schema.jobs.id, updatedAt: schema.jobs.updatedAt, live: schema.sites.live })
    .from(schema.jobs)
    .innerJoin(schema.users, eq(schema.users.id, schema.jobs.userId))
    .leftJoin(schema.sites, eq(schema.sites.jobId, schema.jobs.id))
    .where(eq(schema.users.email, addr))

  if (rows.length === 0) return null

  const sorted = [...rows].sort((a, b) => {
    const liveDiff = Number(Boolean(b.live)) - Number(Boolean(a.live))
    if (liveDiff !== 0) return liveDiff
    return (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0)
  })

  return sorted[0]?.jobId ?? null
}
