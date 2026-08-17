import { Hono } from 'hono'
import type { Env } from '../env'
import type { AssetStats } from '../../shared/types'
import { getAsset, getJob, listAssets, recordEvent } from '../lib/db'
import { id, nowIso, slug } from '../lib/ids'
import { readSession } from '../lib/auth'

const app = new Hono<{ Bindings: Env }>()

const MAX_BYTES = 10 * 1024 * 1024 // 10MB, brief s4 step 5
const MAX_PHOTOS = 20
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml', 'image/webp'])

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
}

/**
 * Upload one file. multipart/form-data with:
 *   file  - the image
 *   kind  - logo | photo
 *   stats - JSON AssetStats computed in the browser (see src/lib/image.ts)
 *
 * The stats come from the client because a Worker cannot decode an image without shipping a
 * wasm codec, and the gap audit needs pixel-level signals. They are advisory only: nothing
 * security relevant depends on them, and every consumer treats missing stats as unknown.
 */
app.post('/jobs/:id/assets', async (c) => {
  const jobId = c.req.param('id')
  const job = await getJob(c.env, jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  let form: FormData
  try {
    form = await c.req.formData()
  } catch (err) {
    return c.json(
      { error: 'bad_request', detail: `Could not read the upload: ${(err as Error).message}` },
      400,
    )
  }

  const file = form.get('file')
  const kind = String(form.get('kind') ?? 'photo')
  if (!(file instanceof File)) return c.json({ error: 'bad_request', detail: 'No file' }, 400)
  if (kind !== 'logo' && kind !== 'photo') {
    return c.json({ error: 'bad_request', detail: 'kind must be logo or photo' }, 400)
  }

  const type = file.type || 'application/octet-stream'
  if (!ALLOWED.has(type)) {
    return c.json(
      { error: 'unsupported_type', detail: `${type} is not supported. Use PNG, JPG, SVG or WebP.` },
      415,
    )
  }
  if (file.size > MAX_BYTES) {
    return c.json(
      {
        error: 'too_large',
        detail: `${(file.size / 1024 / 1024).toFixed(1)}MB is over the 10MB limit.`,
      },
      413,
    )
  }

  const existing = await listAssets(c.env, jobId)
  if (kind === 'photo' && existing.filter((a) => a.kind === 'photo').length >= MAX_PHOTOS) {
    return c.json({ error: 'too_many', detail: `Up to ${MAX_PHOTOS} photos.` }, 409)
  }

  let stats: AssetStats | null = null
  const rawStats = form.get('stats')
  if (typeof rawStats === 'string' && rawStats.length > 0) {
    try {
      stats = JSON.parse(rawStats) as AssetStats
    } catch {
      stats = null // advisory only, never fail an upload over it
    }
  }

  const assetId = id('ast')
  const ext = EXT[type] ?? 'bin'
  const key = `jobs/${jobId}/${kind}/${assetId}-${slug(file.name.replace(/\.[^.]+$/, ''))}.${ext}`

  try {
    await c.env.BUCKET.put(key, file.stream(), {
      httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' },
      customMetadata: { jobId, kind, originalName: file.name },
    })
  } catch (err) {
    return c.json(
      { error: 'storage_failed', detail: `Could not store the file: ${(err as Error).message}` },
      502,
    )
  }

  // Logo is singular. A second logo upload replaces the first, including in R2.
  if (kind === 'logo') {
    for (const old of existing.filter((a) => a.kind === 'logo')) {
      await c.env.BUCKET.delete(old.r2_key).catch(() => undefined)
      await c.env.DB.prepare('DELETE FROM assets WHERE id = ?').bind(old.id).run()
    }
  }

  const sortOrder =
    kind === 'photo' ? existing.filter((a) => a.kind === 'photo').length : 0

  await c.env.DB.prepare(
    `INSERT INTO assets
       (id, job_id, r2_key, kind, filename, content_type, bytes, width, height, sort_order, stats_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      assetId,
      jobId,
      key,
      kind,
      file.name,
      type,
      file.size,
      stats?.width ?? null,
      stats?.height ?? null,
      sortOrder,
      stats ? JSON.stringify(stats) : null,
      nowIso(),
    )
    .run()

  await recordEvent(c.env, jobId, 'asset.uploaded', { assetId, kind, bytes: file.size })

  const saved = await getAsset(c.env, assetId)
  return c.json({ asset: saved }, 201)
})

app.get('/jobs/:id/assets', async (c) => {
  const assets = await listAssets(c.env, c.req.param('id'))
  return c.json({ assets })
})

/**
 * Streams the stored file back. Used by the wizard and the build assembler.
 *
 * The session is already required by the middleware, but an asset id carries no job in its URL,
 * so ownership is checked here. Otherwise a valid session for one job could read another job's
 * uploads.
 */
app.get('/assets/:assetId/raw', async (c) => {
  const asset = await getAsset(c.env, c.req.param('assetId'))
  if (!asset) return c.json({ error: 'not_found' }, 404)

  const session = await readSession(c)
  if (session && session.jobId !== asset.job_id) return c.json({ error: 'forbidden' }, 403)

  const object = await c.env.BUCKET.get(asset.r2_key)
  if (!object) return c.json({ error: 'not_found', detail: 'File missing from storage' }, 404)

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  headers.set('cache-control', 'public, max-age=31536000, immutable')
  return new Response(object.body, { headers })
})

app.delete('/assets/:assetId', async (c) => {
  const asset = await getAsset(c.env, c.req.param('assetId'))
  if (!asset) return c.json({ error: 'not_found' }, 404)

  const session = await readSession(c)
  if (session && session.jobId !== asset.job_id) return c.json({ error: 'forbidden' }, 403)

  await c.env.BUCKET.delete(asset.r2_key).catch(() => undefined)
  await c.env.DB.prepare('DELETE FROM assets WHERE id = ?').bind(asset.id).run()
  await recordEvent(c.env, asset.job_id, 'asset.deleted', { assetId: asset.id })
  return c.json({ ok: true })
})

/** Drag-to-reorder. Body: { ids: string[] } in the new gallery order. */
app.patch('/jobs/:id/assets/order', async (c) => {
  const jobId = c.req.param('id')
  const body = await c.req.json<{ ids?: string[] }>().catch(() => ({}) as { ids?: string[] })
  const ids = body.ids ?? []
  if (!Array.isArray(ids) || ids.length === 0) {
    return c.json({ error: 'bad_request', detail: 'ids must be a non-empty array' }, 400)
  }

  const statements = ids.map((assetId, index) =>
    c.env.DB.prepare('UPDATE assets SET sort_order = ? WHERE id = ? AND job_id = ?').bind(
      index,
      assetId,
      jobId,
    ),
  )
  await c.env.DB.batch(statements)
  return c.json({ ok: true })
})

export default app
