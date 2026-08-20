import {
  PRICING,
  STORE,
  checkoutRef,
  productConfigProblems,
  type PriceKey,
  blocksPayments,
  type ProductConfigProblem,
} from '../../shared/pricing'
import { config } from '../config'

/**
 * The startup statement about what can actually be sold.
 *
 * Every handle, price and variant id lives in shared/pricing.ts, which contains no invented
 * defaults: a product that is not on Chris's store has a null handle, and a checkout for it throws
 * by name. This module is the other half of that rule. It says out loud, at boot, exactly what is
 * missing and what each gap costs, so the state of the store is never something a customer
 * discovers at a checkout.
 *
 * WHY IT REFUSES TO START rather than warning, once payments are switched on: an install with
 * ENABLE_LIVE_PAYMENTS=1 is an install that intends to take money. If a product is missing at that
 * point, the failure mode is a real customer at a broken cart link, and a process that will not
 * boot is far cheaper than that. With payments off it warns instead, because a preview install is
 * expected to be half configured and must stay runnable. See DECISIONS.md D30.
 */

export class ProductConfigError extends Error {
  constructor(readonly problems: ProductConfigProblem[]) {
    super(
      [
        `Refusing to start: ENABLE_LIVE_PAYMENTS is on, but ${problems.length} product configuration ${
          problems.length === 1 ? 'problem is' : 'problems are'
        } outstanding, so a customer could reach a checkout that does not work.`,
        ...problems.map((p) => `  - ${p.missing} (${p.label}). ${p.detail} Breaks: ${p.breaks}`),
        'Work through SHOPIFY-SETUP.md, or set ENABLE_LIVE_PAYMENTS=0 to run without taking payments.',
      ].join('\n'),
    )
    this.name = 'ProductConfigError'
  }
}

let reported = false

/**
 * Called once at boot. Loud either way: silence here would mean an install that looks configured
 * and is not.
 */
export function assertProductConfig(env: Record<string, string | undefined> = process.env): void {
  const cfg = config()
  const problems = productConfigProblems(env)

  // Demo mode sells nothing and reaches nothing, so it stays quiet beyond a single line.
  if (cfg.demoMode) {
    if (!reported) {
      reported = true
      console.log(
        `Products: demo mode, no store contact. ${problems.length} item(s) would need configuring for real payments. See SHOPIFY-SETUP.md.`,
      )
    }
    return
  }

  // A product with no price is never offered anywhere, so a gap on one cannot put a customer at a
  // broken checkout. Refusing to boot over it would mean the app could not go live until every
  // optional add-on had been priced, which is not what this guard is for. It is still reported.
  const blocking = problems.filter(blocksPayments)
  if (blocking.length > 0 && cfg.live.payments) throw new ProductConfigError(blocking)

  if (!reported) {
    reported = true
    if (problems.length === 0) {
      console.log(`Products: all ${Object.keys(PRICING).length} configured against ${STORE.domain}.`)
      return
    }
    console.warn(
      [
        cfg.live.payments
          ? `Products: ${problems.length} item(s) not configured on ${STORE.domain}. None of them blocks a checkout, because an unpriced product is never offered, but each fails loudly if somehow reached:`
          : `Products: ${problems.length} item(s) not configured on ${STORE.domain}. Payments are off, so this install runs, but each of these fails loudly if reached:`,
        ...problems.map((p) => `  - ${p.missing} (${p.label}). ${p.breaks}`),
        '  Checklist: SHOPIFY-SETUP.md',
      ].join('\n'),
    )
  }
}

/**
 * The handle to put on a checkout line.
 *
 * Strict everywhere that matters: outside demo mode this is `checkoutRef`, which throws by name
 * for a product that is not on the store rather than building a cart link that 404s in front of a
 * paying customer.
 *
 * In demo mode it falls back to the proposed handle, because a demo checkout is a local pretend
 * page that charges nothing and touches Shopify not at all. Refusing there would make the whole
 * discharge and go-live flow unwalkable locally purely because Chris has not created the product
 * yet, which is the opposite of what demo mode is for. The startup report still names every
 * missing product on the way past.
 */
export function refForCheckout(key: PriceKey): string {
  if (config().demoMode) return PRICING[key].ref ?? PRICING[key].proposedRef
  return checkoutRef(key)
}

/** For the health endpoint and for Chris, without needing the logs. */
export function productConfigReport(env: Record<string, string | undefined> = process.env) {
  const problems = productConfigProblems(env)
  const blocking = problems.filter(blocksPayments)
  return {
    store: STORE,
    configured: problems.length === 0,
    /** Nothing outstanding would put a customer at a checkout that does not work. */
    canTakePayments: blocking.length === 0,
    blocking,
    problems,
    checklist: 'SHOPIFY-SETUP.md',
  }
}

/** Tests re-run the boot check, so the once-only log guard has to be resettable. */
export function resetProductConfigReportForTests(): void {
  reported = false
}
