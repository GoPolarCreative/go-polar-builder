import { Hono } from 'hono'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { getDb, schema } from '../db/client.js'
import { requireAdmin } from '../lib/auth.js'
import { config } from '../config.js'
import { ShopifyAuthError, ensureStorefrontToken } from '../lib/shopifyAuth.js'
import { attachDomain, publishSite } from '../lib/publish.js'
import { loadPageSet } from '../lib/buildSet.js'
import { storage } from '../lib/storage.js'
import { buildFacts } from '../lib/facts.js'
import { getIntake, listAssets, recordEvent } from '../lib/db.js'
import { buildDischargePackage } from '../lib/discharge.js'
import { toBody } from '../lib/storage.js'
import type { ContentPlan } from '../../shared/plan.js'
import { intakeSchema, type IntakePayload } from '../../shared/intake.js'

const app = new Hono()

/**
 * Operator diagnostics. Guarded by ADMIN_TOKEN, never reachable by a customer.
 *
 * WHY THIS EXISTS. The smoke test after deployment is "buy the build product with a real card and
 * see whether a link arrives in your inbox". When it does arrive, everything worked. When it does
 * not, that single fact says nothing useful: the webhook might never have fired, or fired and been
 * rejected for a bad signature, or been accepted but matched no product, or created the job
 * perfectly and then failed to send the email. Four very different problems with four different
 * fixes, and one symptom.
 *
 * So this walks the same four steps in order and reports each independently, with the reason and
 * the next thing to check. It reads the event log, which every stage of that path already writes
 * to, rather than adding new instrumentation that could itself be wrong.
 */

app.use('/admin/*', requireAdmin)

type StepStatus = 'ok' | 'failed' | 'waiting'

interface TraceStep {
  step: number
  name: string
  status: StepStatus
  detail: string
  /** What to do about it. Only present when something is wrong. */
  fix?: string
  at?: string
}

/** Most recent event of any of these types, optionally for one job. */
async function lastEvent(types: string[], jobId?: string) {
  const db = await getDb()
  const rows = await db
    .select()
    .from(schema.events)
    .where(
      jobId
        ? and(inTypes(types), eq(schema.events.jobId, jobId))
        : inTypes(types),
    )
    .orderBy(desc(schema.events.createdAt))
    .limit(1)
  return rows[0] ?? null
}

function inTypes(types: string[]) {
  return sql`${schema.events.type} in ${types}`
}

/**
 * Walk the purchase-to-build-link path and report every step separately.
 *
 *   GET /api/admin/trace?email=you@example.com
 *
 * The email is the one used at the Shopify checkout. Without it the first two steps still work,
 * because they are about webhooks arriving at all rather than about one order.
 */
