import type { BuildFacts, ContentPlan } from '../../../shared/plan.js'
import { pagesFor, robotsTxt, sitemapXml, type SitePage } from '../pages.js'
import { renderSite } from './site.js'
import { renderServicePage } from './servicePage.js'

/**
 * Render the whole page set.
 *
 * A build is no longer one file. It is the home page plus one service page per additional page the
 * customer bought, all sharing one stylesheet and one design system, plus a sitemap and a robots
 * file once there is more than one page to point at.
 */

export interface RenderedPage extends SitePage {
  html: string
}

export interface RenderedSet {
  pages: RenderedPage[]
  /** Extra files that are not pages and are not verified as pages. */
  files: Array<{ path: string; content: string; contentType: string }>
}

export function renderSiteSet(plan: ContentPlan, facts: BuildFacts): RenderedSet {
  const pages = pagesFor(plan)
  const baseUrl = facts.canonicalUrl.replace(/\/+$/, '')

  const rendered: RenderedPage[] = pages.map((page) =>
    page.depth === 0
      ? { ...page, html: renderSite(plan, facts) }
      : { ...page, html: renderServicePage({ plan, facts, page, pages, baseUrl }) },
  )

  const files: RenderedSet['files'] = []

  // A sitemap listing one URL tells a search engine nothing it could not work out, so these are
  // only written when there is actually a set.
  if (pages.length > 1) {
    const lastMod = new Date().toISOString().slice(0, 10)
    files.push({
      path: 'sitemap.xml',
      content: sitemapXml(baseUrl, pages, lastMod),
      contentType: 'application/xml; charset=utf-8',
    })
    files.push({
      path: 'robots.txt',
      content: robotsTxt(baseUrl),
      contentType: 'text/plain; charset=utf-8',
    })
  }

  return { pages: rendered, files }
}
