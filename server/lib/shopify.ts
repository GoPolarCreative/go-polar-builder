import {
  PRICING,
  knownRefs,
  productForRef,
  sellingPlanEnvKey,
  variantEnvKey,
  variantIdFor,
} from '../../shared/pricing'
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
  /** The product's stable identifier: a Shopify handle for some, a SKU for others. */
  ref: string
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
    // Env var first, then the variant id verified from the store. Recording the real ids means a
    // freshly created product works without three env vars being pasted in, while the env var
    // still wins so a different store can be pointed at without a code change.
    const variantId = variantIdFor(line.ref, process.env)
    if (!variantId) missing.push(variantEnvKey(line.ref))

    const sellingPlanId = envValue(sellingPlanEnvKey(line.ref))
    // A product with requiresSellingPlan on the store CANNOT be bought without one. Shopify
    // rejects the line outright rather than falling back to a one-off charge, so a missing plan id
    // is exactly as fatal as a missing variant id and is treated the same way.
    const product = productForRef(line.ref)?.product
    if (product?.requiresSellingPlan && !sellingPlanId) missing.push(sellingPlanEnvKey(line.ref))

    return { ref: line.ref, quantity: line.quantity, variantId, sellingPlanId }
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
  await assertStoreProductsSellable(req.lines.map((l) => l.ref))

  if (cfg.shopify.storefrontToken) {
    return {
      url: await createCartViaStorefront(cfg, req, resolved as ResolvedLine[]),
      method: 'storefront',
    }
  }

  return { url: permalink(cfg, req, resolved as ResolvedLine[]), method: 'permalink' }
}

interface ResolvedLine {
  ref: string
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
/**
 * A product that cannot be sold the way this app says it can.
 *
 * Two things get a product here, and both have already happened on this store:
 *   - it bills on a different interval to what we advertise. The domain product had a plan NAMED
 *     "Monthly Subscription" whose policy was interval YEAR. Shopify has no objection to that: the
 *     name is a label and the policy is the behaviour.
 *   - it is still a draft. Three products were created in draft for review, and a draft product
 *     cannot be bought by anybody.
 */
const PRODUCT_FIELDS = `
  title
  status
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
  }`

/** Products identified by a Shopify handle are looked up by handle. */
const BY_HANDLE_QUERY = `
  query productByHandle($handle: String!) {
    product: productByHandle(handle: $handle) { ${PRODUCT_FIELDS} }
  }`

/**
 * Products identified by SKU are looked up by product id, read off the store when they were
 * created. Their handles were auto-generated from their titles and are recorded nowhere, so
 * looking them up by handle would mean inventing one.
 */
const BY_ID_QUERY = `
  query productById($id: ID!) {
    product: node(id: $id) { ... on Product { ${PRODUCT_FIELDS} } }
  }`

export class StoreProductError extends Error {
  constructor(readonly problems: StoreProductProblem[]) {
    super(
      [
        `Refusing to build a checkout: ${problems.length} product(s) cannot be sold as advertised.`,
        ...problems.map((p) => `  - "${p.label}" (${p.ref}): ${p.detail}`),
        'See SHOPIFY-SETUP.md.',
      ].join('\n'),
    )
    this.name = 'StoreProductError'
  }
}

export interface StoreProductProblem {
  ref: string
  label: string
  reason: 'draft' | 'billing_interval' | 'missing' | 'no_selling_plan'
  detail: string
}

export interface StoreProductCheck {
  ref: string
  label: string
  ok: boolean
  detail: string
}

interface CachedChecks {
  at: number
  results: StoreProductCheck[]
  problems: StoreProductProblem[]
}

let productCache: CachedChecks | null = null
/** Shopify is not asked on every checkout. These change when a human changes them. */
const CHECK_TTL_MS = 10 * 60 * 1000

export function clearStoreProductCache(): void {
  productCache = null
}

interface ProductNode {
  title?: string
  status?: string
  sellingPlanGroups?: {
    nodes?: Array<{
      name?: string
      sellingPlans?: {
        nodes?: Array<{ name?: string; billingPolicy?: { interval?: string; intervalCount?: number } }>
      }
    }>
  }
}

/**
 * Asks the store what it will actually do with each configured product, rather than trusting what
 * this repo believes.
 *
 * Reading it live matters most for the draft check: Chris publishes a product and it starts selling
 * immediately, with no code change and nothing for anyone to remember.
 */
export async function checkStoreProducts(force = false): Promise<CachedChecks> {
  const cfg = config()
  const now = Date.now()

  if (!force && productCache && now - productCache.at < CHECK_TTL_MS) return productCache

  const results: StoreProductCheck[] = []
  const problems: StoreProductProblem[] = []

  // Nothing to ask and nothing to protect: demo mode never reaches a real checkout.
  if (cfg.demoMode) {
    productCache = { at: now, results, problems }
    return productCache
  }

  const token = cfg.shopify.adminApiToken
  if (!token) {
    // Not a pass. Reported as unverifiable so it can never read as verified.
    for (const product of Object.values(PRICING)) {
      if (!product.ref) continue
      results.push({
        ref: product.ref,
        label: product.label,
        ok: false,
        detail: 'Cannot verify: SHOPIFY_ADMIN_API_TOKEN is not set, so the store cannot be read.',
      })
    }
    productCache = { at: now, results, problems }
    return productCache
  }

  for (const product of Object.values(PRICING)) {
    if (!product.ref) continue
    const ref = product.ref

    try {
      // By id where the identifier is a SKU, because those products' handles were auto-generated
      // from their titles and are not recorded anywhere. By handle for the three that have one.
      const byId = product.refKind === 'sku' && product.productId
      const res = await fetch(`https://${storeDomain(cfg)}/admin/api/2025-01/graphql.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({
          query: byId ? BY_ID_QUERY : BY_HANDLE_QUERY,
          variables: byId ? { id: `gid://shopify/Product/${product.productId}` } : { handle: ref },
        }),
      })

