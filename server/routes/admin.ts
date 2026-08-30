import { Hono } from 'hono'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { getDb, schema } from '../db/client.js'
import { buildLink, createBuildToken, requireAdmin } from '../lib/auth.js'
import { config } from '../config.js'
import { KLAVIYO_METRICS, trackKlaviyoSafely, type KlaviyoMetric } from '../lib/klaviyo.js'
import { klaviyoHealth } from '../lib/klaviyoHealth.js'
import { TAKEDOWN_DAYS, daysUntilTakedown, takedownDueAt } from '../../shared/takedown.js'
import { ShopifyAuthError, ensureStorefrontToken } from '../lib/shopifyAuth.js'
import { attachDomain } from '../lib/publish.js'
import { liveHostnameFor, normaliseHostname, previousPublishedVersion, publishJob } from '../lib/publishJob.js'
import { loadPageSet, persistPageSet } from '../lib/buildSet.js'
import { enforcePlanInvariants } from '../lib/generate.js'
import { verify } from '../lib/verify.js'
import { id } from '../lib/ids.js'
import { storage } from '../lib/storage.js'
import { buildFacts } from '../lib/facts.js'
import { createUserAndJob, getIntake, getJob, listAssets, nextVersion, recordEvent } from '../lib/db.js'
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
  // Klaviyo sends every customer email (D48), so the events to read are klaviyo.sent and
  // klaviyo.failed. The legacy email.* events are still read so a pre-D48 job diagnoses honestly.
  const sent = await lastEvent(['klaviyo.sent', 'email.sent'], jobId ?? undefined)
  const failed = await lastEvent(['klaviyo.failed', 'email.failed'], jobId ?? undefined)
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
  } else if (newestEmail.type === 'klaviyo.sent' || newestEmail.type === 'email.sent') {
    steps.push({
      step: 4,
      name: 'Build link emailed',
      status: 'ok',
      detail: `Klaviyo accepted the event${email ? ` for ${email}` : ''}. If it is not in the inbox, check spam, then the flow's activity in Klaviyo: an accepted event with no send usually means the flow on "Website Build Purchased" is off or filtered.`,
      at: newestEmail.createdAt.toISOString(),
    })
  } else {
    const payload = newestEmail.payload as { error?: string; kind?: string } | null
    steps.push({
      step: 4,
      name: 'Build link emailed',
      status: 'failed',
      detail: `The send failed: ${payload?.error ?? 'no reason recorded'}`,
      fix: /KLAVIYO_API_KEY/.test(payload?.error ?? '')
        ? 'KLAVIYO_API_KEY is not set in Vercel.'
        : /ENABLE_LIVE_EMAIL/.test(payload?.error ?? '')
          ? 'ENABLE_LIVE_EMAIL is not set to 1, so email is deliberately blocked. Set it in Vercel and redeploy.'
          : 'Klaviyo refused the event: the reason above is theirs. The hourly sweep retries missing build links, so it may still arrive.',
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
/**
 * Publish a job's website, as the operator.
 *
 * THE GATES LIVE IN publishJob.ts AND ARE SHARED WITH THE CUSTOMER ROUTE. This used to be eighty
 * lines of its own checks, and the customer button would have been a second eighty lines that
 * drifted from it within a month. Every rule now runs for both callers, and the only thing this
 * endpoint has that the customer's does not is `force`.
 *
 * force skips the hosting-paid gate and lets a failing build through. It exists because Chris
 * sometimes takes payment another way, and because an operator who can see the failure list is
 * entitled to overrule it. A customer never gets it.
 *
 * Attaching the domain stays here rather than in the shared gate: it is a first-connection step
 * an operator does once, not something that should run on every customer publish.
 */
app.post('/admin/publish', async (c) => {
  type PublishBody = { jobId?: string; hostname?: string; force?: boolean }
  const body = await c.req.json<PublishBody>().catch(() => ({}) as PublishBody)
  const jobId = (body.jobId ?? '').trim()
  const hostname = normaliseHostname(body.hostname ?? '')

  if (!jobId || !hostname) {
    return c.json({ error: 'bad_request', detail: 'Send both jobId and hostname.' }, 400)
  }

  let out
  try {
    out = await publishJob({ jobId, hostname, force: body.force, actor: 'operator' })
  } catch (err) {
    // assertNoGoPolarKey throws from inside publishSite. That is the whole point of it and it
    // must not be softened: a site posting enquiries to Go Polar does not go on the internet.
    return c.json(
      { error: 'publish_refused', detail: err instanceof Error ? err.message : 'Publishing was refused.' },
      409,
    )
  }

  if (!out.ok) {
    return c.json({ error: out.error, detail: out.detail, failures: out.failures ?? [] }, out.status)
  }

  const attached = await attachDomain(hostname, jobId)

  return c.json({
    ok: true,
    ...out.result,
    renderChecksSkipped: out.renderChecksSkipped,
    checkedPages: out.verified.map((v) => v.path),
    urls: [`https://${hostname}/`],
    domain: attached,
    note: attached.ok
      ? 'Published. The domain still needs its DNS pointed here before anyone can reach it.'
      : `Published, but the domain was not attached: ${attached.detail}`,
  })
})

/**
 * Put a customer's live site back to an earlier version, as the operator.
 *
 *   POST /api/admin/restore  { jobId, version }
 *
 * FOR THE PHONE CALL. A customer publishes something wrong and rings Chris rather than pressing
 * undo themselves, which is exactly what a person does when they are worried. This does what
 * their undo button does: moves the pointer, republishes, and puts the pointer back if the
 * publish refuses.
 *
 * It goes through the same publishJob gate as everything else, so an operator restoring a
 * version cannot skip the checks either. If the old version genuinely cannot pass, force is
 * still available on /admin/publish and is a deliberate second decision.
 */
app.post('/admin/restore', async (c) => {
  type RestoreBody = { jobId?: string; version?: number }
  const body = await c.req.json<RestoreBody>().catch(() => ({}) as RestoreBody)
  const jobId = (body.jobId ?? '').trim()
  const version = Number(body.version)

  if (!jobId || !Number.isInteger(version) || version < 1) {
    return c.json({ error: 'bad_request', detail: 'Send a jobId and the version number to go back to.' }, 400)
  }

  const db = await getDb()
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1)
  if (!job) return c.json({ error: 'not_found', detail: 'No job with that id.' }, 404)

  const [target] = await db
    .select({ version: schema.builds.version })
    .from(schema.builds)
    .where(and(eq(schema.builds.jobId, jobId), eq(schema.builds.version, version)))
    .limit(1)
  if (!target) return c.json({ error: 'not_found', detail: 'That job has no build at that version.' }, 404)

  const hostname = await liveHostnameFor(jobId)
  if (!hostname) {
    return c.json({ error: 'not_live', detail: 'That job has no live site, so there is nothing to restore.' }, 409)
  }

  const from = job.currentVersion
  await db.update(schema.jobs).set({ currentVersion: version, updatedAt: new Date() }).where(eq(schema.jobs.id, jobId))

  const out = await publishJob({ jobId, hostname, actor: 'operator', restoredFromVersion: version })

  if (!out.ok) {
    // Same rule as the customer path: never leave the database and the internet disagreeing.
    await db.update(schema.jobs).set({ currentVersion: from, updatedAt: new Date() }).where(eq(schema.jobs.id, jobId))
    return c.json({ error: out.error, detail: out.detail + ' Nothing changed; still on version ' + from + '.', failures: out.failures ?? [] }, out.status)
  }

  await recordEvent(jobId, 'admin.restored', { from, to: version, hostname })
  return c.json({ ok: true, hostname, restoredTo: version, wasOn: from })
})

/**
 * What versions this job has, and which one the public is seeing.
 *
 *   GET /api/admin/jobs/:jobId/versions
 *
 * So Chris can look at the alert, see version 7 is live and version 6 was there before, and put
 * 6 back without opening the customer's account.
 */
app.get('/admin/jobs/:jobId/versions', async (c) => {
  const jobId = c.req.param('jobId')
  const db = await getDb()

  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const [site] = await db
    .select({ hostname: schema.sites.hostname, version: schema.sites.version, live: schema.sites.live })
    .from(schema.sites)
    .where(eq(schema.sites.jobId, jobId))
    .limit(1)

  const builds = await db
    .select({ version: schema.builds.version, createdAt: schema.builds.createdAt, passed: schema.builds.passed })
    .from(schema.builds)
    .where(eq(schema.builds.jobId, jobId))
    .orderBy(desc(schema.builds.version))
    .limit(25)

  const edits = await db
    .select({ versionTo: schema.edits.versionTo, prompt: schema.edits.prompt, createdAt: schema.edits.createdAt })
    .from(schema.edits)
    .where(eq(schema.edits.jobId, jobId))
    .orderBy(desc(schema.edits.createdAt))
    .limit(25)

  return c.json({
    jobId,
    businessName: job.businessName,
    currentVersion: job.currentVersion,
    publishedVersion: site?.live ? site.version : null,
    hostname: site?.hostname ?? null,
    previousPublishedVersion: await previousPublishedVersion(jobId, site?.version ?? job.currentVersion),
    builds: builds.map((b) => ({
      ...b,
      // Their words for the change that produced this version, so the list reads as a story.
      prompt: edits.find((e) => e.versionTo === b.version)?.prompt ?? null,
    })),
  })
})

/**
 * Which Klaviyo metrics have ever fired.
 *
 *   GET /api/admin/klaviyo-health
 *
 * Nine of the eleven flows do not exist. The app cannot tell: Klaviyo answers 202 to an event
 * nothing is listening to, so a missing flow looks identical to a working one from here. What
 * this CAN say is which metrics have never fired at all, and those definitely have no flow.
 */
app.get('/admin/klaviyo-health', async (c) => c.json(await klaviyoHealth()))

/**
 * Sites on the cancellation clock, and how long each has left.
 *
 *   GET /api/admin/takedowns
 *
 * VISIBLE BEFORE IT HAPPENS, NOT AFTER. Taking a live business website off the internet is the
 * most serious thing this system does on its own, and a list that only appears once a site has
 * gone dark would be a log, not a safeguard. Anything here can still be stopped by the customer
 * resubscribing, or by Chris ringing them.
 */
app.get('/admin/takedowns', async (c) => {
  const db = await getDb()
  const rows = await db
    .select({
      jobId: schema.golive.jobId,
      endedAt: schema.golive.hostingEndedAt,
      hostname: schema.sites.hostname,
      live: schema.sites.live,
      businessName: schema.jobs.businessName,
    })
    .from(schema.golive)
    .innerJoin(schema.sites, eq(schema.sites.jobId, schema.golive.jobId))
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.golive.jobId))
    .where(eq(schema.golive.hostingStatus, 'cancelled'))

  const pending = rows
    .filter((r) => r.endedAt)
    .map((r) => ({
      jobId: r.jobId,
      businessName: r.businessName,
      hostname: r.hostname,
      stillServing: r.live,
      cancelledAt: r.endedAt!.toISOString(),
      offlineOn: takedownDueAt(r.endedAt!).toISOString(),
      daysLeft: daysUntilTakedown(r.endedAt!),
    }))
    .sort((a, b) => a.daysLeft - b.daysLeft)

  return c.json({
    takedownAfterDays: TAKEDOWN_DAYS,
    pending: pending.filter((p) => p.stillServing),
    alreadyOffline: pending.filter((p) => !p.stillServing),
    note: 'Nothing here has been deleted. Restarting their hosting puts the site straight back.',
  })
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
/**
 * Apply database migrations, from inside the deployment.
 *
 *   POST /api/admin/migrate
 *
 * WHY THIS EXISTS RATHER THAN A LOCAL COMMAND. The runbook used to say: pull the environment down
 * with `vercel env pull` and run the migration against the connection string. That does not work.
 * The Neon integration marks every variable Sensitive, and Vercel redacts sensitive values on
 * pull, so the file arrives with `DATABASE_URL=[SENSITIVE]` in it. The connection string is not
 * meant to leave the platform, which is right, and it means migrations have to run where it lives.
 *
 * Drizzle records what it has applied in its own table, so this is idempotent: running it twice
 * applies nothing the second time. Migrations here are forward-only and none of the three drops a
 * column, so there is no destructive path to guard against beyond the admin token already on this
 * whole route group.
 */
/**
 * Can this deployment actually store a file?
 *
 *   GET /api/admin/storage-check
 *
 * Configuration says storageDriver is vercel-blob. That is a reading of an environment variable,
 * not evidence. This writes a small object, reads it back, compares the bytes and deletes it, so
 * the answer is what the storage layer really did rather than what it was told to do.
 *
 * Worth having permanently. A misconfigured blob store fails at the worst possible moment: after a
 * customer has answered every question and uploaded their photos, at the point the build is saved.
 */
/**
 * Send a real customer email, through the real code path.
 *
 *   POST /api/admin/test-email?email=you@yourdomain.com
 *
 * Emits the same Klaviyo event a paid order emits, so this exercises the transport, the API key,
 * the metric name and the flow behind it rather than a parallel implementation that could drift.
 *
 * Klaviyo answers 202 Accepted, which means it took the event, not that it sent anything. The flow
 * has to exist and be live for an email to follow, so the response says so rather than claiming
 * success on a status code.
 */
app.post('/admin/test-email', async (c) => {
  const cfg = config()

  if (!cfg.klaviyoApiKey) {
    return c.json(
      {
        error: 'not_configured',
        detail: 'KLAVIYO_API_KEY is not set on this deployment.',
        fix: 'Klaviyo, Settings, API Keys, create a private key with write access to events, then set it in Vercel.',
      },
      409,
    )
  }

  if (!cfg.live.email) {
    return c.json(
      {
        error: 'email_disabled',
        detail: cfg.demoMode
          ? 'This deployment is in demo mode, so customer email is logged rather than sent.'
          : 'ENABLE_LIVE_EMAIL is not set, so customer email is refused rather than sent.',
        fix: 'Set ENABLE_LIVE_EMAIL=1 in Vercel and redeploy.',
      },
      409,
    )
  }

  const to = (c.req.query('email') ?? '').trim()
  if (!to.includes('@')) {
    return c.json(
      { error: 'bad_request', detail: 'Pass ?email= a real inbox you can check. There is no useful default.' },
      400,
    )
  }

  /*
   * ANY METRIC, NOT JUST build_purchased.
   *
   * THE REASON THIS EXISTS. Klaviyo will not offer a metric in the flow trigger picker until one
   * event of that name has arrived, so a flow cannot be built for a metric that has never fired.
   * This endpoint used to fire only `build_purchased`, which is the one metric that HAS fired and
   * the one flow that already exists. It was therefore useless for the only job anybody needed it
   * for: making the other eleven metrics appear so their flows could be built.
   *
   * Every metric gets a plausible sample payload below, because a Klaviyo template built against
   * an event with no properties has no tokens to drag in and has to be rebuilt later.
   */
  const requested = (c.req.query('metric') ?? 'build_purchased').trim() as KlaviyoMetric
  if (!(requested in KLAVIYO_METRICS)) {
    return c.json(
      {
        error: 'unknown_metric',
        detail: `"${requested}" is not a metric this app fires.`,
        valid: Object.keys(KLAVIYO_METRICS),
      },
      400,
    )
  }

  const base = cfg.publicAppUrl.replace(/\/$/, '')

  /*
   * Sample values, marked as a test everywhere they could be mistaken for real. The links point
   * at real routes so a template author can see what a real one looks like, but they carry
   * obvious placeholder tokens rather than anything that would open a customer's website.
   */
  const samples: Record<KlaviyoMetric, Record<string, string | number | boolean | null>> = {
    build_purchased: {
      builder_login_link: `${base}/start?t=CONNECTION-TEST`,
      order_id: 'TEST-0000',
      amount_ex_gst_cents: 20_000,
    },
    link_requested: { builder_login_link: `${base}/start?t=CONNECTION-TEST` },
    build_complete: { preview_link: `${base}/preview/job_connection_test` },
    go_live_started: {
      checkout_url: 'https://itscold.com.au/cart',
      business_name: 'Go Polar Test, safe to delete',
      email_addon: false,
      domain_addon: true,
      preview_link: `${base}/preview/job_connection_test`,
    },
    go_live_requested: {
      preview_link: `${base}/preview/job_connection_test`,
      business_name: 'Go Polar Test, safe to delete',
      domain_name: 'example.com.au',
      domain_branch: 'own',
    },
    site_live: {
      site_url: 'https://example.com.au',
      hostname: 'example.com.au',
      business_name: 'Go Polar Test, safe to delete',
      pages: 1,
      is_first_publish: true,
    },
    files_ready: {
      download_link: `${base}/download/TEST`,
      expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      used_placeholder: false,
      business_name: 'Go Polar Test, safe to delete',
    },
    intake_abandoned: { builder_login_link: `${base}/preview/job_connection_test` },
    editing_stalled: { preview_link: `${base}/preview/job_connection_test` },
    login_code: { login_code: '000000', expires_in_minutes: 10 },
    hosting_ending: {
      stage: 59,
      urgency: 'high',
      headline: 'Your website comes offline tomorrow',
      body: 'This is a test event, so nothing is actually coming offline. The real one carries the same fields.',
      business_name: 'Go Polar Test, safe to delete',
      hostname: 'example.com.au',
      site_url: 'https://example.com.au',
      offline_on: '30 September 2026',
      days_left: 1,
    },
    operator_alert: {
      alert: 'go_live_paid',
      business_name: 'Go Polar Test, safe to delete',
      customer_email: to,
      job_id: 'job_connection_test',
      domain_name: 'example-plumbing.com.au',
      domain_registrar: 'GoDaddy',
      domain_action: 'CONNECT it. They already own it, get their logins',
      preview_link: `${base}/preview/job_connection_test`,
      ops_link: `${base}/ops`,
    },
  }

  const sent = await trackKlaviyoSafely({
    metric: requested,
    profile: { email: to, firstName: 'Connection', businessName: 'Go Polar Test, safe to delete' },
    jobId: 'job_connection_test',
    properties: { ...samples[requested], test: true },
  })

  return c.json({
    ok: sent,
    sentTo: to,
    metric: KLAVIYO_METRICS[requested],
    detail: sent
      ? `Klaviyo accepted the event. It will now appear in the flow trigger picker as "${KLAVIYO_METRICS[requested]}". That is not the same as sending: a flow has to exist and be live before anything lands in an inbox.`
      : 'The event was rejected. Check /api/admin/events for the klaviyo.failed entry, which carries the reason.',
  })
})

app.get('/admin/storage-check', async (c) => {
  const cfg = config()
  const store = storage()
  const key = `diagnostics/storage-check-${Date.now()}.txt`
  const payload = `storage check ${new Date().toISOString()}`

  const report: Record<string, unknown> = {
    driver: store.driver,
    configuredDriver: cfg.storageDriver,
    blobTokenPresent: Boolean(cfg.blobToken),
  }

  try {
    await store.put(key, payload, 'text/plain; charset=utf-8')
  } catch (err) {
    return c.json(
      {
        ...report,
        ok: false,
        stage: 'write',
        detail: err instanceof Error ? err.message : String(err),
        fix: cfg.blobToken
          ? 'The token is set but the write failed. Check the Blob store is connected to this project and not deleted.'
          : 'BLOB_READ_WRITE_TOKEN is not set on this deployment. Open the Blob store in the Vercel dashboard, copy its read/write token, and add it to the project environment variables.',
      },
      500,
    )
  }

  const readBack = await store.getText(key).catch(() => null)

  // Clean up whatever happened next, so a repeated check does not litter the store.
  let cleaned = true
  try {
    await store.delete(key)
  } catch {
    cleaned = false
  }

  if (readBack !== payload) {
    return c.json(
      {
        ...report,
        ok: false,
        stage: 'read',
        detail:
          readBack === null
            ? 'The write reported success but the object could not be read back.'
            : 'The object read back did not match what was written.',
        cleanedUp: cleaned,
      },
      500,
    )
  }

  return c.json({
    ...report,
    ok: true,
    bytes: payload.length,
    cleanedUp: cleaned,
    detail: `Wrote, read back and deleted a test object using the ${store.driver} driver. File storage works.`,
  })
})

/**
 * Can this deployment actually attach a customer's web address?
 *
 * THIS CALLS VERCEL FOR REAL, read-only. It exists because the last configuration check on this
 * project reported Boolean(someKey) and was believed, and the key it inspected belonged to a
 * decommissioned provider. A variable being present proves somebody typed something into the
 * dashboard. It does not prove the token is valid, that it can see this project, or that it
 * carries the scope to add a domain. So this fetches the project the token claims to reach and
 * reports what came back.
 *
 * Read-only on purpose: GET the project, never POST a domain. A diagnostic that has to create
 * something in order to tell you it works is a diagnostic nobody runs twice.
 */
app.get('/admin/domain-check', async (c) => {
  const cfg = config()

  const report: Record<string, unknown> = {
    demoMode: cfg.demoMode,
    gateEnabled: cfg.live.domains,
    tokenPresent: Boolean(cfg.vercelApiToken),
    projectIdPresent: Boolean(cfg.vercelProjectId),
    teamIdPresent: Boolean(cfg.vercelTeamId),
  }

  if (cfg.demoMode) {
    return c.json({ ...report, ok: false, detail: 'Demo mode. Nothing here touches DNS.' })
  }
  if (!cfg.live.domains) {
    return c.json({
      ...report,
      ok: false,
      stage: 'gate',
      detail: 'ENABLE_LIVE_DOMAINS is not set on this deployment, so attachDomain refuses before it calls anything.',
      fix: 'npx vercel env add ENABLE_LIVE_DOMAINS production, then redeploy. Environment variables only reach the functions on a new deployment.',
    })
  }
  if (!cfg.vercelApiToken || !cfg.vercelProjectId) {
    return c.json({
      ...report,
      ok: false,
      stage: 'credentials',
      detail: 'VERCEL_API_TOKEN and VERCEL_PROJECT_ID are both required. One of them is missing from this deployment.',
      fix: 'Add the missing variable with npx vercel env add, then redeploy.',
    })
  }

  const url = new URL('https://api.vercel.com/v9/projects/' + cfg.vercelProjectId)
  if (cfg.vercelTeamId) url.searchParams.set('teamId', cfg.vercelTeamId)

  let res: Response
  try {
    res = await fetch(url, { headers: { authorization: 'Bearer ' + cfg.vercelApiToken } })
  } catch (err) {
    return c.json(
      {
        ...report,
        ok: false,
        stage: 'network',
        detail: err instanceof Error ? err.message : String(err),
      },
      500,
    )
  }

  if (!res.ok) {
    const body = (await res.text()).slice(0, 300)
    /*
     * The three ways this fails are indistinguishable from the customer's side and completely
     * different to fix, so they are separated here rather than left as "Vercel said no".
     */
    const fix =
      res.status === 403
        ? 'The token is valid but cannot see this project. If the project belongs to a team, VERCEL_TEAM_ID must be set and must match. Check the token was created with the team selected, not on a personal account.'
        : res.status === 404
          ? 'The token works but no project has that id. VERCEL_PROJECT_ID is wrong, or belongs to a different team.'
          : 'The token was rejected. Create a new one at vercel.com/account/tokens with the right team scope and replace VERCEL_API_TOKEN.'
    return c.json({ ...report, ok: false, stage: 'vercel', status: res.status, detail: body, fix }, 500)
  }

  const project = (await res.json()) as { name?: string; id?: string }
  return c.json({
    ...report,
    ok: true,
    projectName: project.name ?? null,
    detail:
      'The token reached project "' +
      (project.name ?? cfg.vercelProjectId) +
      '" and the gate is on. Attaching a customer domain will be attempted for real.',
    reminder:
      'Attaching is only half of it. The customer still has to point their DNS at Vercel before the address resolves, and that is the part the go-live email walks them through.',
  })
})

app.post('/admin/migrate', async (c) => {
  const cfg = config()
  const started = Date.now()

  // Reading the list off disk rather than out of the database, so the answer is the same whether
  // this is the first run or the fiftieth, and so a missing migrations folder is obvious.
  let available: string[] = []
  try {
    const { readdirSync } = await import('node:fs')
    available = readdirSync('db/migrations')
      .filter((f) => f.endsWith('.sql'))
      .sort()
  } catch (err) {
    return c.json(
      {
        error: 'migrations_missing',
        detail:
          'The db/migrations folder was not found in the deployment. Check it is not excluded by .vercelignore.',
        cause: err instanceof Error ? err.message : String(err),
      },
      500,
    )
  }

  try {
    const { migrate } = await import('../db/migrate.js')
    await migrate()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json(
      {
        error: 'migration_failed',
        detail: message,
        fix: message.includes('DATABASE_URL')
          ? 'DATABASE_URL is not set on this deployment. Attach the Neon integration to the project and redeploy.'
          : 'Read the error above. Migrations are forward-only, so a partial failure leaves the earlier ones applied and safe to re-run.',
        driver: cfg.databaseDriver,
      },
      500,
    )
  }

  // Prove the schema is actually there rather than trusting that no error means success.
  let tables: string[] = []
  try {
    const db = await getDb()
    const result = await db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    )
    const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Array<{
      table_name: string
    }>
    tables = rows.map((r) => r.table_name)
  } catch {
    // Not fatal. The migration succeeded; this is only the readback.
  }

  return c.json({
    ok: true,
    driver: cfg.databaseDriver,
    migrationsOnDisk: available,
    tables,
    tookMs: Date.now() - started,
    detail: `Applied migrations against ${cfg.databaseDriver}. ${tables.length} table(s) now present. Running this again applies nothing.`,
  })
})

/**
 * Create a job for Go Polar to test with, without an order and without paying.
 *
 * WHY THIS EXISTS SEPARATELY FROM /dev/jobs. That route refuses to run once a Shopify webhook
 * secret is configured, which is correct: in production a job is created by the orders/paid
 * webhook and nowhere else, because a job is the thing $220 buys. That rule should not be relaxed
 * to save Chris a click. This route keeps the rule and adds one exception that is behind the admin
 * token, so the only person who can mint a free job is the person holding the secret.
 *
 * MARKED, SO IT NEVER LOOKS LIKE A SALE. The email is recorded as an admin test address and the
 * event is job.created.admin_test, distinct from job.created.dev and from the webhook's own event.
 * Anything counting jobs, revenue or conversion can exclude these; an unmarked test job quietly
 * becomes a wrong number in a report later.
 */
app.post('/admin/test-job', async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string })

  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
  const email = `admin-test+${stamp}@itscold.com.au`

  const { jobId, userId } = await createUserAndJob({
    email,
    name: body.name ?? 'Admin test build',
  })
  await recordEvent(jobId, 'job.created.admin_test', { email })

  // Two extra pages, granted the way a purchase would grant them. Without this a test job has the
  // default allowance of one, the "which services on your extra pages" step never appears, and the
  // multi-page path cannot be exercised at all: the exact blind spot that hid it from testing.
  const db = await getDb()
  await db
    .update(schema.jobs)
    .set({ pagesAllowed: 3, updatedAt: new Date() })
    .where(eq(schema.jobs.id, jobId))
  await recordEvent(jobId, 'pages.granted', { granted: 2, pagesAllowed: 3, test: true })

  const token = await createBuildToken(jobId)

  // The start link, not a session: it puts the browser through the same /start?t= exchange a
  // paying customer goes through, so what gets tested is the real path rather than a shortcut
  // around it.
  return c.json({ jobId, userId, email, startLink: buildLink(token) }, 201)
})

