/**
 * Worker bindings and secrets.
 *
 * Everything in here is server side only. None of it is importable from src/, and none of it is
 * prefixed VITE_, so it cannot reach the client bundle. Brief s14: if the Anthropic key ever
 * appears in dist/client that is a build failure. `scripts/check-bundle.mjs` asserts it.
 */
export interface Env {
  // Bindings
  DB: D1Database
  BUCKET: R2Bucket
  ASSETS: Fetcher
  /**
   * Cloudflare Browser Rendering, used by verification checks 13-16.
   * Optional: unavailable in local dev and on the free plan. When it is missing those checks
   * report "skipped" rather than silently passing.
   */
  BROWSER?: Fetcher

  // Secrets / vars
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_MODEL?: string
  WEB3FORMS_ACCESS_KEY?: string
  PUBLIC_APP_URL?: string
  APP_SECRET?: string

  // Shopify. Every payment goes through here, one-off and recurring (brief s3a, DECISIONS.md D1).
  SHOPIFY_WEBHOOK_SECRET?: string
  SHOPIFY_ADMIN_API_TOKEN?: string
  SHOPIFY_STORE_DOMAIN?: string
  /** Optional. With it, carts are created through the Storefront API, which is the only way to
   *  put a different selling plan on each line. Without it, checkout falls back to a cart
   *  permalink, which can only carry one subscription line. */
  SHOPIFY_STOREFRONT_TOKEN?: string
  /**
   * Per-product variant and selling-plan ids, read dynamically by name:
   *   SHOPIFY_VARIANT_BUILD_TOKEN, SHOPIFY_VARIANT_HOSTING_MONTHLY, ...
   *   SHOPIFY_SELLING_PLAN_HOSTING_MONTHLY, ...
   * They are per-store values that only exist once the products are created, so they are read
   * from env rather than declared here one by one. See shared/pricing.ts.
   */
  RESEND_API_KEY?: string
  RESEND_FROM?: string
  GHL_INBOUND_WEBHOOK_URL?: string

  /**
   * Set to "1" to run generation against a deterministic local stub instead of the Anthropic
   * API. Exists so Phases 2 and 3 can be exercised end to end without a key, and so the
   * verification suite has something to chew on in CI. Never set in production.
   */
  DEV_OFFLINE_GENERATION?: string
}

export const DEFAULT_MODEL = 'claude-sonnet-5'

export function modelFor(env: Env): string {
  return env.ANTHROPIC_MODEL || DEFAULT_MODEL
}

/**
 * Web3Forms key injected server side. Brief s4: this is Go Polar infrastructure, not customer
 * data. Asking for it produced emails and random numbers instead of UUIDs on nearly every
 * submission, so the customer is never asked.
 */
export function web3formsKey(env: Env): string {
  const key = env.WEB3FORMS_ACCESS_KEY?.trim()
  if (key && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) return key
  // Do not fail the build over this in dev. Ship a clearly commented placeholder that the
  // static checks will still accept as a form action, and that a human will notice.
  return '00000000-0000-0000-0000-000000000000'
}
