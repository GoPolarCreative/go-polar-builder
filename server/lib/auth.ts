import type { Context, Next } from 'hono'
import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '../db/client.js'
import { config, type AppConfig } from '../config.js'
import { TOKEN_TTL_DAYS, hashToken, mintToken, readClaims, signClaims } from './signing.js'
import { id } from './ids.js'

/**
 * Auth. Brief s3a: token link by email, no passwords.
 *
 * A build token is 32 random bytes emailed to the customer; only its hash is stored. On first
 * click it is exchanged for a signed session cookie tied to the job. See DECISIONS.md D10.
 */

export const SESSION_COOKIE = 'gp_session'
export const SESSION_TTL_DAYS = TOKEN_TTL_DAYS

export interface SessionClaims {
  jobId: string
  exp: number
}

/** Mint a build token for a job and store only its hash. Returns the raw token, once. */
export async function createBuildToken(jobId: string): Promise<string> {
  const db = await getDb()
  const token = mintToken()
  await db.insert(schema.tokens).values({
    id: id('tok'),
    jobId,
    tokenHash: await hashToken(token),
    expiresAt: new Date(Date.now() + TOKEN_TTL_DAYS * 86_400_000),
  })
  return token
}

export function buildLink(token: string, cfg: AppConfig = config()): string {
  const base = cfg.publicAppUrl.replace(/\/$/, '')
  return `${base}/start?t=${encodeURIComponent(token)}`
}

/**
 * Exchange a build token for a session. The token stays valid for its full 90 days, because
 * people open the same email on a second device, but the first use is recorded.
 */
export async function exchangeToken(
  token: string,
): Promise<{ jobId: string; session: string } | { error: string }> {
  const db = await getDb()
  const hash = await hashToken(token)
  const rows = await db.select().from(schema.tokens).where(eq(schema.tokens.tokenHash, hash)).limit(1)
  const row = rows[0]

  if (!row) {
    return {
      error: 'That link is not valid. Use the "send my link again" option and we will email a fresh one.',
    }
  }
  if (row.expiresAt.getTime() < Date.now()) {
    return { error: 'That link has expired. They last 90 days. Ask for a new one and we will send it through.' }
  }

  if (!row.firstUsedAt) {
    await db.update(schema.tokens).set({ firstUsedAt: new Date() }).where(eq(schema.tokens.id, row.id))
  }

  const session = await signClaims({
    kind: 'session',
    jobId: row.jobId,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_DAYS * 86_400,
  })

  return { jobId: row.jobId, session }
}

export async function findLatestTokenJob(email: string): Promise<string | null> {
  const db = await getDb()
  const rows = await db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .innerJoin(schema.users, eq(schema.users.id, schema.jobs.userId))
    .where(and(eq(schema.users.email, email.trim().toLowerCase())))
    .orderBy(schema.jobs.createdAt)
    .limit(1)
  return rows[0]?.id ?? null
}

export function sessionCookie(session: string, cfg: AppConfig = config()): string {
  const secure = cfg.publicAppUrl.startsWith('https://') ? '; Secure' : ''
  return `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS * 86_400}${secure}`
}

export function clearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return null
}

/**
 * Read the session from a cookie, or from an Authorization: Bearer header.
 *
 * The Bearer path exists so scripts and tests can act as a customer without a cookie jar. It is
 * the same signed value, so it grants nothing a cookie would not.
 */
export async function readSession(c: Context): Promise<SessionClaims | null> {
  const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
  const cookie = readCookie(c.req.header('cookie'), SESSION_COOKIE)
  const value = bearer || cookie
  if (!value) return null

  const claims = await readClaims(value, 'session').catch(() => null)
  if (!claims) return null
  return { jobId: claims.jobId, exp: claims.exp }
}

/**
 * Pull the job id straight out of the path.
 *
 * NOT c.req.param(). This runs as wildcard middleware (/api/jobs/*), and a wildcard pattern has
 * no named parameters, so param('jobId') is undefined here and the ownership check below would
 * silently never run. That exact bug shipped for one commit and was caught by the end to end
 * script asserting that one session cannot read another job.
 */
export function jobIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/jobs\/([^/?#]+)/)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

/**
 * Guard every job route. The job id in the URL must match the session, so knowing somebody
 * else's job id gets you nowhere.
 */
export async function requireSession(c: Context, next: Next) {
  const session = await readSession(c)
  if (!session) {
    return c.json(
      {
        error: 'not_signed_in',
        detail: 'Open your website using the link we emailed you. If you have lost it we can send another.',
      },
      401,
    )
  }

  const jobId = jobIdFromPath(new URL(c.req.url).pathname)
  if (jobId && jobId !== session.jobId) {
    return c.json({ error: 'forbidden', detail: 'That build does not belong to this session.' }, 403)
  }

  c.set('jobId', session.jobId)
  await next()
}

/**
 * Admin guard for the steps a human at Go Polar performs, currently releasing a discharge
 * package. When ADMIN_TOKEN is set it is required. When it is not set, the route is only allowed
 * on an install that has no Shopify secret, which is to say a development one.
 */
export async function requireAdmin(c: Context, next: Next) {
  const cfg = config()

  if (cfg.adminToken) {
    // Accepted either way round. curl and the runbook use x-admin-token; a bearer header is what
    // anyone reaching for an API reaches for first, and refusing it teaches nothing.
    const bearer = (c.req.header('authorization') ?? '').replace(/^Bearer /i, '')
    const supplied = c.req.header('x-admin-token') ?? bearer
    if (!timingSafeEqualString(supplied, cfg.adminToken)) {
      return c.json({ error: 'forbidden', detail: 'Admin token required.' }, 403)
    }
    await next()
    return
  }

  /*
   * No token configured.
   *
   * Open on a demo install, because that is a laptop with fixture data on it and the operator
   * screens have to be usable without ceremony.
   *
   * REFUSED ANYWHERE ELSE. This used to be gated on the Shopify webhook secret, which left a
   * window: a deployment with DEMO_MODE=0 on a real domain, before the webhook had been
   * registered, served /api/admin/* to the entire internet. Publishing a site and reading the
   * event log both live behind here. The absence of a secret is not permission.
   */
  if (cfg.demoMode) {
    await next()
    return
  }

  return c.json(
    {
      error: 'forbidden',
      detail:
        'ADMIN_TOKEN is not set on this deployment, so admin actions are refused. Add it to the Vercel project environment variables.',
    },
    403,
  )
}

/**
 * Compare without leaking the answer in how long it took.
 *
 * Length is compared first and does leak, which is fine: the token is a random string of known
 * shape, and nobody guesses one character at a time from a length.
 */
function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
