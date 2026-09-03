import { assertLiveEnabled, config, LiveActionBlockedError, type AppConfig } from '../config.js'
import { normaliseAuPhone } from '../../shared/phone.js'
import { fakeKlaviyo } from './integrations/fakes.js'
import { recordEvent } from './db.js'

/**
 * Klaviyo. Every email a customer receives from this product is sent by Klaviyo, not by this app.
 *
 * WHY IT WORKS THIS WAY. The app used to send its own email through Resend and separately notify a
 * CRM by webhook, which meant two systems, two sets of DNS records and two places for a message to
 * go missing. It went missing in both. Klaviyo already owns a verified sending domain for
 * itscold.com.au, so it sends, and this app's only job is to say what happened and hand over the
 * link.
 *
 * THE APP EMITS EVENTS. It does not compose emails, does not own templates, and does not decide
 * when to send. A Klaviyo flow triggers on the metric and does all of that, which means the copy
 * can change without a deploy.
 *
 * EVERY EVENT CARRIES ITS OWN LINK. A flow that has to look one up would be a flow that can send an
 * email with a dead button, and the whole product is one link in one email.
 */

/** Metric names, exactly as they appear in Klaviyo. Changing one orphans a live flow. */
export const KLAVIYO_METRICS = {
  build_purchased: 'Website Build Purchased',
  link_requested: 'Website Link Requested',
  build_complete: 'Website Build Complete',
  go_live_requested: 'Website Go Live Requested',
  files_ready: 'Website Files Ready',
  intake_abandoned: 'Website Intake Abandoned',
  editing_stalled: 'Website Editing Stalled',
  /**
   * Fired the moment a customer presses "put my website live", before any payment. The flow on
   * this metric sends them everything they need to set up hosting (the checkout link) and, if
   * they asked us to handle one, the web address. Copy lives in Klaviyo; the one wording rule
   * that binds it is the brief's: "in touch within one business day", never a promise that the
   * domain is connected within any timeframe.
   */
  go_live_started: 'Website Go Live Started',
  /**
   * A cancelled customer's site is coming offline, and here is when.
   *
   * ONE METRIC, FOUR STAGES, told apart by `stage` (0, 30, 53, 59 days since cancellation). The
   * headline and body are computed server side in shared/takedown.ts and travel in the payload,
   * so the flow is a single template that prints them rather than four flows that can drift apart
   * and four places to get the wording of a serious message wrong.
   *
   * The day 59 email is the last warning before a real business website stops answering. It has
   * to arrive.
   */
  hosting_ending: 'Website Hosting Ending',
  /**
   * The six digit sign-in code for a returning customer.
   *
   * The flow needs this to arrive in seconds, not minutes, because the person is sitting on the
   * screen waiting to type it. If a Klaviyo flow on this metric is slow or missing, the whole
   * returning-customer door is shut, so it is worth being the first flow anybody checks.
   *
   * The code is in the event payload and nowhere else: it is not stored, not logged, and not
   * recoverable from this app once sent.
   */
  login_code: 'Website Login Code',
  /**
   * THE SITE IS ACTUALLY ON THE INTERNET. Fired from publishSite, once per publish.
   *
   * Everything before this is a request or a payment. This is the only event that means a real
   * person can type their address and see their website, so it is the one the post-live nurture
   * hangs off. It did not exist until 2026-08-26: publishing wrote a `site.published` row to the
   * events table and told the customer nothing at all.
   *
   * FIRES ON EVERY PUBLISH, INCLUDING RE-PUBLISHES. A flow on this metric must be set to trigger
   * once per profile, or a customer gets the whole welcome sequence again every time their site
   * is updated. The `is_first_publish` property is there so the flow can filter on it instead,
   * which is the safer of the two.
   */
  site_live: 'Website Is Live',
  /**
   * An alert to the OPERATOR, not a customer. Fired against the operatorEmail profile so Chris
   * hears the same minute somebody wants to go live. Needs a Klaviyo flow on this metric that
   * emails him; without the flow the event still lands in Klaviyo's activity feed and /ops
   * shows the waiting list either way.
   */
  operator_alert: 'Operator Alert',
} as const

export type KlaviyoMetric = keyof typeof KLAVIYO_METRICS

export interface KlaviyoProfile {
  email: string
  firstName?: string | null
  lastName?: string | null
  phone?: string | null
  businessName?: string | null
}

export interface KlaviyoEvent {
  metric: KlaviyoMetric
  profile: KlaviyoProfile
  jobId: string | null
  /** Flat, because a Klaviyo template reads {{ event.builder_login_link }} and not much deeper. */
  properties: Record<string, string | number | boolean | null>
}

