import { config as loadEnvFiles } from 'dotenv'
import { serve } from '@hono/node-server'

/**
 * Local API server.
 *
 * Vite serves the client on 5173 and proxies /api here, so the browser sees one origin exactly
 * as it will on Vercel. In production the same Hono app is exported from api/index.ts as a Node
 * function; this file exists only so there is something to run locally.
 *
 * Environment files are loaded before anything imports config, which is why the API app is
 * imported dynamically below rather than at the top.
 */

// .env.local wins, then .env. Neither is required: with nothing set the app runs in demo mode
// against the embedded database and local file storage.
loadEnvFiles({ path: '.env.local', quiet: true })
loadEnvFiles({ path: '.env', quiet: true })

const port = Number(process.env.PORT ?? 8787)

const { default: api } = await import('./index.js')
const { config } = await import('./config.js')
const { migrate } = await import('./db/migrate.js')

const cfg = config()

// The local database is created and migrated on boot, so a fresh clone needs no database step.
if (cfg.databaseDriver === 'pglite') {
  await migrate()
}

/*
 * Close the database on the way out.
 *
 * The local database is Postgres compiled to wasm, and it keeps its data in a directory it opens
 * exclusively. Killing the process without closing it leaves that directory half-written, and
 * the next start fails to open it at all. Since `tsx watch` restarts on every file save, and
 * anyone running this will eventually press Ctrl+C, an unflushed shutdown is the normal case
 * rather than the rare one.
 */
const { closeDb } = await import('./db/client.js')
let shuttingDown = false

const shutdown = async (signal: string) => {
  if (shuttingDown) return
  shuttingDown = true
  try {
    await closeDb()
  } catch (err) {
    console.error('database did not close cleanly', err)
  }
  console.log(`\n  Stopped (${signal}).`)
  process.exit(0)
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => void shutdown(signal))
}
// tsx sends this to the child before restarting on a file change.
process.on('message', (message) => {
  if (message === 'shutdown') void shutdown('watch restart')
})

serve({ fetch: api.fetch, port }, (info) => {
  console.log('')
  console.log(`  Go Polar Website Builder API on http://localhost:${info.port}`)
  console.log(`  database: ${cfg.databaseDriver}${cfg.databaseDriver === 'pglite' ? ` (${cfg.pgliteDir})` : ''}`)
  console.log(`  storage:  ${cfg.storageDriver}${cfg.storageDriver === 'local' ? ` (${cfg.localStorageDir})` : ''}`)
  console.log(
    `  mode:     ${cfg.demoMode ? 'DEMO. Nothing leaves this machine: no payments, no email, no DNS.' : 'live integrations enabled where configured'}`,
  )
  if (cfg.offlineGeneration) {
    console.log(
      '  generation: OFFLINE FIXTURE, not the Anthropic API. Set ANTHROPIC_API_KEY in .env.local for real builds.',
    )
  } else if (!cfg.anthropicApiKey) {
    console.log('  generation: NO API KEY. Set ANTHROPIC_API_KEY, or DEV_OFFLINE_GENERATION=1 to use the fixture.')
  } else {
    console.log('  generation: Anthropic')
  }
  if (cfg.demoMode && !process.env.APP_SECRET) {
    console.log('  sessions: signed with the built-in demo secret. Set APP_SECRET before anything real.')
  }
  console.log('')
})