/**
 * Grant extra pages to an existing job.
 *
 *   POST /api/admin/grant-pages   { jobId: string, pagesAllowed: number }
 *
 * Support tool: a make-good, a manual sale, or a test job created before test jobs came with an
 * allowance. Absolute rather than additive, so running it twice cannot silently double a grant.
 */
app.post('/admin/grant-pages', async (c) => {
  const body = await c.req
    .json<{ jobId?: string; pagesAllowed?: number }>()
    .catch(() => ({}) as { jobId?: string; pagesAllowed?: number })
  const jobId = body.jobId ?? ''
  const pagesAllowed = Number(body.pagesAllowed)
  /*
   * TWENTY-ONE, AND THE ARITHMETIC IS THE POINT.
   *
   * pagesAllowed counts the TOTAL pages including the home page, so the extras a customer gets
   * are pagesAllowed - 1. This ceiling therefore has to be the services ceiling PLUS ONE or the
   * most a customer can be granted is one page short of a page per service. It was ten for that
   * reason, then eleven when Pest-Aside Sydney bought a page for each of ten pest types, and it
   * is twenty-one now that the storefront sells up to twenty additional pages.
   *
   * The number that must not drift is the relationship, not the value: entitlement, picker and
   * delivered-pages check all have to agree on the same maximum, or the picker offers an
   * allocation the grant cannot fund. Change the services ceiling and change this with it.
   */
  const MAX_PAGES = 21
  if (!jobId || !Number.isInteger(pagesAllowed) || pagesAllowed < 1 || pagesAllowed > MAX_PAGES) {
    return c.json(
      { error: 'bad_request', detail: `jobId and pagesAllowed (1 to ${MAX_PAGES}) are required.` },
      400,
    )
  }
  const db = await getDb()
  const job = await getJob(jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)
  await db
    .update(schema.jobs)
    .set({ pagesAllowed, updatedAt: new Date() })
    .where(eq(schema.jobs.id, jobId))
  await recordEvent(jobId, 'pages.granted', { pagesAllowed, by: 'admin' })
  return c.json({ jobId, pagesAllowed, was: job.pagesAllowed })
})

