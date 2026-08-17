import { Hono } from 'hono'
import { storage, toBody } from '../lib/storage'
import { findSiteByHostname } from '../lib/publish'

const app = new Hono()

/**
 * Serving published client websites.
 *
 * A request arriving on a customer hostname is answered here with the site's stored HTML. The
 * images are absolute URLs to stored files, so they never pass through a function: one
 * invocation serves tens of kilobytes of HTML, and the bandwidth that actually costs money is
 * served straight from storage with a long cache header. See DECISIONS.md D24 and D25.
 */

app.get('/site', async (c) => {
  const host = c.req.query('host') ?? c.req.header('host') ?? ''
  const site = await findSiteByHostname(host)
  if (!site) return c.json({ error: 'not_found', detail: `No site published for ${host}` }, 404)

  const html = await storage().getText(site.blobKey)
  if (html === null) return c.json({ error: 'not_found', detail: 'Site document missing from storage' }, 404)

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Short, so an edit going live is visible quickly, but long enough to absorb a refresh.
      'cache-control': 'public, max-age=60, s-maxage=300',
    },
  })
})

/**
 * Asset passthrough for published sites.
 *
 * Public on purpose: these are images on a public website. The key is opaque and nothing else is
 * reachable through it, since only keys recorded in a published site's HTML are ever handed out.
 */
app.get('/site-asset/:key{.+}', async (c) => {
  const key = decodeURIComponent(c.req.param('key'))
  const bytes = await storage().get(key)
  if (!bytes) return c.json({ error: 'not_found' }, 404)

  const type = key.endsWith('.webp')
    ? 'image/webp'
    : key.endsWith('.png')
      ? 'image/png'
      : key.endsWith('.svg')
        ? 'image/svg+xml'
        : 'image/jpeg'

  return new Response(toBody(bytes), {
    headers: {
      'content-type': type,
      // Immutable: a changed image gets a new key, so this can be cached hard.
      'cache-control': 'public, max-age=31536000, immutable',
      'content-length': String(bytes.byteLength),
    },
  })
})

export default app
