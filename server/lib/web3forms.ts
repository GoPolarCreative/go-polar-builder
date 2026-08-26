import { config, assertLiveEnabled, type AppConfig } from '../config.js'
import { fakeLog } from './integrations/fakes.js'

/**
 * The customer's own Web3Forms access key.
 *
 * WHY THIS EXISTS AT ALL. Every generated site posts its enquiry forms to Web3Forms. During the
 * build and the edit loop that happens through Go Polar's key, so the preview forms work before
 * the customer has an account. If a site went live still carrying that key, every enquiry the
 * tradie ever received would land in Go Polar's inbox instead of theirs. That is a lost lead for
 * the person paying for lead generation, and someone else's customer data sitting in our account.
 *
 * WHY IT IS COLLECTED AT GO LIVE AND NOT IN THE INTAKE. It was in the intake once. Out of 59
 * submissions nearly every one came back with an email address or a phone number rather than a
 * UUID, because at that point the customer has no site, no motivation, and no idea what the field
 * is for. See DECISIONS.md D29. It now sits in the go-live flow, where they can see the thing
 * they are protecting, and it is guided rather than a bare text box.
 *
 * THE PART THAT MATTERS MOST. A syntactically valid but wrong key is worse than no key: the forms
 * look fine and every enquiry silently goes nowhere. So a key is never accepted on the strength of
 * its shape. A real test submission is sent through Web3Forms with it, and only a genuine success
 * response gets it saved.
 *
 * ONE CODE PATH. Go-live and the section 9 discharge both come through here. Neither has its own
 * copy of the validation, because two copies drift and one of them ends up being the lenient one.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const WEB3FORMS_SUBMIT_URL = 'https://api.web3forms.com/submit'

/*
 * WEB3FORMS CANNOT BE REACHED FROM A SERVER AT ALL, SO THE BROWSER DOES THE TEST.
 *
 * api.web3forms.com sits behind Cloudflare bot protection that fingerprints the TLS handshake.
 * Every request out of Node gets a "Just a moment..." HTML challenge and a 403, no matter what
 * headers it carries. Measured: node's default UA, a real Chrome UA, an Origin and Referer, both
 * JSON and form encoding, all 403 HTML. The identical body from a browser gets clean JSON back.
 * Header spoofing cannot fix this; the handshake is the tell.
 *
 * So the customer's browser sends the test submission and reports what Web3Forms said, and this
 * function reads that verdict. THAT IS ALSO THE BETTER TEST. Every enquiry form on the live site
 * posts from a visitor's browser to Web3Forms. The server-side check proved a path that no real
 * enquiry ever takes; the browser check proves the one they all take.
 *
 * A customer could forge a success. The only thing they would break is their own enquiry forms,
 * and the failure this module exists to prevent - a mistyped key silently swallowing leads - is
 * still caught, because a mistyped key genuinely comes back success:false in their own browser.
 *
 * The server-side path below is kept for demo mode, the local stub the tests point at, and the
 * chance that Web3Forms stops challenging us one day. It is never the only thing standing between
 * a bad key and a live site.
 */
const USER_AGENT = 'GoPolarBuilder/1.0 (+https://www.itscold.com.au)'

export type KeyRejection = 'empty' | 'email' | 'phone' | 'url' | 'placeholder' | 'not_uuid'

export interface KeyShapeResult {
  ok: boolean
  key: string | null
  reason: KeyRejection | null
  /** Plain English, written to be read by a tradie on a phone. */
  message: string | null
}

/**
 * What did they actually paste?
 *
 * Naming the mistake is the whole job here. "Invalid key" tells someone who pasted their email
 * address nothing at all, and they will paste it again. The three things that came back in the 59
 * submissions were email addresses, phone numbers, and the word they thought it wanted.
 */
export function classifyWeb3FormsKey(raw: string): KeyShapeResult {
  const value = (raw ?? '').trim()

  if (value === '') {
    return {
      ok: false,
      key: null,
      reason: 'empty',
      message: 'Paste the access key that Web3Forms emailed you.',
    }
  }

  if (UUID_RE.test(value)) return { ok: true, key: value.toLowerCase(), reason: null, message: null }

  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return {
      ok: false,
      key: null,
      reason: 'email',
      message:
        'That looks like an email address. We need the access key that Web3Forms emailed you, which is a long code like 1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809. Check that email and copy the code out of it.',
    }
  }

  // Digits, spaces, brackets, plus and dashes only, and enough digits to be a phone number.
  if (/^[\d\s()+-]+$/.test(value) && value.replace(/\D/g, '').length >= 6) {
    return {
      ok: false,
      key: null,
      reason: 'phone',
      message:
        'That looks like a phone number. We need the access key that Web3Forms emailed you, which is a long code like 1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809.',
    }
  }

  if (/^https?:\/\//i.test(value) || /web3forms\.com/i.test(value)) {
    return {
      ok: false,
      key: null,
      reason: 'url',
      message:
        'That is a web address, not the key. Open the email from Web3Forms and copy the access key out of it, which is a long code like 1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809.',
    }
  }

  if (/your|access|key|here|paste|xxxx/i.test(value)) {
    return {
      ok: false,
      key: null,
      reason: 'placeholder',
      message:
        'That is the example text rather than your key. The real one is a long code like 1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809 and it is in the email Web3Forms sent you.',
    }
  }

  return {
    ok: false,
    key: null,
    reason: 'not_uuid',
    message:
      'That is not a Web3Forms access key. It is a long code in five parts separated by dashes, like 1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809. Copy it out of the email Web3Forms sent you.',
  }
}

