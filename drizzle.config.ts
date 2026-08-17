import { defineConfig } from 'drizzle-kit'

/**
 * Migrations are generated from db/schema.ts and applied with `npm run db:migrate`.
 *
 * Generation always targets real Postgres dialect. The same SQL runs against Neon in production
 * and against PGlite locally, which is Postgres compiled to wasm, so local development needs no
 * database server and no account. See DECISIONS.md D22.
 */
export default defineConfig({
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/go_polar_builder',
  },
  strict: true,
  verbose: true,
})
