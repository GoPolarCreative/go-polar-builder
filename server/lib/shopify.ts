import { PRICING, knownHandles, productForHandle, sellingPlanEnvKey, variantEnvKey } from '../../shared/pricing'
import { assertLiveEnabled, config, type AppConfig } from '../config'
import { fakeCheckoutUrl } from './integrations/fakes'

/**
 * Shopify. Brief s3a. Shopify is the front door: the customer never sees the app until they have
 * paid, and every later payment is a checkout link generated here and confirmed by an
 * orders/paid webhook. See DECISIONS.md D1 for why this is Shopify and not Stripe.
 *
 * In demo mode no checkout is created. A local demo checkout link is returned instead, which
 * runs the same processPaidOrder the real webhook runs, so the flow is clickable end to end with
 * nothing configured and the code path exercised is the production one.
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

function storeDomain(cfg: AppConfig): string {
  const domain = cfg.shopify.storeDomain
  if (!domain) {
    throw new ShopifyConfigError(
      'SHOPIFY_STORE_DOMAIN is not set, so no checkout link can be built. Set it to the myshopify.com domain, for example itscold.myshopify.com.',
      ['SHOPIFY_STORE_DOMAIN'],
    )
  }
  return domain.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

/**
 * Variant and selling-plan ids are per-store values that only exist once the products are
 * created, and there is one per product, so they are read by name from the environment rather
 * than declared one by one in config.
 */
function envValue(key: string): string | undefined {
  const value = process.env[key]
  return value && value.trim() !== '' ? value.trim() : undefined
}

export interface CheckoutLine {
  handle: string
  quantity: number
}

export interface CheckoutRequest {
  jobId: string
  email: string
  lines: CheckoutLine[]
  returnTo?: string
}

