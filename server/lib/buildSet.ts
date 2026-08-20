import type { BuildFacts, ContentPlan } from '../../shared/plan'
import type { VerificationReport } from '../../shared/types'
import { getDb, schema } from '../db/client'
import { and, eq } from 'drizzle-orm'
import { id } from './ids'
import { storage } from './storage'
import { pagesFor, robotsTxt, sitemapXml, type SitePage } from './pages'
import { renderServicePage } from './render/servicePage'
import { verify } from './verify'

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

  for (const page of pages.slice(1)) {
    const html = renderServicePage({ plan, facts, page, pages, baseUrl })
    const report = await verify(html, facts, { runRender: args.runRender ?? false })
    totalBytes += await record(page, html, report)
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

  const passed = persisted.every((p) => p.passed)

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
