import { Hono } from 'hono'
import type { Env } from '../env'
import { PRICING, formatPrice } from '../../shared/pricing'
import { getJob, recordEvent, setJobStatus } from '../lib/db'
import { id, nowIso } from '../lib/ids'
import { ShopifyConfigError, createCheckout, type CheckoutLine } from '../lib/shopify'
import {
  checkAvailability,
  inspectDomain,
  normaliseDomain,
  requiresAuEligibility,
} from '../lib/domains'
import { isValidAbn } from '../../shared/abn'

const app = new Hono<{ Bindings: Env }>()

/**
 * Phase 5, brief s8. Go live.
 *
 * Screen 1 is the plan and the payment. Screen 2 is the domain, in three branches. Screen 3 is
 * the confirmation. The job does not advance past screen 1 until Shopify confirms the payment.
 *
 * The wording rule from the brief is enforced in the copy below: contact within one business
 * day, never a promise that the domain will be connected within any timeframe. Transfers,
 * registrar locks and uncooperative third parties are outside Go Polar's control.
 */

const CONTACT_PROMISE = 'One of our team will be in touch within one business day to get it connected.'

async function getGoLive(env: Env, jobId: string) {
  return env.DB.prepare('SELECT * FROM golive WHERE job_id = ?')
    .bind(jobId)
    .first<{
      job_id: string
      hosting: number
      email_addon: number
      domain_addon: number
      checkout_url: string | null
      paid_at: string | null
      status: string
    }>()
}

/** Screen 1: what it costs to keep the website online, and what they have chosen so far. */
app.get('/jobs/:jobId/golive', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(c.env, jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const [golive, domain] = await Promise.all([
    getGoLive(c.env, jobId),
    c.env.DB.prepare('SELECT * FROM domains WHERE job_id = ? ORDER BY created_at DESC LIMIT 1')
      .bind(jobId)
      .first<{ name: string; branch: string; status: string; whois_json: string | null }>(),
  ])

  return c.json({
    jobStatus: job.status,
    currentVersion: job.current_version,
    selection: golive
      ? {
          hosting: golive.hosting === 1,
          emailAddon: golive.email_addon === 1,
          domainAddon: golive.domain_addon === 1,
          status: golive.status,
          checkoutUrl: golive.checkout_url,
          paidAt: golive.paid_at,
        }
      : null,
    domain: domain
      ? {
          name: domain.name,
          branch: domain.branch,
          status: domain.status,
          report: domain.whois_json ? JSON.parse(domain.whois_json) : null,
        }
      : null,
    // Prices come from one place and always carry the GST label.
    pricing: {
      hosting: { label: PRICING.hosting.label, price: formatPrice('hosting'), required: true },
      domain: { label: PRICING.domain.label, price: formatPrice('domain', { approx: true }), required: false },
      email: { label: PRICING.email.label, price: formatPrice('email'), required: false },
    },
    promise: CONTACT_PROMISE,
  })
})

/**
 * Screen 1 action. Builds the Shopify checkout for hosting plus whatever add-ons were chosen.
 *
 * Hosting must not start billing at build-token purchase (brief s3a). It starts here, at go
 * live, and the job only advances when the orders/paid webhook confirms this checkout.
 */
