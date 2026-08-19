import { formatPrice } from './pricing'

/**
 * Everything the builder says to a customer about additional pages, in one place.
 *
 * WHY THIS IS A FILE RATHER THAN STRINGS IN COMPONENTS. It is the most legally sensitive copy in
 * the product. Chris sells to Australian small businesses, and an unsubstantiated performance
 * claim is exposure under the Australian Consumer Law before it is anything else. Keeping it in
 * one file means the whole claim surface can be read in one sitting and signed off in one go.
 *
 * THE RULE: PERSUADE WITH THE MECHANISM, NEVER WITH A PROMISE.
 *
 * Allowed, because it describes how search works and is verifiable:
 *   "One page covering eight services is competing with itself."
 *   "A page about one service, in a named service area, gives a search engine something specific."
 *
 * Forbidden, and there is a test that greps for these:
 *   any ranking claim, any position, "page one", "top of Google"
 *   any traffic or lead volume, "more customers", "double your enquiries"
 *   any timeframe, "within weeks", "results fast"
 *   any guarantee
 *
 * COPY IS NOT APPROVED. This needs Chris's sign-off before a customer reads it. See DECISIONS.md
 * D44.
 */

/** The one-line version, used next to a service in the intake. */
export const PAGE_OPTION_LABEL = 'Give this service its own page'

/** The mechanism, in two sentences. Used wherever there is room for it. */
export const PAGE_MECHANISM =
  'A single page covering all your services is competing with itself for every one of them. A page about one service, in the suburbs you actually work in, gives a search engine something specific to match against.'

/** The shorter version, for a tight space. */
export const PAGE_MECHANISM_SHORT =
  'One page covering eight services competes with itself. A page about one service gives a search engine something specific to match.'

/** What the customer literally gets, so the money is attached to something concrete. */
export const PAGE_INCLUDES: string[] = [
  'Its own address, like /services/blocked-drains/',
  'Copy written about that one service and the suburbs you cover',
  'Its own enquiry form, coming to the same inbox',
  'A link in your menu, on desktop and mobile',
]

/** Priced from the config module, so there is one price in the product and no second copy. */
export function pagePriceLine(): string {
  const price = formatPrice('additionalPage')
  return price ? `${price} each, one off.` : 'Ask us about additional pages.'
}

/** The honest limit, stated up front rather than discovered later. */
export const PAGE_CAVEAT =
  'This is not a guarantee of anything. It is a structure that gives you a chance of being found for a specific job in a specific place, which one page trying to cover everything does not.'

/** Heading and body for the preview stage, where they can see what a page actually is. */
export const PREVIEW_HEADING = 'Want a page for each service?'
export const PREVIEW_BODY =
  'Your site is one page right now, which is what the build covers. You can add a dedicated page for any service you offer.'