/**
 * Permanently delete jobs and everything they own.
 *
 *   POST /api/admin/wipe-jobs   { jobIds: string[], confirm: 'wipe', dryRun?: boolean }
 *
 * FOR CLEARING TEST DATA, NOT FOR CUSTOMERS. There is deliberately no "wipe everything" form:
 * every job to be deleted is named in the request, so the caller has read the list they are about
 * to destroy. dryRun (the default if confirm is missing) reports what would go without touching
 * anything, and the runbook is to always dry-run first.
 *
 * WHAT IT TOUCHES, AND ONE THING IT REFUSES TO. Child rows are removed in foreign-key order, the
 * job's blobs are swept by the jobs/<id>/ prefix, and a user with no remaining jobs goes too.
 * Order rows are NOT deleted: they are the record of money received, so their jobId is nulled and
 * the row kept. A wipe that falsified revenue history would be worse than the clutter it removes.
 */
/**
 * Repair a build that shipped fewer pages than the customer paid for.
 *
 *   POST /api/admin/jobs/:jobId/repair-pages   { "services": ["A", "B"], "dryRun": true }
 *
 * WHY THIS EXISTS AND WHY IT IS NOT A REBUILD. On 2026-08-26 a customer bought four additional
 * pages, never allocated them to a service, and received a one page website. Intake now refuses
 * to let that happen again, but it does not help the people it already happened to, and they are
 * the ones owed something.
 *
 * The obvious repair, running the generator again, is the wrong one. By the time anybody notices,
 * the customer has usually spent edit rounds on the page they did get. Regenerating throws all of
 * that away and hands them back a website they have to redo. So this does not regenerate.
 *
 * It takes the CURRENT plan and the CURRENT home page HTML, byte for byte, adds the service pages
 * the customer paid for through the same invariant pass the build uses, and writes a new version.
 * The home page they have been editing is carried across untouched. Nothing they wrote is lost.
 *
 * IT NEVER COSTS THE CUSTOMER A ROUND. No row goes into `edits`, and `jobs.editsUsed` is not
 * touched. This is our mistake and they do not pay for it.
 */
