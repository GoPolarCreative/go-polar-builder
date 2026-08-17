import type { Env } from '../env'
import { recordEvent } from './db'

/**
 * GoHighLevel. Brief s12: POST to a GHL inbound webhook on every one of these state changes.
 *
 * | Event                  | Why it matters                                        |
 * | payment received       | start the build nurture sequence                      |
 * | intake abandoned 24h   | warmest possible lead, currently nothing catches these |
 * | build complete         | notify, drive them back to preview                    |
 * | stalled in editing 72h | recovery sequence                                     |
 * | go live requested      | Chris actions the domain                              |
 * | site live              | handover sequence, review request                     |
 * | discharge requested    | Chris actions, plus exit survey                       |
 *
 * A GHL outage must never take down the request that triggered it, least of all a payment
 * webhook (DECISIONS.md D11).
 */

export type GhlEvent =
  | 'payment_received'
  | 'intake_abandoned'
  | 'build_complete'
  | 'editing_stalled'
  | 'go_live_requested'
  | 'site_live'
  | 'discharge_requested'
  | 'build_held'
  | 'edit_overage'

export interface GhlContact {
  email: string
  phone?: string | null
  firstName?: string | null
  businessName?: string | null
}

export interface GhlPayload {
  event: GhlEvent
  contact: GhlContact
  jobId: string
  /** Existing custom values in use, plus the two the brief asks us to add. */
  customValues: {
    builder_login_link?: string
    preview_link?: string
    [key: string]: string | undefined
  }
  data?: Record<string, unknown>
}

export class GhlConfigError extends Error {
  constructor() {
    super(
      'GHL_INBOUND_WEBHOOK_URL is not set, so CRM notifications cannot be sent. Create an inbound webhook in GoHighLevel and set the URL with "npx wrangler secret put GHL_INBOUND_WEBHOOK_URL".',
    )
    this.name = 'GhlConfigError'
  }
}

export async function notifyGhl(env: Env, payload: GhlPayload): Promise<void> {
  const url = env.GHL_INBOUND_WEBHOOK_URL?.trim()
  if (!url) throw new GhlConfigError()

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...payload,
      // Brief s12: SMS to Australian mobiles from the US toll-free number is unreliable. Email
      // only until an Australian number or an alphanumeric sender ID is provisioned. Passed
      // explicitly so a workflow in GHL can branch on it rather than relying on somebody
      // remembering.
      preferredChannel: 'email',
      smsSafe: false,
      sentAt: new Date().toISOString(),
    }),
  })

  if (!res.ok) {
    throw new Error(`GHL webhook returned ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
}

/** Notify, and record the failure rather than throwing into a payment webhook. */
export async function notifyGhlSafely(env: Env, payload: GhlPayload): Promise<boolean> {
  try {
    await notifyGhl(env, payload)
    await recordEvent(env, payload.jobId, 'ghl.sent', { event: payload.event })
    return true
  } catch (err) {
    await recordEvent(env, payload.jobId, 'ghl.failed', {
      event: payload.event,
      error: err instanceof Error ? err.message : String(err),
      retry: true,
    })
    return false
  }
}

export function builderLoginLink(env: Env, token: string): string {
  const base = (env.PUBLIC_APP_URL ?? 'https://build.itscold.com.au').replace(/\/$/, '')
  return `${base}/start?t=${encodeURIComponent(token)}`
}

export function previewLink(env: Env, jobId: string): string {
  const base = (env.PUBLIC_APP_URL ?? 'https://build.itscold.com.au').replace(/\/$/, '')
  return `${base}/preview/${jobId}`
}
