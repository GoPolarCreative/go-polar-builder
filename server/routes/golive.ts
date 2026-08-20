import { Hono } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import { getDb, schema } from '../db/client.js'
import { PRICING, ProductNotOnStoreError, formatPrice } from '../../shared/pricing.js'
import { intakeSchema, type IntakePayload } from '../../shared/intake.js'
import { isValidAbn } from '../../shared/abn.js'
import type { Job } from '../../shared/types.js'
import { config, web3formsKey } from '../config.js'
import { getIntake, getJob, getUserForJob, listAssets, recordEvent, setJobStatus } from '../lib/db.js'
import { id } from '../lib/ids.js'
import { ShopifyConfigError, createCheckout, type CheckoutLine } from '../lib/shopify.js'
import { refForCheckout } from '../lib/products.js'
import { checkAvailability, inspectDomain, normaliseDomain, requiresAuEligibility } from '../lib/domains.js'
import { buildFacts } from '../lib/facts.js'
import { copyPageSet } from '../lib/buildSet.js'
import {
  applyFormsKey,
  classifyWeb3FormsKey,
  maskKey,
  verifyWeb3FormsKey,
} from '../lib/web3forms.js'

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
 * A key here means a real test submission through Web3Forms came back successful, because that is
 * the only way one gets written. Until then the site cannot go live: it would carry Go Polar's
 * key, and the tradie would never see a single enquiry from the website they just paid for.
 */
