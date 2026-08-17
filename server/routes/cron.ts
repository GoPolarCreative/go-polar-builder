import { Hono } from 'hono'
import { config } from '../config'
import { runSweep } from '../lib/sweep'

const app = new Hono()

/**
 * Vercel Cron target. Configured hourly in vercel.json (DECISIONS.md D12).
 *
 * Vercel signs cron invocations with the CRON_SECRET as a bearer token. When that secret is set
 * it is required, so the sweep cannot be triggered by anyone who finds the URL. In local
 * development, where no secret exists, it runs on request so it can be exercised by hand.
 */
app.get('/cron/sweep', async (c) => {
  const cfg = config()

  if (cfg.cronSecret) {
    const auth = c.req.header('authorization')
    if (auth !== `Bearer ${cfg.cronSecret}`) {
      return c.json({ error: 'forbidden', detail: 'Bad or missing cron secret.' }, 403)
    }
  } else if (!cfg.demoMode) {
    // A production deployment with no CRON_SECRET would leave this open. Refuse rather than run.
    return c.json(
      {
        error: 'not_configured',
        detail:
          'CRON_SECRET is not set, so the sweep endpoint refuses to run. Vercel sets this automatically when you add a cron job; add it to the project environment variables if it is missing.',
      },
      503,
    )
  }

  const report = await runSweep()
  if (report.problems.length > 0) console.error('sweep problems', report.problems)
  return c.json(report)
})

export default app
