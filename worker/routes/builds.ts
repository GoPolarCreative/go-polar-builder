import { Hono } from 'hono'
import type { Env } from '../env'
import { intakeSchema, type IntakePayload } from '../../shared/intake'
import { getIntake, getJob, listAssets } from '../lib/db'
import { buildFacts } from '../lib/facts'
import { inlineAssets } from '../lib/inline'
import { verify } from '../lib/verify'

const app = new Hono<{ Bindings: Env }>()

async function loadBuild(
  env: Env,
  jobId: string,
  version: number,
): Promise<{ html: string; r2Key: string; checks: unknown } | null> {
  const row = await env.DB.prepare(
    'SELECT r2_key, checks_json FROM builds WHERE job_id = ? AND version = ?',
  )
    .bind(jobId, version)
    .first<{ r2_key: string; checks_json: string | null }>()
  if (!row) return null

  const object = await env.BUCKET.get(row.r2_key)
  if (!object) return null

  return {
    html: await object.text(),
    r2Key: row.r2_key,
    checks: row.checks_json ? JSON.parse(row.checks_json) : null,
  }
}

app.get('/jobs/:jobId/builds', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT version, bytes, passed, repair_passes, created_at FROM builds WHERE job_id = ? ORDER BY version DESC',
  )
    .bind(c.req.param('jobId'))
    .all()
  return c.json({ builds: rows.results ?? [] })
})

/** The stored document, exactly as generated. Relative asset paths, no inlining. */
app.get('/jobs/:jobId/builds/:version/html', async (c) => {
  const build = await loadBuild(c.env, c.req.param('jobId'), Number(c.req.param('version')))
  if (!build) return c.json({ error: 'not_found' }, 404)
  return new Response(build.html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
})

/**
 * Self-contained copy with every image inlined as a data URI. This is what the preview iframe
 * gets in Phase 4 (srcdoc cannot resolve relative paths) and what the render checks load.
 */
app.get('/jobs/:jobId/builds/:version/preview', async (c) => {
  const jobId = c.req.param('jobId')
  const version = Number(c.req.param('version'))

  const [build, stored, assets] = await Promise.all([
    loadBuild(c.env, jobId, version),
    getIntake(c.env, jobId),
    listAssets(c.env, jobId),
  ])
  if (!build) return c.json({ error: 'not_found' }, 404)

  const parsed = intakeSchema.safeParse(stored?.payload)
  if (!parsed.success) {
    // Without the intake there are no asset paths to map, so hand back the raw build rather
    // than silently returning a page with broken images.
    return new Response(build.html, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  const facts = buildFacts(c.env, parsed.data as IntakePayload, assets)
  const inlined = await inlineAssets(c.env, build.html, facts, assets)

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
  const build = await loadBuild(c.env, c.req.param('jobId'), Number(c.req.param('version')))
  if (!build) return c.json({ error: 'not_found' }, 404)
  return c.json({ report: build.checks })
})

/** Re-run verification against a stored build. Used to re-check after a binding is added. */
app.post('/jobs/:jobId/builds/:version/verify', async (c) => {
  const jobId = c.req.param('jobId')
  const version = Number(c.req.param('version'))

  const job = await getJob(c.env, jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const [build, stored, assets] = await Promise.all([
    loadBuild(c.env, jobId, version),
    getIntake(c.env, jobId),
    listAssets(c.env, jobId),
  ])
  if (!build) return c.json({ error: 'not_found' }, 404)

  const parsed = intakeSchema.safeParse(stored?.payload)
  if (!parsed.success) {
    return c.json({ error: 'invalid_intake', detail: 'Stored intake does not validate' }, 422)
  }

  const facts = buildFacts(c.env, parsed.data as IntakePayload, assets)
  const report = await verify(c.env, build.html, facts, assets)

  await c.env.DB.prepare('UPDATE builds SET checks_json = ?, passed = ? WHERE job_id = ? AND version = ?')
    .bind(JSON.stringify(report), report.passed ? 1 : 0, jobId, version)
    .run()

  return c.json({ report })
})

export default app
