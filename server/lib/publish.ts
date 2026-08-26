import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '../db/client.js'
import type { BuildFacts } from '../../shared/plan.js'
import { config, web3formsKey } from '../config.js'
import { storage } from './storage.js'
import { assertNoGoPolarKey } from './web3forms.js'
import { id } from './ids.js'
import { getJob, getUserForJob, recordEvent } from './db.js'
import { trackKlaviyoSafely } from './klaviyo.js'
import { fakeDomainAttach } from './integrations/fakes.js'

/**
 * Publishing a finished site so visitors can reach it. Brief s2: hosting is $30/month.
 *
 * HOW IT WORKS (DECISIONS.md D24). At go-live the stored index.html is rewritten so every asset
 * path becomes an absolute URL to the stored file, and the result is saved as the site's live
 * document. Requests arriving on a customer hostname are answered by the API function with that
 * document; the images come straight from storage rather than through a function.
 *
 * That split matters for cost. One function invocation serves the HTML, which is tens of
 * kilobytes. The images, which are the actual bandwidth, are served by the storage CDN with a
 * long cache header and never touch compute. See D25 for the bandwidth maths.
 */

export interface PublishResult {
  hostname: string
  version: number
  bytes: number
  assetsRewritten: number
  /** How many HTML pages are now live on this hostname. */
  pages: number
}

/**
 * Rewrite asset references to the URLs the storage layer actually serves.
 *
 * THIS USED TO BE A PLAIN SUBSTRING REPLACE AND IT BROKE TWO THINGS SILENTLY.
 *
 * The manifest holds bare paths like `assets/photo-01.jpg`, and the home page references them
 * exactly that way, so a substring replace was right for the case it was written for. It was
 * wrong for every other way the same file gets named:
 *
 *   - A service page lives at `services/<slug>/index.html` and references `../../assets/x.jpg`.
 *     Replacing the tail left `../../https://blob.../key`, so EVERY IMAGE ON EVERY PAID SERVICE
 *     PAGE was broken on the published site. Nothing caught it: the build passes, the page
 *     renders, the images just do not appear.
 *   - The JSON-LD `image` field and the new og:image build an absolute URL as
 *     `https://theirsite.com.au/assets/logo.svg`. Replacing the tail left
 *     `https://theirsite.com.au/https://blob.../key`.
 *
 * So the match now swallows whatever prefix names the same file: a run of `../`, or an absolute
 * origin. Longest manifest paths still go first, so `photo-01-thumb.webp` is replaced before
 * `photo-01.webp` and the shorter name cannot corrupt the longer one.
 */

/** Escape a manifest path for use inside a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function rewriteAssetPaths(
  html: string,
  facts: BuildFacts,
  urlFor: (key: string) => string,
): { html: string; count: number } {
  let out = html
  let count = 0

  for (const path of Object.keys(facts.assetManifest).sort((a, b) => b.length - a.length)) {
    const meta = facts.assetManifest[path]!
    if (!out.includes(path)) continue

    /*
     * Optionally an absolute origin, or optionally a run of ../, then the path itself. The
     * character class stops the origin from running past the end of the attribute it sits in,
     * which is what keeps two URLs on the same line from being merged into one.
     */
    const pattern = new RegExp(
      '(?:https?:\\/\\/[^"\'\\s<>)]*?\\/|(?:\\.\\.\\/)+)?' + escapeRegExp(path),
      'g',
    )

    const before = out
    out = out.replace(pattern, urlFor(meta.key))
    if (out !== before) count++
  }

  return { html: out, count }
}