app.post('/admin/jobs/:jobId/repair-pages', requireAdmin, async (c) => {
  // requireAdmin widens the param type, so the empty string stands in and getJob turns it into a 404.
  const jobId = c.req.param('jobId') ?? ''
  const job = await getJob(jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const body = await c.req
    .json<{ services?: string[]; dryRun?: boolean }>()
    .catch(() => ({}) as { services?: string[]; dryRun?: boolean })
  const wanted = (body.services ?? []).map((v) => String(v).trim()).filter(Boolean)

  const stored = await getIntake(jobId)
  const parsedIntake = intakeSchema.safeParse(stored?.payload)
  if (!parsedIntake.success) {
    return c.json({ error: 'invalid_intake', detail: 'Stored intake does not validate' }, 422)
  }
  const intake = parsedIntake.data as IntakePayload
  const entitled = Math.max(0, job.pagesAllowed - 1)

  // Read-only reconnaissance. Always available, so the operator can see the service list and the
  // shortfall before committing to anything.
  if (body.dryRun || wanted.length === 0) {
    return c.json({
      ok: true,
      dryRun: true,
      jobId,
      businessName: job.businessName,
      currentVersion: job.currentVersion,
      pagesAllowed: job.pagesAllowed,
      additionalPagesOwed: entitled,
      servicesTheyOffer: intake.services,
      primaryService: intake.primaryService,
      currentlyAllocated: intake.ownPageServices ?? [],
      shortfall: entitled - (intake.ownPageServices ?? []).length,
      detail: 'Nothing was changed. Send { services: [...] } with exactly ' + entitled + ' of the services above to repair.',
    })
  }

  const unknown = wanted.filter((name) => !intake.services.includes(name))
  if (unknown.length > 0) {
    return c.json(
      {
        error: 'unknown_service',
        detail: 'These are not services this customer offers: ' + unknown.join(', '),
        servicesTheyOffer: intake.services,
      },
      400,
    )
  }

  if (new Set(wanted).size !== wanted.length) {
    return c.json({ error: 'duplicate_service', detail: 'The same service is listed twice.' }, 400)
  }

  if (wanted.length !== entitled) {
    return c.json(
      {
        error: 'wrong_count',
        detail:
          'This customer paid for ' + entitled + ' additional page(s) and you sent ' +
          wanted.length + '. Send exactly ' + entitled + '.',
      },
      400,
    )
  }

  const fromVersion = job.currentVersion
  if (fromVersion < 1) {
    return c.json({ error: 'not_ready', detail: 'There is no build to repair.' }, 409)
  }

  const db = await getDb()
  const [planRow] = await db
    .select({ plan: schema.plans.plan })
    .from(schema.plans)
    .where(and(eq(schema.plans.jobId, jobId), eq(schema.plans.version, fromVersion)))
    .limit(1)
  const [buildRow] = await db
    .select({ blobKey: schema.builds.blobKey })
    .from(schema.builds)
    .where(and(eq(schema.builds.jobId, jobId), eq(schema.builds.version, fromVersion)))
    .limit(1)

  if (!planRow || !buildRow) {
    return c.json({ error: 'not_found', detail: 'The current version could not be loaded.' }, 404)
  }

  const homeHtml = await storage().getText(buildRow.blobKey)
  if (!homeHtml) {
    return c.json({ error: 'not_found', detail: 'The current home page could not be read.' }, 404)
  }

  // The corrected answers. Written straight to the payload rather than through submitIntake,
  // because that helper resets the job status to 'intake' and this job is well past that.
  const nextIntake: IntakePayload = { ...intake, ownPageServices: wanted }
  const assets = await listAssets(jobId)
  const facts = buildFacts(nextIntake, assets)

  // The same invariant pass the build runs. It synthesises a complete, schema-valid entry for
  // every paid service the plan is missing, which is exactly the situation here.
  const repairedPlan = enforcePlanInvariants(
    planRow.plan as ContentPlan,
    nextIntake,
    facts,
    assets,
    { pagesAllowed: job.pagesAllowed },
  )

  const toVersion = await nextVersion(jobId)
  const now = new Date()

  await db
    .update(schema.intake)
    .set({ payload: nextIntake, updatedAt: now })
    .where(eq(schema.intake.jobId, jobId))

  await db
    .insert(schema.plans)
    .values({ id: id('pln'), jobId, version: toVersion, plan: repairedPlan })
    .onConflictDoUpdate({
      target: [schema.plans.jobId, schema.plans.version],
      set: { plan: repairedPlan },
    })

  // The home page is re-verified rather than assumed, because a report has to belong to the bytes
  // it describes. It is not re-generated: these are the customer's own edited bytes.
  const homeReport = await verify(homeHtml, facts, { runRender: false })

  const set = await persistPageSet({
    jobId,
    version: toVersion,
    plan: repairedPlan,
    facts,
    homeHtml,
    homeReport,
    paidPageServices: wanted,
    pagesAllowed: job.pagesAllowed,
  })

  await db
    .update(schema.jobs)
    .set({ currentVersion: toVersion, updatedAt: now })
    .where(eq(schema.jobs.id, jobId))

  await recordEvent(jobId, 'pages.repaired', {
    fromVersion,
    toVersion,
    services: wanted,
    pagesBuilt: set.pages.length,
    passed: set.passed,
    // Stated in the trail so it can never be mistaken for something the customer spent.
    editCharged: false,
    notify: 'chris',
  })

  return c.json({
    ok: true,
    jobId,
    fromVersion,
    toVersion,
    services: wanted,
    pages: set.pages.map((p) => p.path),
    passed: set.passed,
    failures: set.failures,
    editCharged: false,
    detail: set.passed
      ? 'Repaired. The customer keeps every edit they had made and has not been charged a round.'
      : 'Pages were written but the set did not pass. Look at failures before telling the customer anything.',
  })
})

app.post('/admin/wipe-jobs', async (c) => {
  const body = await c.req
    .json<{ jobIds?: string[]; confirm?: string; dryRun?: boolean }>()
    .catch(() => ({}) as { jobIds?: string[]; confirm?: string; dryRun?: boolean })

  const jobIds = [...new Set(body.jobIds ?? [])]
  if (jobIds.length === 0) {
    return c.json({ error: 'bad_request', detail: 'jobIds must name every job to delete.' }, 400)
  }
  const dryRun = body.confirm !== 'wipe' || body.dryRun === true

  const db = await getDb()
  const cfg = config()
  const report: Array<Record<string, unknown>> = []

  for (const jobId of jobIds) {
    const jobRows = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1)
    const job = jobRows[0]
    if (!job) {
      report.push({ jobId, result: 'not_found' })
      continue
    }

    // Everything that would go, counted up front so the dry run is the same code path.
    const counts: Record<string, number> = {}
    const tables = [
      ['events', schema.events],
      ['discharges', schema.discharges],
      ['buildPages', schema.buildPages],
      ['golive', schema.golive],
      ['domains', schema.domains],
      ['edits', schema.edits],
      ['builds', schema.builds],
      ['plans', schema.plans],
      ['assets', schema.assets],
      ['intake', schema.intake],
      ['tokens', schema.tokens],
      ['sites', schema.sites],
    ] as const

    for (const [name, table] of tables) {
      const rows = await db
        .select({ n: sql<number>`count(*)` })
        .from(table)
        .where(eq((table as typeof schema.events).jobId, jobId))
      counts[name] = Number(rows[0]?.n ?? 0)
    }

    // Blobs under this job's prefix. Counted in both modes, deleted only on the real run.
    let blobCount = 0
    const blobUrls: string[] = []
    if (cfg.blobToken) {
      const { list } = await import('@vercel/blob')
      let cursor: string | undefined
      do {
        const page = await list({ prefix: `jobs/${jobId}/`, cursor, token: cfg.blobToken })
        blobCount += page.blobs.length
        for (const b of page.blobs) blobUrls.push(b.url)
        cursor = page.hasMore ? page.cursor : undefined
      } while (cursor)
    }

    if (dryRun) {
      report.push({ jobId, result: 'would_delete', business: job.businessName, rows: counts, blobs: blobCount })
      continue
    }

    // The real thing. Blobs first: if this dies halfway, orphaned DB rows still name their blobs
    // and the wipe can be re-run, whereas deleted rows pointing at live blobs would leak storage
    // with nothing left that knows the keys.
    if (blobUrls.length > 0) {
      const { del } = await import('@vercel/blob')
      for (let i = 0; i < blobUrls.length; i += 50) {
        await del(blobUrls.slice(i, i + 50), { token: cfg.blobToken })
      }
    }

    for (const [, table] of tables) {
      await db.delete(table).where(eq((table as typeof schema.events).jobId, jobId))
    }

    // Orders are the money trail. Detach, keep.
    await db.update(schema.orders).set({ jobId: null }).where(eq(schema.orders.jobId, jobId))

    await db.delete(schema.jobs).where(eq(schema.jobs.id, jobId))

    // The user goes only when this was their last job.
    if (job.userId) {
      const remaining = await db
        .select({ n: sql<number>`count(*)` })
        .from(schema.jobs)
        .where(eq(schema.jobs.userId, job.userId))
      if (Number(remaining[0]?.n ?? 0) === 0) {
        await db.delete(schema.users).where(eq(schema.users.id, job.userId))
      }
    }

    // The audit trace survives the job it describes: jobId is nullable on events.
    await recordEvent(null, 'job.wiped', { jobId, business: job.businessName, blobs: blobCount })

    report.push({ jobId, result: 'deleted', business: job.businessName, rows: counts, blobs: blobCount })
  }

  return c.json({ dryRun, jobs: report })
})

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
      // For the 24-hour call. The phone lives in the intake answers, nowhere else.
      phone: sql<string | null>`${schema.intake.payload}->>'phone'`,
    })
    .from(schema.jobs)
    .innerJoin(schema.users, eq(schema.users.id, schema.jobs.userId))
    .leftJoin(schema.golive, eq(schema.golive.jobId, schema.jobs.id))
    .leftJoin(schema.intake, eq(schema.intake.jobId, schema.jobs.id))
    .orderBy(desc(schema.jobs.updatedAt))
    .limit(100)

  const domainRows = await db.select().from(schema.domains).orderBy(desc(schema.domains.createdAt))
  const domainFor = new Map<string, (typeof domainRows)[number]>()
  for (const row of domainRows) if (!domainFor.has(row.jobId)) domainFor.set(row.jobId, row)

  /*
   * When did each customer FIRST ask to go live. The first golive.requested event is the
   * timestamp the manual flow (D53) is measured against: over 24 hours without the site going
   * live means Chris rings them. The event is the source of truth rather than a golive column
   * because the plan screen upserts its row on every visit, and "when did they first ask" must
   * not move when they change their mind about an addon.
   */
  const goLiveFirsts = await db
    .select({
      jobId: schema.events.jobId,
      requestedAt: sql<string>`min(${schema.events.createdAt})`,
    })
    .from(schema.events)
    .where(eq(schema.events.type, 'golive.requested'))
    .groupBy(schema.events.jobId)
  const goLiveRequestedFor = new Map<string, Date>()

  // Which jobs are actually published. One query, used by the waiting-list test above.
  const publishedRows = await db
    .select({ jobId: schema.sites.jobId })
    .from(schema.sites)
    .where(eq(schema.sites.live, true))
  const publishedJobIds = new Set(publishedRows.map((r) => r.jobId))
  for (const row of goLiveFirsts) {
    if (row.jobId) goLiveRequestedFor.set(row.jobId, new Date(row.requestedAt))
  }

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

    /*
     * WAITING MEANS "NOT PUBLISHED YET", AND jobs.status CANNOT ANSWER THAT ANY MORE.
     *
     * The brief's lifecycle treated 'live' as terminal, and this line was written when that was
     * true. It is not true now: a live customer editing their own site flips the status back to
     * 'editing' (edits.ts), so every customer who has ever gone live and then changed something
     * reappeared on this waiting list, with an hours-waiting counter climbing, for a job that was
     * finished weeks ago.
     *
     * The sites row is the fact that matters: a live row means the public can see it, whatever
     * the job status happens to say this minute. Same reasoning as editPhaseFor. See D65.
     */
    const goLiveRequestedAt = goLiveRequestedFor.get(row.jobId) ?? null
    const stillWaiting =
      goLiveRequestedAt !== null && !publishedJobIds.has(row.jobId) && row.status !== 'discharged'
    const goLiveWaitingHours = stillWaiting
      ? Math.floor((Date.now() - goLiveRequestedAt.getTime()) / 3_600_000)
      : null

    return {
      jobId: row.jobId,
      businessName: row.businessName,
      email: row.email,
      phone: row.phone,
      status: row.status,
      version: row.version,
      pagesAllowed: row.pagesAllowed,
      editsLeft: row.editsAllowed - row.editsUsed,
      goLiveRequestedAt: goLiveRequestedAt?.toISOString() ?? null,
      goLiveWaitingHours,
      // The 24-hour rule: still not live a day after they asked means ring them.
      goLiveOverdue: goLiveWaitingHours !== null && goLiveWaitingHours >= 24,
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
  // Everyone who has pressed "go live" and is not live yet, oldest first, so the person who has
  // been waiting longest is at the top and the 24-hour calls fall out of reading the list.
  const waitingGoLive = jobs
    .filter((j) => j.goLiveWaitingHours !== null)
    .sort((a, b) => (b.goLiveWaitingHours ?? 0) - (a.goLiveWaitingHours ?? 0))

  return c.json({
    summary: {
      readyToTakeLive: ready.length,
      paidButBlocked: paidButBlocked.length,
      waitingGoLive: waitingGoLive.length,
      goLiveOverdue: waitingGoLive.filter((j) => j.goLiveOverdue).length,
      total: jobs.length,
    },
    waitingGoLive,
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

/**
 * What a customer actually asked for, and what changed when they did.
 *
 *   GET /api/admin/jobs/:jobId/edits
 *
 * "I asked for a change and nothing happened" is unanswerable without the request itself. The
 * first time it was said out loud, the request was in a column nothing could read, and the whole
 * diagnosis came down to guessing from a diff summary. Support needs the sentence they typed.
 */
app.get('/admin/jobs/:jobId/edits', requireAdmin, async (c) => {
  const db = await getDb()
  const jobId = c.req.param('jobId') ?? ''

  const rows = await db
    .select({
      versionFrom: schema.edits.versionFrom,
      versionTo: schema.edits.versionTo,
      prompt: schema.edits.prompt,
      diffSummary: schema.edits.diffSummary,
      counted: schema.edits.counted,
      createdAt: schema.edits.createdAt,
    })
    .from(schema.edits)
    .where(eq(schema.edits.jobId, jobId))
    .orderBy(schema.edits.createdAt)

  return c.json({ jobId, edits: rows })
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
