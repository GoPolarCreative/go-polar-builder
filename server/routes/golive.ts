import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { getDb, schema } from '../db/client.js'
import { PRICING, ProductNotOnStoreError, formatPrice } from '../../shared/pricing.js'
import { LIVE_EDITS_PER_MONTH } from '../../shared/allowance.js'
import { isValidAbn } from '../../shared/abn.js'
import type { Job } from '../../shared/types.js'
import { config } from '../config.js'
import { getIntake, getJob, getUserForJob, recordEvent, setJobStatus } from '../lib/db.js'
import { id } from '../lib/ids.js'
import { ShopifyConfigError, createCheckout, type CheckoutLine } from '../lib/shopify.js'
import { previewLink, trackKlaviyoSafely } from '../lib/klaviyo.js'
import { goLiveCartLines } from '../lib/products.js'
import { checkAvailability, inspectDomain, normaliseDomain, requiresAuEligibility } from '../lib/domains.js'
import { classifyWeb3FormsKey, maskKey, verifyWeb3FormsKey } from '../lib/web3forms.js'

const app = new Hono()

/**
 * Phase 5, brief s8. Going live.
 *
 * Screen 1 is the plan and the payment. Screen 2 is the domain, in three branches. Screen 3 is
 * the confirmation. The job does not advance past screen 1 until the payment is confirmed.
 *
 * The wording rule from the brief is enforced in the copy: contact within one business day,
 * never a promise that the domain will be connected in any timeframe. Transfers, registrar locks
 * and uncooperative third parties are outside Go Polar's control.
 */

const CONTACT_PROMISE = 'One of our team will be in touch within one business day to get it connected.'

async function getGoLive(jobId: string) {
  const db = await getDb()
  const rows = await db.select().from(schema.golive).where(eq(schema.golive.jobId, jobId)).limit(1)
  return rows[0] ?? null
}

/**
 * Where this job stands on the enquiry inbox.
 *
 * TWO STATES, NOT ONE. `saved` means a well-formed key is on the job. `verified` means a real test
 * enquiry went through it and arrived. They are separated because the setup panel runs before the
 * build, where sending a test needs an inbox and an outbound email path that may not be switched
 * on, and failing there in front of a customer who has done nothing wrong is what this split fixes.
 *
 * Only `verified` unblocks go live, and publishJob refuses on the same column. A saved key is a
 * step completed, not a guarantee: an access key is a UUID, so a single typo still parses and the
 * forms would silently go nowhere.
 */
function formsKeyState(job: Job) {
  const saved = Boolean(job.web3formsKeyMasked)
  const verified = Boolean(job.web3formsKeyMasked && job.web3formsVerifiedAt)
  return {
    required: true,
    saved,
    verified,
    keyMasked: job.web3formsKeyMasked,
    verifiedAt: job.web3formsVerifiedAt,
    blocksGoLive: !verified,
    /*
     * The screen is written from this, so the reason lives with the rule rather than in the UI.
     *
     * WRITTEN SO IT IS TRUE IN BOTH PLACES IT APPEARS. This task is now asked before the build and
     * repeated on the editing page afterwards. The previous wording opened with "Right now the
     * enquiry forms on your website send to our account", which is a plain falsehood on the first
     * of those screens, because at that point there is no website and no form. It now describes
     * the rule rather than the current state, which is accurate whenever it is read.
     */
    why: verified
      ? 'Your enquiry forms send to your own Web3Forms account, so enquiries come straight to you.'
      : 'The contact form on your website needs somewhere to send enquiries. That has to be your own free Web3Forms account rather than ours, so every enquiry goes straight to your inbox and nowhere else. It is free and it takes a couple of minutes.',
    signUpUrl: 'https://web3forms.com/',
    whatToExpect: [
      'Open web3forms.com and put in the email address you want your enquiries to go to.',
      // The actual path through their site, because "they email you a key" was not what happens.
      'Click sign up, then free account, then form setup, then form access key.',
      'Copy that key back into the box below.',
      // True about when it happens. The test runs at go live, not on this screen.
      'When you go live we send one test enquiry through it, so you can see it reach you.',
    ],
  }
}

async function latestDomain(jobId: string) {
  const db = await getDb()
  const rows = await db
    .select()
    .from(schema.domains)
    .where(eq(schema.domains.jobId, jobId))
    .orderBy(desc(schema.domains.createdAt))
    .limit(1)
  return rows[0] ?? null
}

