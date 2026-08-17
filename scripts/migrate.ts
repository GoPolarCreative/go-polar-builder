import { config as loadEnvFiles } from 'dotenv'
import { rm } from 'node:fs/promises'

/**
 * Apply database migrations.
 *
 *   npm run db:migrate    apply everything outstanding
 *   npm run db:reset      throw the local database away first
 *
 * Against Neon this is an ordinary migration run. Locally it applies the same SQL to the
 * embedded PGlite database, so there is nothing to install and no account to create.
 */

loadEnvFiles({ path: '.env.local', quiet: true })
loadEnvFiles({ path: '.env', quiet: true })

const reset = process.argv.includes('--reset')

const { config } = await import('../server/config')
const cfg = config()

if (reset) {
  if (cfg.databaseDriver !== 'pglite') {
    console.error(
      'Refusing to reset a real Postgres database. --reset only applies to the local embedded database.',
    )
    process.exit(1)
  }
  await rm(cfg.pgliteDir, { recursive: true, force: true })
  await rm(cfg.localStorageDir, { recursive: true, force: true })
  console.log(`Removed ${cfg.pgliteDir} and ${cfg.localStorageDir}`)
}

const { migrate } = await import('../server/db/migrate')
const { closeDb } = await import('../server/db/client')

await migrate()
console.log(`Migrations applied (${cfg.databaseDriver}).`)
await closeDb()