export async function createCheckout(
  req: CheckoutRequest,
): Promise<{ url: string; method: 'storefront' | 'permalink' | 'demo' }> {
  const cfg = config()

  if (cfg.demoMode) return { url: fakeCheckoutUrl(req), method: 'demo' }

  // Sending a customer to a real checkout is a live payment action.
  assertLiveEnabled('payments', cfg)

  const missing: string[] = []
  const resolved = req.lines.map((line) => {
    const variantKey = variantEnvKey(line.handle)
    const variantId = envValue(variantKey)
    if (!variantId) missing.push(variantKey)

    const sellingPlanId = envValue(sellingPlanEnvKey(line.handle))
    // A product with requiresSellingPlan on the store CANNOT be bought without one. Shopify
    // rejects the line outright rather than falling back to a one-off charge, so a missing plan id
    // is exactly as fatal as a missing variant id and is treated the same way.
    const product = productForHandle(line.handle)?.product
    if (product?.requiresSellingPlan && !sellingPlanId) missing.push(sellingPlanEnvKey(line.handle))

    return { handle: line.handle, quantity: line.quantity, variantId, sellingPlanId }
  })

  if (missing.length > 0) {
    throw new ShopifyConfigError(
      `Cannot build a checkout link: ${missing.join(', ')} not set. ${
        missing.some((m) => m.startsWith('SHOPIFY_SELLING_PLAN'))
          ? 'The subscription products cannot be bought without their selling plan id: Shopify rejects the line. '
          : ''
      }Copy the ids out of Shopify and add them to the Vercel project environment variables. See SHOPIFY-SETUP.md.`,
      missing,
    )
  }

  // What the app believes it is selling has to match what the store will actually bill. The domain
  // product spent a period named "Monthly Subscription" while billing once a year, which is exactly
  // the failure this catches: silent, and expensive in the customer's favour or ours.
  await assertBillingPoliciesMatch(req.lines.map((l) => l.handle))

  if (cfg.shopify.storefrontToken) {
    return {
      url: await createCartViaStorefront(cfg, req, resolved as ResolvedLine[]),
      method: 'storefront',
    }
  }

  return { url: permalink(cfg, req, resolved as ResolvedLine[]), method: 'permalink' }
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
 * LIMITATION, and why the Storefront path is preferred: a permalink takes a single selling_plan
 * parameter, so it carries only one subscription line. When more than one is requested this
 * throws rather than quietly dropping the customer's email add-on from their cart.
 */
function permalink(cfg: AppConfig, req: CheckoutRequest, lines: ResolvedLine[]): string {
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

  return `https://${storeDomain(cfg)}/cart/${items}?${params.toString()}`
}

async function createCartViaStorefront(
  cfg: AppConfig,
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

  const res = await fetch(`https://${storeDomain(cfg)}/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Shopify-Storefront-Access-Token': cfg.shopify.storefrontToken!,
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
// Billing policy verification
// ---------------------------------------------------------------------------------------------

/**
 * Does the store bill this product the way the app says it does?
 *
 * The domain product was configured with a selling plan called "Monthly Subscription" whose
 * billing policy was interval YEAR, count 1. Nothing in Shopify objects to that: the name is a
 * label and the policy is the behaviour. The app would have advertised $5.50 a month and the store
 * would have charged $5.50 a year, and the only way anybody finds out is by reading a billing
 * policy or by noticing the revenue is missing twelve months later.
 *
 * A comment would not have caught it, so this reads the real policy out of the Admin API and
 * refuses to build a checkout link for any product whose interval does not match.
 */
export class BillingPolicyMismatchError extends Error {
  constructor(readonly mismatches: BillingMismatch[]) {
    super(
      [
        `Refusing to build a checkout: ${mismatches.length} product(s) bill differently to what this app advertises.`,
        ...mismatches.map(
          (m) =>
            `  - "${m.label}" (${m.handle}) is sold as ${m.expected} but its selling plan "${m.planName}" bills every ${m.actualCount} ${m.actual}.`,
        ),
        'Fix the billing policy in Appstle, or correct the product in shared/pricing.ts. See SHOPIFY-SETUP.md.',
      ].join('\n'),
    )
    this.name = 'BillingPolicyMismatchError'
  }
}

export interface BillingMismatch {
  handle: string
  label: string
  planName: string
  expected: string
  actual: string
  actualCount: number
}

export interface BillingPolicyCheck {
  handle: string
  label: string
  ok: boolean
  detail: string
}

interface CachedPolicies {
  at: number
  results: BillingPolicyCheck[]
  mismatches: BillingMismatch[]
}

let policyCache: CachedPolicies | null = null
/** Shopify is not asked on every checkout. A billing policy changes when a human changes it. */
const POLICY_TTL_MS = 10 * 60 * 1000

export function clearBillingPolicyCache(): void {
  policyCache = null
}

const PRODUCT_POLICY_QUERY = `
  query productPolicies($handle: String!) {
    productByHandle(handle: $handle) {
      title
      requiresSellingPlan
      sellingPlanGroups(first: 5) {
        nodes {
          name
          sellingPlans(first: 5) {
            nodes {
              name
              billingPolicy {
                ... on SellingPlanRecurringBillingPolicy { interval intervalCount }
              }
            }
          }
        }
      }
    }
  }`

/**
 * Reads every configured product's billing policy. Returns a report rather than throwing, so the
 * health endpoint can show it; `assertBillingPoliciesMatch` is the throwing wrapper used before a
 * checkout is built.
 */
export async function checkBillingPolicies(force = false): Promise<CachedPolicies> {
  const cfg = config()
  const now = Date.now()

  if (!force && policyCache && now - policyCache.at < POLICY_TTL_MS) return policyCache

  const results: BillingPolicyCheck[] = []
  const mismatches: BillingMismatch[] = []

  // Nothing to ask, and nothing to protect: demo mode never reaches a real checkout.
  if (cfg.demoMode) {
    policyCache = { at: now, results, mismatches }
    return policyCache
  }

  const token = cfg.shopify.adminApiToken
  if (!token) {
    // Not a mismatch, but not a pass either. Reported as unknown so it cannot read as verified.
    for (const product of Object.values(PRICING)) {
      if (!product.handle || !product.requiresSellingPlan) continue
      results.push({
        handle: product.handle,
        label: product.label,
        ok: false,
        detail:
          'Cannot verify: SHOPIFY_ADMIN_API_TOKEN is not set, so the billing policy on the store cannot be read.',
      })
    }
    policyCache = { at: now, results, mismatches }
    return policyCache
  }

  for (const product of Object.values(PRICING)) {
    if (!product.handle || !product.requiresSellingPlan) continue

    try {
      const res = await fetch(`https://${storeDomain(cfg)}/admin/api/2025-01/graphql.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query: PRODUCT_POLICY_QUERY, variables: { handle: product.handle } }),
      })

      if (!res.ok) {
        results.push({
          handle: product.handle,
          label: product.label,
          ok: false,
          detail: `Shopify Admin API returned ${res.status} reading this product.`,
        })
        continue
      }

      const json = (await res.json()) as {
        data?: {
          productByHandle?: {
            title?: string
            sellingPlanGroups?: {
              nodes?: Array<{
                name?: string
                sellingPlans?: {
                  nodes?: Array<{ name?: string; billingPolicy?: { interval?: string; intervalCount?: number } }>
                }
              }>
            }
          } | null
        }
      }

      const node = json.data?.productByHandle
      if (!node) {
        results.push({
          handle: product.handle,
          label: product.label,
          ok: false,
          detail: 'No product with this handle exists on the store.',
        })
        continue
      }

      const plans = (node.sellingPlanGroups?.nodes ?? []).flatMap((g) =>
        (g.sellingPlans?.nodes ?? []).map((p) => ({ group: g.name ?? '', ...p })),
      )

      if (plans.length === 0) {
        results.push({
          handle: product.handle,
          label: product.label,
          ok: false,
          detail: 'The product requires a selling plan but has no selling plan groups attached.',
        })
        continue
      }

      const expected = product.recurrence === 'monthly' ? 'MONTH' : 'ONE-OFF'
      const bad = plans.filter(
        (p) => p.billingPolicy?.interval !== expected || (p.billingPolicy?.intervalCount ?? 1) !== 1,
      )

      if (bad.length > 0) {
        const first = bad[0]!
        mismatches.push({
          handle: product.handle,
          label: product.label,
          planName: first.name ?? 'unnamed plan',
          expected: `every 1 ${expected}`,
          actual: first.billingPolicy?.interval ?? 'unknown',
          actualCount: first.billingPolicy?.intervalCount ?? 0,
        })
        results.push({
          handle: product.handle,
          label: product.label,
          ok: false,
          detail: `Sold as every 1 ${expected}, but "${first.name}" bills every ${
            first.billingPolicy?.intervalCount ?? '?'
          } ${first.billingPolicy?.interval ?? 'unknown'}.`,
        })
        continue
      }

      results.push({
        handle: product.handle,
        label: product.label,
        ok: true,
        detail: `Bills every 1 ${expected}, as advertised.`,
      })
    } catch (err) {
      results.push({
        handle: product.handle,
        label: product.label,
        ok: false,
        detail: `Could not read the billing policy: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  policyCache = { at: now, results, mismatches }
  return policyCache
}

/** Throws before a checkout is built if any of these products bills differently to what we say. */
export async function assertBillingPoliciesMatch(handles: string[]): Promise<void> {
  const { mismatches } = await checkBillingPolicies()
  const relevant = mismatches.filter((m) => handles.includes(m.handle))
  if (relevant.length > 0) throw new BillingPolicyMismatchError(relevant)
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
  customer?: {
    id?: number | string
    email?: string | null
    first_name?: string | null
    last_name?: string | null
    phone?: string | null
  }
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
 * Which product is this line item?
 *
 * orders/paid does not include the product handle, so matching goes: configured variant id
 * first, then SKU (set the SKU to the handle in Shopify and this always works), then the product
 * title as a last resort. An unmatched line is reported, never guessed at.
 */
export function handleForLineItem(item: ShopifyLineItem): string | null {
  const variantId = item.variant_id != null ? String(item.variant_id) : null
  if (variantId) {
    for (const handle of knownHandles()) {
      if (envValue(variantEnvKey(handle)) === variantId) return handle
    }
  }

  const sku = item.sku?.trim().toLowerCase()
  if (sku && knownHandles().includes(sku)) return sku

  // Last resort, and matched against the titles actually on the store: "Website Hosting",
  // "Email Hosting", "Domain (1 Year)". Order matters, because "Email Hosting" contains the word
  // hosting and would otherwise be read as the hosting product.
  const title = (item.title ?? item.name ?? '').toLowerCase()
  if (title.includes('email')) return PRICING.email.handle
  if (title.includes('hosting')) return PRICING.hosting.handle
  if (title.includes('domain')) return PRICING.domain.handle
  if (title.includes('build')) return PRICING.build.proposedHandle
  if (title.includes('discharge')) return PRICING.discharge.proposedHandle
  if (title.includes('update')) return PRICING.postLiveEdit.proposedHandle
  if (title.includes('edits')) return PRICING.extraEdits.proposedHandle

  return null
}

export { kindForHandle } from '../../shared/pricing'

export function centsFromPrice(price: string | undefined): number {
  const value = Number(price ?? '0')
  return Number.isFinite(value) ? Math.round(value * 100) : 0
}

// ---------------------------------------------------------------------------------------------
// Admin API, used by the reconciliation sweep
// ---------------------------------------------------------------------------------------------

/**
 * Paid orders since a timestamp. Brief s3a: webhooks do get dropped, and a paying customer who
 * never receives a link is the worst possible failure in this system.
 */
export async function listPaidOrdersSince(sinceIso: string): Promise<ShopifyOrder[]> {
  const cfg = config()
  if (cfg.demoMode) return []

  const token = cfg.shopify.adminApiToken
  if (!token) {
    throw new ShopifyConfigError(
      'SHOPIFY_ADMIN_API_TOKEN is not set, so missed orders cannot be reconciled. Create a custom app in Shopify with read_orders scope and add the token to the Vercel project environment variables.',
      ['SHOPIFY_ADMIN_API_TOKEN'],
    )
  }

  const url = new URL(`https://${storeDomain(cfg)}/admin/api/2025-01/orders.json`)
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
