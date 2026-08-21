import { assertLiveEnabled, config, LiveActionBlockedError, type AppConfig } from '../config.js'
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

/** An Australian mobile in the form Klaviyo will accept, or nothing at all. */
function e164(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = phone.replace(/[^\d+]/g, '')
  if (digits.startsWith('+')) return digits
  if (digits.startsWith('04') && digits.length === 10) return `+61${digits.slice(1)}`
  if (digits.startsWith('61')) return `+${digits}`
  // Anything else is left out rather than guessed at. A wrong number on a profile is worse than
  // no number, because it looks like a real one.
  return null
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