/** Screen 1: what it costs to keep the website online, and what they have chosen so far. */
app.get('/jobs/:jobId/golive', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const [golive, domain] = await Promise.all([getGoLive(jobId), latestDomain(jobId)])

  return c.json({
    jobStatus: job.status,
    currentVersion: job.currentVersion,
    selection: golive
      ? {
          hosting: golive.hosting,
          emailAddon: golive.emailAddon,
          domainAddon: golive.domainAddon,
          status: golive.status,
          checkoutUrl: golive.checkoutUrl,
          paidAt: golive.paidAt?.toISOString() ?? null,
        }
      : null,
    domain: domain
      ? { name: domain.name, branch: domain.branch, status: domain.status, registrar: domain.registrar, report: domain.whois }
      : null,
    // Prices come from one place and always carry the GST label.
    pricing: {
      hosting: { label: PRICING.hosting.label, price: formatPrice('hosting'), required: true },
      domain: { label: PRICING.domain.label, price: formatPrice('domain'), required: false },
      email: { label: PRICING.email.label, price: formatPrice('email'), required: false },
    },
    formsKey: formsKeyState(job),
    promise: CONTACT_PROMISE,
    demoMode: config().demoMode,
  })
})

/**
 * The enquiry inbox step. Saves the key; does not prove it.
 *
 * The three gates that used to live here have been split across the two places they can each
 * actually run:
 *   1. the shape, with the mistake named rather than a generic rejection - still here
 *   2. a real test submission through Web3Forms - moved to go live, where there is a built site,
 *      an engaged customer and a failure they can act on, and where nothing is charged until it
 *      passes
 *   3. putting their key in every form and leaving none of ours - moved to publishJob, which is
 *      the single place a site becomes public and therefore the only place the swap has to be true
 *
 * The guarantee is unchanged. publishJob still refuses on web3formsVerifiedAt, which only gate 2
 * ever sets, so nothing reaches the internet on a key nobody has proved.
 */
