import { Hono } from 'hono'
import { desc, eq, and } from 'drizzle-orm'
import { getDb, schema } from '../db/client'
import { intakeSchema, type IntakePayload } from '../../shared/intake'
import type { VerificationReport } from '../../shared/types'
import { getIntake, getJob, listAssets } from '../lib/db'
import { buildFacts } from '../lib/facts'
import { inlineAssets } from '../lib/inline'
import { storage } from '../lib/storage'
import { verify } from '../lib/verify'

const app = new Hono()

async function loadBuild(
  jobId: string,
  version: number,
): Promise<{ html: string; blobKey: string; checks: VerificationReport | null } | null> {
  const db = await getDb()
  const rows = await db
    .select()
    .from(schema.builds)
    .where(and(eq(schema.builds.jobId, jobId), eq(schema.builds.version, version)))
    .limit(1)
  const row = rows[0]
  if (!row) return null

  const html = await storage().getText(row.blobKey)
  if (html === null) return null

  return { html, blobKey: row.blobKey, checks: (row.checks as VerificationReport | null) ?? null }
}

app.get('/jobs/:jobId/builds', async (c) => {
  const db = await getDb()
  const rows = await db
    .select({
      version: schema.builds.version,
      bytes: schema.builds.bytes,
      pageWeightBytes: schema.builds.pageWeightBytes,
      passed: schema.builds.passed,
      repairPasses: schema.builds.repairPasses,
      createdAt: schema.builds.createdAt,
    })
    .from(schema.builds)
    .where(eq(schema.builds.jobId, c.req.param('jobId')))
    .orderBy(desc(schema.builds.version))
  return c.json({ builds: rows })
})

/** The stored document, exactly as generated. Relative asset paths, no inlining. */
app.get('/jobs/:jobId/builds/:version/html', async (c) => {
  const build = await loadBuild(c.req.param('jobId'), Number(c.req.param('version')))
  if (!build) return c.json({ error: 'not_found' }, 404)
  return new Response(build.html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
})

/**
 * Self-contained copy with every image inlined as a data URI. This is what the preview iframe
 * gets (srcdoc cannot resolve relative paths) and what the render checks load.
 */
app.get('/jobs/:jobId/builds/:version/preview', async (c) => {
  const jobId = c.req.param('jobId')
  const version = Number(c.req.param('version'))

  const [build, stored, assets] = await Promise.all([
    loadBuild(jobId, version),
    getIntake(jobId),
    listAssets(jobId),
  ])
  if (!build) return c.json({ error: 'not_found' }, 404)

  const parsed = intakeSchema.safeParse(stored?.payload)
  if (!parsed.success) {
    // Without the intake there are no asset paths to map, so hand back the raw build rather than
    // silently returning a page with broken images.
    return new Response(build.html, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  const facts = buildFacts(parsed.data as IntakePayload, assets)
  const inlined = await inlineAssets(build.html, facts)

  return new Response(inlined.html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-assets-inlined': String(inlined.inlined),
      'x-assets-missing': String(inlined.missing.length),
    },
  })
})

/** The verification report stored with the build. */
app.get('/jobs/:jobId/builds/:version/checks', async (c) => {
  const build = await loadBuild(c.req.param('jobId'), Number(c.req.param('version')))
  if (!build) return c.json({ error: 'not_found' }, 404)
  return c.json({ report: build.checks })
})

/** Re-run verification against a stored build. Used after a browser driver becomes available. */
app.post('/jobs/:jobId/builds/:version/verify', async (c) => {
  const jobId = c.req.param('jobId')
  const version = Number(c.req.param('version'))

  const job = await getJob(jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const [build, stored, assets] = await Promise.all([
    loadBuild(jobId, version),
    getIntake(jobId),
    listAssets(jobId),
  ])
  if (!build) return c.json({ error: 'not_found' }, 404)

  const parsed = intakeSchema.safeParse(stored?.payload)
  if (!parsed.success) {
    return c.json({ error: 'invalid_intake', detail: 'Stored intake does not validate' }, 422)
  }

  const facts = buildFacts(parsed.data as IntakePayload, assets)
  const report = await verify(build.html, facts)

  const db = await getDb()
  await db
    .update(schema.builds)
    .set({ checks: report, passed: report.passed, pageWeightBytes: report.pageWeightBytes })
    .where(and(eq(schema.builds.jobId, jobId), eq(schema.builds.version, version)))

  return c.json({ report })
})

export default app
