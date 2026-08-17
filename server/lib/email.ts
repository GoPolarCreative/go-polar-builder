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
// ---------------------------------------------------------------------------------------------

export function buildLinkEmail(args: { link: string }): EmailMessage {
  return {
    to: '',
    subject: 'Your website build is ready to start',
    text: `Thanks for that, your payment has come through.

Here is your link to get started:

${args.link}

You will be asked a handful of questions about your business, then your website gets built in front of you. Set aside about fifteen minutes and have your logo and a few job photos handy if you have them.

The link works for 90 days, so there is no rush. Start it tonight or start it next Sunday, it will be waiting.

You get 10 rounds of changes before you go live.

Any questions, just reply to this email.

Go Polar Creative
https://www.itscold.com.au
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

Go Polar Creative
https://www.itscold.com.au
`,
  }
}

export function buildCompleteEmail(args: { businessName: string; previewLink: string }): EmailMessage {
  return {
    to: '',
    subject: `${args.businessName}, your website is built`,
    text: `Your website is done and waiting for you to look at.

${args.previewLink}

Have a proper look through it on your phone as well as on a computer. If anything needs changing, just say so in the box on that page. You have 10 rounds of changes included, and you can put as many changes as you like into each one.

When you are happy with it, there is a button to go live.

Go Polar Creative
https://www.itscold.com.au
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
    text: `Payment received, thanks.

One of our team will be in touch within one business day to get${args.domain ? ` ${args.domain}` : ' your domain'} connected.

What you pay each month from here:
${args.monthly.map((m) => `  ${m}`).join('\n')}

That is it. No mandatory maintenance fees and no lock-in contract.

Changes after you are live are ${formatPrice('postLiveEdit')} per update, handled by our team.

Go Polar Creative
https://www.itscold.com.au
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
    text: `Your website files are ready.

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

Go Polar Creative
https://www.itscold.com.au
`,
  }
}