app.post('/jobs/:jobId/golive/forms-key', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  /*
   * NO BUILD IS REQUIRED HERE, AND THAT IS THE WHOLE POINT.
   *
   * This route used to refuse unless job.currentVersion >= 1. InboxSetup, meanwhile, is
   * deliberately placed BEFORE the build: read its header comment, which records three previous
   * homes for this task and a real tester who stalled when it arrived after the build. So the
   * normal state when a customer uses the panel as designed is currentVersion 0, and the route
   * answered that with a 409 rendered under a banner reading "That key was not accepted".
   *
   * Their key was never looked at. Two halves of one path disagreeing, and the customer told
   * their perfectly good key was rejected.
   */
  type KeyBody = { key?: string; proof?: { success?: boolean; message?: string; status?: number } }
  const body = await c.req.json<KeyBody>().catch(() => ({}) as KeyBody)
  const raw = body.key ?? ''

  /*
   * SHAPE ONLY, ON PURPOSE, AND THE TEST HAS MOVED RATHER THAN GONE.
   *
   * A live test submission here needed an inbox, an outbound request and assertLiveEnabled('email'),
   * which throws wherever email is not switched on. That is three ways for a setup step to fail in
   * front of a customer who has done nothing wrong.
   *
   * What a shape check cannot do is tell a right key from a well-formed wrong one: an access key is
   * a UUID, so a single typo still parses, and the site would look perfect while every enquiry went
   * nowhere. So the key is SAVED here but NOT marked verified. web3formsVerifiedAt stays null until
   * a real test enquiry succeeds at go live, and publishJob still refuses on that column, so the
   * guarantee is unchanged: nothing reaches the internet on a key nobody has proved.
   */
  const shape = classifyWeb3FormsKey(raw)
  if (!shape.ok || !shape.key) {
    return c.json({ error: 'invalid_key', reason: shape.reason, detail: shape.message, saved: false }, 422)
  }

  /*
   * THE BROWSER TEST IS AN UPGRADE, NEVER A GATE.
   *
   * Web3Forms blocks server-side submissions at the TLS layer, so the only place a real test can
   * run is the customer's own browser, and the client sends the outcome here as `proof`. When it
   * succeeded we mark the key verified on the spot, which is the good path and the common one.
   *
   * When it did not, for any reason, the key is still saved and the customer is still told they
   * are done. A blocked request, an offline moment or an install with email switched off is our
   * problem, not theirs, and it must not produce a red banner on a step they completed correctly.
   * Go live picks up the proof later, and publishJob refuses until it exists, so nothing ships on
   * an unproven key either way.
   */
  const proved = body.proof?.success === true

  const db = await getDb()
  await db
    .update(schema.jobs)
    // Not an edit. The customer completed a step we require rather than asking for a change, so
    // edits_used is untouched.
    .set({
      customerWeb3formsKey: shape.key,
      ...(proved ? { web3formsVerifiedAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.jobs.id, jobId))

  await recordEvent(jobId, proved ? 'golive.forms_key_verified' : 'golive.forms_key_saved', {
    key: maskKey(shape.key),
    tested: proved,
  })

  return c.json({
    ok: true,
    saved: true,
    tested: proved,
    keyMasked: maskKey(shape.key),
    detail: proved
      ? 'Done. We sent a test enquiry through your Web3Forms account and it went through. Check your email and you should see it there.'
      : 'Saved. Your enquiries will go to this Web3Forms account. We send a test enquiry through it when you go live, so you can see it arrive.',
  })
})

/**
 * Screen 1 action. Builds the checkout for hosting plus whatever add-ons were chosen.
 *
 * Hosting must not start billing at build-token purchase (brief s3a). It starts here, at go
 * live, and the job only advances when the paid webhook confirms this checkout.
 */
app.post('/jobs/:jobId/golive/plan', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)
  if (job.currentVersion < 1) {
    return c.json({ error: 'not_ready', detail: 'There is no website built yet.' }, 409)
  }

  // Go-live is blocked until the enquiry inbox is sorted. Checked here as well as on the screen,
  // because the screen is a courtesy and this is the rule. Taking payment for a live site whose
  // enquiry forms deliver to us would be the worst possible order to do this in.
  if (!job.web3formsKeyMasked) {
    return c.json(
      {
        error: 'forms_key_required',
        detail:
          'Before your website can go live we need your own Web3Forms access key, so enquiries come to you rather than to us. It is free and takes a minute. Nothing has been charged.',
        formsKey: formsKeyState(job),
      },
      409,
    )
  }

  /*
   * THE REAL TEST, AT THE MOMENT IT IS BOTH POSSIBLE AND WORTH DOING.
   *
   * The setup panel saves the key on shape alone, because it runs before the build and a live send
   * there has three ways to fail in front of somebody who has done nothing wrong. The proof has to
   * happen somewhere, though: an access key is a UUID, so a typo parses, and a site whose forms
   * silently go nowhere is the worst thing this product can hand a tradie paying for leads.
   *
   * Here is that somewhere. The customer is at the checkout, engaged, and a failure is actionable
   * on the spot rather than a fortnight later when no enquiries have arrived. Nothing is charged
   * until it passes, and publishJob still refuses on web3formsVerifiedAt, so the guarantee that
   * reaches the internet is exactly the one it always was.
   */
  if (!job.web3formsVerifiedAt) {
    const db = await getDb()
    const [row] = await db
      .select({ key: schema.jobs.customerWeb3formsKey })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, jobId))
      .limit(1)

    const storedKey = row?.key ?? ''
    const verification = await verifyWeb3FormsKey(
      storedKey,
      { businessName: job.businessName ?? 'your business', jobId },
      config(),
    ).catch((err: unknown) => ({
      ok: false as const,
      // A missing email path is our configuration problem, and the message says so rather than
      // implying the customer's key is at fault.
      message:
        'We could not send the test enquiry just now, so nothing has been charged. This is on our end. Try again in a few minutes and if it keeps happening, get in touch.',
      detail: `throw:${err instanceof Error ? err.message : String(err)}`,
      live: false,
    }))

    if (!verification.ok) {
      await recordEvent(jobId, 'golive.forms_key_rejected', {
        key: job.web3formsKeyMasked,
        detail: verification.detail,
      })
      return c.json(
        {
          error: 'forms_key_rejected',
          detail: verification.message,
          formsKey: formsKeyState(job),
        },
        409,
      )
    }

    await db
      .update(schema.jobs)
      .set({ web3formsVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.jobs.id, jobId))

    await recordEvent(jobId, 'golive.forms_key_verified', {
      key: job.web3formsKeyMasked,
      testEnquirySent: verification.live,
    })
  }

  const body = await c.req
    .json<{ emailAddon?: boolean; domainAddon?: boolean; email?: string }>()
    .catch(() => ({}) as { emailAddon?: boolean; domainAddon?: boolean; email?: string })

  const user = await getUserForJob(jobId)
  const email = (body.email ?? user?.email ?? '').trim().toLowerCase()
  if (!email) return c.json({ error: 'bad_request', detail: 'No email address on this job.' }, 400)

  const db = await getDb()
  const now = new Date()

  /*
   * THE DOMAIN ANSWER DECIDES THE CART, NOT THE CHECKBOX.
   *
   * The domain question is now asked BEFORE this screen, so by the time anybody pays we already
   * know whether they said "I need one". If they did, the domain line goes in the cart whatever
   * the client sent. A customer who answers "I need a domain" and then reaches a checkout with
   * no domain on it goes live with no address, and nothing downstream would catch that: the
   * build passes, the payment clears, and the failure only surfaces as a phone call. Same rule
   * as the paid-pages check in D55 - an intention recorded on one screen must not be lost by a
   * flag on the next one.
   */
  const [recordedDomain] = await db
    .select({ branch: schema.domains.branch })
    .from(schema.domains)
    .where(eq(schema.domains.jobId, jobId))
    .orderBy(desc(schema.domains.createdAt))
    .limit(1)
  const needsDomainPurchase = recordedDomain?.branch === 'new'
  const domainAddon = Boolean(body.domainAddon) || needsDomainPurchase

  // Read the existing state BEFORE the upsert, because "the customer just pressed go live for
  // the first time" is the moment the manual flow hangs off, and the upsert erases the evidence.
  const [priorGoLive] = await db
    .select({ checkoutUrl: schema.golive.checkoutUrl })
    .from(schema.golive)
    .where(eq(schema.golive.jobId, jobId))
    .limit(1)

  let checkoutUrl: string | null = null
  let configError: { detail: string; missing: string[] } | null = null

  try {
    // checkoutHandle throws by name for a product that is not on the store, rather than putting a
    // guessed handle into a cart link that would 404 in front of a paying customer.
    const lines: CheckoutLine[] = goLiveCartLines({
      domainBranch: recordedDomain?.branch ?? null,
      domainAddon: body.domainAddon,
      emailAddon: body.emailAddon,
    })

    const checkout = await createCheckout({
      jobId,
      email,
      lines,
      returnTo: `${config().publicAppUrl}/golive/${jobId}?paid=1`,
    })
    checkoutUrl = checkout.url
  } catch (err) {
    if (err instanceof ShopifyConfigError) {
      // Not a stub and not a silent failure: the selection is saved, and the real reason the
      // link cannot be built is handed back so it shows in the UI.
      configError = { detail: err.message, missing: err.missing }
    } else if (err instanceof ProductNotOnStoreError) {
      configError = { detail: err.message, missing: [`Shopify product "${err.proposedRef}"`] }
    } else if (err instanceof Error && err.name === 'LiveActionBlockedError') {
      configError = { detail: err.message, missing: ['ENABLE_LIVE_PAYMENTS'] }
    } else {
      throw err
    }
  }

  await db
    .insert(schema.golive)
    .values({
      jobId,
      hosting: true,
      emailAddon: Boolean(body.emailAddon),
      domainAddon,
      checkoutUrl,
      checkoutCreatedAt: now,
      status: checkoutUrl ? 'awaiting_payment' : 'selecting',
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.golive.jobId,
      set: {
        emailAddon: Boolean(body.emailAddon),
        domainAddon,
        checkoutUrl,
        checkoutCreatedAt: now,
        status: checkoutUrl ? 'awaiting_payment' : 'selecting',
        updatedAt: now,
      },
    })

  await recordEvent(jobId, 'golive.requested', {
    emailAddon: Boolean(body.emailAddon),
    domainAddon,
    checkoutBuilt: Boolean(checkoutUrl),
    notify: 'chris',
  })

  /*
   * THE MANUAL GO-LIVE FLOW (DECISIONS.md D53). Deliberately manual-first for the first
   * customers: Chris is told the same minute somebody wants to go live, the customer is
   * automatically sent what they need, and /ops shows who has been waiting more than 24 hours
   * so he can ring them. Both fire once, on the FIRST press, not on every revisit of the plan
   * screen; the /ops waiting list is keyed on the first golive.requested event either way.
   *
   * The customer event fires the first time a checkout link exists (if the first press hit a
   * config error, the first successful retry sends it), so the email always carries a working
   * link. The wording rule is the brief's and applies to the Klaviyo template as much as here:
   * contact within one business day, never "connected within 24 hours".
   */
  const cfg = config()
  const intakeRow = await getIntake(jobId)
  const intakePhone = (intakeRow?.payload as { phone?: string } | null)?.phone ?? null

  if (checkoutUrl && !priorGoLive?.checkoutUrl) {
    await trackKlaviyoSafely({
      metric: 'go_live_started',
      profile: { email, businessName: job.businessName, phone: intakePhone },
      jobId,
      properties: {
        checkout_url: checkoutUrl,
        business_name: job.businessName ?? '',
        email_addon: Boolean(body.emailAddon),
        domain_addon: domainAddon,
        preview_link: previewLink(jobId),
      },
    })
  }

  if (!priorGoLive) {
    await trackKlaviyoSafely({
      metric: 'operator_alert',
      profile: { email: cfg.operatorEmail },
      jobId,
      properties: {
        alert: 'go_live_requested',
        business_name: job.businessName ?? 'Unnamed business',
        customer_email: email,
        customer_phone: intakePhone,
        wants_email_addon: Boolean(body.emailAddon),
        wants_domain_addon: domainAddon,
        checkout_built: Boolean(checkoutUrl),
        job_id: jobId,
        // Deep link, not just the list. Chris opens this from his phone and should land on the
        // customer, not on a page of cards he has to search.
        ops_link: `${cfg.publicAppUrl.replace(/\/$/, '')}/ops#job-${jobId}`,
        preview_link: previewLink(jobId),
      },
    })
  }

  if (configError) {
    return c.json(
      {
        error: 'checkout_unavailable',
        detail: configError.detail,
        missing: configError.missing,
        // The selection is stored either way, so nothing the customer chose is lost.
        saved: true,
      },
      503,
    )
  }

  return c.json({ checkoutUrl, promise: CONTACT_PROMISE })
})

