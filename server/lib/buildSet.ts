import type { BuildFacts, ContentPlan } from '../../shared/plan.js'
import type { CheckResult, VerificationReport } from '../../shared/types.js'
import { getDb, schema } from '../db/client.js'
import { and, eq } from 'drizzle-orm'
import { id } from './ids.js'
import { storage } from './storage.js'
import { pagesFor, robotsTxt, sitemapXml, slugify, type SitePage } from './pages.js'
import { renderServicePage } from './render/servicePage.js'
import { verify } from './verify.js'
import { createRenderDriver } from './checks/render.js'

/**
 * Render, verify and persist a whole page set for one version.
 *
 * A build is the home page plus one service page per additional page the customer bought. The home
 * page comes in already built and already verified, because on the real path it is model output
 * that has been through the repair loop. The service pages are rendered deterministically from the
 * same plan and the same stylesheet, so the set is one site rather than one site and some pages.
 *
 * EVERY PAGE IS VERIFIED AND EVERY PAGE IS STORED. The version passes only when all of them pass.
 * A set reporting success because the home page passed is the failure this exists to prevent.
 *
 * Used by both the first build and every edit, so there is one place that knows what a version is
 * made of. See DECISIONS.md D43 and D45.
 */

export interface PersistedPage {
  path: string
  url: string
  title: string
  passed: boolean
  pageWeightBytes: number
}

export interface PersistedSet {
  pages: PersistedPage[]
  /** True only when every page passed. */
  passed: boolean
  /** The home page report, which is what the customer-facing summary still shows. */
  homeReport: VerificationReport
  /** Heaviest single page, which is what the weight budget is about. */
  heaviestBytes: number
  totalBytes: number
  failures: Array<{ path: string; checkId: string; detail: string }>
}

/** Where one page of one version lives in storage. */
export function pageBlobKey(jobId: string, version: number, path: string): string {
  return `jobs/${jobId}/builds/v${version}/${path}`
}

/**
 * CHECK 19: PAGES DELIVERED.
 *
 * Every other check asks whether a page is CORRECT. This asks whether it EXISTS. The bug that
 * caused it (D55) was not a bad page, it was a missing one: the customer paid for three, the
 * plan carried none, and every per-page check passed because every page that got built was fine.
 * A set can be flawless and still be short.
 *
 * Same reasoning as the duplicate mobile bar: a prompt instruction is a hope, a check is a
 * guarantee. A failing result makes the whole version fail, and publish refuses a version that
 * did not pass, so a short build cannot reach a customer.
 *
 * Pure and exported so the guarantee can be proved without a database, which is the only way a
 * test of it is worth anything.
 */
export function pagesDeliveredCheck(
  paidPageServices: string[],
  deliveredPaths: string[],
  /*
   * THE ENTITLEMENT, AND IT IS REQUIRED ON PURPOSE.
   *
   * This argument was added after the check passed a build that shipped one page to a customer
   * who had paid for five. The old signature compared the delivered pages against the services
   * the customer had CHOSEN, so when they chose nothing there was nothing to be missing, and it
   * returned "0 paid page(s) requested, 0 built" and passed. A guard that only fires once the
   * thing it guards is already populated is not a guard.
   *
   * It is required rather than optional so that TypeScript refuses to compile a call site that
   * forgets it. An optional argument would restore the exact failure: a caller omits it, the
   * entitlement half of the check silently switches off, and the build reports success.
   */
  pagesAllowed: number,
): CheckResult {
  const delivered = new Set(deliveredPaths)
  const missing = paidPageServices.filter(
    (service) => !delivered.has('services/' + slugify(service) + '/index.html'),
  )
  const built = paidPageServices.length - missing.length

  // Pages that were bought and then never pointed at a service. These never reach the plan at
  // all, which is why nothing further down the chain has any way of noticing them.
  const entitled = Math.max(0, (pagesAllowed || 1) - 1)
  const unallocated = Math.max(0, entitled - paidPageServices.length)

  const problems: string[] = []
  if (missing.length > 0) {
    problems.push('PAID FOR BUT NOT BUILT: ' + missing.join(', ') + '.')
  }
  if (unallocated > 0) {
    problems.push(
      'PAID FOR BUT NEVER CHOSEN: ' + unallocated + ' of ' + entitled +
        ' additional page(s) were never assigned to a service, so nothing was ever built for them.',
    )
  }

  return {
    id: 'pages_delivered',
    label: 'Every page they paid for was built',
    status: problems.length === 0 ? 'pass' : 'fail',
    detail:
      problems.length === 0
        ? entitled + ' additional page(s) paid for, ' + built + ' built'
        : problems.join(' ') + ' The customer has been charged for ' + entitled +
          ' additional page(s) and this build contains ' + built +
          '. This build must not be published.',
    evidence: unallocated > 0 ? [...missing, 'unallocated:' + unallocated] : missing,
  }
}