/** Kept for the discharge path and the checks, which only ever needed the shape question. */
export function isValidWeb3FormsKey(value: string): boolean {
  return classifyWeb3FormsKey(value).ok
}

/** Safe to log, safe to show back on screen, useless to anyone who intercepts it. */
export function maskKey(key: string): string {
  const value = key.trim()
  if (value.length < 12) return '****'
  return `${value.slice(0, 8)}${'*'.repeat(19)}${value.slice(-4)}`
}

/**
 * What the customer's browser got back from Web3Forms. Passed through untouched so the decision
 * is made in one place rather than in the page.
 */
export interface BrowserProof {
  success?: boolean
  message?: string
  status?: number
}

export interface KeyVerification {
  ok: boolean
  /** What went wrong, in words the customer can act on. Null when it worked. */
  message: string | null
  /** The real underlying reason, for the event log. Never the customer's only explanation. */
  detail: string | null
  /** Did a test enquiry actually reach their inbox? False for a faked run. */
  live: boolean
}

/**
 * Send a real test submission through Web3Forms with this key.
 *
 * This is the only thing that distinguishes a key that works from a key that is merely shaped
 * correctly, and it is the reason this whole module exists. Web3Forms answers a bad key with
 * `success: false` and a reason, which is exactly the signal needed.
 *
 * The customer is told to expect this email, because an unexplained test enquiry arriving in a
 * tradie's inbox looks like a lead they have already lost.
 */
export async function verifyWeb3FormsKey(
  key: string,
  args: { businessName: string; jobId: string; proof?: BrowserProof | null },
  cfg: AppConfig = config(),
): Promise<KeyVerification> {
  const shape = classifyWeb3FormsKey(key)
  if (!shape.ok || !shape.key) {
    return { ok: false, message: shape.message, detail: `shape:${shape.reason}`, live: false }
  }

  if (cfg.demoMode) return fakeVerification(shape.key, args)

  /*
   * The browser already sent the real submission, so this is the answer that counts. A test
   * enquiry genuinely landed in their inbox, which is why live is true here.
   */
  if (args.proof) {
    assertLiveEnabled('email', cfg)
    if (args.proof.success === true) {
      return { ok: true, message: null, detail: 'browser:accepted', live: true }
    }
    const said = (args.proof.message ?? '').trim() || 'no reason given'
    return {
      ok: false,
      message: `Web3Forms rejected that key, so we have not saved it. They said: "${said}". Check you copied the whole key out of their email, and that the Web3Forms account is verified.`,
      detail: `browser:${args.proof.status ?? 0}:${said}`,
      live: false,
    }
  }

  // A real email lands in a real inbox, so it goes through the same gate as everything else that
  // reaches a person. If the flag is off this throws by name rather than quietly passing a key
  // that was never tested.
  assertLiveEnabled('email', cfg)

  const payload = {
    access_key: shape.key,
    subject: `Test enquiry from your new website`,
    from_name: 'Go Polar Creative',
    // Web3Forms echoes the fields into the email, so this is what the tradie will read.
    message: [
      `This is a test enquiry sent by Go Polar Creative while setting up ${args.businessName}.`,
      '',
      'It confirms the enquiry forms on your new website reach this inbox. You do not need to reply to it.',
      '',
      'If a real customer fills in the form on your website, it will arrive looking like this one.',
    ].join('\n'),
  }

  let res: Response
  try {
    res = await fetch(cfg.web3formsApiUrl || WEB3FORMS_SUBMIT_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(payload),
    })
  } catch (err) {
    // Reaching Web3Forms failed, which is not the same as the key being wrong, and the customer
    // must not be told their key is bad when it might be fine.
    const detail = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      message:
        'We could not reach Web3Forms just now to test your key, so we have not saved it. This is our end, not yours. Try again in a minute.',
      detail: `network:${detail}`,
      live: false,
    }
  }

  const body = await res.text()

  let parsed: { success?: boolean; message?: string } | null = null
  try {
    parsed = JSON.parse(body) as { success?: boolean; message?: string }
  } catch {
    parsed = null
  }

  if (res.ok && parsed?.success === true) {
    return { ok: true, message: null, detail: parsed.message ?? 'accepted', live: true }
  }

  /*
   * ONLY A JSON ANSWER FROM WEB3FORMS MAY BE READ AS A VERDICT ON THE KEY.
   *
   * Anything that is not JSON is Cloudflare, a proxy or an outage talking, not Web3Forms. Telling
   * somebody their key is wrong when the key is fine is the worst thing this function can do: it is
   * unfixable from their side, so they retype a correct key over and over and eventually give up on
   * going live. The body still reaches the event log, truncated, because that is where a diagnosis
   * belongs rather than in front of a tradie on a phone.
   */
  if (parsed === null) {
    const challenge = /just a moment|cf-browser-verification|cloudflare|<!doctype html/i.test(body)
    return {
      ok: false,
      message:
        'We could not get a proper answer out of Web3Forms just now, so we have not saved your key yet. This is our end rather than yours, and your key is probably fine. Give it a minute and try again.',
      detail: `unreadable:${res.status}:${challenge ? 'challenge' : 'non-json'}:${body.slice(0, 160).replace(/\s+/g, ' ')}`,
      live: false,
    }
  }

  /* JSON, but about their infrastructure rather than about the key. */
  if (res.status === 403 || res.status === 429 || res.status >= 500) {
    return {
      ok: false,
      message:
        'Web3Forms is not answering properly just now, so we have not saved your key yet. This is our end rather than yours. Give it a minute and try again.',
      detail: `upstream:${res.status}:${(parsed.message ?? '').slice(0, 160)}`,
      live: false,
    }
  }

  const reported = (parsed.message ?? body.slice(0, 200)).trim()
  return {
    ok: false,
    message: `Web3Forms rejected that key, so we have not saved it. They said: "${reported}". Check you copied the whole key out of their email, and that the Web3Forms account is verified.`,
    detail: `web3forms:${res.status}:${reported}`,
    live: false,
  }
}

