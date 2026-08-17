import type { Context, Next } from 'hono'
import type { Env } from '../env'
import { TOKEN_TTL_DAYS, hashToken, mintToken, readClaims, signClaims } from './signing'
import { id, nowIso } from './ids'

/**
 * Auth. Brief s3a: token link by email, no passwords.
 *
 * A build token is 32 random bytes emailed to the customer. Only its hash is stored. On first
 * click it is exchanged for a signed session cookie tied to the job. See DECISIONS.md D10.
 */

export const SESSION_COOKIE = 'gp_session'
export const SESSION_TTL_DAYS = TOKEN_TTL_DAYS

export interface SessionClaims {
  jobId: string
  exp: number
}

/** Mint a build token for a job and store only its hash. Returns the raw token, once. */
export async function createBuildToken(env: Env, jobId: string): Promise<string> {
  const token = mintToken()
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 86_400_000).toISOString()

  await env.DB.prepare(
    'INSERT INTO tokens (id, job_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(id('tok'), jobId, await hashToken(token), expiresAt, nowIso())
    .run()

  return token
}

export function buildLink(env: Env, token: string): string {
  const base = (env.PUBLIC_APP_URL ?? 'https://build.itscold.com.au').replace(/\/$/, '')
  return `${base}/start?t=${encodeURIComponent(token)}`
}

/**
 * Exchange a build token for a session. The token stays valid for its full 90 days, because
 * people open the same email on a second device, but the first use is recorded.
 */
export async function exchangeToken(
  env: Env,
  token: string,
): Promise<{ jobId: string; session: string } | { error: string }> {
  const hash = await hashToken(token)
  const row = await env.DB.prepare(
    'SELECT id, job_id, expires_at, first_used_at FROM tokens WHERE token_hash = ?',
  )
    .bind(hash)
    .first<{ id: string; job_id: string; expires_at: string; first_used_at: string | null }>()

  if (!row) {
    return { error: 'That link is not valid. Use the "send my link again" option and we will email a fresh one.' }
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { error: 'That link has expired. They last 90 days. Ask for a new one and we will send it through.' }
  }

  if (!row.first_used_at) {
    await env.DB.prepare('UPDATE tokens SET first_used_at = ? WHERE id = ?').bind(nowIso(), row.id).run()
  }

  const session = await signClaims(env, {
    kind: 'session',
    jobId: row.job_id,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_DAYS * 86_400,
  })

  return { jobId: row.job_id, session }
}

export function sessionCookie(env: Env, session: string): string {
  const secure = (env.PUBLIC_APP_URL ?? '').startsWith('https://') ? '; Secure' : ''
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
export async function readSession(c: Context<{ Bindings: Env }>): Promise<SessionClaims | null> {
  const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
  const cookie = readCookie(c.req.header('cookie'), SESSION_COOKIE)
  const value = bearer || cookie
  if (!value) return null

  const claims = await readClaims(c.env, value, 'session').catch(() => null)
  if (!claims) return null
  return { jobId: claims.jobId, exp: claims.exp }
}

/**
 * Guard every job route. The job id in the URL must match the session, so knowing somebody
 * else's job id gets you nowhere.
 */
export async function requireSession(c: Context<{ Bindings: Env }>, next: Next) {
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

  const jobId = c.req.param('jobId') ?? c.req.param('id')
  if (jobId && jobId !== session.jobId) {
    return c.json({ error: 'forbidden', detail: 'That build does not belong to this session.' }, 403)
  }

  c.set('jobId' as never, session.jobId as never)
  await next()
}

/**
 * Admin guard for the steps a human at Go Polar performs, currently releasing a discharge
 * package. When ADMIN_TOKEN is set it is required. When it is not set, the route is only allowed
 * on an install that has no Shopify secret, which is to say a development one.
 */
export async function requireAdmin(c: Context<{ Bindings: Env }>, next: Next) {
  const configured = c.env.ADMIN_TOKEN?.trim()
  if (configured) {
    if (c.req.header('x-admin-token') !== configured) {
      return c.json({ error: 'forbidden', detail: 'Admin token required.' }, 403)
    }
    await next()
    return
  }

  if (c.env.SHOPIFY_WEBHOOK_SECRET) {
    return c.json(
      {
        error: 'forbidden',
        detail: 'ADMIN_TOKEN is not set on this deployment, so admin actions are refused. Set it with "npx wrangler secret put ADMIN_TOKEN".',
      },
      403,
    )
  }

  await next()
}
