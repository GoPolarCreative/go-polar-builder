import type { Env } from '../env'

/**
 * HMAC signing for build tokens, session cookies and signed download links.
 *
 * Everything is derived from APP_SECRET, which lives in Worker secrets. There is no session
 * table: a session is a signed value the Worker can verify without a read. See DECISIONS.md D10
 * for the trade that makes, and what to do if Chris would rather have revocable sessions.
 */

export class MissingSecretError extends Error {
  constructor(name: string) {
    super(
      `${name} is not set. Add it to .dev.vars for local dev, or run "npx wrangler secret put ${name}" for production. Generate one with: node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`,
    )
    this.name = 'MissingSecretError'
  }
}

function requireSecret(env: Env): string {
  const secret = env.APP_SECRET?.trim()
  if (!secret) throw new MissingSecretError('APP_SECRET')
  return secret
}

async function key(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(requireSecret(env)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function sign(env: Env, payload: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await key(env), new TextEncoder().encode(payload))
  return base64url(signature)
}

/**
 * Constant-time verify. `crypto.subtle.verify` is constant time, which is why it is used instead
 * of re-signing and comparing strings: a plain === on a signature leaks timing.
 */
export async function verifySignature(env: Env, payload: string, signature: string): Promise<boolean> {
  const bytes = fromBase64Url(signature)
  if (!bytes) return false
  try {
    return await crypto.subtle.verify('HMAC', await key(env), bytes, new TextEncoder().encode(payload))
  } catch {
    return false
  }
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
    // Built over an explicit ArrayBuffer so it satisfies BufferSource. Uint8Array.from gives
    // ArrayBufferLike, which TypeScript will not accept for WebCrypto.
    const bytes = new Uint8Array(new ArrayBuffer(binary.length))
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// Signed values: "<payload>.<signature>", where payload is base64url JSON
// ---------------------------------------------------------------------------------------------

export interface SignedClaims {
  /** What this value is for, so a download link can never be replayed as a session. */
  kind: 'session' | 'download'
  jobId: string
  /** Unix seconds. */
  exp: number
  [key: string]: unknown
}

export async function signClaims(env: Env, claims: SignedClaims): Promise<string> {
  const payload = base64url(new TextEncoder().encode(JSON.stringify(claims)))
  return `${payload}.${await sign(env, payload)}`
}

export async function readClaims(
  env: Env,
  value: string,
  expectedKind: SignedClaims['kind'],
): Promise<SignedClaims | null> {
  const [payload, signature] = value.split('.')
  if (!payload || !signature) return null
  if (!(await verifySignature(env, payload, signature))) return null

  const bytes = fromBase64Url(payload)
  if (!bytes) return null

  let claims: SignedClaims
  try {
    claims = JSON.parse(new TextDecoder().decode(bytes)) as SignedClaims
  } catch {
    return null
  }

  if (claims.kind !== expectedKind) return null
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null
  return claims
}

// ---------------------------------------------------------------------------------------------
// Build tokens
// ---------------------------------------------------------------------------------------------

/** 90 days. People buy on a Thursday night and start on a Sunday (brief s3a). */
export const TOKEN_TTL_DAYS = 90

/**
 * A build token is 32 random bytes. Only its SHA-256 hash is stored, so the database never holds
 * anything that could be used to log in.
 */
export function mintToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64url(bytes)
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return base64url(digest)
}

// ---------------------------------------------------------------------------------------------
// Shopify webhook verification
// ---------------------------------------------------------------------------------------------

/**
 * Verify a Shopify webhook HMAC. Brief s3a: reject anything that fails verification, and do not
 * trust the payload otherwise.
 *
 * Shopify signs the RAW request body with the webhook secret and sends base64 in
 * X-Shopify-Hmac-Sha256. The body must be verified before it is parsed, which is why callers
 * read the text first and hand it in here.
 */
export async function verifyShopifyHmac(
  secret: string,
  rawBody: string,
  headerValue: string | null,
): Promise<boolean> {
  if (!headerValue) return false

  const signature = fromBase64Url(headerValue.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
  if (!signature) return false

  const hmacKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  try {
    return await crypto.subtle.verify('HMAC', hmacKey, signature, new TextEncoder().encode(rawBody))
  } catch {
    return false
  }
}
