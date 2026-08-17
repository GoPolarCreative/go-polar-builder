import { Hono } from 'hono'
import { config } from './config'
import { recordEvent } from './lib/db'
import { requireSession } from './lib/auth'
import auth from './routes/auth'
import jobs from './routes/jobs'
import intake from './routes/intake'
import assets from './routes/assets'
import lookups from './routes/lookups'
import generate from './routes/generate'
import builds from './routes/builds'
import edits from './routes/edits'
import golive from './routes/golive'
import discharge from './routes/discharge'
import webhooks from './routes/webhooks'
import cron from './routes/cron'
import demo from './routes/demo'
import sites from './routes/sites'
import dev from './routes/dev'

/**
 * Go Polar Website Builder API.
 *
 * A Hono app. In production it runs as a single Vercel Node function (api/index.ts); locally it
 * runs behind @hono/node-server (server/local.ts). Node runtime rather than Edge, because
 * generation is long running and needs the timeout headroom.
 */
export const api = new Hono().basePath('/api')

api.get('/health', (c) => {
  const cfg = config()
  return c.json({
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

api.notFound((c) =>
  c.json({ error: 'not_found', detail: `No route for ${c.req.method} ${c.req.path}` }, 404),
)

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