export async function persistPageSet(args: {
  jobId: string
  version: number
  plan: ContentPlan
  facts: BuildFacts
  /** The home page, already verified and repaired. */
  homeHtml: string
  homeReport: VerificationReport
  repairPasses?: number
  /** Render checks are expensive; the caller decides whether the service pages get them. */
  runRender?: boolean
  /**
   * What the customer actually paid for: every service they asked to have its own page.
   * Supplied so the set can be checked against the entitlement rather than against the plan,
   * which is the thing that was wrong. See DECISIONS.md D55.
   */
  paidPageServices?: string[]
  /**
   * The page allowance off the job row. Required, so a caller cannot quietly disable the half of
   * the entitlement check that catches pages the customer bought and never allocated.
   */
  pagesAllowed: number
}): Promise<PersistedSet> {
  const { jobId, version, plan, facts, homeHtml, homeReport } = args
  const db = await getDb()
  const store = storage()

  const pages = pagesFor(plan)
  const home = pages[0]!
  const baseUrl = facts.canonicalUrl.replace(/\/+$/, '')

  const persisted: PersistedPage[] = []
  const failures: PersistedSet['failures'] = []

  const record = async (page: SitePage, html: string, report: VerificationReport) => {
    const blobKey = pageBlobKey(jobId, version, page.path)
    await store.put(blobKey, html, 'text/html; charset=utf-8')

    await db.insert(schema.buildPages).values({
      id: id('bpg'),
      jobId,
      version,
      path: page.path,
      url: page.url,
      serviceSlug: page.slug,
      title: page.title,
      blobKey,
      bytes: html.length,
      pageWeightBytes: report.pageWeightBytes,
      checks: report,
      passed: report.passed,
    })
      /*
       * A RETRY MUST NOT DIE ON THE LEFTOVERS OF AN ABORTED ATTEMPT.
       *
       * nextVersion counts rows in the builds table, and a run that wrote its pages and then
       * failed before writing the build row leaves those pages behind at that version. The next
       * attempt asks for the same version, hits build_pages_version_path_idx, and dies. Every
       * retry then dies the same way, so the job is stuck permanently on the wreckage of the
       * first failure.
       *
       * Seen for real on 2026-08-27: three interrupted builds on one job, and the fourth reached
       * "All 18 checks passed" and then threw a unique violation inserting index.html.
       *
       * The plans table already handles this exact case in the same way and for the same reason.
       * A page sitting at this version belongs to an attempt that never finished, so replacing it
       * is right.
       */
      .onConflictDoUpdate({
        target: [schema.buildPages.jobId, schema.buildPages.version, schema.buildPages.path],
        set: {
          url: page.url,
          serviceSlug: page.slug,
          title: page.title,
          blobKey,
          bytes: html.length,
          pageWeightBytes: report.pageWeightBytes,
          checks: report,
          passed: report.passed,
        },
      })

    for (const check of [...report.static, ...report.render]) {
      if (check.status === 'fail') {
        failures.push({ path: page.path, checkId: check.id, detail: check.detail ?? '' })
      }
    }

    persisted.push({
      path: page.path,
      url: page.url,
      title: page.title,
      passed: report.passed,
      pageWeightBytes: report.pageWeightBytes,
    })
    return html.length
  }

  let totalBytes = await record(home, homeHtml, homeReport)

  /*
   * THE SERVICE PAGES GET LOOKED AT, ON ONE BROWSER.
   *
   * This passed `args.runRender ?? false` and no caller ever passed true, so no service page has
   * ever been through a browser: not on a build, not on a publish, not anywhere. verifySet exists
   * because "a multi-page build reported success because the home page was checked and the rest
   * were not" was a real failure, and this default reproduced it for exactly the checks that
   * needed a browser to see.
   *
   * What that cost: ten service pages shipped with a header logo pointing at a file two
   * directories away, and "Start a conversation" in white on a white card, past eighteen green
   * checks. Both are things a browser sees immediately and no amount of reading the markup does.
   *
   * One driver for the whole set. Launching Chromium costs seconds and, in a function, a cold
   * start; eleven launches against one time limit is how this becomes "turn it off again".
   * Opened once here, handed to every page, closed in the finally.
   */
  const driver = args.runRender === false ? null : createRenderDriver()
  try {
    for (const page of pages.slice(1)) {
      const html = renderServicePage({ plan, facts, page, pages, baseUrl })
      const report = await verify(html, facts, {
        runRender: args.runRender,
        driver,
      })
      totalBytes += await record(page, html, report)
    }
  } finally {
    await driver?.dispose()
  }

  // A sitemap listing one URL tells a search engine nothing it could not work out, so these are
  // written only when there is actually a set. They are files, not pages: not verified as pages.
  if (pages.length > 1) {
    const lastMod = new Date().toISOString().slice(0, 10)
    await store.put(
      pageBlobKey(jobId, version, 'sitemap.xml'),
      sitemapXml(baseUrl, pages, lastMod),
      'application/xml; charset=utf-8',
    )
    await store.put(
      pageBlobKey(jobId, version, 'robots.txt'),
      robotsTxt(baseUrl),
      'text/plain; charset=utf-8',
    )
  }

  const pagesDelivered = pagesDeliveredCheck(
    args.paidPageServices ?? [],
    persisted.map((page) => page.path),
    args.pagesAllowed,
  )

  homeReport.static.push(pagesDelivered)
  if (pagesDelivered.status === "fail") {
    homeReport.passed = false
    failures.push({ path: 'index.html', checkId: 'pages_delivered', detail: pagesDelivered.detail ?? '' })
  }

  const passed = persisted.every((p) => p.passed) && pagesDelivered.status === "pass"

  await db.insert(schema.builds).values({
    id: id('bld'),
    jobId,
    version,
    // The builds row still points at the home page, so everything that reads a "the build" keeps
    // working. The set lives in build_pages.
    blobKey: pageBlobKey(jobId, version, 'index.html'),
    bytes: totalBytes,
    pageWeightBytes: Math.max(...persisted.map((p) => p.pageWeightBytes)),
    checks: homeReport,
    passed,
    repairPasses: args.repairPasses ?? 0,
  })

  return {
    pages: persisted,
    passed,
    homeReport,
    heaviestBytes: Math.max(...persisted.map((p) => p.pageWeightBytes)),
    totalBytes,
    failures,
  }
}

