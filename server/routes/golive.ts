import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { getDb, schema } from '../db/client'
import { PRICING, formatPrice } from '../../shared/pricing'
import { isValidAbn } from '../../shared/abn'
import { config } from '../config'
import { getJob, getUserForJob, recordEvent, setJobStatus } from '../lib/db'
import { id } from '../lib/ids'
import { ShopifyConfigError, createCheckout, type CheckoutLine } from '../lib/shopify'
import { checkAvailability, inspectDomain, normaliseDomain, requiresAuEligibility } from '../lib/domains'

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
      domain: { label: PRICING.domain.label, price: formatPrice('domain', { approx: true }), required: false },
      email: { label: PRICING.email.label, price: formatPrice('email'), required: false },
    },
    promise: CONTACT_PROMISE,
    demoMode: config().demoMode,
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

  const body = await c.req
    .json<{ emailAddon?: boolean; domainAddon?: boolean; email?: string }>()
    .catch(() => ({}) as { emailAddon?: boolean; domainAddon?: boolean; email?: string })

  const user = await getUserForJob(jobId)
  const email = (body.email ?? user?.email ?? '').trim().toLowerCase()
  if (!email) return c.json({ error: 'bad_request', detail: 'No email address on this job.' }, 400)

  const lines: CheckoutLine[] = [{ handle: PRICING.hosting.handle, quantity: 1 }]
  if (body.emailAddon) lines.push({ handle: PRICING.email.handle, quantity: 1 })
  if (body.domainAddon) lines.push({ handle: PRICING.domain.handle, quantity: 1 })

  const db = await getDb()
  const now = new Date()
  let checkoutUrl: string | null = null
  let configError: { detail: string; missing: string[] } | null = null

  try {
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
    monthly.push({ label: PRICING.domain.label, price: formatPrice('domain', { approx: true }) })
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