function formsKeyState(job: Job) {
  const verified = Boolean(job.web3formsKeyMasked && job.web3formsVerifiedAt)
  return {
    required: true,
    verified,
    keyMasked: job.web3formsKeyMasked,
    verifiedAt: job.web3formsVerifiedAt,
    blocksGoLive: !verified,
    // The screen is written from this, so the reason lives with the rule rather than in the UI.
    why: verified
      ? 'Your enquiry forms send to your own Web3Forms account, so enquiries come straight to you.'
      : 'Right now the enquiry forms on your website send to our account, which is fine while you are still working on it but not once it is live. Before we can put it online we need your own free Web3Forms account, so every enquiry goes straight to your inbox and nowhere else.',
    signUpUrl: 'https://web3forms.com/',
    whatToExpect: [
      'Open web3forms.com and put in the email address you want your enquiries to go to.',
      'They email you an access key straight away. It is free, and there is nothing to install.',
      'Copy that key back into the box below.',
      'We send a test enquiry through it to make sure it reaches you, then put your website live.',
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
      ? { name: domain.name, branch: domain.branch, status: domain.status, report: domain.whois }
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
 * The enquiry inbox step. Required before anything else in this flow.
 *
 * Three gates, in order, and none of them is skippable:
 *   1. the shape, with the mistake named rather than a generic rejection
 *   2. a real test submission through Web3Forms, because a valid-looking wrong key produces a
 *      site whose forms silently go nowhere, which is the worst outcome for someone paying for
 *      lead generation
 *   3. the rebuild, which must actually put their key in both forms and leave none of ours
 *
 * Nothing is written to the job until all three pass.
 */
app.post('/jobs/:jobId/golive/forms-key', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)
  if (job.currentVersion < 1) {
    return c.json({ error: 'not_ready', detail: 'There is no website built yet.' }, 409)
  }

  const body = await c.req.json<{ key?: string }>().catch(() => ({}) as { key?: string })
  const raw = body.key ?? ''

  const shape = classifyWeb3FormsKey(raw)
  if (!shape.ok || !shape.key) {
    return c.json({ error: 'invalid_key', reason: shape.reason, detail: shape.message, saved: false }, 422)
  }

  // Gate 2. Nothing is stored yet, deliberately: an unverified key in the database is a key
  // somebody will later assume was checked.
  const verification = await verifyWeb3FormsKey(
    shape.key,
    { businessName: job.businessName ?? 'your business', jobId },
    config(),
  )

  if (!verification.ok) {
    await recordEvent(jobId, 'golive.forms_key_rejected', {
      key: maskKey(shape.key),
      detail: verification.detail,
    })
    return c.json(
      { error: 'key_rejected', detail: verification.message, saved: false, tested: true },
      422,
    )
  }

  // Gate 3. Rebuild the current version with their key in place of ours. This is a deterministic
  // swap of the access_key values and nothing else, so not a word of their copy can move.
  const goPolar = web3formsKey()
  const db = await getDb()
  const current = await db
    .select()
    .from(schema.builds)
    .where(and(eq(schema.builds.jobId, jobId), eq(schema.builds.version, job.currentVersion)))
    .limit(1)

  const build = current[0]
  if (!build) return c.json({ error: 'not_found', detail: 'The current build is missing.' }, 404)

  const [stored, assets] = await Promise.all([getIntake(jobId), listAssets(jobId)])
  const parsedIntake = intakeSchema.safeParse(stored?.payload)
  if (!parsedIntake.success) {
    return c.json({ error: 'invalid_intake', detail: 'Your answers could not be read.' }, 422)
  }
  const facts = buildFacts(parsedIntake.data as IntakePayload, assets)

  const version = job.currentVersion + 1
  const customerKey = shape.key
  let formsUpdated = 0

  // EVERY PAGE, not just the home page. A service page left pointing at the Go Polar account
  // would quietly send that page's enquiries to us after the customer has gone live.
  const copied = await copyPageSet({
    jobId,
    fromVersion: job.currentVersion,
    toVersion: version,
    facts,
    transform: (pageHtml) => {
      const swapped = applyFormsKey(pageHtml, goPolar, customerKey)
      // Better to refuse than to hand back a site that says its forms were switched over when
      // one of them still is not. Returning null aborts before anything is written.
      if (swapped.replaced < 1 || !swapped.clean) return null
      formsUpdated += swapped.replaced
      return { html: swapped.html }
    },
  })

  if ('error' in copied) {
    return c.json(
      {
        error: 'rebuild_failed',
        detail: `Your key tested fine, but we could not switch it into the website cleanly, so nothing has been changed. This is our problem to fix, not yours. (${copied.error})`,
        saved: false,
      },
      500,
    )
  }

  const swap = { replaced: formsUpdated }

  // Every version needs its plan alongside it. The plan is the source of truth that rollback and
  // the discharge package both read by version, and a build with no plan beside it is a version
  // that cannot be handed over. Nothing in the plan changes here: only where the forms post.
  const currentPlan = await db
    .select({ plan: schema.plans.plan })
    .from(schema.plans)
    .where(and(eq(schema.plans.jobId, jobId), eq(schema.plans.version, job.currentVersion)))
    .limit(1)

  if (currentPlan[0]) {
    await db.insert(schema.plans).values({ id: id('pln'), jobId, version, plan: currentPlan[0].plan })
  }

  await db
    .update(schema.jobs)
    // Not an edit. The customer did not ask for a change to their website, they completed a step
    // we require, so `edits_used` is untouched.
    .set({
      customerWeb3formsKey: shape.key,
      web3formsVerifiedAt: new Date(),
      currentVersion: version,
      updatedAt: new Date(),
    })
    .where(eq(schema.jobs.id, jobId))

  await recordEvent(jobId, 'golive.forms_key_verified', {
    key: maskKey(shape.key),
    version,
    formsUpdated: swap.replaced,
    testEnquirySent: verification.live,
    notify: 'chris',
  })

  return c.json({
    ok: true,
    version,
    formsUpdated: swap.replaced,
    keyMasked: maskKey(shape.key),
    testEnquirySent: verification.live,
    detail: verification.live
      ? `Done. We sent a test enquiry through your Web3Forms account, and it went through. Both forms on your website now come to your inbox. Check your email and you should see it there.`
      : `Done. Your key is saved and both forms on your website now point at your Web3Forms account. No test enquiry was actually sent, because this install is in demo mode.`,
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
  if (!job.web3formsKeyMasked || !job.web3formsVerifiedAt) {
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

  const body = await c.req
    .json<{ emailAddon?: boolean; domainAddon?: boolean; email?: string }>()
    .catch(() => ({}) as { emailAddon?: boolean; domainAddon?: boolean; email?: string })

  const user = await getUserForJob(jobId)
  const email = (body.email ?? user?.email ?? '').trim().toLowerCase()
  if (!email) return c.json({ error: 'bad_request', detail: 'No email address on this job.' }, 400)

  const db = await getDb()
  const now = new Date()
  let checkoutUrl: string | null = null
  let configError: { detail: string; missing: string[] } | null = null

  try {
    // checkoutHandle throws by name for a product that is not on the store, rather than putting a
    // guessed handle into a cart link that would 404 in front of a paying customer.
    const lines: CheckoutLine[] = [{ ref: refForCheckout('hosting'), quantity: 1 }]
    if (body.emailAddon) lines.push({ ref: refForCheckout('email'), quantity: 1 })
    if (body.domainAddon) lines.push({ ref: refForCheckout('domain'), quantity: 1 })

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
      domainAddon: Boolean(body.domainAddon),
      checkoutUrl,
      checkoutCreatedAt: now,
      status: checkoutUrl ? 'awaiting_payment' : 'selecting',
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.golive.jobId,
      set: {
        emailAddon: Boolean(body.emailAddon),
        domainAddon: Boolean(body.domainAddon),
        checkoutUrl,
        checkoutCreatedAt: now,
        status: checkoutUrl ? 'awaiting_payment' : 'selecting',
        updatedAt: now,
      },
    })

  await recordEvent(jobId, 'golive.requested', {
    emailAddon: Boolean(body.emailAddon),
    domainAddon: Boolean(body.domainAddon),
    checkoutBuilt: Boolean(checkoutUrl),
    notify: 'chris',
  })

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
    .json<{ branch?: string; domain?: string; abn?: string; entityName?: string }>()
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
    afterLaunch: {
      label: PRICING.postLiveEdit.label,
      price: formatPrice('postLiveEdit'),
      detail: 'Changes after you are live are handled by our team.',
    },
  })
})

export default app
