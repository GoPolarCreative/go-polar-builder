/**
 * Every product, price and Shopify handle in the business, in one place.
 *
 * ALL PRICES ARE EX GST, in whole cents. Shopify is to be configured with prices entered
 * exclusive of tax, GST added at checkout, so these numbers are what gets typed into Shopify.
 * Everything shown to a customer carries a "+ GST" label, which is why `formatPrice` adds it and
 * there is no way to format a price without it.
 *
 * TWO RULES THAT ARE NOT NEGOTIABLE HERE.
 *
 * 1. NO INVENTED DEFAULTS. A product that does not exist on the store has `handle: null`. Nothing
 *    guesses, nothing falls back, and a checkout for such a product fails loudly naming what Chris
 *    has to create. A guessed handle produces a checkout link that 404s in front of a paying
 *    customer, which is worse than an error we can see.
 *
 * 2. NO PRICE IS INVENTED. `extra-edits` has never been decided, so it is null, and the UI shows
 *    no price and no buy button while it stays null. See DECISIONS.md D2.
 *
 * STORE REALITY. The `status` field records what was actually on Chris's store when it was
 * queried on 2026-08-18, not what we would like to be there. Where the store disagrees with the
 * decided price, that is written down rather than smoothed over, and the fix is his to make in
 * Shopify. SHOPIFY-SETUP.md is the checklist. See DECISIONS.md D30.
 */

export type PriceKey = 'build' | 'hosting' | 'domain' | 'email' | 'postLiveEdit' | 'extraEdits' | 'discharge'

export type OrderKind = 'build' | 'hosting' | 'domain' | 'email' | 'edit' | 'discharge'

export interface Product {
  /**
   * The product handle on Chris's Shopify store. NULL MEANS IT DOES NOT EXIST THERE. Nothing may
   * treat a null handle as a reason to guess.
   */
  handle: string | null
  /** What the handle should be once he creates it. Documentation for SHOPIFY-SETUP.md only. */
  proposedHandle: string
  label: string
  /** Cents, ex GST. null means the price is undecided and must never reach a customer. */
  exGstCents: number | null
  recurrence: 'once' | 'monthly'
  /** Which kind of order this becomes when the orders/paid webhook arrives. */
  kind: OrderKind
  /** What was actually on the store on 2026-08-18. */
  store: StoreState
}

export interface StoreState {
  exists: boolean
  /** The product title on the store, where it differs from our label. */
  title?: string
  /** What is wrong with it today, in Chris's terms. Rendered into SHOPIFY-SETUP.md. */
  mismatch?: string
  /** What stops working in this app until he fixes it. */
  breaks?: string
}

/**
 * The store itself, as queried on 2026-08-18. Recorded because several of these facts change what
 * the app can do: a Basic plan and zero selling plan groups mean nothing recurring exists yet.
 */
export const STORE = {
  name: 'Go Polar Creative',
  domain: 'itscold.com.au',
  plan: 'Basic',
  currency: 'AUD',
  timezone: 'AWST',
  /** Zero. Nothing on the store is set up to bill monthly. */
  sellingPlanGroups: 0,
  queriedOn: '2026-08-18',
} as const

export const PRICING: Record<PriceKey, Product> = {
  build: {
    handle: null,
    proposedHandle: 'build-token',
    label: 'Website build',
    exGstCents: 20_000,
    recurrence: 'once',
    kind: 'build',
    store: {
      exists: false,
      breaks:
        'Nobody can buy a build. This is the front door of the entire product: no build token means no job, no build link and no customer.',
    },
  },
  hosting: {
    handle: 'website-hosting-australia',
    proposedHandle: 'website-hosting-australia',
    label: 'Hosting',
    exGstCents: 3_000,
    recurrence: 'monthly',
    kind: 'hosting',
    store: {
      exists: true,
      title: 'Website Hosting',
      mismatch:
        'Priced at $33.00, which is $30 with GST already inside it. Once tax is set to prices-entered-exclusive it has to read $30.00. It also has a second variant, "Hosting + 2 Monthly Website Edits" at $100.00, which this app does not currently offer anywhere.',
      breaks:
        'Customers are charged $3 a month more than decided, and once tax is switched to exclusive they are charged $33 plus GST.',
    },
  },
  domain: {
    handle: 'domain-1-year',
    proposedHandle: 'domain-1-year',
    label: 'Domain name',
    exGstCents: 500,
    recurrence: 'monthly',
    kind: 'domain',
    store: {
      exists: true,
      title: 'Domain (1 Year)',
      mismatch:
        'Titled and sold as a one-off year, not a monthly subscription. The decided price is $5 + GST per month.',
      breaks:
        'A customer pays once and the domain renewal is never billed again. The app describes it as monthly, so the two disagree in front of the customer.',
    },
  },
  email: {
    handle: 'email-hosting',
    proposedHandle: 'email-hosting',
    label: 'Custom email address',
    exGstCents: 1_495,
    recurrence: 'monthly',
    kind: 'email',
    store: {
      exists: true,
      title: 'Email Hosting',
      mismatch: 'Price is right at $14.95, but it is a one-off product with no selling plan, so it never rebills.',
      breaks: 'Custom email is charged once instead of monthly.',
    },
  },
  postLiveEdit: {
    handle: null,
    proposedHandle: 'post-live-edit',
    label: 'Website update after launch',
    exGstCents: 10_000,
    recurrence: 'once',
    kind: 'edit',
    store: {
      exists: false,
      breaks:
        'A live customer who wants a change cannot pay for one. The confirmation screen still states the price, so they are told a number they cannot act on.',
    },
  },
  extraEdits: {
    handle: null,
    proposedHandle: 'extra-edits',
    label: 'Another 5 edits before launch',
    // TODO(chris): still undecided. While this is null the UI shows no price and no buy button and
    // offers to put the customer in touch instead. Setting a number in cents ex GST turns the whole
    // path on, and the product then has to be created in Shopify with the proposed handle above.
    exGstCents: null,
    recurrence: 'once',
    kind: 'edit',
    store: {
      exists: false,
      breaks:
        'Nothing, today. The price is undecided so the path is already dark by design: a customer out of edits is offered contact or going live, never a number.',
    },
  },
  discharge: {
    handle: null,
    proposedHandle: 'discharge',
    label: 'Discharge and file handover',
    exGstCents: 30_000,
    recurrence: 'once',
    kind: 'discharge',
    store: {
      exists: false,
      breaks:
        'A customer who wants to take their files elsewhere cannot pay for it. Section 9 requires this offer to be visible rather than hidden, so it is offered and then cannot be completed.',
    },
  },
}

