/**
 * Every product, price, handle and selling plan in the business, in one place.
 *
 * PRICES ARE GST-INCLUSIVE, because the store is. `taxesIncluded: true` was verified on
 * itscold.com.au on 2026-08-19: prices are entered with GST already inside them and tax is charged
 * on the product rather than added at checkout.
 *
 * That decides how prices are displayed. The app shows THE SAME NUMBER THE CUSTOMER IS CHARGED,
 * labelled "inc GST". Showing "$30 + GST" here and then $33.00 at the Shopify checkout is the kind
 * of mismatch that reads as a bait and switch to a tradie, and they are right to read it that way.
 * One number, the real one, everywhere. This is customer-facing copy and needs Chris's sign-off:
 * see DECISIONS.md D31.
 *
 * The ex-GST figure is still recorded, because that is how Chris states his prices and how the
 * `orders.amount_ex_gst` column stores them, but it is never what a customer reads.
 *
 * THREE RULES THAT ARE NOT NEGOTIABLE HERE.
 *
 * 1. NO INVENTED DEFAULTS. A product that does not exist on the store has `handle: null`. Nothing
 *    guesses, and a checkout for it fails loudly naming what has to be created.
 *
 * 2. NO INVENTED PRICES. Where the store and a stated decision disagree, that is an open question
 *    recorded as one, not a number picked by us. `email` and `extraEdits` are both open today, so
 *    neither shows a price to anybody.
 *
 * 3. SELLING PLANS ARE NOT OPTIONAL. All three recurring products have `requiresSellingPlan: true`
 *    on the store, so a checkout line without a selling plan id is REJECTED by Shopify. The plan id
 *    is as load-bearing as the variant id and is treated the same way.
 */

export type PriceKey = 'build' | 'hosting' | 'domain' | 'email' | 'postLiveEdit' | 'extraEdits' | 'discharge'

export type OrderKind = 'build' | 'hosting' | 'domain' | 'email' | 'edit' | 'discharge'

/** Australian GST. Used only to convert between the two ways of stating the same price. */
export const GST_RATE = 0.1

export interface Product {
  /**
   * The product handle on the store. NULL MEANS IT DOES NOT EXIST THERE, and nothing may treat a
   * null handle as licence to guess.
   */
  handle: string | null
  /** What the handle should be once created. Documentation for SHOPIFY-SETUP.md only. */
  proposedHandle: string
  label: string
  /**
   * What the customer is charged, GST included, in whole cents. This is the number displayed.
   * null means the price is genuinely unresolved and no number may reach a customer.
   */
  incGstCents: number | null
  recurrence: 'once' | 'monthly'
  kind: OrderKind
  /**
   * True where the store has `requiresSellingPlan: true`. Such a product CANNOT be bought without
   * a selling plan id on the line, so a missing plan id is a hard failure, not a downgrade to a
   * one-off purchase.
   */
  requiresSellingPlan: boolean
  store: StoreState
  /** Set when the store price and a stated decision disagree. Blocks the price from being shown. */
  openQuestion?: OpenQuestion
}

export interface StoreState {
  exists: boolean
  title?: string
  /** Selling plan group and plan name on the store, where one exists. */
  sellingPlan?: { group: string; plan: string; interval: 'MONTH' | 'YEAR'; intervalCount: number }
  /** What is left to do, in Chris's terms. Rendered into SHOPIFY-SETUP.md. */
  todo?: string
  /** What breaks in this app until it is done. */
  breaks?: string
}

export interface OpenQuestion {
  summary: string
  /** The two readings, so the question can be asked precisely rather than as "check the price". */
  options: string[]
  effect: string
}

/**
 * The store, verified on 2026-08-19.
 *
 * `sellingPlanGroups` is deliberately absent as a shop-level count: app-owned groups are not
 * exposed at shop level to another app's token, which made an earlier reading of "zero groups"
 * wrong. They are read per product, and per product they exist.
 */