/**
 * Screen 2 lookup. Runs before the customer is asked to confirm anything.
 * Brief s8 branch A: do not ask the customer where their domain is hosted, they do not know, and
 * the lookup is more reliable than the answer.
 */
app.get('/jobs/:jobId/golive/domain/inspect', async (c) => {
  try {
    return c.json({ report: await inspectDomain(c.req.query('domain') ?? '') })
  } catch (err) {
    return c.json(
      { error: 'lookup_failed', detail: err instanceof Error ? err.message : 'Domain lookup failed' },
      400,
    )
  }
})

/** Branch B helper: live availability. */
app.get('/jobs/:jobId/golive/domain/available', async (c) => {
  const result = await checkAvailability(c.req.query('domain') ?? '')
  return c.json({
    ...result,
    // auDA eligibility is collected at this point or it gets chased forever (brief s8).
    requiresAbn: requiresAuEligibility(result.domain),
  })
})

/**
 * Screen 2 action. Three branches, per brief s8.
 *   own    - they have it, we queue the connection
 *   new    - they need one, we check availability, collect auDA details, queue the purchase
 *   locked - a previous designer holds it and is not answering. Honest expectations only.
 */
app.post('/jobs/:jobId/golive/domain', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const body = await c.req
    .json<{ branch?: string; domain?: string; abn?: string; entityName?: string; registrar?: string }>()
    .catch(() => ({}) as Record<string, never>)

  const branch = body.branch
  if (branch !== 'own' && branch !== 'new' && branch !== 'locked') {
    return c.json({ error: 'bad_request', detail: 'Pick one of the three options.' }, 400)
  }

  const domain = normaliseDomain(body.domain ?? '')
  if (!domain) {
    return c.json({ error: 'bad_request', detail: 'Enter the domain like yourbusiness.com.au' }, 400)
  }

  // auDA eligibility for .au, collected now rather than chased later.
  if (branch === 'new' && requiresAuEligibility(domain)) {
    const abn = (body.abn ?? '').trim()
    const entityName = (body.entityName ?? '').trim()
    if (!isValidAbn(abn)) {
      return c.json(
        {
          error: 'eligibility_required',
          detail:
            'A .au domain needs a valid ABN. auDA will not let us register one without it, and we cannot buy it on your behalf until we have it.',
          field: 'abn',
        },
        422,
      )
    }
    if (entityName.length < 2) {
      return c.json(
        {
          error: 'eligibility_required',
          detail: 'auDA also needs the registered entity name that the ABN belongs to.',
          field: 'entityName',
        },
        422,
      )
    }
  }

  let report: unknown = null
  let mx: unknown = null
  if (branch === 'own' || branch === 'locked') {
    try {
      const inspection = await inspectDomain(domain)
      report = inspection
      mx = inspection.mx
    } catch (err) {
      // A failed lookup does not stop them going live. It becomes a note for whoever picks it up.
      report = { error: err instanceof Error ? err.message : 'lookup failed' }
    }
  }

  const db = await getDb()
  await db.insert(schema.domains).values({
    id: id('dom'),
    jobId,
    name: domain,
    branch,
    // Their answer, capped so a paste of an entire confirmation email cannot fill the column.
    registrar: (body.registrar ?? '').trim().slice(0, 120) || null,
    whois: report,
    mx,
    status: branch === 'new' ? 'purchase_queued' : branch === 'locked' ? 'recovery' : 'connection_queued',
  })

  await setJobStatus(jobId, 'go_live_pending')
  await recordEvent(jobId, 'golive.domain_submitted', {
    branch,
    domain,
    abn: branch === 'new' ? (body.abn ?? null) : null,
    entityName: branch === 'new' ? (body.entityName ?? null) : null,
    notify: 'chris',
  })

  const nextSteps: Record<typeof branch, string[]> = {
    own: [
      `We have found ${domain} and can see where it currently points.`,
      CONTACT_PROMISE,
      'Your existing email keeps working exactly as it does now. We do not touch your mail records.',
    ],
    new: [
      `We will register ${domain} for you.`,
      CONTACT_PROMISE,
      'A .au domain has to be registered against your ABN, which is why we asked for it.',
    ],
    locked: [
      `We will start tracking down who currently controls ${domain}.`,
      'We look up the registrar and the listed contacts, then approach them directly. If that goes nowhere, there is a formal complaint process with the registrar, and an auDA dispute after that.',
      // The brief is explicit: do not promise a timeframe on this branch.
      'We cannot put a timeframe on this one, because it depends on a third party responding. We will keep you posted at every step, and we can put your site live on a temporary address in the meantime so it is not sitting idle.',
    ],
  }

  return c.json({ ok: true, branch, domain, report, nextSteps: nextSteps[branch] })
})