export const EDITS_INCLUDED = 10
export const EXTRA_EDITS_QUANTITY = 5

/** Whether a price is known well enough to put in front of a customer. */
export function isPriceSet(key: PriceKey): boolean {
  return PRICING[key].exGstCents !== null
}

/**
 * The only way to render a price. Always carries the GST label, because every displayed price
 * must, and always in dollars. Returns null when the price is undecided, and every caller is
 * expected to degrade rather than print something.
 */
// `approx` exists for a price that is genuinely an estimate. Nothing uses it today: the domain
// was the only "approximately" price in the brief and it was settled at exactly $5/month ex GST
// on 2026-08-18. Kept because the next price that is an estimate should say so rather than round.
export function formatPrice(key: PriceKey, opts: { approx?: boolean } = {}): string | null {
  const item = PRICING[key]
  if (item.exGstCents === null) return null

  const dollars = item.exGstCents / 100
  const amount = Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`
  const suffix = item.recurrence === 'monthly' ? '/month' : ''
  return `${opts.approx ? 'around ' : ''}${amount}${suffix} + GST`
}

// -----------------------------------------------------------------------------------------------
// Handles
// -----------------------------------------------------------------------------------------------

export class ProductNotOnStoreError extends Error {
  constructor(
    readonly key: PriceKey,
    readonly proposedHandle: string,
  ) {
    const product = PRICING[key]
    super(
      `"${product.label}" does not exist on the Shopify store, so no checkout can be built for it. Create it in Shopify with the handle "${proposedHandle}"${
        product.exGstCents === null
          ? ' once its price has been decided'
          : `, priced ${(product.exGstCents / 100).toFixed(2)} ex GST${product.recurrence === 'monthly' ? ' per month with a monthly selling plan' : ''}`
      }, then set ${variantEnvKey(proposedHandle)}. See SHOPIFY-SETUP.md. Until then: ${product.store.breaks ?? 'this path cannot complete.'}`,
    )
    this.name = 'ProductNotOnStoreError'
  }
}

/**
 * The handle to buy, or a loud refusal. This is the only way a handle reaches a checkout, so a
 * product that does not exist cannot silently become a broken cart link.
 */
export function checkoutHandle(key: PriceKey): string {
  const product = PRICING[key]
  if (!product.handle) throw new ProductNotOnStoreError(key, product.proposedHandle)
  return product.handle
}

/** Maps a handle from a Shopify order back to the kind of order it is. Real handles only. */
export function kindForHandle(handle: string): OrderKind | null {
  for (const product of Object.values(PRICING)) {
    if (product.handle && product.handle === handle) return product.kind
    // A proposed handle is matched too: if Chris creates the product before this file is updated,
    // an order for it should still be understood rather than dropped on the floor.
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

/** Every handle the app might see on an order, real or proposed. */
export function knownHandles(): string[] {
  return Object.values(PRICING).flatMap((p) => (p.handle ? [p.handle, p.proposedHandle] : [p.proposedHandle]))
}

/**
 * Shopify variant and selling-plan ids.
 *
 * Per-store values that only exist once the products are created, so they are read from the
 * environment by name and never hardcoded. One env var per product:
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
  /** The env var or the Shopify object that is missing. */
  missing: string
  detail: string
  breaks: string
}

/**
 * What is not configured yet, and what each gap costs.
 *
 * Called at startup so the state of the store is stated out loud rather than discovered by a
 * customer at a checkout. `env` is passed in so this stays a pure function and the client bundle
 * never touches process.env.
 */
export function productConfigProblems(env: Record<string, string | undefined>): ProductConfigProblem[] {
  const problems: ProductConfigProblem[] = []

  for (const [key, product] of Object.entries(PRICING) as Array<[PriceKey, Product]>) {
    if (!product.handle) {
      problems.push({
        key,
        label: product.label,
        missing: `Shopify product "${product.proposedHandle}"`,
        detail:
          product.exGstCents === null
            ? 'Does not exist on the store, and its price is still undecided.'
            : `Does not exist on the store. Decided price is ${formatPrice(key)}.`,
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
        detail: `The product exists on the store, but its variant id is not set, so no checkout link can be built for it.`,
        breaks: 'Any checkout including this line fails with a configuration error.',
      })
    }

    if (product.recurrence === 'monthly') {
      const planKey = sellingPlanEnvKey(product.handle)
      if (!env[planKey]?.trim()) {
        problems.push({
          key,
          label: product.label,
          missing: planKey,
          detail: `Priced monthly, but no selling plan is configured. The store has ${STORE.sellingPlanGroups} selling plan groups, so nothing recurring exists yet.`,
          breaks: 'The customer is charged once and never billed again.',
        })
      }
    }
  }

  return problems
}