export const STORE = {
  name: 'Go Polar Creative',
  domain: 'itscold.com.au',
  plan: 'Basic',
  currency: 'AUD',
  timezone: 'AWST',
  /** Prices are entered with GST inside them. Everything about display follows from this. */
  taxesIncluded: true,
  subscriptionApp: 'Appstle',
  verifiedOn: '2026-08-19',
} as const

export const PRICING: Record<PriceKey, Product> = {
  build: {
    handle: null,
    proposedHandle: 'build-token',
    label: 'Website build',
    // $200 + GST as decided, grossed up because the store holds tax-inclusive prices.
    incGstCents: 22_000,
    recurrence: 'once',
    kind: 'build',
    requiresSellingPlan: false,
    store: {
      exists: false,
      todo: 'Create it, priced $220.00, which is $200 + GST on a tax-inclusive store. One-off, no selling plan.',
      breaks:
        'Nobody can buy a build. This is the front door of the entire product: no build token means no job, no build link and no customer.',
    },
  },
  hosting: {
    handle: 'website-hosting-australia',
    proposedHandle: 'website-hosting-australia',
    label: 'Hosting',
    // $33.00 on the store = $30.00 + GST. Matches the decision.
    incGstCents: 3_300,
    recurrence: 'monthly',
    kind: 'hosting',
    requiresSellingPlan: true,
    store: {
      exists: true,
      title: 'Website Hosting',
      sellingPlan: { group: 'Website Hosting', plan: 'Monthly Subscription', interval: 'MONTH', intervalCount: 1 },
      todo: 'Nothing. Price and billing interval both correct.',
      breaks:
        'A second variant, "Hosting + 2 Monthly Website Edits" at $100.00, exists on the store and is not offered anywhere in this app. No decision on file.',
    },
  },
  domain: {
    handle: 'domain-1-year',
    proposedHandle: 'domain-1-year',
    label: 'Domain name',
    // $5.50 on the store = $5.00 + GST. Interval corrected from YEAR to MONTH by Chris.
    incGstCents: 550,
    recurrence: 'monthly',
    kind: 'domain',
    requiresSellingPlan: true,
    store: {
      exists: true,
      title: 'Domain Hosting',
      sellingPlan: { group: 'Domain Hosting', plan: 'Monthly Subscription', interval: 'MONTH', intervalCount: 1 },
      todo: 'Nothing. The plan was billing YEAR and now bills MONTH.',
    },
  },
  email: {
    handle: 'email-hosting',
    proposedHandle: 'email-hosting',
    label: 'Custom email address',
    // UNRESOLVED. The store says $14.95 inc, which is $13.59 + GST. The stated decision was
    // $14.95 + GST, which would be $16.45 inc. Both are plausible and picking one for him would be
    // inventing a price, so nothing is shown until he says which.
    incGstCents: null,
    recurrence: 'monthly',
    kind: 'email',
    requiresSellingPlan: true,
    store: {
      exists: true,
      title: 'Email Hosting',
      sellingPlan: { group: 'Email Hosting', plan: 'Monthly Subscription', interval: 'MONTH', intervalCount: 1 },
      todo: 'Decide the price. The other two were grossed up for GST and this one looks like it was missed.',
      breaks:
        'The custom email add-on is offered with no price and no way to buy it, the same way extra edits are.',
    },
    openQuestion: {
      summary:
        'The store charges $14.95 including GST, which is $13.59 + GST. The stated decision was $14.95 + GST, which would be $16.45 on the store.',
      options: [
        'Leave the store at $14.95 and accept $13.59 + GST as the real price.',
        'Change the store to $16.45, which makes it $14.95 + GST as stated.',
      ],
      effect: 'Until it is settled the add-on shows no price and cannot be bought.',
    },
  },
  postLiveEdit: {
    handle: null,
    proposedHandle: 'post-live-edit',
    label: 'Website update after launch',
    // $100 + GST as decided, grossed up for the tax-inclusive store.
    incGstCents: 11_000,
    recurrence: 'once',
    kind: 'edit',
    requiresSellingPlan: false,
    store: {
      exists: false,
      todo: 'Create it, priced $110.00, which is $100 + GST. One-off, no selling plan.',
      breaks:
        'A live customer who wants a change cannot pay for one, while the confirmation screen still quotes the price.',
    },
  },
  extraEdits: {
    handle: null,
    proposedHandle: 'extra-edits',
    label: 'Another 5 edits before launch',
    // TODO(chris): never decided. While this is null the UI shows no price and no buy button and
    // offers to put the customer in touch instead. Set the number and the whole path turns on.
    incGstCents: null,
    recurrence: 'once',
    kind: 'edit',
    requiresSellingPlan: false,
    store: {
      exists: false,
      todo: 'Do not create it yet. Decide the price first.',
      breaks:
        'Nothing today. The price is undecided so the path is already dark by design: a customer out of edits is offered a conversation or going live, never a number.',
    },
  },
  discharge: {
    handle: null,
    proposedHandle: 'discharge',
    label: 'Discharge and file handover',
    // $300 + GST as decided, grossed up for the tax-inclusive store.
    incGstCents: 33_000,
    recurrence: 'once',
    kind: 'discharge',
    requiresSellingPlan: false,
    store: {
      exists: false,
      todo: 'Create it, priced $330.00, which is $300 + GST. One-off, no selling plan.',
      breaks:
        'A customer who wants to take their files elsewhere cannot pay for it, and section 9 requires the offer to be visible rather than hidden.',
    },
  },
}

