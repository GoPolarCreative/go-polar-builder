import { Hono } from 'hono'
import type { Env } from './env'
import { recordEvent } from './lib/db'
import jobs from './routes/jobs'
import intake from './routes/intake'
import assets from './routes/assets'
import lookups from './routes/lookups'
import generate from './routes/generate'
import builds from './routes/builds'
import dev from './routes/dev'

/**
 * Go Polar Website Builder API.
 *
 * Everything lives under /api. Static assets are served by the Workers Assets binding, with
 * run_worker_first scoped to /api/* so the SPA fallback does not swallow API calls.
 *
 * AUTH: none yet. Phase 6 adds the magic-link session and every route below moves behind it.
 * Until then a job id is the only thing standing between a caller and a job, which is fine for
 * local development and is NOT fine in production. The Phase 6 middleware slot is marked below.
 */
const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    // Useful when someone asks why generation is not working.
    anthropicKeyPresent: Boolean(c.env.ANTHROPIC_API_KEY),
    offlineGeneration: c.env.DEV_OFFLINE_GENERATION === '1',
    browserRendering: Boolean(c.env.BROWSER),
  }),
)

// PHASE 6: app.use('/api/jobs/*', requireSession)

app.route('/api', jobs)
app.route('/api', intake)
app.route('/api', assets)
app.route('/api', lookups)
app.route('/api', generate)
app.route('/api', builds)
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

export default app
