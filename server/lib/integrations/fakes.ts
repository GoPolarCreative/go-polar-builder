import type { GhlPayload } from '../ghl.js'
import type { CheckoutRequest } from '../shopify.js'
import type { DomainReport } from '../domains.js'
import { config } from '../../config.js'

/**
 * Local fakes for every outbound integration.
 *
 * DEMO MODE. Selected by DEMO_MODE=1, which is the default when nothing is configured, so a
 * fresh clone runs the entire product on localhost with no accounts anywhere. Nothing leaves the
 * machine: no money moves, no email reaches a real person, no DNS record changes.
 *
 * Every fake LOGS what it would have done, in one obvious format, so the flow can be watched in
 * the terminal rather than guessed at:
 *
 *   FAKE RESEND: would send build link to jobs@coldfrontplumbing.com.au
 *
 * These are not silent no-ops. A silent no-op in a payment path is indistinguishable from
 * success, which is how money goes missing. Anything the fakes cannot honestly simulate throws.
 */

export function fakeLog(system: string, action: string, detail?: Record<string, unknown>): void {
  const parts = detail
    ? Object.entries(detail)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ')
    : ''
  console.log(`FAKE ${system.toUpperCase()}: would ${action}${parts ? `  [${parts}]` : ''}`)
}

// ---------------------------------------------------------------------------------------------

export async function fakeGhl(payload: GhlPayload): Promise<void> {
  fakeLog('ghl', `fire "${payload.event}" into the CRM`, {
    contact: payload.contact.email,
    jobId: payload.jobId,
    ...payload.customValues,
  })
}

export async function fakeResend(message: { to: string; subject: string; text: string }): Promise<{ id: string }> {
  fakeLog('resend', `send "${message.subject}" to ${message.to}`)
  // The body matters more than the envelope when you are checking the flow, so it is printed
  // indented rather than hidden.
  console.log(
    message.text
      .trim()
      .split('\n')
      .map((line) => `        | ${line}`)
      .join('\n'),
  )
  return { id: `fake_email_${Math.random().toString(36).slice(2, 10)}` }
}

/**
 * A checkout the customer can actually complete locally.
 *
 * Returns a link to the demo checkout page in this app, which on confirmation runs the very same
 * processPaidOrder the real Shopify webhook runs. That way the go-live and discharge flows can
 * be clicked all the way through with nothing configured, and the code path being exercised is
 * the production one.
 */
export function fakeCheckoutUrl(req: CheckoutRequest): string {
  const base = config().publicAppUrl.replace(/\/$/, '')
  const params = new URLSearchParams({
    job: req.jobId,
    email: req.email,
    lines: req.lines.map((l) => `${l.ref}:${l.quantity}`).join(','),
  })
  fakeLog('shopify', 'create a checkout', {
    jobId: req.jobId,
    lines: req.lines.map((l) => l.ref).join(','),
  })
  return `${base}/demo/checkout?${params.toString()}`
}

/**
 * Canned domain intelligence, shaped exactly like a real lookup so the screen can be reviewed.
 * Marked in the summary so nobody mistakes it for a real answer.
 */
export function fakeDomainReport(domain: string): DomainReport {
  fakeLog('whois', `look up ${domain} over RDAP and DNS`)
  return {
    domain,
    registered: true,
    registrar: 'Demo Registrar Pty Ltd',
    registrarUrl: null,
    createdAt: '2019-03-11T00:00:00Z',
    expiresAt: '2027-03-11T00:00:00Z',
    statuses: ['clientTransferProhibited'],
    nameservers: ['ns1.demo-host.com.au', 'ns2.demo-host.com.au'],
    mx: [{ type: 'MX', value: 'aspmx.l.google.com', priority: 1 }],
    a: ['203.0.113.10'],
    likelyHost: 'a demo host',
    likelyMailProvider: 'Google Workspace',
    summary: [
      `DEMO MODE: this is a canned lookup for ${domain}, not a real one.`,
      'It is registered with Demo Registrar Pty Ltd. That is who it is bought from.',
      'Its nameservers point at a demo host, which is most likely who hosts the website at the moment.',
      'Email on this domain is handled by Google Workspace. We will not touch that.',
      'It is currently locked against transfer, which is normal.',
    ],
    problems: [],
    source: ['rdap', 'dns'],
  }
}

export function fakeAvailability(domain: string): { domain: string; available: boolean; detail: string } {
  fakeLog('registrar', `check whether ${domain} is available`)
  // Deterministic so the screen behaves the same on every run: anything with "taken" in it is
  // taken, everything else is free.
  const available = !/taken|google|example/i.test(domain)
  return {
    domain,
    available,
    detail: available
      ? 'DEMO MODE: available. Nobody has registered it.'
      : 'DEMO MODE: already taken. Try a different one.',
  }
}

export function fakeDomainAttach(domain: string, jobId: string): void {
  fakeLog('vercel domains', `attach ${domain} to the project and issue a certificate`, { jobId })
}
