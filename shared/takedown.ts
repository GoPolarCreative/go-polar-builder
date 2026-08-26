/**
 * What happens to a website after the hosting stops being paid for.
 *
 * TAKING A LIVE BUSINESS WEBSITE OFF THE INTERNET IS A SERIOUS ACTION. It is the phone number a
 * customer's customers ring. Doing it by accident, or a day early, or without warning, is worse
 * than eating the hosting cost for another month, so every part of this is deliberately slow,
 * loud and reversible:
 *
 *   DAY 0    Cancellation received. The site stays up and keeps serving. Editing stops, because
 *            editing is the thing they stopped paying for.
 *   DAY 30   Halfway. Still up.
 *   DAY 53   A week to go.
 *   DAY 59   Tomorrow.
 *   DAY 60   The site stops serving.
 *
 * NOTHING IS EVER DELETED. Takedown flips one boolean on the `sites` row. The build, every
 * version, the plan and the images all stay exactly where they are, because a customer who
 * resubscribes in month four, or who pays for a discharge in year two, is somebody we can still
 * help. Deleting a customer's website to save a few cents of storage would be the most expensive
 * saving in this product.
 *
 * RESUBSCRIBING BEFORE DAY 60 UNDOES ALL OF IT with no intervention from anybody. The clock is
 * derived from `hostingEndedAt`, so clearing that field IS cancelling the takedown.
 *
 * DISCHARGE STAYS AVAILABLE THROUGHOUT, including after the site is down. They paid $220 for the
 * build and the files are theirs to buy. Taking the site offline is about hosting, not ownership.
 *
 * ONLY A CONFIRMED CANCELLATION STARTS THE CLOCK. Not a failed payment, not a missing webhook,
 * not silence. `hostingStatus` defaults to 'unknown' and nothing here reads it as a cancellation.
 */

/** Days between the cancellation and the site going dark. Chris's call. */
export const TAKEDOWN_DAYS = 60

/** When a customer is warned, in days since cancellation. */
export const WARNING_DAYS = [0, 30, 53, 59] as const

export type WarningStage = (typeof WARNING_DAYS)[number]

const DAY = 86_400_000

export function takedownDueAt(cancelledAt: Date): Date {
  return new Date(cancelledAt.getTime() + TAKEDOWN_DAYS * DAY)
}

export function daysSinceCancellation(cancelledAt: Date, now: Date = new Date()): number {
  return Math.floor((now.getTime() - cancelledAt.getTime()) / DAY)
}

export function daysUntilTakedown(cancelledAt: Date, now: Date = new Date()): number {
  return Math.ceil((takedownDueAt(cancelledAt).getTime() - now.getTime()) / DAY)
}

/**
 * Which warning is due, if any.
 *
 * Returns the LATEST stage that has been reached and not yet sent, so a sweep that has been down
 * for a week does not fire four emails in one minute when it comes back. A customer who has heard
 * nothing for a fortnight should get "your site comes down tomorrow", not a pile of history.
 */
export function warningDue(
  cancelledAt: Date,
  alreadySent: number[],
  now: Date = new Date(),
): WarningStage | null {
  const elapsed = daysSinceCancellation(cancelledAt, now)
  const reached = WARNING_DAYS.filter((d) => elapsed >= d && !alreadySent.includes(d))
  return reached.length > 0 ? reached[reached.length - 1]! : null
}

/** Is this site due to come down? Strictly at or past the deadline, never a day early. */
export function takedownDue(cancelledAt: Date, now: Date = new Date()): boolean {
  return now.getTime() >= takedownDueAt(cancelledAt).getTime()
}

/**
 * The sentence a customer reads at each stage.
 *
 * Every one of them says how to stop it, because a warning that does not tell somebody what to do
 * is just a threat. No jargon, no em dashes, and it never pretends the decision is out of our
 * hands: we are the ones taking it down and the wording says so.
 */
export function warningCopy(stage: WarningStage, businessName: string, downOn: string): {
  urgency: 'low' | 'medium' | 'high'
  headline: string
  body: string
} {
  const name = businessName || 'your business'
  switch (stage) {
    case 0:
      return {
        urgency: 'low',
        headline: 'Your hosting has been cancelled',
        body: `Your website for ${name} is still online and will stay online until ${downOn}. You cannot make changes to it any more, because that is part of the hosting. If you want to keep the site, start your hosting again and everything comes straight back, including your changes. Reply to this email if you would rather talk it through.`,
      }
    case 30:
      return {
        urgency: 'low',
        headline: 'Your website comes offline in 30 days',
        body: `Just so you know where things are at. Your website for ${name} is still online, and it comes down on ${downOn}. Starting your hosting again puts everything back, and nothing has been deleted. If you want your files instead of the hosting, we can do that too, just ask.`,
      }
    case 53:
      return {
        urgency: 'medium',
        headline: 'One week until your website comes offline',
        body: `Your website for ${name} comes down on ${downOn}, which is a week away. After that, anyone typing your web address will not find you. If that is not what you want, start your hosting again and it stays up. Nothing has been deleted either way.`,
      }
    case 59:
      return {
        urgency: 'high',
        headline: 'Your website comes offline tomorrow',
        body: `This is the last one. Your website for ${name} comes down tomorrow, ${downOn}. From then on your web address will not show anything. We have not deleted a thing, so it can still come back later, but it will be offline in the meantime. If this is a mistake, reply to this email today and we will sort it out.`,
      }
  }
}
