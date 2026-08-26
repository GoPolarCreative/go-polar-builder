import { and, desc, eq } from 'drizzle-orm'
import { getDb, schema } from '../db/client.js'
import { intakeSchema, type IntakePayload } from '../../shared/intake.js'
import type { ContentPlan } from '../../shared/plan.js'
import type { CheckResult } from '../../shared/types.js'
import { buildFacts } from './facts.js'
import { getIntake, getUserForJob, listAssets, recordEvent } from './db.js'
import { config } from '../config.js'
import { trackKlaviyoSafely } from './klaviyo.js'
import { loadPageSet, pagesDeliveredCheck } from './buildSet.js'
import { generateFavicon } from './discharge.js'
import { publishSite, type PublishResult } from './publish.js'
import { storage } from './storage.js'
import { verify } from './verify.js'

/**
 * The one place a website becomes public.
 *
 * WHY THIS IS A LIBRARY AND NOT TWO ROUTE HANDLERS. There are now two callers: the operator
 * endpoint Chris uses, and the customer's own publish button. They must not be two
 * implementations of "is this safe to publish", because the whole failure mode this product keeps
 * hitting is a rule that exists in one path and not the other. Everything here runs for both. The
 * ONLY difference either caller gets is `force`, which the customer route never passes.
 *
 * WHAT IT REFUSES, AND WHY EACH ONE MATTERS
 *
 *   hosting unpaid          Publishing starts a service nobody is paying for.
 *   forms key unverified    The live site would post enquiries to Go Polar's inbox, so the
 *                           customer would never see a single lead from the site they bought.
 *                           This is the worst failure available to this product (D29).
 *   a page missing          A partial site is worse than no site.
 *   any check fails         Covered below.
 *   a paid page absent      They were charged for it (D55).
 *
 * CHECKS ARE RE-RUN HERE, NOT READ OFF A FLAG. `builds.passed` records how a version looked when
 * it was BUILT. Publishing can happen much later, against a different version after a rollback,
 * with a plan or an asset set that has moved underneath it. A stored boolean is a memory of a
 * check; running the check is the check. It costs a couple of seconds on a path a customer takes
 * a handful of times a month.
 *
 * WHAT "ALL THE CHECKS" HONESTLY MEANS IN PRODUCTION. There are 19. Four of them drive a real
 * browser, and production runs with `renderDriver: none` because there is no browser in a
 * serverless function. Those four come back `skipped`, not `pass`, and `reportPassed` only ever
 * blocks on `fail`. So production enforces the 15 static checks plus the paid-pages check, and
 * the render four are enforced at build time on a machine that has a browser. That is a real
 * limitation and it is stated rather than papered over.
 *
 * NOTHING IS WRITTEN UNTIL EVERYTHING IS READ. Every page is loaded and verified before the first
 * byte reaches storage. A refusal half way through would otherwise leave a live site as a mix of
 * old and new pages, which is the silent partial delivery this codebase has already produced
 * twice.
 */

export interface PublishRefusal {
  ok: false
  status: 400 | 404 | 409 | 422
  error: string
  detail: string
  /** Present when checks were the reason. One entry per failing page. */
  failures?: Array<{ path: string; checkId: string; detail: string }>
}

export interface PublishSuccess {
  ok: true
  result: PublishResult
  /** Which pages were verified on the way through, and what the checks said. */
  verified: Array<{ path: string; checks: CheckResult[] }>
  renderChecksSkipped: boolean
}

export type PublishOutcome = PublishRefusal | PublishSuccess

const refuse = (
  status: PublishRefusal['status'],
  error: string,
  detail: string,
  failures?: PublishRefusal['failures'],
): PublishRefusal => ({ ok: false, status, error, detail, failures })