export async function publishSite(args: {
  jobId: string
  hostname: string
  version: number
  html: string
  facts: BuildFacts
  /** The rest of the set. Home comes in as `html` because it is the page the caller already had. */
  extraPages?: Array<{ path: string; html: string }>
  /** sitemap.xml and robots.txt, served as they are. */
  extraFiles?: Array<{ path: string; content: string; contentType: string }>
}): Promise<PublishResult> {
  const cfg = config()
  const store = storage()
  const db = await getDb()

  const goPolar = web3formsKey(cfg)
  // The last line of defence for the customer's leads. Whatever route got us here, a document
  // that still posts to Go Polar's Web3Forms account does not go on the public internet. Every
  // page is checked, because the one nobody looks at is the one that leaks. See DECISIONS.md D29.
  assertNoGoPolarKey(args.html, goPolar)
  for (const page of args.extraPages ?? []) assertNoGoPolarKey(page.html, goPolar)

  const base = cfg.publicAppUrl.replace(/\/$/, '')
  // With Vercel Blob the stored object has its own public URL. Locally there is no CDN, so the
  // asset route on this app stands in, which keeps the local preview honest.
  const urlFor = (key: string) =>
    store.driver === 'vercel-blob' ? `${base}/api/site-asset/${encodeURIComponent(key)}` : `${base}/api/site-asset/${encodeURIComponent(key)}`

  const rewritten = rewriteAssetPaths(args.html, args.facts, urlFor)
  const blobKey = `sites/${args.hostname}/index.html`
  await store.put(blobKey, rewritten.html, 'text/html; charset=utf-8')

  // Service pages, under the same path the links already use, so /services/<slug>/ resolves.
  let pagesPublished = 1
  for (const page of args.extraPages ?? []) {
    const out = rewriteAssetPaths(page.html, args.facts, urlFor)
    await store.put(`sites/${args.hostname}/${page.path}`, out.html, 'text/html; charset=utf-8')
    pagesPublished++
  }

  for (const file of args.extraFiles ?? []) {
    await store.put(`sites/${args.hostname}/${file.path}`, file.content, file.contentType)
  }

  const existing = await db
    .select({ id: schema.sites.id })
    .from(schema.sites)
    .where(eq(schema.sites.hostname, args.hostname))
    .limit(1)

  // Read before the upsert below, which makes every publish look like an existing one.
  const isFirstPublish = !existing[0]
  const jobRow = await getJob(args.jobId)

  if (existing[0]) {
    await db
      .update(schema.sites)
      .set({ jobId: args.jobId, version: args.version, live: true, updatedAt: new Date() })
      .where(eq(schema.sites.id, existing[0].id))
  } else {
    await db.insert(schema.sites).values({
      id: id('site'),
      jobId: args.jobId,
      hostname: args.hostname,
      version: args.version,
      live: true,
    })
  }

  await recordEvent(args.jobId, 'site.published', {
    hostname: args.hostname,
    version: args.version,
    bytes: rewritten.html.length,
    pages: pagesPublished,
  })

  /*
   * TELL THE CUSTOMER THEIR SITE IS UP.
   *
   * This is the first moment the thing they bought exists at an address, and until now it was
   * also the quietest: a row in the events table and nothing else. No email, no confirmation,
   * nothing to forward to their partner.
   *
   * `is_first_publish` is computed BEFORE the sites row is written above, because after the
   * upsert every publish looks like an existing one. A flow that welcomes somebody to their new
   * website must not fire again when they change a photo six weeks later.
   *
   * Safely, and after the publish is complete: Klaviyo being down must never turn a successful
   * publish into a failed request. The site is live either way.
   */
  const owner = await getUserForJob(args.jobId)
  if (owner?.email) {
    await trackKlaviyoSafely({
      metric: 'site_live',
      profile: { email: owner.email, businessName: jobRow?.businessName ?? null },
      jobId: args.jobId,
      properties: {
        site_url: `https://${args.hostname}`,
        hostname: args.hostname,
        business_name: jobRow?.businessName ?? '',
        pages: pagesPublished,
        is_first_publish: isFirstPublish,
      },
    })
  }

  return {
    hostname: args.hostname,
    version: args.version,
    bytes: rewritten.html.length,
    assetsRewritten: rewritten.count,
    pages: pagesPublished,
  }
}

/**
 * Turn a request path into the stored object that answers it.
 *
 * Pages are directories with an index.html inside, so /services/gutter-cleaning/ and
 * /services/gutter-cleaning both resolve to the same file, and a trailing slash is not something a
 * visitor has to get right. Anything with a .. in it is refused rather than normalised, because
 * normalising a traversal attempt is how one gets through.
 */
export function siteObjectKey(hostname: string, requestPath: string): string | null {
  const clean = decodeURIComponent(requestPath.split('?')[0] ?? '/')
  if (clean.includes('..')) return null

  const trimmed = clean.replace(/^\/+/, '').replace(/\/+$/, '')
  if (trimmed === '') return SITE_PREFIX + hostname + '/index.html'
  if (trimmed === 'sitemap.xml' || trimmed === 'robots.txt') return SITE_PREFIX + hostname + '/' + trimmed
  if (trimmed.endsWith('.html')) return SITE_PREFIX + hostname + '/' + trimmed
  return SITE_PREFIX + hostname + '/' + trimmed + '/index.html'
}

const SITE_PREFIX = 'sites/'

export async function findSiteByHostname(
  hostname: string,
  requestPath = '/',
): Promise<{ jobId: string; version: number; blobKey: string } | null> {
  const db = await getDb()
  const host = hostname.toLowerCase().replace(/:\d+$/, '')
  const rows = await db
    .select()
    .from(schema.sites)
    .where(and(eq(schema.sites.hostname, host), eq(schema.sites.live, true)))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  const blobKey = siteObjectKey(row.hostname, requestPath)
  if (!blobKey) return null
  return { jobId: row.jobId, version: row.version, blobKey }
}

/**
 * Attach a custom domain to the Vercel project so a certificate is issued and traffic arrives.
 *
 * A live DNS action, so it is gated. In demo mode it logs what it would have done and changes
 * nothing anywhere.
 */
export async function attachDomain(domain: string, jobId: string): Promise<{ ok: boolean; detail: string }> {
  const cfg = config()

  if (cfg.demoMode) {
    fakeDomainAttach(domain, jobId)
    return { ok: true, detail: `DEMO MODE: ${domain} was not attached to anything.` }
  }

  if (!cfg.live.domains) {
    return {
      ok: false,
      detail:
        'Refusing to attach a domain: ENABLE_LIVE_DOMAINS is not set. This install is in preview mode, where nothing touches DNS.',
    }
  }
  if (!cfg.vercelApiToken || !cfg.vercelProjectId) {
    return {
      ok: false,
      detail:
        'VERCEL_API_TOKEN and VERCEL_PROJECT_ID are needed to attach a domain. Add them to the project environment variables.',
    }
  }

  const url = new URL(`https://api.vercel.com/v10/projects/${cfg.vercelProjectId}/domains`)
  if (cfg.vercelTeamId) url.searchParams.set('teamId', cfg.vercelTeamId)

  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.vercelApiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: domain }),
  })

  if (!res.ok) {
    return { ok: false, detail: `Vercel refused the domain: ${(await res.text()).slice(0, 300)}` }
  }
  return { ok: true, detail: `${domain} attached. DNS still has to point at Vercel before it resolves.` }
}
