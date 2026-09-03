import type { BuildFacts, ContentPlan } from '../../shared/plan.js'

/**
 * The page set.
 *
 * The $197 build token buys ONE page. Each additional-page purchase buys one more, and each extra
 * page is a dedicated service page: one service, its own URL, its own copy written around that
 * service and the service area, its own heading structure and meta, its own enquiry form, and a
 * link in the navigation.
 *
 * URL STRUCTURE. Human readable, because this is sold as an SEO feature and an opaque URL would
 * undercut the whole point:
 *
 *   /                              index.html
 *   /services/blocked-drains/      services/blocked-drains/index.html
 *
 * Directories with an index.html, so the served URL is clean and the same file opens from disk in
 * a discharge zip. Links between pages are RELATIVE for exactly that reason: "/" would resolve to
 * the filesystem root when a customer double-clicks the file. See DECISIONS.md D43.
 */

export interface SitePage {
  /** Path within the site, used as the storage key suffix and the zip entry name. */
  path: string
  /** Clean URL for canonicals, the sitemap and the nav. Always starts and ends with a slash. */
  url: string
  /** null for the home page. */
  slug: string | null
  service: string | null
  title: string
  /** How many directories deep, so relative links can be built. */
  depth: number
}

/** kebab-case, ASCII, safe in a URL and readable by a person. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/**
 * Every page this plan produces, home first.
 *
 * The plan is the source of truth: `enforcePagesAllowed` has already trimmed it to what the
 * customer actually paid for, so nothing here needs to know about entitlement.
 */
export function pagesFor(plan: ContentPlan): SitePage[] {
  const home: SitePage = {
    path: 'index.html',
    url: '/',
    slug: null,
    service: null,
    title: plan.meta.title,
    depth: 0,
  }

  return [
    home,
    ...plan.servicePages.map((page) => ({
      path: `services/${page.slug}/index.html`,
      url: `/services/${page.slug}/`,
      slug: page.slug,
      service: page.service,
      title: page.title,
      depth: 2,
    })),
  ]
}

/**
 * A link from one page to another that works both when served and when opened from disk.
 *
 * An absolute "/services/x/" is correct on a server and points at the filesystem root when a
 * customer double-clicks index.html out of their discharge zip. Relative links work in both.
 */
export function relativeLink(from: SitePage, to: SitePage): string {
  const up = '../'.repeat(from.depth)
  if (to.depth === 0) return up === '' ? 'index.html' : `${up}index.html`
  return `${up}services/${to.slug}/index.html`
}

/** Absolute canonical for a page, from the site's own base URL. */
export function canonicalFor(base: string, page: SitePage): string {
  const root = base.replace(/\/+$/, '')
  return page.url === '/' ? `${root}/` : `${root}${page.url}`
}

/**
 * Trim the plan to what the customer has paid for.
 *
 * Server authoritative, and it runs on model output as well as the fixture. Two rules, and they
 * fail in opposite directions: never generate a page nobody paid for, and never silently drop a
 * page somebody did. The second is why this returns what it dropped rather than just dropping it.
 */
export function enforcePagesAllowed(
  plan: ContentPlan,
  pagesAllowed: number,
): { plan: ContentPlan; dropped: string[] } {
  // One of the allowance is always the home page.
  const extraAllowed = Math.max(0, pagesAllowed - 1)
  if (plan.servicePages.length <= extraAllowed) return { plan, dropped: [] }

  const kept = plan.servicePages.slice(0, extraAllowed)
  const dropped = plan.servicePages.slice(extraAllowed).map((p) => p.service)
  return { plan: { ...plan, servicePages: kept }, dropped }
}

/** robots.txt, written only when there is a sitemap worth pointing at. */
export function robotsTxt(base: string): string {
  const root = base.replace(/\/+$/, '')
  return `User-agent: *\nAllow: /\n\nSitemap: ${root}/sitemap.xml\n`
}

/** sitemap.xml listing every page in the set. */
export function sitemapXml(base: string, pages: SitePage[], lastMod: string): string {
  const urls = pages
    .map(
      (page) =>
        `  <url>\n    <loc>${canonicalFor(base, page)}</loc>\n    <lastmod>${lastMod}</lastmod>\n    <priority>${page.depth === 0 ? '1.0' : '0.8'}</priority>\n  </url>`,
    )
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
}

/**
 * BreadcrumbList for a service page. Decorative on a one-page site, real once there is a set:
 * Home, then the service.
 */
export function breadcrumbSchema(base: string, page: SitePage): Record<string, unknown> | null {
  if (page.depth === 0) return null
  const root = base.replace(/\/+$/, '')
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${root}/` },
      { '@type': 'ListItem', position: 2, name: page.service, item: canonicalFor(base, page) },
    ],
  }
}

/**
 * Service schema for a service page, tied back to the LocalBusiness by @id so the two are one
 * graph rather than two unrelated blobs. areaServed is the same shape the home page declares.
 */
export function serviceSchema(
  base: string,
  page: SitePage,
  plan: ContentPlan,
  facts: BuildFacts,
): Record<string, unknown> | null {
  if (page.depth === 0 || !page.service) return null
  const root = base.replace(/\/+$/, '')

  const areaServed =
    plan.schema.areaServed.mode === 'city'
      ? plan.schema.areaServed.cities.map((city) => ({ '@type': 'City', name: city }))
      : [
          {
            '@type': 'GeoCircle',
            geoMidpoint: {
              '@type': 'GeoCoordinates',
              latitude: plan.schema.areaServed.lat,
              longitude: plan.schema.areaServed.lng,
            },
            geoRadius: plan.schema.areaServed.radiusMetres,
          },
        ]

  return {
    '@context': 'https://schema.org',
    '@type': 'Service',
    '@id': `${canonicalFor(base, page)}#service`,
    name: page.service,
    serviceType: page.service,
    areaServed,
    provider: { '@id': `${root}/#business` },
    url: canonicalFor(base, page),
    ...(facts.phoneE164 ? { telephone: facts.phoneE164 } : {}),
  }
}