app.post('/jobs/:jobId/golive/plan', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(c.env, jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)
  if (job.current_version < 1) {
    return c.json({ error: 'not_ready', detail: 'There is no website built yet.' }, 409)
  }

  const body = await c.req
    .json<{ emailAddon?: boolean; domainAddon?: boolean; email?: string }>()
    .catch(() => ({}) as { emailAddon?: boolean; domainAddon?: boolean; email?: string })

  const user = await c.env.DB.prepare('SELECT email FROM users WHERE id = ?')
    .bind(job.user_id)
    .first<{ email: string }>()
  const email = (body.email ?? user?.email ?? '').trim().toLowerCase()
  if (!email) return c.json({ error: 'bad_request', detail: 'No email address on this job.' }, 400)

  const lines: CheckoutLine[] = [{ handle: PRICING.hosting.handle, quantity: 1 }]
  if (body.emailAddon) lines.push({ handle: PRICING.email.handle, quantity: 1 })
  if (body.domainAddon) lines.push({ handle: PRICING.domain.handle, quantity: 1 })

  const now = nowIso()
  let checkoutUrl: string | null = null
  let configError: { detail: string; missing: string[] } | null = null

  try {
    const checkout = await createCheckout(c.env, {
      jobId,
      email,
      lines,
      returnTo: `${c.env.PUBLIC_APP_URL ?? ''}/golive/${jobId}?paid=1`,
    })
    checkoutUrl = checkout.url
  } catch (err) {
    if (err instanceof ShopifyConfigError) {
      // Not a stub and not a silent failure: the selection is saved, and the real reason the
      // link cannot be built is handed back so it shows in the UI.
      configError = { detail: err.message, missing: err.missing }
    } else {
      throw err
    }
  }

  await c.env.DB.prepare(
    `INSERT INTO golive (job_id, hosting, email_addon, domain_addon, checkout_url, checkout_created_at, status, created_at, updated_at)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET
       email_addon = excluded.email_addon,
       domain_addon = excluded.domain_addon,
       checkout_url = excluded.checkout_url,
       checkout_created_at = excluded.checkout_created_at,
       status = excluded.status,
       updated_at = excluded.updated_at`,
  )
    .bind(
      jobId,
      body.emailAddon ? 1 : 0,
      body.domainAddon ? 1 : 0,
      checkoutUrl,
      now,
      checkoutUrl ? 'awaiting_payment' : 'selecting',
      now,
      now,
    )
    .run()

  await recordEvent(c.env, jobId, 'golive.requested', {
    emailAddon: Boolean(body.emailAddon),
    domainAddon: Boolean(body.domainAddon),
    checkoutBuilt: Boolean(checkoutUrl),
    notify: 'chris',
  })

  if (configError) {
    return c.json(
      {
        error: 'shopify_not_configured',
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
 * Brief s8 branch A: do not ask the customer where their domain is hosted, they do not know,
 * and the lookup is more reliable than the answer.
 */
app.get('/jobs/:jobId/golive/domain/inspect', async (c) => {
  const input = c.req.query('domain') ?? ''
  try {
    const report = await inspectDomain(input)
    return c.json({ report })
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
  const job = await getJob(c.env, jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const body = await c.req
    .json<{ branch?: string; domain?: string; abn?: string; entityName?: string; confirmed?: boolean }>()
    .catch(() => ({}) as Record<string, never>)

  const branch = body.branch
  if (branch !== 'own' && branch !== 'new' && branch !== 'locked') {
    return c.json({ error: 'bad_request', detail: 'Pick one of the three options.' }, 400)
  }

  const domain = normaliseDomain(body.domain ?? '')
  if (!domain) {
    return c.json(
      { error: 'bad_request', detail: 'Enter the domain like yourbusiness.com.au' },
      400,
    )
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

  const now = nowIso()
  await c.env.DB.prepare(
    `INSERT INTO domains (id, job_id, name, branch, whois_json, mx_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id('dom'),
      jobId,
      domain,
      branch,
      report ? JSON.stringify(report) : null,
      mx ? JSON.stringify(mx) : null,
      branch === 'new' ? 'purchase_queued' : branch === 'locked' ? 'recovery' : 'connection_queued',
      now,
    )
    .run()

  if (branch === 'new') {
    await c.env.DB.prepare('UPDATE users SET name = COALESCE(name, ?) WHERE id = ?')
      .bind(body.entityName ?? null, job.user_id)
      .run()
  }

  await setJobStatus(c.env, jobId, 'go_live_pending')
  await recordEvent(c.env, jobId, 'golive.domain_submitted', {
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
  const [golive, domain] = await Promise.all([
    getGoLive(c.env, jobId),
    c.env.DB.prepare('SELECT name, branch, status FROM domains WHERE job_id = ? ORDER BY created_at DESC LIMIT 1')
      .bind(jobId)
      .first<{ name: string; branch: string; status: string }>(),
  ])

  const monthly: Array<{ label: string; price: string | null }> = [
    { label: PRICING.hosting.label, price: formatPrice('hosting') },
  ]
  if (golive?.domain_addon === 1) {
    monthly.push({ label: PRICING.domain.label, price: formatPrice('domain', { approx: true }) })
  }
  if (golive?.email_addon === 1) {
    monthly.push({ label: PRICING.email.label, price: formatPrice('email') })
  }

  return c.json({
    paid: Boolean(golive?.paid_at),
    monthly,
    domain: domain ?? null,
    promise: CONTACT_PROMISE,
    afterLaunch: {
      label: PRICING.postLiveEdit.label,
      price: formatPrice('postLiveEdit'),
      detail: 'Changes after you are live are handled by our team.',
    },
  })
})

export default app