app.get('/admin/trace', async (c) => {
  const db = await getDb()
  const email = (c.req.query('email') ?? '').trim().toLowerCase()
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const steps: TraceStep[] = []

  // --- 1. did a webhook arrive at all -----------------------------------------------------------
  const anyWebhook = await lastEvent([
    'webhook.received',
    'webhook.rejected',
    'webhook.refused',
    'webhook.failed',
  ])

  if (!anyWebhook) {
    steps.push({
      step: 1,
      name: 'Shopify sent the webhook',
      status: 'waiting',
      detail: 'No webhook of any kind has ever reached this deployment.',
      fix: 'Shopify admin, Settings, Notifications, Webhooks. Check the orders/paid webhook exists and points at https://build.itscold.com.au/api/webhooks/shopify. That page also lists recent delivery attempts and their response codes: a 404 means the URL is wrong, a timeout means the deployment is down.',
    })
  } else {
    steps.push({
      step: 1,
      name: 'Shopify sent the webhook',
      status: 'ok',
      detail: `Last webhook activity was "${anyWebhook.type}".`,
      at: anyWebhook.createdAt.toISOString(),
    })
  }

  // --- 2. was it accepted -----------------------------------------------------------------------
  const refused = await lastEvent(['webhook.refused'])
  const rejected = await lastEvent(['webhook.rejected'])
  const received = await lastEvent(['webhook.received'])

  const newest = [refused, rejected, received]
    .filter(Boolean)
    .sort((a, b) => b!.createdAt.getTime() - a!.createdAt.getTime())[0]

  if (!newest) {
    steps.push({
      step: 2,
      name: 'Signature verified',
      status: 'waiting',
      detail: 'Nothing to verify yet, because no webhook has arrived.',
    })
  } else if (newest.type === 'webhook.rejected') {
    steps.push({
      step: 2,
      name: 'Signature verified',
      status: 'failed',
      detail: 'A webhook arrived and its HMAC signature did not match, so it was refused.',
      fix: 'SHOPIFY_WEBHOOK_SECRET in Vercel does not match the signing secret Shopify shows for this webhook. Copy it again from the webhook in Shopify admin, set it in Vercel, and redeploy so the function picks it up.',
      at: newest.createdAt.toISOString(),
    })
  } else if (newest.type === 'webhook.refused') {
    const reason = (newest.payload as { reason?: string } | null)?.reason ?? 'unknown'
    steps.push({
      step: 2,
      name: 'Signature verified',
      status: 'failed',
      detail: `The webhook was refused before verification: ${reason}.`,
      fix:
        reason === 'demo_mode'
          ? 'This deployment is still in demo mode, where webhooks are inert on purpose. Set DEMO_MODE=0 in Vercel and redeploy.'
          : 'SHOPIFY_WEBHOOK_SECRET is not set, so webhooks cannot be verified and are refused rather than trusted. Set it in Vercel and redeploy.',
      at: newest.createdAt.toISOString(),
    })
  } else {
    steps.push({
      step: 2,
      name: 'Signature verified',
      status: 'ok',
      detail: 'A webhook arrived and its signature matched.',
      at: newest.createdAt.toISOString(),
    })
  }

  // --- 3. did it become a user and a job --------------------------------------------------------
  let jobId: string | null = null

  const upstreamOk = steps.every((s) => s.status === 'ok')

  if (!upstreamOk) {
    steps.push({
      step: 3,
      name: 'Job created',
      status: 'waiting',
      detail: 'Nothing got this far, because the webhook did not arrive or was not accepted.',
    })
  } else if (!email) {
    steps.push({
      step: 3,
      name: 'Job created',
      status: 'waiting',
      detail: 'Pass ?email= the address used at the Shopify checkout to check this step.',
    })
  } else {
    const users = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1)
    const user = users[0]
    const jobs = user
      ? await db
          .select()
          .from(schema.jobs)
          .where(eq(schema.jobs.userId, user.id))
          .orderBy(desc(schema.jobs.createdAt))
          .limit(1)
      : []
    jobId = jobs[0]?.id ?? null

    if (jobId) {
      steps.push({
        step: 3,
        name: 'Job created',
        status: 'ok',
        detail: `Job ${jobId} exists for ${email}, status "${jobs[0]!.status}".`,
        at: jobs[0]!.createdAt.toISOString(),
      })
    } else {
      // A webhook that arrived and verified but produced no job means the line items did not match
      // any product this app knows about, which is the interesting failure.
      const unmatched = await lastEvent(['order.unmatched', 'order.unmatched_line'])
      const recentUnmatched =
        unmatched && unmatched.createdAt >= since
          ? (unmatched.payload as { title?: string; ref?: string; reason?: string } | null)
          : null

      steps.push({
        step: 3,
        name: 'Job created',
        status: 'failed',
        detail: recentUnmatched
          ? `No job for ${email}. An order arrived but a line item matched no known product: ${JSON.stringify(recentUnmatched)}.`
          : `No user or job exists for ${email}.`,
        fix: recentUnmatched
          ? 'The purchased product is not one this app recognises. Check the SKU on the Shopify product is exactly build-token, and that its variant id matches what is recorded. See SHOPIFY-SETUP.md.'
          : 'If steps 1 and 2 passed, the order carried a different email to the one given here. Check the order in Shopify. If they passed and the email is right, look at the Vercel function logs for the webhook request.',
      })
    }
  }

  // --- 4. did the build link email go out -------------------------------------------------------
  const sent = await lastEvent(['email.sent'], jobId ?? undefined)
  const failed = await lastEvent(['email.failed'], jobId ?? undefined)
  const newestEmail = [sent, failed]
    .filter(Boolean)
    .sort((a, b) => b!.createdAt.getTime() - a!.createdAt.getTime())[0]

  if (!jobId) {
    steps.push({
      step: 4,
      name: 'Build link emailed',
      status: 'waiting',
      detail: 'No job to send anything for yet.',
    })
  } else if (!newestEmail) {
    steps.push({
      step: 4,
      name: 'Build link emailed',
      status: 'failed',
      detail: 'The job exists but no send was ever attempted for it.',
      fix: 'Look at the Vercel function logs for the webhook request. The job was created, so the failure is after that point.',
    })
  } else if (newestEmail.type === 'email.sent') {
    steps.push({
      step: 4,
      name: 'Build link emailed',
      status: 'ok',
      detail: `Resend accepted the message for ${(newestEmail.payload as { to?: string } | null)?.to ?? email}. If it is not in the inbox, check spam and then check Resend's own delivery log.`,
      at: newestEmail.createdAt.toISOString(),
    })
  } else {
    const payload = newestEmail.payload as { error?: string; kind?: string } | null
    steps.push({
      step: 4,
      name: 'Build link emailed',
      status: 'failed',
      detail: `The send failed: ${payload?.error ?? 'no reason recorded'}`,
      fix: /RESEND_API_KEY/.test(payload?.error ?? '')
        ? 'RESEND_API_KEY is not set in Vercel.'
        : /ENABLE_LIVE_EMAIL/.test(payload?.error ?? '')
          ? 'ENABLE_LIVE_EMAIL is not set to 1, so email is deliberately blocked. Set it in Vercel and redeploy.'
          : 'Usually the sending domain is not verified in Resend. Check the domain on RESEND_FROM is verified there. The hourly sweep retries failed sends, so it may still arrive.',
      at: newestEmail.createdAt.toISOString(),
    })
  }

  // The earliest step that is not ok, which is the one worth acting on. A later step reading
  // "waiting" is a consequence of this one, not a second problem.
  const stopped = steps.find((s) => s.status !== 'ok')

  return c.json({
    email: email || null,
    jobId,
    verdict: !stopped
      ? 'The whole path worked.'
      : stopped.status === 'failed'
        ? `Broke at step ${stopped.step}: ${stopped.name}. ${stopped.fix ?? ''}`.trim()
        : `Stopped at step ${stopped.step}: ${stopped.name}. ${stopped.detail}`,
    steps,
    demoMode: config().demoMode,
  })
})

