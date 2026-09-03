import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * A customer's domain must reach their website, including at "/".
 *
 * Vercel serves a matching static file BEFORE it applies any rewrite. dist/index.html was the
 * builder app, so a request for "/" on ANY host matched that file and never reached the function
 * that works out whose website the domain belongs to. Customer domains served the Go Polar builder
 * on their home page; every other page served their site correctly, because no static file matched
 * those paths.
 *
 * It was invisible until a domain actually pointed here, and the first one to do so was a test
 * domain. A real business would have seen the builder's front page on their own address.
 *
 * These are guards on the config rather than on one file name: they fail if the entry point moves
 * back to the root, or if the rewrite stops agreeing with the build.
 */

const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
  rewrites: Array<{ source: string; has?: Array<{ type: string; value: string }>; destination: string }>
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }

describe('the builder app does not sit where every host matches it', () => {
  const builderRule = vercel.rewrites.find((r) => r.has?.some((h) => h.type === 'host'))

  it('the host-scoped rewrite exists and is the only one that serves the app', () => {
    expect(builderRule, 'no host-scoped rewrite in vercel.json').toBeTruthy()
    expect(builderRule!.destination).toBe('/app.html')
  })

  it('NOTHING rewrites to /index.html, which is the shape that caused it', () => {
    for (const r of vercel.rewrites) {
      expect(r.destination, `${r.source} still points at the root entry`).not.toBe('/index.html')
    }
  })

  it('every other host falls through to the function', () => {
    const fallthrough = vercel.rewrites.filter((r) => r.destination === '/api/index')
    // One for /api/*, one for everything else on a customer domain.
    expect(fallthrough.length).toBeGreaterThanOrEqual(2)
    const catchAll = fallthrough.find((r) => !r.source.startsWith('/api'))
    expect(catchAll, 'no catch-all to the function for customer domains').toBeTruthy()
    expect(catchAll!.has, 'the catch-all must not be limited to a host').toBeUndefined()
  })

  it('the catch-all is ordered after the builder rule, or the builder would never load', () => {
    const builderAt = vercel.rewrites.findIndex((r) => r.has?.some((h) => h.type === 'host'))
    const catchAt = vercel.rewrites.findIndex(
      (r) => r.destination === '/api/index' && !r.source.startsWith('/api'),
    )
    expect(builderAt).toBeGreaterThanOrEqual(0)
    expect(catchAt).toBeGreaterThan(builderAt)
  })

  it('the build actually produces what the rewrite points at', () => {
    for (const script of ['build', 'vercel:build']) {
      expect(pkg.scripts[script], `${script} must move the entry off the root`).toContain(
        'name-app-entry',
      )
    }
  })

  it('the builder rule still lets its own assets through as files', () => {
    // /assets/ and /demo/ are excluded, so the hashed bundle and the demo pages stay static.
    expect(vercel.rewrites.find((r) => r.destination === '/app.html')!.source).toContain('assets/')
  })
})
