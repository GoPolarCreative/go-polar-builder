import { config, type AppConfig } from '../config'

/**
 * Getting an Admin API token, however this install is configured to get one.
 *
 * WHY THIS EXISTS. Shopify removed admin-created custom apps. That was the flow where you went to
 * Settings, Apps, Develop apps, ticked some scopes and were handed a permanent `shpat_` token that
 * you pasted into an environment variable and never thought about again. New installs cannot do
 * that any more: the admin now points at the Dev Dashboard, and an app built there that acts on a
 * store in its own organisation authenticates with the **client credentials grant**.
 *
 * The practical difference is that there is no token to paste. There is a client id and a client
 * secret, and the app exchanges them for a token that **expires after 24 hours**. So the token has
 * to be fetched, cached and refreshed rather than read from configuration.
 *
 * BOTH ROUTES ARE SUPPORTED, deliberately:
 *
 *   - `SHOPIFY_ADMIN_API_TOKEN`, if set, is used as-is and never expires. Anyone maintaining an
 *     app created before the change keeps working, and it is the simpler thing to debug.
 *   - `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` otherwise, exchanged on demand.
 *
 * Neither set means no Admin API. That is reported as unverifiable rather than treated as a pass,
 * which is the rule everywhere else in this file's neighbourhood.
 */

const TOKEN_ENDPOINT = (domain: string) => `https://${domain}/admin/oauth/access_token`

/**
 * Refresh this far before the stated expiry.
 *
 * Shopify says 86399 seconds. A token that expires mid-request is a failed reconciliation sweep,
 * and the sweep is the backstop for a customer who paid and never got their link, so it is worth
 * five minutes of margin to never find out what that looks like.
 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

interface CachedToken {
  token: string
  expiresAt: number
  /** What Shopify says the token can do. A readback, not a request. */
  scope: string
}

let cached: CachedToken | null = null

/** Tests and the config reload path need this, because the cache outlives a config change. */
export function resetShopifyTokenCache(): void {
  cached = null
}

export class ShopifyAuthError extends Error {
  constructor(
    message: string,
    readonly fix: string,
  ) {
    super(message)
    this.name = 'ShopifyAuthError'
  }
}

/** How this install is set up to talk to the Admin API, for reporting rather than for logic. */
export function adminAuthMode(cfg: AppConfig = config()): 'static-token' | 'client-credentials' | 'none' {
  if (cfg.shopify.adminApiToken) return 'static-token'
  if (cfg.shopify.clientId && cfg.shopify.clientSecret) return 'client-credentials'
  return 'none'
}

/**
 * An Admin API access token, or null when this install has no way to get one.
 *
 * Null rather than a throw, because every caller already has a "cannot verify" path that says so
 * in words. A throw here would turn a configuration gap into an exception in a cron job.
 */
export async function adminApiToken(cfg: AppConfig = config()): Promise<string | null> {
  if (cfg.shopify.adminApiToken) return cfg.shopify.adminApiToken

  const clientId = cfg.shopify.clientId
  const clientSecret = cfg.shopify.clientSecret
  const domain = cfg.shopify.storeDomain
  if (!clientId || !clientSecret || !domain) return null

  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.token

  const res = await fetch(TOKEN_ENDPOINT(domain), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  })

  const body = await res.text()

  if (!res.ok) {
    // The one failure worth naming, because the message Shopify returns does not say what to do
    // and the cause is never obvious: the app and the store have to be in the same organisation,
    // and owning a store does not put it in one.
    if (body.includes('shop_not_permitted')) {
      throw new ShopifyAuthError(
        `Shopify refused the client credentials grant for ${domain}: the app and the store are not in the same organisation.`,
        'Open the Dev Dashboard, confirm the app is listed under Apps and that this store is listed under Stores in the same organisation. Check SHOPIFY_STORE_DOMAIN matches the myshopify.com subdomain exactly.',
      )
    }
    throw new ShopifyAuthError(
      `Shopify returned ${res.status} exchanging the client credentials for an access token: ${body.slice(0, 200)}`,
      'Check SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET against the Settings page of the app in the Dev Dashboard. A secret that has been rotated invalidates the old one immediately.',
    )
  }

  let parsed: { access_token?: string; expires_in?: number; scope?: string }
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new ShopifyAuthError(
      `Shopify returned something that is not JSON from the token endpoint: ${body.slice(0, 200)}`,
      'This usually means SHOPIFY_STORE_DOMAIN is not a myshopify.com domain. It must be the store subdomain, not the customer-facing domain.',
    )
  }

  if (!parsed.access_token) {
    throw new ShopifyAuthError(
      'Shopify accepted the token request but returned no access_token.',
      'Confirm the app has a released version with scopes selected, and that it is installed on the store.',
    )
  }

  const lifetimeMs = (parsed.expires_in ?? 86_399) * 1000
  cached = {
    token: parsed.access_token,
    scope: parsed.scope ?? '',
    // Never negative, however short a lifetime Shopify decides to return.
    expiresAt: now + Math.max(lifetimeMs - REFRESH_MARGIN_MS, 30_000),
  }
  return cached.token
}

