import { config, type AppConfig } from '../config'

/**
 * HMAC signing for build tokens, session cookies and signed download links.
 *
 * Everything derives from APP_SECRET. There is no session table: a session is a signed value the
 * server can verify without a read. See DECISIONS.md D10 for the trade that makes.
 *
 * Uses WebCrypto, which is available in Node 18 and later as well as in every edge runtime, so
 * this file did not have to change when the platform did.
 */

export class MissingSecretError extends Error {
  constructor(name: string) {
    super(
      `${name} is not set. Add it to .env.local for local development, or to the Vercel project environment variables for production. Generate one with: node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`,
    )
    this.name = 'MissingSecretError'
  }
}

function requireSecret(cfg: AppConfig): string {
  const secret = cfg.appSecret
  if (!secret) throw new MissingSecretError('APP_SECRET')
  return secret
}

async function key(cfg: AppConfig): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(requireSecret(cfg)),
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

export async function sign(payload: string, cfg: AppConfig = config()): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await key(cfg), new TextEncoder().encode(payload))
  return base64url(signature)
}

/**
 * Constant-time verify. crypto.subtle.verify is constant time, which is why it is used instead
 * of re-signing and comparing strings: a plain === on a signature leaks timing.
 */
export async function verifySignature(
  payload: string,
  signature: string,
  cfg: AppConfig = config(),
): Promise<boolean> {
  const bytes = fromBase64Url(signature)
  if (!bytes) return false
  try {
    return await crypto.subtle.verify('HMAC', await key(cfg), bytes, new TextEncoder().encode(payload))
  } catch {
    return false
  }
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
    // Built over an explicit ArrayBuffer so it satisfies BufferSource.
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

export async function signClaims(claims: SignedClaims, cfg: AppConfig = config()): Promise<string> {
  const payload = base64url(new TextEncoder().encode(JSON.stringify(claims)))
  return `${payload}.${await sign(payload, cfg)}`
}

export async function readClaims(
  value: string,
  expectedKind: SignedClaims['kind'],
  cfg: AppConfig = config(),
): Promise<SignedClaims | null> {
  const [payload, signature] = value.split('.')
  if (!payload || !signature) return null
  if (!(await verifySignature(payload, signature, cfg))) return null

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
 * Shopify signs the RAW request body and sends base64 in X-Shopify-Hmac-Sha256. The body must be
 * verified before it is parsed, which is why callers read the text first and hand it in here.
 */
export async function verifyShopifyHmac(
  secret: string,
  rawBody: string,
  headerValue: string | null,
): Promise<boolean> {
  if (!headerValue) return false

  const signature = fromBase64Url(
    headerValue.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  )
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