/** Screen 3. What happens next, and what it costs each month, restated. */
app.get('/jobs/:jobId/golive/confirmation', async (c) => {
  const jobId = c.req.param('jobId')
  const [golive, domain] = await Promise.all([getGoLive(jobId), latestDomain(jobId)])

  const monthly: Array<{ label: string; price: string | null }> = [
    { label: PRICING.hosting.label, price: formatPrice('hosting') },
  ]
  if (golive?.domainAddon) {
    monthly.push({ label: PRICING.domain.label, price: formatPrice('domain') })
  }
  if (golive?.emailAddon) monthly.push({ label: PRICING.email.label, price: formatPrice('email') })

  return c.json({
    paid: Boolean(golive?.paidAt),
    monthly,
    domain: domain ? { name: domain.name, branch: domain.branch, status: domain.status } : null,
    promise: CONTACT_PROMISE,
    /*
     * WHAT HAPPENS AFTER LAUNCH, ON THE TIER THEY JUST BOUGHT.
     *
     * This used to quote the $110 post-launch edit product with "handled by our team", on the last
     * screen of the purchase flow, to a customer who had just paid for the tier that includes TEN
     * SELF-SERVE CHANGES A MONTH. It contradicted the landing page, the comparison section and the
     * product itself, and it was the final thing they read before the checkout.
     *
     * The $110 product is not retired: it is what a legacy $33 subscriber pays, because that tier
     * genuinely has no editor. It just has nothing to do with anybody arriving here.
     *
     * Taken from shared/allowance.ts so the number cannot drift from the one the editor enforces.
     */
    afterLaunch: {
      label: 'Changes after you go live',
      price: null,
      detail: `Included. You get ${LIVE_EDITS_PER_MONTH} changes a month, and you make them yourself in the same chat box you used to build it.`,
    },
  })
})

export default app