      if (!res.ok) {
        results.push({ ref, label: product.label, ok: false, detail: `Shopify Admin API returned ${res.status} reading this product.` })
        continue
      }

      const json = (await res.json()) as { data?: { product?: ProductNode | null } }
      const node = json.data?.product

      if (!node) {
        const problem: StoreProductProblem = {
          ref,
          label: product.label,
          reason: 'missing',
          detail: 'no such product on the store.',
        }
        problems.push(problem)
        results.push({ ref, label: product.label, ok: false, detail: problem.detail })
        continue
      }

      if (node.status && node.status.toUpperCase() !== 'ACTIVE') {
        const problem: StoreProductProblem = {
          ref,
          label: product.label,
          reason: 'draft',
          detail: `"${node.title ?? product.label}" is ${node.status.toLowerCase()} on the store, so nobody can buy it. Publish it in Shopify.`,
        }
        problems.push(problem)
        results.push({ ref, label: product.label, ok: false, detail: problem.detail })
        continue
      }

      if (product.requiresSellingPlan) {
        const plans = (node.sellingPlanGroups?.nodes ?? []).flatMap((g) =>
          (g.sellingPlans?.nodes ?? []).map((sp) => ({ group: g.name ?? '', ...sp })),
        )

        if (plans.length === 0) {
          const problem: StoreProductProblem = {
            ref,
            label: product.label,
            reason: 'no_selling_plan',
            detail: 'requires a selling plan but has no selling plan groups attached.',
          }
          problems.push(problem)
          results.push({ ref, label: product.label, ok: false, detail: problem.detail })
          continue
        }

        const bad = plans.filter(
          (sp) => sp.billingPolicy?.interval !== 'MONTH' || (sp.billingPolicy?.intervalCount ?? 1) !== 1,
        )

        if (bad.length > 0) {
          const first = bad[0]!
          const problem: StoreProductProblem = {
            ref,
            label: product.label,
            reason: 'billing_interval',
            detail: `sold as every 1 MONTH, but the plan "${first.name}" bills every ${first.billingPolicy?.intervalCount ?? '?'} ${first.billingPolicy?.interval ?? 'unknown'}.`,
          }
          problems.push(problem)
          results.push({ ref, label: product.label, ok: false, detail: problem.detail })
          continue
        }

        results.push({
          ref,
          label: product.label,
          ok: true,
          detail: 'Active, and bills every 1 MONTH as advertised.',
        })
        continue
      }

      results.push({ ref, label: product.label, ok: true, detail: 'Active, one-off, as advertised.' })
    } catch (err) {
      results.push({ ref, label: product.label, ok: false, detail: `Could not read this product: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  productCache = { at: now, results, problems }
  return productCache
}

/** Throws before a checkout is built if any of these products cannot be sold as advertised. */
export async function assertStoreProductsSellable(refs: string[]): Promise<void> {
  const { problems } = await checkStoreProducts()
  const relevant = problems.filter((p) => refs.includes(p.ref))
  if (relevant.length > 0) throw new StoreProductError(relevant)
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
/**
 * Which product is this order line?
 *
 * `orders/paid` carries no product handle, so matching goes by what is actually dependable, in
 * descending order of trust:
 *
 *   1. VARIANT ID. Exact, numeric, and now known for the three one-off products because they were
 *      read off the store when they were created. Cannot be confused with anything else.
 *   2. SKU. Set deliberately to `build-token`, `post-live-edit` and `discharge`, so for those three
 *      it is the identifier rather than an incidental field.
 *   3. TITLE. Last resort and genuinely fragile: the titles on the store are "DIY Website Build",
 *      "Website Update" and "Website Discharge", none of which anybody here chose, and every one of
 *      them contains the word "website". Matched on the distinguishing word only, most specific
 *      first, and it returns null rather than guessing when nothing fits.
 *
 * The product HANDLE is deliberately not used for the one-off products. Shopify generated those
 * from the titles and this code has never seen them, so assuming one would be exactly the kind of
 * invention that produces a checkout link that 404s.
 */
export function refForLineItem(item: ShopifyLineItem): string | null {
  const variantId = item.variant_id != null ? String(item.variant_id) : null
  if (variantId) {
    for (const ref of knownRefs()) {
      if (variantIdFor(ref, process.env) === variantId) return ref
    }
  }

  const sku = item.sku?.trim().toLowerCase()
  if (sku && knownRefs().includes(sku)) return sku

  // Order matters twice over here. "Email Hosting" contains "hosting" and would otherwise be read
  // as the hosting subscription, and all three one-off products contain "website".
  const title = (item.title ?? item.name ?? '').toLowerCase()
  if (title.includes('email')) return PRICING.email.ref
  if (title.includes('domain')) return PRICING.domain.ref
  if (title.includes('discharge')) return PRICING.discharge.ref
  if (title.includes('update')) return PRICING.postLiveEdit.ref
  if (title.includes('build')) return PRICING.build.ref
  if (title.includes('edits')) return PRICING.extraEdits.proposedRef
  if (title.includes('hosting')) return PRICING.hosting.ref

  return null
}

export { kindForRef } from '../../shared/pricing'

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