/**
 * The raw event log, newest first. For anything the trace does not cover.
 *
 *   GET /api/admin/events?limit=50&type=email.failed&job=job_xxx
 */
/**
 * Put a paid site on the internet.
 *
 *   POST /api/admin/publish  { "jobId": "...", "hostname": "example.com.au" }
 *
 * The operator step between "they paid for hosting" and "their website answers on their domain".
 * It is deliberately not automatic: the hostname has to be one somebody has actually pointed at
 * us, and nothing here can check that a DNS record exists before it is made.
 *
 * THREE THINGS ARE REFUSED RATHER THAN WARNED ABOUT.
 *   1. Hosting not paid. Publishing first means serving a site nobody is being billed for.
 *   2. The Web3Forms key not verified. A live site posting to the Go Polar account sends the
 *      customer's enquiries to us, which is the single worst failure this product can have.
 *      publishSite asserts this again per page; this is the earlier, friendlier refusal.
 *   3. A build that did not pass its checks. Passing is what "finished" means here.
 *
 * The whole page set goes live together, along with its sitemap and robots file, because half a
 * site is worse than none: internal links would 404 on the pages that did not make it.
 */
app.post('/admin/publish', async (c) => {
  type PublishBody = { jobId?: string; hostname?: string; force?: boolean }
  const body = await c.req.json<PublishBody>().catch(() => ({}) as PublishBody)
  const jobId = (body.jobId ?? '').trim()
  const hostname = (body.hostname ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')

  if (!jobId || !hostname) {
    return c.json({ error: 'bad_request', detail: 'Send both jobId and hostname.' }, 400)
  }

  const db = await getDb()
  const [jobRow] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1)
  if (!jobRow) return c.json({ error: 'not_found', detail: `No job ${jobId}` }, 404)

  const [goliveRow] = await db.select().from(schema.golive).where(eq(schema.golive.jobId, jobId)).limit(1)
  if (!goliveRow?.paidAt && !body.force) {
    return c.json(
      { error: 'not_paid', detail: 'Hosting has not been paid for on this job. Pass force:true only if you have taken payment another way.' },
      409,
    )
  }

  if (!jobRow.web3formsVerifiedAt) {
    return c.json(
      {
        error: 'forms_key_unverified',
        detail:
          'This job has no verified Web3Forms key, so its forms still post to the Go Polar account. The customer completes this on the go-live screen. Publishing is blocked until they do.',
      },
      409,
    )
  }

  const version = jobRow.currentVersion
  const [buildRow] = await db
    .select()
    .from(schema.builds)
    .where(and(eq(schema.builds.jobId, jobId), eq(schema.builds.version, version)))
    .limit(1)
  if (!buildRow) return c.json({ error: 'not_found', detail: `Job ${jobId} has no build at version ${version}.` }, 404)
  if (!buildRow.passed && !body.force) {
    return c.json(
      { error: 'checks_failed', detail: `Version ${version} did not pass its checks. Fix it, or pass force:true to publish anyway.` },
      409,
    )
  }

  const [planRow] = await db
    .select({ plan: schema.plans.plan })
    .from(schema.plans)
    .where(and(eq(schema.plans.jobId, jobId), eq(schema.plans.version, version)))
    .limit(1)
  if (!planRow) return c.json({ error: 'not_found', detail: 'That version has no plan stored beside it.' }, 404)

  const [stored, assets] = await Promise.all([getIntake(jobId), listAssets(jobId)])
  const parsed = intakeSchema.safeParse(stored?.payload)
  if (!parsed.success) return c.json({ error: 'invalid_intake', detail: 'The stored answers could not be read.' }, 422)
  const facts = buildFacts(parsed.data as IntakePayload, assets)

  const set = await loadPageSet(jobId, version)
  const store = storage()

  const home = set.find((p) => p.path === 'index.html')
  const homeHtml = await store.getText(home ? home.blobKey : buildRow.blobKey)
  if (homeHtml === null) return c.json({ error: 'not_found', detail: 'The home page is missing from storage.' }, 404)

  const extraPages: Array<{ path: string; html: string }> = []
  for (const page of set.filter((p) => p.path !== 'index.html')) {
    const html = await store.getText(page.blobKey)
    if (html === null) {
      return c.json({ error: 'page_missing', detail: `${page.path} is missing from storage, so nothing was published.` }, 409)
    }
    extraPages.push({ path: page.path, html })
  }

  const extraFiles: Array<{ path: string; content: string; contentType: string }> = []
  if (extraPages.length > 0) {
    for (const [path, contentType] of [
      ['sitemap.xml', 'application/xml; charset=utf-8'],
      ['robots.txt', 'text/plain; charset=utf-8'],
    ] as const) {
      const content = await store.getText(`jobs/${jobId}/builds/v${version}/${path}`)
      if (content !== null) extraFiles.push({ path, content, contentType })
    }
  }

  try {
    const result = await publishSite({
      jobId,
      hostname,
      version,
      html: homeHtml,
      facts,
      extraPages,
      extraFiles,
    })

    const attached = await attachDomain(hostname, jobId)

    return c.json({
      ok: true,
      ...result,
      urls: [`https://${hostname}/`, ...extraPages.map((p) => `https://${hostname}/${p.path.replace(/index.html$/, '')}`)],
      domain: attached,
      note: attached.ok
        ? 'Published. The domain still needs its DNS pointed here before anyone can reach it.'
        : `Published, but the domain was not attached: ${attached.detail}`,
    })
  } catch (err) {
    // assertNoGoPolarKey throws here. That is the whole point of it and it must not be softened.
    return c.json(
      { error: 'publish_refused', detail: err instanceof Error ? err.message : 'Publishing was refused.' },
      409,
    )
  }
})