export const EDITS_INCLUDED = 10
export const EXTRA_EDITS_QUANTITY = 5

/** Whether a price is settled well enough to put in front of a customer. */
export function isPriceSet(key: PriceKey): boolean {
  return PRICING[key].incGstCents !== null
}

/** Ex-GST cents, for the order records. Never displayed. */
export function exGstCents(key: PriceKey): number | null {
  const inc = PRICING[key].incGstCents
  return inc === null ? null : Math.round(inc / (1 + GST_RATE))
}

/**
 * The only way to render a price, and it always says "inc GST" because on this store that is what
 * the number is. Returns null when the price is unresolved, and every caller degrades rather than
 * printing something.
 */
export function formatPrice(key: PriceKey): string | null {
  const item = PRICING[key]
  if (item.incGstCents === null) return null

  const dollars = item.incGstCents / 100
  const amount = Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`
  const suffix = item.recurrence === 'monthly' ? '/month' : ''
  return `${amount}${suffix} inc GST`
}

// -----------------------------------------------------------------------------------------------
// Handles, variants and selling plans
// -----------------------------------------------------------------------------------------------

export class ProductNotOnStoreError extends Error {
  constructor(
    readonly key: PriceKey,
    readonly proposedHandle: string,
  ) {
    const product = PRICING[key]
    super(
      `"${product.label}" does not exist on the Shopify store, so no checkout can be built for it. Create it with the handle "${proposedHandle}". ${
        product.store.todo ?? ''
      } Then set ${variantEnvKey(proposedHandle)}. See SHOPIFY-SETUP.md. Until then: ${
        product.store.breaks ?? 'this path cannot complete.'
      }`,
    )
    this.name = 'ProductNotOnStoreError'
  }
}

export class PriceUnresolvedError extends Error {
  constructor(readonly key: PriceKey) {
    const product = PRICING[key]
    super(
      `"${product.label}" has no settled price, so it cannot be sold and no number may be shown. ${
        product.openQuestion?.summary ?? 'The price has never been decided.'
      } See SHOPIFY-SETUP.md.`,
    )
    this.name = 'PriceUnresolvedError'
  }
}

/**
 * The handle to buy, or a loud refusal. The only way a handle reaches a checkout, so neither a
 * missing product nor an unsettled price can quietly become a broken or wrongly-priced cart.
 */
export function checkoutHandle(key: PriceKey): string {
  const product = PRICING[key]
  if (!product.handle) throw new ProductNotOnStoreError(key, product.proposedHandle)
  if (product.incGstCents === null) throw new PriceUnresolvedError(key)
  return product.handle
}

export function kindForHandle(handle: string): OrderKind | null {
  for (const product of Object.values(PRICING)) {
    if (product.handle === handle) return product.kind
    // A proposed handle matches too: if a product is created before this file is updated, an order
    // for it should still be understood rather than dropped on the floor.
    if (product.proposedHandle === handle) return product.kind
  }
  return null
}

export function productForHandle(handle: string): { key: PriceKey; product: Product } | null {
  for (const [key, product] of Object.entries(PRICING) as Array<[PriceKey, Product]>) {
    if (product.handle === handle || product.proposedHandle === handle) return { key, product }
  }
  return null
}

export function knownHandles(): string[] {
  return Object.values(PRICING).flatMap((p) => (p.handle ? [p.handle, p.proposedHandle] : [p.proposedHandle]))
}

/**
 * Shopify variant and selling-plan ids, one env var per product:
 *
 *   SHOPIFY_VARIANT_WEBSITE_HOSTING_AUSTRALIA=45012345678901
 *   SHOPIFY_SELLING_PLAN_WEBSITE_HOSTING_AUSTRALIA=6890123456
 */
export function variantEnvKey(handle: string): string {
  return `SHOPIFY_VARIANT_${handle.replace(/-/g, '_').toUpperCase()}`
}

export function sellingPlanEnvKey(handle: string): string {
  return `SHOPIFY_SELLING_PLAN_${handle.replace(/-/g, '_').toUpperCase()}`
}

// -----------------------------------------------------------------------------------------------
// Configuration report
// -----------------------------------------------------------------------------------------------

export interface ProductConfigProblem {
  key: PriceKey
  label: string
  /** The env var, the Shopify object, or the decision that is missing. */
  missing: string
  detail: string
  breaks: string
  /** True where this is a question for Chris rather than a value to paste in. */
  needsDecision?: boolean
}

/**
 * What is not configured yet, and what each gap costs.
 *
 * `env` is passed in so this stays pure and the client bundle never touches process.env.
 */
export function productConfigProblems(env: Record<string, string | undefined>): ProductConfigProblem[] {
  const problems: ProductConfigProblem[] = []

  for (const [key, product] of Object.entries(PRICING) as Array<[PriceKey, Product]>) {
    if (product.incGstCents === null) {
      problems.push({
        key,
        label: product.label,
        missing: `a decision on the price of "${product.label}"`,
        detail: product.openQuestion?.summary ?? 'The price has never been decided.',
        breaks: product.openQuestion?.effect ?? product.store.breaks ?? 'It cannot be sold.',
        needsDecision: true,
      })
    }

    if (!product.handle) {
      problems.push({
        key,
        label: product.label,
        missing: `Shopify product "${product.proposedHandle}"`,
        detail: product.store.todo ?? 'Does not exist on the store.',
        breaks: product.store.breaks ?? 'This path cannot complete.',
      })
      continue
    }

    const variantKey = variantEnvKey(product.handle)
    if (!env[variantKey]?.trim()) {
      problems.push({
        key,
        label: product.label,
        missing: variantKey,
        detail: 'The product exists on the store, but its variant id is not set here.',
        breaks: 'Any checkout including this line fails with a configuration error.',
      })
    }

    if (product.requiresSellingPlan) {
      const planKey = sellingPlanEnvKey(product.handle)
      if (!env[planKey]?.trim()) {
        problems.push({
          key,
          label: product.label,
          missing: planKey,
          detail: `This product has requiresSellingPlan set on the store, so Shopify rejects any line without a selling plan id. Its plan is "${
            product.store.sellingPlan?.plan ?? 'Monthly Subscription'
          }" in the "${product.store.sellingPlan?.group ?? product.label}" group.`,
          breaks: 'The checkout is rejected outright. Not a downgrade to a one-off charge, a refusal.',
        })
      }
    }
  }

  return problems
}
