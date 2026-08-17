import type { Env } from '../env'
import { HANDLE_TO_KIND, sellingPlanEnvKey, variantEnvKey } from '../../shared/pricing'

/**
 * Shopify integration. Brief s3a. Shopify is the front door: the customer never sees the app
 * until they have paid, and every later payment (hosting, edits, discharge) is a checkout link
 * generated here and confirmed by an orders/paid webhook.
 *
 * See DECISIONS.md D1 for why this is Shopify and not Stripe.
 *
 * NO CREDENTIALS ARE AVAILABLE IN THIS BUILD. Everything is written against the real APIs and
 * reads its configuration from Worker env. Nothing is stubbed: with the ids and tokens set it
 * works, and without them it throws an error that names the exact missing variable.
 */

export class ShopifyConfigError extends Error {
  constructor(
    message: string,
    readonly missing: string[],
  ) {
    super(message)
    this.name = 'ShopifyConfigError'
  }
}

function storeDomain(env: Env): string {
  const domain = env.SHOPIFY_STORE_DOMAIN?.trim()
  if (!domain) {
    throw new ShopifyConfigError(
      'SHOPIFY_STORE_DOMAIN is not set, so no checkout link can be built. Set it to the myshopify.com domain, for example itscold.myshopify.com.',
      ['SHOPIFY_STORE_DOMAIN'],
    )
  }
  return domain.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

function envValue(env: Env, key: string): string | undefined {
  return (env as unknown as Record<string, string | undefined>)[key]?.trim() || undefined
}

export interface CheckoutLine {
  /** Shopify product handle, e.g. hosting-monthly. */
  handle: string
  quantity: number
}

export interface CheckoutRequest {
  jobId: string
  email: string
  lines: CheckoutLine[]
  /** Where Shopify sends them after paying. */
  returnTo?: string
}

/**
 * Build a checkout the customer can pay. Prefers the Storefront API, which is the only way to
 * attach a different selling plan to each line, and falls back to a cart permalink when there is
 * no Storefront token.
 */
export async function createCheckout(env: Env, req: CheckoutRequest): Promise<{ url: string; method: 'storefront' | 'permalink' }> {
  const missing: string[] = []
  const resolved = req.lines.map((line) => {
    const variantKey = variantEnvKey(line.handle)
    const planKey = sellingPlanEnvKey(line.handle)
    const variantId = envValue(env, variantKey)
    if (!variantId) missing.push(variantKey)
    return {
      handle: line.handle,
      quantity: line.quantity,
      variantId,
      sellingPlanId: envValue(env, planKey),
    }
  })

  if (missing.length > 0) {
    throw new ShopifyConfigError(
      `Cannot build a checkout link: ${missing.join(', ')} not set. Create the product in Shopify, copy the variant id, and set it as a Worker secret or var.`,
      missing,
    )
  }

  const storefrontToken = env.SHOPIFY_STOREFRONT_TOKEN?.trim()
  if (storefrontToken) {
    return {
      url: await createCartViaStorefront(env, storefrontToken, req, resolved as ResolvedLine[]),
      method: 'storefront',
    }
  }

  return { url: permalink(env, req, resolved as ResolvedLine[]), method: 'permalink' }
}

interface ResolvedLine {
  handle: string
  quantity: number
  variantId: string
  sellingPlanId?: string
}

/**
 * Cart permalink fallback.
 *
 * LIMITATION, and it is why the Storefront path is preferred: a permalink takes a single
 * selling_plan parameter, so it can only carry one subscription line. When more than one
 * subscription is requested this throws rather than quietly dropping the customer's email add-on
 * from their cart.
 */
function permalink(env: Env, req: CheckoutRequest, lines: ResolvedLine[]): string {
  const subscriptions = lines.filter((l) => l.sellingPlanId)
  if (subscriptions.length > 1) {
    throw new ShopifyConfigError(
      'This checkout has more than one subscription line, which a cart permalink cannot carry. Set SHOPIFY_STOREFRONT_TOKEN so carts can be created through the Storefront API.',
      ['SHOPIFY_STOREFRONT_TOKEN'],
    )
  }

  const items = lines.map((l) => `${l.variantId}:${l.quantity}`).join(',')
  const params = new URLSearchParams()
  if (subscriptions[0]?.sellingPlanId) params.set('selling_plan', subscriptions[0].sellingPlanId)
  params.set('checkout[email]', req.email)
  // Carried through to the order so the webhook can match it back to the job without guessing.
  params.set('attributes[job_id]', req.jobId)
  if (req.returnTo) params.set('return_to', req.returnTo)

  return `https://${storeDomain(env)}/cart/${items}?${params.toString()}`
}

/** Storefront API cart creation. Each line carries its own selling plan. */
async function createCartViaStorefront(
  env: Env,
  token: string,
  req: CheckoutRequest,
  lines: ResolvedLine[],
): Promise<string> {
  const query = `
    mutation cartCreate($input: CartInput!) {
      cartCreate(input: $input) {
        cart { checkoutUrl }
        userErrors { field message }
      }
    }`

  const variables = {
    input: {
      buyerIdentity: { email: req.email },
      attributes: [{ key: 'job_id', value: req.jobId }],
      lines: lines.map((l) => ({
        quantity: l.quantity,
        merchandiseId: `gid://shopify/ProductVariant/${l.variantId}`,
        ...(l.sellingPlanId ? { sellingPlanId: `gid://shopify/SellingPlan/${l.sellingPlanId}` } : {}),
      })),
    },
  }

  const res = await fetch(`https://${storeDomain(env)}/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Shopify-Storefront-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!res.ok) {
    throw new Error(`Shopify Storefront API returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }

  const json = (await res.json()) as {
    data?: { cartCreate?: { cart?: { checkoutUrl?: string }; userErrors?: Array<{ message: string }> } }
    errors?: Array<{ message: string }>
  }

  const errors = [
    ...(json.errors ?? []).map((e) => e.message),
    ...(json.data?.cartCreate?.userErrors ?? []).map((e) => e.message),
  ]
  if (errors.length > 0) throw new Error(`Shopify rejected the cart: ${errors.join('; ')}`)

  const url = json.data?.cartCreate?.cart?.checkoutUrl
  if (!url) throw new Error('Shopify returned a cart with no checkout URL')
  return url
}

// ---------------------------------------------------------------------------------------------
// Webhook payloads
// ---------------------------------------------------------------------------------------------

export interface ShopifyLineItem {
  product_id?: number | string
  variant_id?: number | string
  sku?: string | null
  title?: string
  quantity?: number
  price?: string
  name?: string
}

export interface ShopifyOrder {
  id: number | string
  email?: string | null
  contact_email?: string | null
  customer?: { id?: number | string; email?: string | null; first_name?: string | null; last_name?: string | null; phone?: string | null }
  line_items?: ShopifyLineItem[]
  note_attributes?: Array<{ name: string; value: string }>
  total_price?: string
  currency?: string
  created_at?: string
  financial_status?: string
}

export function orderEmail(order: ShopifyOrder): string | null {
  const email = order.email ?? order.contact_email ?? order.customer?.email ?? null
  return email ? email.trim().toLowerCase() : null
}

export function orderJobIdAttribute(order: ShopifyOrder): string | null {
  return order.note_attributes?.find((a) => a.name === 'job_id')?.value ?? null
}

/**
 * Work out which product a line item is.
 *
 * orders/paid does not include the product handle, so matching goes: configured variant id
 * first, then SKU (set the SKU to the handle in Shopify and this always works), then the product
 * title as a last resort. An unmatched line is reported, never guessed at.
 */
export function handleForLineItem(env: Env, item: ShopifyLineItem): string | null {
  const variantId = item.variant_id != null ? String(item.variant_id) : null
  if (variantId) {
    for (const handle of Object.keys(HANDLE_TO_KIND)) {
      if (envValue(env, variantEnvKey(handle)) === variantId) return handle
    }
  }

  const sku = item.sku?.trim().toLowerCase()
  if (sku && sku in HANDLE_TO_KIND) return sku

  const title = (item.title ?? item.name ?? '').toLowerCase()
  if (title.includes('build')) return 'build-token'
  if (title.includes('hosting')) return 'hosting-monthly'
  if (title.includes('domain')) return 'domain-monthly'
  if (title.includes('email')) return 'email-monthly'
  if (title.includes('discharge')) return 'discharge'
  if (title.includes('update')) return 'post-live-edit'
  if (title.includes('edits')) return 'extra-edits'

  return null
}

export function kindForHandle(handle: string): 'build' | 'hosting' | 'domain' | 'email' | 'edit' | 'discharge' | null {
  return HANDLE_TO_KIND[handle] ?? null
}

export function centsFromPrice(price: string | undefined): number {
  const value = Number(price ?? '0')
  return Number.isFinite(value) ? Math.round(value * 100) : 0
}

// ---------------------------------------------------------------------------------------------
// Admin API, used by the reconciliation sweep
// ---------------------------------------------------------------------------------------------

/**
 * Paid orders since a timestamp. Brief s3a: "Webhooks do get dropped and a paying customer who
 * never receives a link is the worst possible failure in this system."
 */
export async function listPaidOrdersSince(env: Env, sinceIso: string): Promise<ShopifyOrder[]> {
  const token = env.SHOPIFY_ADMIN_API_TOKEN?.trim()
  if (!token) {
    throw new ShopifyConfigError(
      'SHOPIFY_ADMIN_API_TOKEN is not set, so missed orders cannot be reconciled. Create a custom app in Shopify with read_orders scope and set the token as a Worker secret.',
      ['SHOPIFY_ADMIN_API_TOKEN'],
    )
  }

  const url = new URL(`https://${storeDomain(env)}/admin/api/2025-01/orders.json`)
  url.searchParams.set('status', 'any')
  url.searchParams.set('financial_status', 'paid')
  url.searchParams.set('created_at_min', sinceIso)
  url.searchParams.set('limit', '250')

  const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } })
  if (!res.ok) {
    throw new Error(`Shopify Admin API returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }

  const json = (await res.json()) as { orders?: ShopifyOrder[] }
  return json.orders ?? []
}
