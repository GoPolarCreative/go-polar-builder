import { Hono } from 'hono'
import { config } from './config.js'
import { recordEvent } from './lib/db.js'
import { assertProductConfig, productConfigReport } from './lib/products.js'
import { checkStoreProducts } from './lib/shopify.js'
import { adminAuthMode, grantedScopes, missingScopes } from './lib/shopifyAuth.js'
import { requireSession } from './lib/auth.js'
import { findSiteByHostname } from './lib/publish.js'
import { storage } from './lib/storage.js'
import auth from './routes/auth.js'
import jobs from './routes/jobs.js'
import intake from './routes/intake.js'
import assets from './routes/assets.js'
import lookups from './routes/lookups.js'
import generate from './routes/generate.js'
import builds from './routes/builds.js'
import edits from './routes/edits.js'
import golive from './routes/golive.js'
import discharge from './routes/discharge.js'
import webhooks from './routes/webhooks.js'
import cron from './routes/cron.js'
import demo from './routes/demo.js'
import sites from './routes/sites.js'
import dev from './routes/dev.js'
import admin from './routes/admin.js'

/**
 * Go Polar Website Builder API.
 *
 * A Hono app. In production it runs as a single Vercel Node function (api/index.ts); locally it
 * runs behind @hono/node-server (server/local.ts). Node runtime rather than Edge, because
 * generation is long running and needs the timeout headroom.
 */
export const api = new Hono().basePath('/api')

// Says at boot exactly which Shopify products are missing and what each gap breaks, and refuses
// to start at all if this install intends to take payments while something is unconfigured. See
// server/lib/products.ts and SHOPIFY-SETUP.md.
assertProductConfig()

api.get('/health', async (c) => {
  const cfg = config()
  // Asks the store what it will actually do with each product: active or draft, and billing every
  // 1 MONTH or something else. Cached for ten minutes, so this is one round trip at most. Empty in
  // demo mode, and "cannot verify" rather than "ok" without an admin token.
  const store = await checkStoreProducts().catch((err) => ({
    results: [{ ref: '-', label: 'store', ok: false, detail: String(err) }],
  }))
  return c.json({
    products: productConfigReport(),
    storeChecks: store.results,
    // How this install talks to the Admin API, and whether the scopes chosen on the app's version
    // actually cover what it calls. A forgotten scope otherwise shows up as a 403 on a call that
    // used to work, weeks later, with nothing pointing at the cause.
    shopifyAuth: {
      mode: adminAuthMode(cfg),
      scopes: grantedScopes(),
      missingScopes: missingScopes(),
      detail:
        adminAuthMode(cfg) === 'none'
          ? 'No Admin API credentials. Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET from the app in the Dev Dashboard. See DEPLOY.md section 6.'
          : missingScopes().length > 0
            ? `The app is missing ${missingScopes().join(' and ')}. Release a new version in the Dev Dashboard with the scope added and approve it on the store.`
            : 'Scopes ok.',
    },
    ok: true,
    // Presence only, never values.
    demoMode: cfg.demoMode,
    anthropicKeyPresent: Boolean(cfg.anthropicApiKey),
    offlineGeneration: cfg.offlineGeneration,
    renderDriver: cfg.renderDriver,
    databaseDriver: cfg.databaseDriver,
    storageDriver: cfg.storageDriver,
    shopifyConfigured: Boolean(cfg.shopify.webhookSecret),
    emailConfigured: Boolean(cfg.resendApiKey),
    ghlConfigured: Boolean(cfg.ghlWebhookUrl),
    sessionsConfigured: Boolean(cfg.appSecret),
    live: cfg.live,
  })
})

// ---------------------------------------------------------------------------------------------
// Public: no session required, each protects itself
//   auth      - token exchange and the resend-my-link flow
//   webhooks  - HMAC verified against the raw body, refuses outright without a secret
//   cron      - bearer secret
//   lookups   - suburb and ABN checks, no customer data
//   sites     - serving a published client website by hostname
//   discharge/download - signed link, verified by signature and expiry
// ---------------------------------------------------------------------------------------------
api.route('/', auth)
api.route('/', webhooks)
api.route('/', cron)
// Operator diagnostics. Guards itself with ADMIN_TOKEN, so it sits with the other self-guarding
// routes rather than behind the customer session middleware.
api.route('/', admin)
api.route('/', lookups)
api.route('/', sites)

// ---------------------------------------------------------------------------------------------
// Everything touching a job is behind a session. The job id in the URL must match the session,
// so knowing somebody else's job id gets a caller nowhere.
// ---------------------------------------------------------------------------------------------
api.use('/jobs/*', requireSession)
api.use('/assets/*', requireSession)

api.route('/', jobs)
api.route('/', intake)
api.route('/', assets)
api.route('/', generate)
api.route('/', builds)
api.route('/', edits)
api.route('/', golive)
api.route('/', discharge)

// Demo and development only. Every route inside refuses to run outside those modes.
api.route('/', demo)
api.route('/', dev)

/**
 * Published customer websites.
 *
 * A request that matched no API route and did not arrive on a Go Polar hostname is a visitor on a
 * customer's own domain, so it is answered from that site's published files. Vercel rewrites send
 * those hostnames here (see vercel.json), and this is the only place that decides what a customer
 * domain serves. A page set is served path by path, which is why the whole path is passed through
 * rather than only the home page.
 */
api.notFound(async (c) => {
  const host = (c.req.header('host') ?? '').toLowerCase().replace(/:d+$/, '')
  const builderHost = (() => {
    try {
      return new URL(config().publicAppUrl).hostname.toLowerCase()
    } catch {
      return ''
    }
  })()

  const isGoPolarHost =
    host === '' ||
    host === builderHost ||
    host.startsWith('localhost') ||
    host.startsWith('127.0.0.1') ||
    host.endsWith('.vercel.app')

  if (!isGoPolarHost) {
    const site = await findSiteByHostname(host, c.req.path)
    if (site) {
      const body = await storage().getText(site.blobKey)
      if (body !== null) {
        const type = site.blobKey.endsWith('.xml')
          ? 'application/xml; charset=utf-8'
          : site.blobKey.endsWith('.txt')
            ? 'text/plain; charset=utf-8'
            : 'text/html; charset=utf-8'
        return new Response(body, {
          headers: {
            'content-type': type,
            'cache-control': 'public, max-age=60, s-maxage=300',
          },
        })
      }
    }
    // A live site with nothing at this path. Say so as a website would, not as an API would.
    return c.html('<!doctype html><meta charset="utf-8"><title>Page not found</title><p>Page not found.', 404)
  }

  return c.json({ error: 'not_found', detail: `No route for ${c.req.method} ${c.req.path}` }, 404)
})

// Brief s14: every external call is wrapped and surfaces a real error to the UI, never a silent
// fail. This is the backstop for anything that got past a local try/catch.
api.onError(async (err, c) => {
  console.error('unhandled error', c.req.method, c.req.path, err)
  try {
    await recordEvent(null, 'error.unhandled', {
      path: c.req.path,
      method: c.req.method,
      message: err instanceof Error ? err.message : String(err),
    })
  } catch {
    /* the error log is not allowed to become the error */
  }
  return c.json(
    { error: 'internal_error', detail: err instanceof Error ? err.message : 'Unexpected error' },
    500,
  )
})

export default api