/**
 * Demo mode. No account exists and nothing may leave the machine, so the submission is faked and
 * said to be faked. `live: false` travels with it so nothing downstream can claim a test enquiry
 * was delivered when none was.
 *
 * A key of all zeroes is treated as rejected, so the failure path can be walked locally too. That
 * is also the placeholder `web3formsKey()` falls back to, which is the one key that genuinely
 * must never be accepted.
 */
function fakeVerification(key: string, args: { businessName: string; jobId: string }): KeyVerification {
  if (/^0{8}-/.test(key)) {
    fakeLog('web3forms', `test that key and be REJECTED (a zero key is the demo failure case)`, {
      jobId: args.jobId,
      key: maskKey(key),
    })
    return {
      ok: false,
      message:
        'Web3Forms rejected that key, so we have not saved it. Check you copied the whole key out of their email, and that the Web3Forms account is verified.',
      detail: 'demo:rejected',
      live: false,
    }
  }

  fakeLog('web3forms', `send a test enquiry to the inbox behind this key`, {
    jobId: args.jobId,
    business: args.businessName,
    key: maskKey(key),
  })
  return { ok: true, message: null, detail: 'demo:accepted', live: false }
}

// ---------------------------------------------------------------------------------------------
// Putting the key into a built document
// ---------------------------------------------------------------------------------------------

export interface KeySwap {
  html: string
  /** How many form access_key values now carry the replacement. */
  replaced: number
  /** True if the Go Polar key is completely gone from the document. */
  clean: boolean
}

/**
 * Swap the access key in every form. Deterministic, and deliberately not a model call: the only
 * thing that may change is the value of the hidden access_key input, and asking a model to
 * rewrite a document it might otherwise improve is how a customer's copy changes underneath them.
 */
export function applyFormsKey(html: string, fromKey: string, toKey: string): KeySwap {
  const out = fromKey ? html.split(fromKey).join(toKey) : html
  const replaced = countAccessKey(out, toKey)
  return { html: out, replaced, clean: fromKey !== toKey ? !out.includes(fromKey) : true }
}

export function countAccessKey(html: string, key: string): number {
  if (!key) return 0
  const re = new RegExp(`name="access_key"\\s+value="${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'gi')
  return (html.match(re) ?? []).length
}

/**
 * The rule that protects the customer's leads: a document about to be served to the public may
 * not carry Go Polar's key. Called by the publish path, which refuses rather than warns.
 */
export function assertNoGoPolarKey(html: string, goPolarKey: string): void {
  if (goPolarKey && html.includes(goPolarKey)) {
    throw new Error(
      'Refusing to publish: this document still posts its enquiry forms to the Go Polar Web3Forms account, so the customer would never receive their own enquiries. The customer has to supply and verify their own key before the site can go live.',
    )
  }
}