/**
 * Mint or fetch the Storefront API token.
 *
 *   POST /api/admin/storefront-token
 *
 * In the Dev Dashboard world there is no page showing a Storefront token, so it has to be created
 * through the Admin API. It inherits the app's unauthenticated scopes, which is why the app version
 * has to carry unauthenticated_write_checkouts before this can work. See DEPLOY.md section 6.
 *
 * The token is returned so it can be pasted into Vercel. It is not stored: a value read from the
 * environment on every boot is one that can be rotated by changing one setting, and a value this
 * app wrote into its own database is one nobody can find later.
 */
app.post('/admin/storefront-token', async (c) => {
  try {
    const result = await ensureStorefrontToken()
    return c.json({
      ok: true,
      token: result.token,
      created: result.created,
      scopes: result.scopes,
      detail: result.created
        ? 'Created a new Storefront access token. Set it in Vercel as SHOPIFY_STOREFRONT_TOKEN and redeploy.'
        : 'This app already had a Storefront access token, so it was reused rather than spending another of the 100 allowed. Set it in Vercel as SHOPIFY_STOREFRONT_TOKEN and redeploy.',
      warning: result.scopes.includes('unauthenticated_write_checkouts')
        ? null
        : `This token's scopes are "${result.scopes}", which does not include unauthenticated_write_checkouts. Multi-subscription checkouts will still be refused. Release a new app version with that scope, approve it on the store, then delete this token in Shopify and run this again.`,
    })
  } catch (err) {
    if (err instanceof ShopifyAuthError) {
      return c.json({ error: 'shopify_auth', detail: err.message, fix: err.fix }, 409)
    }
    return c.json({ error: 'failed', detail: err instanceof Error ? err.message : String(err) }, 500)
  }
})

