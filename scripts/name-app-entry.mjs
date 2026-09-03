import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Move the builder's own page off the root of the build output.
 *
 * WHY. Vercel serves a matching static file BEFORE it applies any rewrite. dist/index.html is the
 * builder app, so a request for "/" on ANY host matched that file and never reached the function
 * that works out whose website the domain belongs to. Customer domains served the Go Polar builder
 * on their home page, and every other page correctly served their site, because no static file
 * matched those paths.
 *
 * It was invisible until a customer domain actually pointed here. The first one to do so was a
 * test domain, which is the only reason this was found before a real business was on it.
 *
 * Renaming it to app.html leaves nothing at the root to shadow the rewrite. The builder's own
 * hosts are pointed at /app.html explicitly in vercel.json; every other host falls through to the
 * function, which is what was intended all along.
 *
 * Done here rather than by renaming the source file, because Vite's dev server serves index.html
 * from the project root and `npm run dev` should keep working exactly as it does.
 */

const from = join('dist', 'index.html')
const to = join('dist', 'app.html')

if (!existsSync(from)) {
  // Already renamed, or the build did not produce one. Either way, say so rather than failing
  // silently: a missing entry point is not something to discover in production.
  if (existsSync(to)) {
    console.log('App entry already at dist/app.html.')
    process.exit(0)
  }
  console.error('No dist/index.html and no dist/app.html. The client build produced no entry page.')
  process.exit(1)
}

renameSync(from, to)
console.log('App entry moved to dist/app.html, so nothing shadows a customer domain at "/".')
