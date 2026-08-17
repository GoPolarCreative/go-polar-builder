/**
 * Every price in the product, in one place.
 *
 * ALL PRICES ARE EX GST, in whole cents, exactly as the brief states. Shopify is configured with
 * prices entered exclusive of tax and GST added at checkout, so these numbers match what is
 * entered in Shopify. Anything displayed to a customer carries a "+ GST" label, which is why
 * `formatPrice` adds it and there is no way to format one without it.
 *
 * DO NOT INVENT A PRICE HERE. If the brief does not state it, the value is null and the UI
 * degrades. See DECISIONS.md D2.
 */

export interface PriceItem {
  handle: string
  label: string
  /** Cents, ex GST. null means the price is not yet decided and must not be shown. */
  exGstCents: number | null
  recurrence: 'once' | 'monthly'
}

export const PRICING = {
  build: {
    handle: 'build-token',
    label: 'Website build',
    exGstCents: 20_000,
    recurrence: 'once',
  },
  hosting: {
    handle: 'hosting-monthly',
    label: 'Hosting',
    exGstCents: 3_000,
    recurrence: 'monthly',
  },
  domain: {
    handle: 'domain-monthly',
    label: 'Domain name',
    // The brief says "approx $5/month". Displayed with the word "around" for that reason.
    exGstCents: 500,
    recurrence: 'monthly',
  },
  email: {
    handle: 'email-monthly',
    label: 'Custom email address',
    exGstCents: 1_495,
    recurrence: 'monthly',
  },
  postLiveEdit: {
    handle: 'post-live-edit',
    label: 'Website update after launch',
    exGstCents: 10_000,
    recurrence: 'once',
  },
  extraEdits: {
    handle: 'extra-edits',
    label: 'Another 5 edits before launch',
    // TODO(chris): price not set in the brief. While this is null the UI shows no price and no
    // buy button, and offers to put the customer in touch instead. Set it to a number in cents
    // ex GST and the whole path turns on. Also create the Shopify product with the handle above
    // and add its variant id to SHOPIFY_VARIANTS.
    exGstCents: null,
    recurrence: 'once',
  },
  discharge: {
    handle: 'discharge',
    label: 'Discharge and file handover',
    exGstCents: 30_000,
    recurrence: 'once',
  },
} as const satisfies Record<string, PriceItem>

export type PriceKey = keyof typeof PRICING

export const EDITS_INCLUDED = 10
export const EXTRA_EDITS_QUANTITY = 5

/** Whether a price is known well enough to put in front of a customer. */
export function isPriceSet(key: PriceKey): boolean {
  return PRICING[key].exGstCents !== null
}

/**
 * The only way to render a price. Always carries the GST label, because every displayed price
 * must (brief s2), and always in dollars.
 */
export function formatPrice(key: PriceKey, opts: { approx?: boolean } = {}): string | null {
  const item = PRICING[key]
  if (item.exGstCents === null) return null

  const dollars = item.exGstCents / 100
  const amount = Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`
  const suffix = item.recurrence === 'monthly' ? '/month' : ''
  return `${opts.approx ? 'around ' : ''}${amount}${suffix} + GST`
}

/** Maps a Shopify product handle back to the order kind stored on the job. */
export const HANDLE_TO_KIND: Record<string, 'build' | 'hosting' | 'domain' | 'email' | 'edit' | 'discharge'> = {
  'build-token': 'build',
  'hosting-monthly': 'hosting',
  'domain-monthly': 'domain',
  'email-monthly': 'email',
  'post-live-edit': 'edit',
  'extra-edits': 'edit',
  discharge: 'discharge',
}

/**
 * Shopify variant and selling-plan ids, needed to build a checkout permalink.
 *
 * These are per-store values that only exist once the products are created in Shopify, so they
 * are read from Worker env, never hardcoded. Checkout-link generation fails with a clear error
 * naming the missing variable rather than producing a broken link.
 *
 * Env var per product, e.g. SHOPIFY_VARIANT_HOSTING_MONTHLY=45012345678901
 * Selling plans for subscriptions, e.g. SHOPIFY_SELLING_PLAN_HOSTING_MONTHLY=6890123456
 */
export function variantEnvKey(handle: string): string {
  return `SHOPIFY_VARIANT_${handle.replace(/-/g, '_').toUpperCase()}`
}

export function sellingPlanEnvKey(handle: string): string {
  return `SHOPIFY_SELLING_PLAN_${handle.replace(/-/g, '_').toUpperCase()}`
}