/**
 * Carry a whole page set forward into a new version with one deterministic change applied to
 * every page.
 *
 * This exists for the Web3Forms key swap at go-live. That swap has to reach every page, because a
 * service page still posting to the Go Polar account sends that page's enquiries to us after the
 * customer has gone live, and it is exactly the page nobody thinks to check. See DECISIONS.md D29.
 *
 * A version built before page sets existed has no build_pages rows, so the home page is read from
 * the builds row and the new version is written as a one page set.
 */
export async function copyPageSet(args: {
  jobId: string
  fromVersion: number
  toVersion: number
  facts: BuildFacts
  /** Applied to each page. Returning null aborts the whole copy, so a set cannot go half swapped. */
  transform: (html: string, path: string) => { html: string } | null
  runRender?: boolean
}): Promise<{ pages: PersistedPage[]; passed: boolean; homeReport: VerificationReport | null } | { error: string }> {
  const { jobId, fromVersion, toVersion, facts } = args
  const db = await getDb()
  const store = storage()

  let source = await loadPageSet(jobId, fromVersion)
  if (source.length === 0) {
    const rows = await db
      .select()
      .from(schema.builds)
      .where(and(eq(schema.builds.jobId, jobId), eq(schema.builds.version, fromVersion)))
      .limit(1)
    const row = rows[0]
    if (!row) return { error: 'The current build is missing.' }
    source = [
      {
        path: 'index.html',
        url: '/',
        title: '',
        blobKey: row.blobKey,
        serviceSlug: null,
        passed: row.passed,
        pageWeightBytes: row.pageWeightBytes ?? 0,
      },
    ]
  }

  // Transform everything before writing anything. A page that will not swap cleanly stops the
  // whole thing here, with the previous version untouched.
  const transformed: Array<{ page: (typeof source)[number]; html: string }> = []
  for (const page of source) {
    const html = await store.getText(page.blobKey)
    if (html === null) return { error: `Page ${page.path} is missing from storage.` }
    const result = args.transform(html, page.path)
    if (!result) return { error: `Could not apply the change to ${page.path}.` }
    transformed.push({ page, html: result.html })
  }

  const persisted: PersistedPage[] = []
  let homeReport: VerificationReport | null = null
  let totalBytes = 0

  for (const { page, html } of transformed) {
    const report = await verify(html, facts, { runRender: args.runRender ?? false })
    if (page.path === 'index.html') homeReport = report

    const blobKey = pageBlobKey(jobId, toVersion, page.path)
    await store.put(blobKey, html, 'text/html; charset=utf-8')
    totalBytes += html.length

    await db.insert(schema.buildPages).values({
      id: id('bpg'),
      jobId,
      version: toVersion,
      path: page.path,
      url: page.url,
      serviceSlug: page.serviceSlug,
      title: page.title,
      blobKey,
      bytes: html.length,
      pageWeightBytes: report.pageWeightBytes,
      checks: report,
      passed: report.passed,
    })

    persisted.push({
      path: page.path,
      url: page.url,
      title: page.title,
      passed: report.passed,
      pageWeightBytes: report.pageWeightBytes,
    })
  }

  const passed = persisted.every((p) => p.passed)

  await db.insert(schema.builds).values({
    id: id('bld'),
    jobId,
    version: toVersion,
    blobKey: pageBlobKey(jobId, toVersion, 'index.html'),
    bytes: totalBytes,
    pageWeightBytes: Math.max(...persisted.map((p) => p.pageWeightBytes)),
    checks: homeReport,
    passed,
  })

  // Carry the sitemap and robots forward too, so the new version is a complete set on its own.
  if (persisted.length > 1) {
    const baseUrl = facts.canonicalUrl.replace(/\/+$/, '')
    const lastMod = new Date().toISOString().slice(0, 10)
    const pages = persisted.map((p) => ({
      path: p.path,
      url: p.url,
      title: p.title,
      slug: p.path === 'index.html' ? null : p.path.split('/')[1] ?? null,
      service: null,
    }))
    await store.put(
      pageBlobKey(jobId, toVersion, 'sitemap.xml'),
      sitemapXml(baseUrl, pages as unknown as SitePage[], lastMod),
      'application/xml; charset=utf-8',
    )
    await store.put(pageBlobKey(jobId, toVersion, 'robots.txt'), robotsTxt(baseUrl), 'text/plain; charset=utf-8')
  }

  return { pages: persisted, passed, homeReport }
}

/** Every stored page of one version, home first. */
export async function loadPageSet(
  jobId: string,
  version: number,
): Promise<
  Array<{
    path: string
    url: string
    title: string
    blobKey: string
    serviceSlug: string | null
    passed: boolean
    pageWeightBytes: number
  }>
> {
  const db = await getDb()
  const rows = await db
    .select()
    .from(schema.buildPages)
    .where(and(eq(schema.buildPages.jobId, jobId), eq(schema.buildPages.version, version)))

  // Home first, then the service pages in a stable order.
  return rows
    .map((r) => ({
      path: r.path,
      url: r.url,
      title: r.title,
      blobKey: r.blobKey,
      serviceSlug: r.serviceSlug,
      passed: r.passed,
      pageWeightBytes: r.pageWeightBytes ?? 0,
    }))
    .sort((a, b) => (a.path === 'index.html' ? -1 : b.path === 'index.html' ? 1 : a.path.localeCompare(b.path)))
}
