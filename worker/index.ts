import { Hono } from 'hono'
import type { Env } from './env'
import { recordEvent } from './lib/db'
import { requireSession } from './lib/auth'
import { runSweep } from './lib/sweep'
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
import dev from './routes/dev'

/**
 * Go Polar Website Builder API.
 *
 * Everything lives under /api. Static assets are served by the Workers Assets binding, with
 * run_worker_first scoped to /api/* so the SPA fallback does not swallow API calls.
 */
const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    // Useful when someone asks why something is not working. No secret values, only presence.
    anthropicKeyPresent: Boolean(c.env.ANTHROPIC_API_KEY),
    offlineGeneration: c.env.DEV_OFFLINE_GENERATION === '1',
    browserRendering: Boolean(c.env.BROWSER),
    shopifyConfigured: Boolean(c.env.SHOPIFY_WEBHOOK_SECRET),
    emailConfigured: Boolean(c.env.RESEND_API_KEY),
    ghlConfigured: Boolean(c.env.GHL_INBOUND_WEBHOOK_URL),
    sessionsConfigured: Boolean(c.env.APP_SECRET),
  }),
)

// ---------------------------------------------------------------------------------------------
// Public: no session required, each protects itself
//   auth      - token exchange and the resend-my-link flow
//   webhooks  - HMAC verified against the raw body, refuses outright without a secret
//   lookups   - suburb and ABN checks, no customer data
//   discharge/download - signed link, verified by signature and expiry
// ---------------------------------------------------------------------------------------------
app.route('/api', auth)
app.route('/api', webhooks)
app.route('/api', lookups)

// ---------------------------------------------------------------------------------------------
// Everything touching a job is behind a session. The job id in the URL must match the session,
// so knowing somebody else's job id gets a caller nowhere.
// ---------------------------------------------------------------------------------------------
app.use('/api/jobs/*', requireSession)
app.use('/api/assets/*', requireSession)

app.route('/api', jobs)
app.route('/api', intake)
app.route('/api', assets)
app.route('/api', generate)
app.route('/api', builds)
app.route('/api', edits)
app.route('/api', golive)
app.route('/api', discharge)

// Development only. Every route inside refuses to run once Shopify is configured.
app.route('/api', dev)

app.notFound((c) =>
  c.req.path.startsWith('/api')
    ? c.json({ error: 'not_found', detail: `No route for ${c.req.method} ${c.req.path}` }, 404)
    : c.text('Not found', 404),
)

// Brief s14: every external call is wrapped and surfaces a real error to the UI, never a silent
// fail. This is the backstop for anything that got past a local try/catch.
app.onError(async (err, c) => {
  console.error('unhandled error', c.req.method, c.req.path, err)
  try {
    await recordEvent(c.env, null, 'error.unhandled', {
      path: c.req.path,
      method: c.req.method,
      message: err instanceof Error ? err.message : String(err),
    })
  } catch {
    /* the error log is not allowed to become the error */
  }
  return c.json(
    {
      error: 'internal_error',
      detail: err instanceof Error ? err.message : 'Unexpected error',
    },
    500,
  )
})

export default {
  fetch: app.fetch,

  /**
   * Hourly sweep. Reconciles dropped Shopify webhooks, retries build links that never sent, and
   * fires the two time-based GHL events. See lib/sweep.ts and DECISIONS.md D12.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runSweep(env)
        .then((report) => {
          if (report.problems.length > 0) console.error('sweep problems', report.problems)
        })
        .catch((err) => console.error('sweep failed', err)),
    )
  },
} satisfies ExportedHandler<Env>
