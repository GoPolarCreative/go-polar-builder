import { Hono } from 'hono'
import type { AssetStats, AssetVariant } from '../../shared/types.js'
import { deleteAsset, getAsset, getJob, insertAsset, listAssets, recordEvent, reorderAssets } from '../lib/db.js'
import { id, nowIso, slug } from '../lib/ids.js'
import { readSession } from '../lib/auth.js'
import { storage, toBody } from '../lib/storage.js'
import { formatBytes, processImage, savingSummary } from '../lib/images.js'

const app = new Hono()

const MAX_BYTES = 10 * 1024 * 1024 // 10MB, brief s4 step 5
const MAX_PHOTOS = 20
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml', 'image/webp'])

/**
 * Upload one file. multipart/form-data with:
 *   file  - the image
 *   kind  - logo | photo
 *   stats - JSON AssetStats computed in the browser (see src/lib/image.ts)
 *
 * The original is stored untouched for rebuilds, and processed derivatives are generated here:
 * a web-sized and a thumbnail, each as WebP and JPEG. Only the derivatives are ever referenced
 * by a generated site, because whatever is referenced is what every visitor downloads on every
 * visit and Vercel bills the bandwidth. See DECISIONS.md D25.
 */
app.post('/jobs/:jobId/assets', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(jobId)
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
      { error: 'too_large', detail: `${formatBytes(file.size)} is over the 10MB limit.` },
      413,
    )
  }

  const existing = await listAssets(jobId)
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

  const bytes = new Uint8Array(await file.arrayBuffer())
  const assetId = id('ast')
  const store = storage()
  const stem = slug(file.name.replace(/\.[^.]+$/, '')) || 'image'

  // --- process ---------------------------------------------------------------------------------
  let processed
  try {
    processed = await processImage(bytes, kind, type)
  } catch (err) {
    return c.json(
      {
        error: 'image_unreadable',
        detail: `We could not read ${file.name}. Try re-saving it as a JPG or PNG. (${(err as Error).message})`,
      },
      422,
    )
  }

  // --- store -----------------------------------------------------------------------------------
  const originalKey = `jobs/${jobId}/original/${assetId}-${stem}`
  const variants: AssetVariant[] = []

  try {
    await store.put(originalKey, bytes, type)
    for (const v of processed.variants) {
      const key = `jobs/${jobId}/${kind}/${assetId}-${v.role}.${v.format === 'jpeg' ? 'jpg' : v.format}`
      await store.put(key, v.data, v.contentType)
      variants.push({ role: v.role, format: v.format, key, bytes: v.bytes, width: v.width, height: v.height })
    }
  } catch (err) {
    return c.json(
      { error: 'storage_failed', detail: `Could not store the file: ${(err as Error).message}` },
      502,
    )
  }

  // A logo is singular. A second upload replaces the first, including its stored files.
  if (kind === 'logo') {
    for (const old of existing.filter((a) => a.kind === 'logo')) {
      await store.delete(old.originalKey)
      for (const v of old.variants) await store.delete(v.key)
      await deleteAsset(old.id)
    }
  }

  const saved = await insertAsset({
    id: assetId,
    jobId,
    kind,
    filename: file.name,
    contentType: type,
    originalKey,
    originalBytes: bytes.byteLength,
    width: processed.width || stats?.width || null,
    height: processed.height || stats?.height || null,
    sortOrder: kind === 'photo' ? existing.filter((a) => a.kind === 'photo').length : 0,
    stats,
    variants,
  })

  const saving = savingSummary(processed)
  await recordEvent(jobId, 'asset.uploaded', {
    assetId,
    kind,
    originalBytes: bytes.byteLength,
    shippedBytes: variants.find((v) => v.role === 'web' && v.format === 'webp')?.bytes ?? null,
    saving,
  })

  return c.json({ asset: saved, saving, uploadedAt: nowIso() }, 201)
})

app.get('/jobs/:jobId/assets', async (c) => {
  return c.json({ assets: await listAssets(c.req.param('jobId')) })
})

/**
 * Stream a stored file back. Used by the wizard and by the local preview of the built site.
 *
 * `variant` picks which derivative: web (default) or thumb, and original for a rebuild. The
 * session is required by middleware, but an asset id carries no job in its URL, so ownership is
 * checked here too. Otherwise a valid session for one job could read another job's uploads.
 */
app.get('/assets/:assetId/raw', async (c) => {
  const asset = await getAsset(c.req.param('assetId'))
  if (!asset) return c.json({ error: 'not_found' }, 404)

  const session = await readSession(c)
  if (session && session.jobId !== asset.jobId) return c.json({ error: 'forbidden' }, 403)

  const want = c.req.query('variant') ?? 'web'
  let key = asset.originalKey
  let contentType = asset.contentType ?? 'application/octet-stream'

  if (want !== 'original') {
    const role = want === 'thumb' ? 'thumb' : 'web'
    const variant =
      asset.variants.find((v) => v.role === role && v.format === 'webp') ??
      asset.variants.find((v) => v.role === role) ??
      asset.variants[0]
    if (variant) {
      key = variant.key
      contentType =
        variant.format === 'webp'
          ? 'image/webp'
          : variant.format === 'png'
            ? 'image/png'
            : variant.format === 'svg'
              ? 'image/svg+xml'
              : 'image/jpeg'
    }
  }

  const bytes = await storage().get(key)
  if (!bytes) return c.json({ error: 'not_found', detail: 'File missing from storage' }, 404)

  return new Response(toBody(bytes), {
    headers: {
      'content-type': contentType,
      'cache-control': 'private, max-age=3600',
      'content-length': String(bytes.byteLength),
    },
  })
})

app.delete('/assets/:assetId', async (c) => {
  const asset = await getAsset(c.req.param('assetId'))
  if (!asset) return c.json({ error: 'not_found' }, 404)

  const session = await readSession(c)
  if (session && session.jobId !== asset.jobId) return c.json({ error: 'forbidden' }, 403)

  const store = storage()
  await store.delete(asset.originalKey)
  for (const v of asset.variants) await store.delete(v.key)
  await deleteAsset(asset.id)

  await recordEvent(asset.jobId, 'asset.deleted', { assetId: asset.id })
  return c.json({ ok: true })
})

/** Drag-to-reorder. Body: { ids: string[] } in the new gallery order. */
app.patch('/jobs/:jobId/assets/order', async (c) => {
  const jobId = c.req.param('jobId')
  const body = await c.req.json<{ ids?: string[] }>().catch(() => ({}) as { ids?: string[] })
  const ids = body.ids ?? []
  if (!Array.isArray(ids) || ids.length === 0) {
    return c.json({ error: 'bad_request', detail: 'ids must be a non-empty array' }, 400)
  }
  await reorderAssets(jobId, ids)
  return c.json({ ok: true })
})

export default app