/** Strip anything that is not a bare host. Accepts what a customer might paste. */
export function normaliseHostname(raw: string): string {
  return (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
}

/**
 * The hostname this job is already live on, if any.
 *
 * The customer route does not accept a hostname from the browser. Letting a caller name the host
 * it publishes to is fine for an operator and wrong for a customer: it is an instruction to write
 * to an arbitrary key in shared storage. Their host comes from the domain we connected for them.
 */
export async function liveHostnameFor(jobId: string): Promise<string | null> {
  const db = await getDb()
  const [row] = await db
    .select({ hostname: schema.sites.hostname })
    .from(schema.sites)
    .where(eq(schema.sites.jobId, jobId))
    .limit(1)
  return row?.hostname ?? null
}

export async function publishJob(args: {
  jobId: string
  hostname: string
  /** Operator escape hatch. Skips the hosting-paid and checks gates. Never set by a customer. */
  force?: boolean
  /** Recorded on the event so the log distinguishes a customer publish from an operator one. */
  actor: 'customer' | 'operator'
  /** Set when this publish is a rollback, so the event says so. */
  restoredFromVersion?: number
}): Promise<PublishOutcome> {
  const { jobId, actor } = args
  const hostname = normaliseHostname(args.hostname)
  if (!jobId || !hostname) return refuse(400, 'bad_request', 'A job and a hostname are both required.')

  const db = await getDb()
  const store = storage()

  const [jobRow] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1)
  if (!jobRow) return refuse(404, 'not_found', `No job ${jobId}.`)

  const [goliveRow] = await db
    .select()
    .from(schema.golive)
    .where(eq(schema.golive.jobId, jobId))
    .limit(1)

  /*
   * A cancelled subscription stops new publishes. The operator force flag deliberately still
   * works: Chris may well need to push a correction to a site whose billing has lapsed while he
   * sorts it out with them.
   */
  if (goliveRow?.hostingStatus === 'cancelled' && !args.force) {
    return refuse(
      409,
      'hosting_ended',
      'The hosting subscription on this job has ended, so it cannot publish changes. The website that is already online is untouched.',
    )
  }

  if (!goliveRow?.paidAt && !args.force) {
    return refuse(
      409,
      'not_paid',
      'Hosting has not been paid for on this job, so it cannot go on the internet yet.',
    )
  }

  if (!jobRow.web3formsVerifiedAt) {
    return refuse(
      409,
      'forms_key_unverified',
      'The enquiry form on this site still posts to Go Polar rather than to the customer. Publishing is blocked until they connect their own inbox, or every enquiry their website earns would land in our mailbox instead of theirs.',
    )
  }

  const version = jobRow.currentVersion
  const [buildRow] = await db
    .select()
    .from(schema.builds)
    .where(and(eq(schema.builds.jobId, jobId), eq(schema.builds.version, version)))
    .limit(1)
  if (!buildRow) return refuse(404, 'not_found', `This job has no build at version ${version}.`)

  const [planRow] = await db
    .select({ plan: schema.plans.plan })
    .from(schema.plans)
    .where(and(eq(schema.plans.jobId, jobId), eq(schema.plans.version, version)))
    .limit(1)
  if (!planRow) return refuse(404, 'not_found', 'That version has no plan stored beside it.')

  const [stored, assets] = await Promise.all([getIntake(jobId), listAssets(jobId)])
  const parsed = intakeSchema.safeParse(stored?.payload)
  if (!parsed.success) return refuse(422, 'invalid_intake', 'The stored answers could not be read.')
  const intake = parsed.data as IntakePayload
  const facts = buildFacts(intake, assets)

  // ---------------------------------------------------------------------------------------
  // Read everything first. Nothing below this line writes until all of it has passed.
  // ---------------------------------------------------------------------------------------
  const set = await loadPageSet(jobId, version)
  const home = set.find((p) => p.path === 'index.html')
  const homeHtml = await store.getText(home ? home.blobKey : buildRow.blobKey)
  if (homeHtml === null) return refuse(404, 'not_found', 'The home page is missing from storage.')

  const pages: Array<{ path: string; html: string }> = [{ path: 'index.html', html: homeHtml }]
  for (const page of set.filter((p) => p.path !== 'index.html')) {
    const html = await store.getText(page.blobKey)
    if (html === null) {
      return refuse(
        409,
        'page_missing',
        `${page.path} is missing from storage. Nothing has been published, because a site missing one of its pages is worse than a site that has not changed.`,
      )
    }
    pages.push({ path: page.path, html })
  }

  // ---------------------------------------------------------------------------------------
  // Verify every page. Render checks are requested and will report themselves skipped where
  // there is no browser, which is not the same as passing and is not treated as a failure.
  // ---------------------------------------------------------------------------------------
  const verified: PublishSuccess['verified'] = []
  const failures: NonNullable<PublishRefusal['failures']> = []
  let renderChecksSkipped = false

  for (const page of pages) {
    const report = await verify(page.html, facts)
    renderChecksSkipped = renderChecksSkipped || report.renderSkipped
    const checks = [...report.static, ...report.render]
    verified.push({ path: page.path, checks })
    for (const check of checks) {
      if (check.status === 'fail') {
        failures.push({ path: page.path, checkId: check.id, detail: check.detail ?? check.label })
      }
    }
  }

  /*
   * The entitlement check, on the live path as well as the build path.
   *
   * D55 put this on persistPageSet, which covers a fresh build. It has to run here too: a
   * rollback can select an older version that predates a page the customer has since paid for,
   * and publishing that would quietly take the page off their live site.
   */
  const paidPageServices = (intake.ownPageServices ?? []).filter((n) => intake.services.includes(n))
  const delivered = pages.map((p) => p.path)
  const pagesCheck = pagesDeliveredCheck(paidPageServices, delivered, jobRow.pagesAllowed)
  const homeEntry = verified.find((v) => v.path === 'index.html')
  if (homeEntry) homeEntry.checks.push(pagesCheck)
  if (pagesCheck.status === 'fail') {
    failures.push({ path: 'index.html', checkId: 'pages_delivered', detail: pagesCheck.detail ?? '' })
  }

  if (failures.length > 0 && !args.force) {
    await recordEvent(jobId, 'publish.refused', { actor, version, hostname, failures })
    return refuse(
      409,
      'checks_failed',
      `This version did not pass its checks, so nothing was published and the live site is untouched. ${failures.length} problem(s) found.`,
      failures,
    )
  }

  // ---------------------------------------------------------------------------------------
  // Everything passed. Now write.
  // ---------------------------------------------------------------------------------------
  const extraFiles: Array<{ path: string; content: string; contentType: string }> = []

  // A decorative tab icon must never be the reason a go live fails. See admin.ts for the history.
  try {
    extraFiles.push({
      path: 'favicon.svg',
      content: generateFavicon(planRow.plan as ContentPlan),
      contentType: 'image/svg+xml',
    })
  } catch (err) {
    await recordEvent(jobId, 'publish.favicon_skipped', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  if (pages.length > 1) {
    for (const [path, contentType] of [
      ['sitemap.xml', 'application/xml; charset=utf-8'],
      ['robots.txt', 'text/plain; charset=utf-8'],
    ] as const) {
      const content = await store.getText(`jobs/${jobId}/builds/v${version}/${path}`)
      if (content !== null) extraFiles.push({ path, content, contentType })
    }
  }

  const result = await publishSite({
    jobId,
    hostname,
    version,
    html: homeHtml,
    facts,
    extraPages: pages.filter((p) => p.path !== 'index.html'),
    extraFiles,
  })

  await recordEvent(jobId, 'publish.done', {
    actor,
    version,
    hostname,
    pages: result.pages,
    restoredFrom: args.restoredFromVersion ?? null,
    forced: Boolean(args.force),
  })

  /*
   * TELL CHRIS A CUSTOMER CHANGED THEIR LIVE SITE.
   *
   * THIS IS NOT A JOB QUEUE ITEM. Publishing has already overwritten the documents the public is
   * served (see D24: findSiteByHostname derives the blob key from hostname and path, never from
   * the version, so the new bytes are live the moment they are written). Nothing is waiting for
   * Chris. This alert exists so he knows a change happened and can eyeball it, which matters
   * because the person who rings him about a website that "looks wrong" will not mention that
   * they changed it themselves an hour ago.
   *
   * It carries WHAT CHANGED and WHICH VERSION so the alert is readable without opening anything,
   * and the previous version so he can put it back from /ops if they ring in a panic.
   *
   * Operator publishes do not alert: Chris does not need an email about his own action.
   */
  if (actor === 'customer') {
    const cfg = config()
    const user = await getUserForJob(jobId)
    const previous = await previousPublishedVersion(jobId, version)
    const summary = await lastEditSummary(jobId)

    await trackKlaviyoSafely({
      metric: 'operator_alert',
      profile: { email: cfg.operatorEmail },
      jobId,
      properties: {
        alert: args.restoredFromVersion ? 'customer_restored' : 'customer_published',
        business_name: jobRow.businessName ?? 'Unnamed business',
        customer_email: user?.email ?? '',
        job_id: jobId,
        hostname,
        site_url: `https://${hostname}`,
        version,
        previous_version: previous ?? '',
        // The customer's own words for the change, which is the most useful line in the alert.
        what_changed: summary ?? 'No description recorded',
        pages: result.pages,
        ops_link: `${cfg.publicAppUrl.replace(/\/$/, '')}/ops#job-${jobId}`,
        note: previous
          ? `Nothing to do. If they ring about it, version ${previous} can be put back from /ops.`
          : 'Nothing to do. This is their first published version, so there is nothing to roll back to.',
      },
    })
  }

  return { ok: true, result, verified, renderChecksSkipped }
}

/**
 * The version that was live before this one, so an alert can offer a way back.
 *
 * Read off the publish events rather than the builds table: what matters is what was PUBLISHED,
 * not what was built. A customer can build five versions and publish one.
 */
export async function previousPublishedVersion(jobId: string, current: number): Promise<number | null> {
  const db = await getDb()
  const rows = await db
    .select({ payload: schema.events.payload })
    .from(schema.events)
    .where(and(eq(schema.events.jobId, jobId), eq(schema.events.type, 'publish.done')))
    .orderBy(desc(schema.events.createdAt))
    .limit(20)

  for (const row of rows) {
    const v = (row.payload as { version?: number } | null)?.version
    if (typeof v === 'number' && v !== current) return v
  }
  return null
}

/** What the customer asked for, in their words, on the edit that produced this version. */
export async function lastEditSummary(jobId: string): Promise<string | null> {
  const db = await getDb()
  const [row] = await db
    .select({ prompt: schema.edits.prompt, diffSummary: schema.edits.diffSummary })
    .from(schema.edits)
    .where(and(eq(schema.edits.jobId, jobId), eq(schema.edits.counted, true)))
    .orderBy(desc(schema.edits.createdAt))
    .limit(1)
  if (!row) return null
  const text = row.prompt ?? row.diffSummary
  return text ? text.slice(0, 300) : null
}