/**
 * The worklist. Who is waiting on Chris, and for what.
 *
 *   GET /api/admin/queue
 *
 * The operating model is not "the app runs the customer's website". It is: the customer builds,
 * pays for hosting, and Chris takes the files and puts them live the same way he already does for
 * every other client site. So the app's last job is to say clearly whose site is finished and paid
 * for and what it still needs, rather than leaving that to an inbox.
 *
 * Paid-but-blocked is listed separately and first, because those customers have handed over money
 * and can see nothing happening.
 */
app.get('/admin/queue', async (c) => {
  const db = await getDb()

  const rows = await db
    .select({
      jobId: schema.jobs.id,
      businessName: schema.jobs.businessName,
      status: schema.jobs.status,
      version: schema.jobs.currentVersion,
      held: schema.jobs.held,
      heldReason: schema.jobs.heldReason,
      editsUsed: schema.jobs.editsUsed,
      editsAllowed: schema.jobs.editsAllowed,
      pagesAllowed: schema.jobs.pagesAllowed,
      formsKeyVerifiedAt: schema.jobs.web3formsVerifiedAt,
      email: schema.users.email,
      updatedAt: schema.jobs.updatedAt,
      hostingPaidAt: schema.golive.paidAt,
      hosting: schema.golive.hosting,
      emailAddon: schema.golive.emailAddon,
      domainAddon: schema.golive.domainAddon,
    })
    .from(schema.jobs)
    .innerJoin(schema.users, eq(schema.users.id, schema.jobs.userId))
    .leftJoin(schema.golive, eq(schema.golive.jobId, schema.jobs.id))
    .orderBy(desc(schema.jobs.updatedAt))
    .limit(100)

  const domainRows = await db.select().from(schema.domains).orderBy(desc(schema.domains.createdAt))
  const domainFor = new Map<string, (typeof domainRows)[number]>()
  for (const row of domainRows) if (!domainFor.has(row.jobId)) domainFor.set(row.jobId, row)

  const jobs = rows.map((row) => {
    const domain = domainFor.get(row.jobId) ?? null

    // What is stopping this one going live, in the order it has to be fixed. An empty list means
    // it is ready for you to take the files.
    const blockers: string[] = []
    if (row.version < 1) blockers.push('They have not built anything yet.')
    if (row.held) blockers.push(`Held: ${row.heldReason ?? 'verification failed twice'}. Needs a look.`)
    if (!row.hostingPaidAt) blockers.push('Hosting has not been paid for.')
    if (!row.formsKeyVerifiedAt) {
      blockers.push(
        'No verified Web3Forms key, so the forms still post to the Go Polar account. They do this themselves on the go-live screen. Do not put the site live without it.',
      )
    }

    return {
      jobId: row.jobId,
      businessName: row.businessName,
      email: row.email,
      status: row.status,
      version: row.version,
      pagesAllowed: row.pagesAllowed,
      editsLeft: row.editsAllowed - row.editsUsed,
      wants: {
        hosting: Boolean(row.hosting),
        email: Boolean(row.emailAddon),
        domain: Boolean(row.domainAddon),
        domainName: domain?.name ?? null,
        domainBranch: domain?.branch ?? null,
      },
      hostingPaidAt: row.hostingPaidAt?.toISOString() ?? null,
      formsKeyVerified: Boolean(row.formsKeyVerifiedAt),
      readyForYou: blockers.length === 0,
      blockers,
      files: blockers.length === 0 ? `/api/admin/jobs/${row.jobId}/files` : null,
      updatedAt: row.updatedAt.toISOString(),
    }
  })

  const ready = jobs.filter((j) => j.readyForYou)
  const paidButBlocked = jobs.filter((j) => !j.readyForYou && j.hostingPaidAt)

  return c.json({
    summary: {
      readyToTakeLive: ready.length,
      paidButBlocked: paidButBlocked.length,
      total: jobs.length,
    },
    paidButBlocked,
    ready,
    all: jobs,
  })
})