export class KlaviyoConfigError extends Error {
  constructor() {
    super(
      'KLAVIYO_API_KEY is not set, so no customer email can be sent. Create a private API key in Klaviyo under Settings, API Keys, with write access to events, and add it to the Vercel project environment variables.',
    )
    this.name = 'KlaviyoConfigError'
  }
}

const ENDPOINT = 'https://a.klaviyo.com/api/events'

/**
 * The API version, pinned.
 *
 * Klaviyo versions by date and an unpinned client silently follows whatever is current, which is
 * how a working integration breaks on a morning nobody deployed anything. Bump it deliberately.
 */
const REVISION = '2026-07-15'

/**
 * The customer's phone in E.164, or nothing.
 *
 * THIS USED TO BE ITS OWN THREE-LINE GUESS, and it was wrong ten times out of seventeen on real
 * Australian formats. Two of those were the dangerous kind: "+61 (0)412 345 678" and
 * "61 0412 345 678" both came out as "+610412345678", which is not a number, and it was returned
 * rather than rejected because it started with a plus. Klaviyo answers an invalid phone_number
 * with a 400 for the WHOLE event, and the event carrying that phone is build_purchased - the one
 * that emails somebody the link to the website they have just paid $197 for.
 *
 * The other eight were silent drops: every landline (02, 03, 07, 08), every 1300 and 1800 number,
 * and anything written 0061. Those customers simply had no phone on their Klaviyo profile.
 *
 * shared/phone.ts has handled all of this correctly the whole time, and facts.ts and generate.ts
 * were already using it. There was never a reason for a second opinion in here.
 *
 * Anything it cannot read is still left out rather than guessed at: a wrong number on a profile is
 * worse than no number, because it looks like a real one.
 */
function e164(phone: string | null | undefined): string | null {
  return normaliseAuPhone(phone ?? '')
}

export async function trackKlaviyo(event: KlaviyoEvent): Promise<void> {
  const cfg = config()

  // Demo mode never reaches Klaviyo. It logs exactly what it would have sent.
  if (cfg.demoMode) return fakeKlaviyo(event)

  assertLiveEnabled('email', cfg)
  const key = cfg.klaviyoApiKey
  if (!key) throw new KlaviyoConfigError()

  const phone = e164(event.profile.phone)

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Klaviyo-API-Key ${key}`,
      revision: REVISION,
      'content-type': 'application/vnd.api+json',
      accept: 'application/vnd.api+json',
    },
    body: JSON.stringify({
      data: {
        type: 'event',
        attributes: {
          properties: {
            ...event.properties,
            job_id: event.jobId,
            source: 'go-polar-builder',
          },
          metric: {
            data: { type: 'metric', attributes: { name: KLAVIYO_METRICS[event.metric] } },
          },
          profile: {
            data: {
              type: 'profile',
              attributes: {
                email: event.profile.email,
                ...(event.profile.firstName ? { first_name: event.profile.firstName } : {}),
                ...(event.profile.lastName ? { last_name: event.profile.lastName } : {}),
                ...(phone ? { phone_number: phone } : {}),
                ...(event.profile.businessName
                  ? { organization: event.profile.businessName }
                  : {}),
              },
            },
          },
        },
      },
    }),
  })

  // 202 is the documented success. Klaviyo has accepted it for processing, which is not the same
  // as having sent anything, and nothing here should pretend otherwise.
  if (res.status !== 202) {
    throw new Error(`Klaviyo returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
}

/**
 * Track, and record the failure rather than throwing into a payment webhook.
 *
 * A Klaviyo outage must never take down the request that triggered it, least of all the one
 * handling a payment. The order is already committed by the time this runs; the sweep re-sends
 * anything whose email never went out.
 */
export async function trackKlaviyoSafely(event: KlaviyoEvent): Promise<boolean> {
  try {
    await trackKlaviyo(event)
    await recordEvent(event.jobId, 'klaviyo.sent', { metric: KLAVIYO_METRICS[event.metric] })
    return true
  } catch (err) {
    if (err instanceof LiveActionBlockedError) console.warn(err.message)
    await recordEvent(event.jobId, 'klaviyo.failed', {
      metric: KLAVIYO_METRICS[event.metric],
      to: event.profile.email,
      error: err instanceof Error ? err.message : String(err),
      retry: true,
    })
    return false
  }
}

export function builderLoginLink(token: string): string {
  return `${config().publicAppUrl.replace(/\/$/, '')}/start?t=${encodeURIComponent(token)}`
}

export function previewLink(jobId: string): string {
  return `${config().publicAppUrl.replace(/\/$/, '')}/preview/${jobId}`
}

/** Whether this install can send a customer an email at all. Used by the health report. */
export function klaviyoConfigured(cfg: AppConfig = config()): boolean {
  return Boolean(cfg.klaviyoApiKey)
}
