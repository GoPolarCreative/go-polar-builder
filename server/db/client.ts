import { drizzle as drizzlePostgres, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite'
import * as schema from '../../db/schema'
import { config } from '../config'

/**
 * The database handle.
 *
 * Two drivers, one schema, one set of migrations:
 *   postgres - Neon (or any Postgres) via postgres.js, used on Vercel
 *   pglite   - Postgres compiled to wasm, running in the Node process, used locally
 *
 * PGlite is what makes `npm run dev` work on a fresh clone with no accounts and no database
 * server, which is a hard requirement for local preview. It is real Postgres, so the SQL, the
 * types and the migrations are identical to production rather than an approximation.
 * See DECISIONS.md D22.
 */

export type Database = PostgresJsDatabase<typeof schema> | PgliteDatabase<typeof schema>

let instance: Database | null = null
let closer: (() => Promise<void>) | null = null

export async function getDb(): Promise<Database> {
  if (instance) return instance

  const cfg = config()

  if (cfg.databaseDriver === 'postgres') {
    if (!cfg.databaseUrl) {
      throw new Error(
        'DATABASE_URL is not set. Provision Postgres from the Vercel marketplace (Neon is the default) and add the connection string, or set DATABASE_DRIVER=pglite to use the embedded local database.',
      )
    }
    const { default: postgres } = await import('postgres')
    // Serverless functions get a small pool: many short-lived instances, each holding few
    // connections, is the shape Neon expects.
    const sql = postgres(cfg.databaseUrl, { max: 3, idle_timeout: 20, prepare: false })
    instance = drizzlePostgres(sql, { schema })
    closer = async () => {
      await sql.end({ timeout: 5 })
    }
    return instance
  }

  const { PGlite } = await import('@electric-sql/pglite')

  /*
   * Retry, because of one specific local failure.
   *
   * PGlite holds an exclusive lock on its data directory. In development the API runs under
   * `tsx watch`, so saving a file starts a new process while the old one is still shutting down,
   * and the new one fails to open the database. Before this retry existed the API simply died,
   * the Vite proxy started refusing connections, and the app in the browser went quiet with no
   * explanation, which is the same class of silent failure this project keeps stamping out.
   *
   * The old process is gone within a second or so, so a few short retries cover it. If it still
   * cannot open, that is a real problem and it says so rather than exiting into nothing.
   */
  const attempts = 5
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const client = new PGlite(cfg.pgliteDir)
      await client.waitReady
      instance = drizzlePglite(client, { schema })
      closer = async () => {
        await client.close()
      }
      return instance
    } catch (err) {
      if (attempt === attempts) {
        throw new Error(
          `Could not open the local database at ${cfg.pgliteDir} after ${attempts} attempts. Another process is probably still using it. Stop any other "npm run dev" and try again, or run "npm run db:reset" to start fresh. Original error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt))
    }
  }

  throw new Error('unreachable')
}

export async function closeDb(): Promise<void> {
  if (closer) await closer()
  instance = null
  closer = null
}

export { schema }
