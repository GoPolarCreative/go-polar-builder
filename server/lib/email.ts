import { assertLiveEnabled, config, LiveActionBlockedError } from '../config'
import { recordEvent } from './db'
import { formatPrice } from '../../shared/pricing'
import { fakeResend } from './integrations/fakes'

/**
 * Transactional email through Resend.
 *
 * Go Polar controls these, not Shopify's order confirmation, so the branding and the
 * instructions are right (brief s3a step 6).
 *
 * NOTHING IS STUBBED AND NOTHING SILENTLY DROPS. In demo mode the message is printed in full to
 * the terminal and never sent. With live email enabled and a key present, it sends. With live
 * email enabled and no key, it throws an error naming the variable. Either way the caller
 * records the outcome and the hourly sweep retries: a paying customer who never receives a link
 * is the worst failure in this system. See DECISIONS.md D11.
 */

export class EmailConfigError extends Error {
  constructor(name: string) {
    super(
      `${name} is not set, so no email can be sent. Add it to the Vercel project environment variables. Until then every send is recorded as email.failed and retried by the hourly sweep.`,
    )
    this.name = 'EmailConfigError'
  }
}

export interface EmailMessage {
  to: string
  subject: string
  text: string
}

export async function send(message: EmailMessage): Promise<{ id: string }> {
  const cfg = config()

  if (cfg.demoMode) return fakeResend(message)

  // Refuses rather than pretends. An email to a real customer is not something to do by accident.
  assertLiveEnabled('email', cfg)

  if (!cfg.resendApiKey) throw new EmailConfigError('RESEND_API_KEY')

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.resendApiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: cfg.resendFrom,
      to: [message.to],
      subject: message.subject,
      text: message.text,
    }),
  })

  if (!res.ok) {
    throw new Error(`Resend returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  return (await res.json()) as { id: string }
}

/** Send, and never let an email failure take down the request that triggered it. */
export async function sendSafely(
  jobId: string | null,
  kind: string,
  message: EmailMessage,
): Promise<boolean> {
  try {
    await send(message)
    await recordEvent(jobId, 'email.sent', { kind, to: message.to })
    return true
  } catch (err) {
    if (err instanceof LiveActionBlockedError) console.warn(err.message)
    await recordEvent(jobId, 'email.failed', {
      kind,
      to: message.to,
      error: err instanceof Error ? err.message : String(err),
      retry: true,
    })
    return false
  }
}

// ---------------------------------------------------------------------------------------------
// The messages. Plain text on purpose: it lands in the inbox, renders on every phone, and a
// tradie reads it in ten seconds.
//
// The voice is the one on itscold.com.au. Short declarative sentences, no marketing language,
// nothing promised that we cannot control. Every message signs off the same way, with a real
// phone number, because the person reading it has just paid money to somebody on the internet.
// ---------------------------------------------------------------------------------------------

const SIGN_OFF = `Go Polar.
hello@itscold.com.au
+61 435 031 044
Perth, WA & Sunshine Coast, QLD. Mon-Fri, 8am-5pm.
https://www.itscold.com.au`

export function buildLinkEmail(args: { link: string }): EmailMessage {
  return {
    to: '',
    subject: 'Your website build is ready to start',
    text: `Payment came through. Here is your link:

${args.link}

A handful of questions about your business, then the site gets built in front of you. Give it fifteen minutes. Have your logo and a few job photos ready if you have them.

The link works for 90 days. Tonight or next Sunday, it will be waiting.

Ten rounds of changes are included before you go live.

Anything at all, reply to this email.

${SIGN_OFF}
`,
  }
}

export function resendLinkEmail(args: { link: string }): EmailMessage {
  return {
    to: '',
    subject: 'Your website builder link',
    text: `Here is your link again:

${args.link}

It works for 90 days from now.

${SIGN_OFF}
`,
  }
}

export function buildCompleteEmail(args: { businessName: string; previewLink: string }): EmailMessage {
  return {
    to: '',
    subject: `${args.businessName}, your website is built`,
    text: `Your website is built. Go and have a look.

${args.previewLink}

Look at it on your phone as well as on a computer. Anything you want changed, type it in the box on that page in your own words. Ten rounds are included, and one round can carry as many changes as you like.

When it is right, there is a button to put it live.

${SIGN_OFF}
`,
  }
}

export function goLiveReceiptEmail(args: {
  businessName: string
  domain: string | null
  monthly: string[]
}): EmailMessage {
  return {
    to: '',
    subject: `${args.businessName}, we are getting your site live`,
    text: `Payment received.

One of our team will be in touch within one business day to get${args.domain ? ` ${args.domain}` : ' your domain'} connected.

What you pay each month from here:
${args.monthly.map((m) => `  ${m}`).join('\n')}

That is the lot. No maintenance retainer, no lock-in contract.

${
  formatPrice('postLiveEdit')
    ? `Changes after you are live are ${formatPrice('postLiveEdit')} per update, handled by our team.`
    : 'Changes after you are live are handled by our team. Ask us and we will quote it.'
}

${SIGN_OFF}
`,
  }
}

export function dischargeReadyEmail(args: {
  businessName: string
  downloadLink: string
  expiresAt: string
  usedPlaceholder: boolean
}): EmailMessage {
  return {
    to: '',
    subject: `${args.businessName} website files`,
    text: `Your files are ready.

${args.downloadLink}

That link works until ${new Date(args.expiresAt).toLocaleDateString('en-AU')}.

Inside you will find index.html, your images, a favicon, and a preview copy you can open by double clicking. Upload the first three to any web host, keeping the same folder structure. Nothing needs compiling.
${
  args.usedPlaceholder
    ? `
One thing that matters: your enquiry forms have a placeholder in them and will not send anywhere until you replace it with your own free Web3Forms key. READ-ME-FIRST.txt in the zip walks through it. It takes about a minute at web3forms.com.
`
    : `
Your enquiry forms are already pointed at your own Web3Forms account, so enquiries come straight to you.
`
}
All the best with it.

${SIGN_OFF}
`,
  }
}