/**
 * The scopes Shopify says this token actually has.
 *
 * Worth surfacing because scopes are chosen on the app's version in the Dev Dashboard, not in this
 * request, so the first sign that a scope was forgotten is a 403 on a call that used to be fine.
 * Null when the token came from configuration, since a static token does not report its own scopes.
 */
export function grantedScopes(): string | null {
  return cached?.scope ?? null
}

/**
 * The scopes this app actually needs, derived from the calls it makes rather than guessed at.
 *
 *   read_orders    listPaidOrdersSince, the reconciliation sweep
 *   read_products  the product, variant and selling plan checks
 *
 * Storefront access is separate and is listed on the app's version as an unauthenticated scope:
 *   unauthenticated_write_checkouts   cartCreate, for a checkout carrying two subscriptions
 */
export const REQUIRED_ADMIN_SCOPES = ['read_orders', 'read_products'] as const
export const REQUIRED_UNAUTHENTICATED_SCOPES = ['unauthenticated_write_checkouts'] as const

/**
 * Check the token can do what the app needs, once, at boot or from the health endpoint.
 *
 * Only meaningful for the client credentials route, where Shopify reads the scopes back. Returns
 * an empty array when there is nothing to say, including when the answer is unknowable.
 */
export function missingScopes(): string[] {
  const scope = cached?.scope
  if (!scope) return []
  const granted = new Set(scope.split(',').map((s) => s.trim()))
  return REQUIRED_ADMIN_SCOPES.filter((needed) => !granted.has(needed))
}

/**
 * The Storefront API token, which in the Dev Dashboard world is not shown anywhere.
 *
 * A storefront access token is created through the Admin API and inherits the unauthenticated
 * scopes of the app that creates it, so this only works when the app's released version carries
 * `unauthenticated_write_checkouts`. If it does not, Shopify refuses the creation rather than
 * handing back a token that cannot do anything, which is the right way round.
 *
 * Existing tokens are reused. Shopify allows 100 per app per shop, and a function that created a
 * fresh one on every cold start would spend them silently and then start failing months later for
 * a reason nobody would connect to this.
 */
const STOREFRONT_TOKEN_TITLE = 'Go Polar Website Builder'

export async function ensureStorefrontToken(
  cfg: AppConfig = config(),
): Promise<{ token: string; created: boolean; scopes: string }> {
  const admin = await adminApiToken(cfg)
  if (!admin) {
    throw new ShopifyAuthError(
      'No Admin API credentials, so a Storefront token cannot be created.',
      'Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET first. See DEPLOY.md section 6.',
    )
  }

  const domain = cfg.shopify.storeDomain
  if (!domain) {
    throw new ShopifyAuthError('SHOPIFY_STORE_DOMAIN is not set.', 'Set it to the myshopify.com subdomain.')
  }

  const base = `https://${domain}/admin/api/2025-01/storefront_access_tokens.json`
  const headers = { 'X-Shopify-Access-Token': admin, 'content-type': 'application/json' }

  const existing = await fetch(base, { headers })
  if (existing.ok) {
    const json = (await existing.json()) as {
      storefront_access_tokens?: Array<{ access_token: string; title: string; access_scope: string }>
    }
    const mine = json.storefront_access_tokens?.find((t) => t.title === STOREFRONT_TOKEN_TITLE)
    if (mine) return { token: mine.access_token, created: false, scopes: mine.access_scope ?? '' }
  }

  const res = await fetch(base, {
    method: 'POST',
    headers,
    body: JSON.stringify({ storefront_access_token: { title: STOREFRONT_TOKEN_TITLE } }),
  })

  const body = await res.text()
  if (!res.ok) {
    throw new ShopifyAuthError(
      `Shopify returned ${res.status} creating a Storefront access token: ${body.slice(0, 200)}`,
      'This usually means the app version has no unauthenticated scopes. Release a version with unauthenticated_write_checkouts, approve it on the store, and try again.',
    )
  }

  const json = JSON.parse(body) as {
    storefront_access_token?: { access_token: string; access_scope: string }
  }
  const token = json.storefront_access_token?.access_token
  if (!token) {
    throw new ShopifyAuthError(
      'Shopify accepted the request but returned no Storefront access token.',
      'Check the app is installed on this store.',
    )
  }

  return { token, created: true, scopes: json.storefront_access_token?.access_scope ?? '' }
}