/**
 * Download a customer's finished website as a zip, as the operator.
 *
 *   GET /api/admin/jobs/:jobId/files
 *
 * The same package the paid discharge produces, and deliberately the same code, so what Chris
 * pushes to GitHub is byte for byte what a customer paying $330 would have received. Two
 * differences: it is not gated on a discharge purchase, and it marks nothing as discharged,
 * because this is Chris hosting their site rather than a customer leaving.
 *
 * The Web3Forms key is still swapped for the customer's own. That is not optional: a site put live
 * carrying the Go Polar key sends the customer's enquiries to us. This refuses by default when
 * there is no verified key, and says which key went in either way.
 */
app.get('/admin/jobs/:jobId/files', async (c) => {
  const jobId = c.req.param('jobId')
  const db = await getDb()

  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1)
  if (!job) return c.json({ error: 'not_found', detail: `No job ${jobId}` }, 404)
  if (job.currentVersion < 1) {
    return c.json({ error: 'nothing_built', detail: 'This job has no build yet.' }, 409)
  }

  if (!job.web3formsVerifiedAt && c.req.query('allowGoPolarKey') !== 'yes') {
    return c.json(
      {
        error: 'forms_key_unverified',
        detail:
          'This customer has not verified their own Web3Forms key, so their enquiry forms would post to the Go Polar account. Ask them to finish the go-live screen first. Add ?allowGoPolarKey=yes to download anyway, which ships a clearly commented placeholder instead of any real key.',
      },
      409,
    )
  }

  const version = job.currentVersion
  const [planRow] = await db
    .select({ plan: schema.plans.plan })
    .from(schema.plans)
    .where(and(eq(schema.plans.jobId, jobId), eq(schema.plans.version, version)))
    .limit(1)
  if (!planRow) {
    return c.json({ error: 'not_found', detail: 'That version has no plan stored beside it.' }, 404)
  }

  const [stored, assets] = await Promise.all([getIntake(jobId), listAssets(jobId)])
  const parsed = intakeSchema.safeParse(stored?.payload)
  if (!parsed.success) return c.json({ error: 'invalid_intake' }, 422)
  const facts = buildFacts(parsed.data as IntakePayload, assets)

  const store = storage()
  const set = await loadPageSet(jobId, version)
  const home = set.find((pg) => pg.path === 'index.html')
  const homeKey = home ? home.blobKey : `jobs/${jobId}/builds/v${version}/index.html`
  const homeHtml = await store.getText(homeKey)
  if (homeHtml === null) {
    return c.json({ error: 'not_found', detail: 'The home page is missing from storage.' }, 404)
  }

  const extraPages: Array<{ path: string; html: string }> = []
  for (const page of set.filter((pg) => pg.path !== 'index.html')) {
    const html = await store.getText(page.blobKey)
    if (html === null) {
      return c.json({ error: 'page_missing', detail: `${page.path} is missing from storage.` }, 409)
    }
    extraPages.push({ path: page.path, html })
  }

  const extraFiles: Array<{ path: string; content: string }> = []
  if (extraPages.length > 0) {
    for (const name of ['sitemap.xml', 'robots.txt']) {
      const content = await store.getText(`jobs/${jobId}/builds/v${version}/${name}`)
      if (content !== null) extraFiles.push({ path: name, content })
    }
  }

  const pkg = await buildDischargePackage({
    jobId,
    html: homeHtml,
    plan: planRow.plan as ContentPlan,
    facts,
    customerWeb3FormsKey: job.customerWeb3formsKey,
    extraPages,
    extraFiles,
  })

  await recordEvent(jobId, 'files.downloaded_by_operator', {
    version,
    pages: set.length,
    keySwapped: pkg.keySwapped,
  })

  const slug = (job.businessName ?? 'website')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return new Response(toBody(Buffer.from(pkg.zip)), {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${slug}-v${version}.zip"`,
      'content-length': String(pkg.zip.byteLength),
      // Visible from the download alone: whose key is in these files.
      'x-forms-key': pkg.keySwapped ? 'customer' : 'placeholder',
      'x-pages': String(set.length),
    },
  })
})

app.get('/admin/events', async (c) => {
  const db = await getDb()
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200)
  const type = c.req.query('type')
  const job = c.req.query('job')
  const hours = Number(c.req.query('hours') ?? 24)

  const filters = [gte(schema.events.createdAt, new Date(Date.now() - hours * 60 * 60 * 1000))]
  if (type) filters.push(eq(schema.events.type, type))
  if (job) filters.push(eq(schema.events.jobId, job))

  const rows = await db
    .select()
    .from(schema.events)
    .where(and(...filters))
    .orderBy(desc(schema.events.createdAt))
    .limit(limit)

  return c.json({
    count: rows.length,
    events: rows.map((r) => ({
      at: r.createdAt.toISOString(),
      type: r.type,
      jobId: r.jobId,
      payload: r.payload,
    })),
  })
})

export default app
