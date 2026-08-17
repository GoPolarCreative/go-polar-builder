import { Hono } from 'hono'
import type { Env } from '../env'
import type { ContentPlan } from '../../shared/plan'
import { intakeSchema, type IntakePayload } from '../../shared/intake'
import { PRICING, formatPrice } from '../../shared/pricing'
import { getIntake, getJob, listAssets, recordEvent, setJobStatus } from '../lib/db'
import { id, nowIso } from '../lib/ids'
import { buildFacts } from '../lib/facts'
import { buildDischargePackage, isValidWeb3FormsKey } from '../lib/discharge'
import { ShopifyConfigError, createCheckout } from '../lib/shopify'
import { readClaims, signClaims } from '../lib/signing'

const app = new Hono<{ Bindings: Env }>()

/** Brief s9: signed download link, 30 day expiry. */
const DOWNLOAD_TTL_DAYS = 30

interface DischargeRow {
  id: string
  job_id: string
  status: string
  customer_web3forms_key: string | null
  version: number | null
  r2_key: string | null
  file_count: number | null
  bytes: number | null
  used_placeholder: number | null
  checkout_url: string | null
  paid_at: string | null
  prepared_at: string | null
  released_at: string | null
  expires_at: string | null
  created_at: string
}

async function latestDischarge(env: Env, jobId: string): Promise<DischargeRow | null> {
  return (
    (await env.DB.prepare('SELECT * FROM discharges WHERE job_id = ? ORDER BY created_at DESC LIMIT 1')
      .bind(jobId)
      .first<DischargeRow>()) ?? null
  )
}

/**
 * The discharge offer. Brief s9: available from the go-live screen and at any time after launch,
 * VISIBLE, NOT HIDDEN. So this returns everything the customer needs to decide, including what
 * they do not get.
 */
app.get('/jobs/:jobId/discharge', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(c.env, jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const row = await latestDischarge(c.env, jobId)

  return c.json({
    price: formatPrice('discharge'),
    includes: [
      'Your index.html, your images, and a favicon',
      'A standalone preview copy you can open by double clicking',
      'Instructions for putting it on any host',
    ],
    excludes: ['Hosting', 'Domain or DNS setup', 'The website builder and your remaining changes', 'Support'],
    footerCreditStays: true,
    web3formsNote:
      'Your enquiry forms currently send through our Web3Forms account. Before we hand the files over we swap that for your own key, so your enquiries come to you. It is free and takes a minute to set up at web3forms.com. If you would rather sort it later we will leave a clearly marked placeholder instead, but the forms will not send anywhere until you replace it.',
    current: row
      ? {
          status: row.status,
          checkoutUrl: row.checkout_url,
          preparedAt: row.prepared_at,
          releasedAt: row.released_at,
          expiresAt: row.expires_at,
          usedPlaceholder: row.used_placeholder === 1,
          fileCount: row.file_count,
        }
      : null,
  })
})

/**
 * Request a discharge. Validates the customer's own Web3Forms key if they have one, then builds
 * the Shopify checkout. Nothing is packaged until the orders/paid webhook confirms payment.
 */
app.post('/jobs/:jobId/discharge/request', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(c.env, jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)
  if (job.current_version < 1) {
    return c.json({ error: 'not_ready', detail: 'There is no website to hand over yet.' }, 409)
  }

  const body = await c.req
    .json<{ web3formsKey?: string }>()
    .catch(() => ({}) as { web3formsKey?: string })

  const rawKey = (body.web3formsKey ?? '').trim()
  if (rawKey && !isValidWeb3FormsKey(rawKey)) {
    return c.json(
      {
        error: 'invalid_key',
        detail:
          'That does not look like a Web3Forms access key. It is a UUID, like 1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809. Copy it from your Web3Forms dashboard, or leave it blank and we will put a placeholder in.',
        field: 'web3formsKey',
      },
      422,
    )
  }

  const user = await c.env.DB.prepare('SELECT email FROM users WHERE id = ?')
    .bind(job.user_id)
    .first<{ email: string }>()
  const email = user?.email ?? ''

  let checkoutUrl: string | null = null
  let configError: ShopifyConfigError | null = null
  try {
    const checkout = await createCheckout(c.env, {
      jobId,
      email,
      lines: [{ handle: PRICING.discharge.handle, quantity: 1 }],
      returnTo: `${c.env.PUBLIC_APP_URL ?? ''}/discharge/${jobId}?paid=1`,
    })
    checkoutUrl = checkout.url
  } catch (err) {
    if (err instanceof ShopifyConfigError) configError = err
    else throw err
  }

  const dischargeId = id('dis')
  await c.env.DB.prepare(
    `INSERT INTO discharges (id, job_id, status, customer_web3forms_key, checkout_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      dischargeId,
      jobId,
      checkoutUrl ? 'awaiting_payment' : 'requested',
      rawKey || null,
      checkoutUrl,
      nowIso(),
    )
    .run()

  await recordEvent(c.env, jobId, 'discharge.requested', {
    dischargeId,
    hasOwnKey: Boolean(rawKey),
    notify: 'chris',
  })

  if (configError) {
    return c.json(
      { error: 'shopify_not_configured', detail: configError.message, missing: configError.missing, saved: true },
      503,
    )
  }

  return c.json({ dischargeId, checkoutUrl, price: formatPrice('discharge') })
})

/**
 * Package the files. Called by the Shopify orders/paid webhook (Phase 6) and available directly
 * for testing and for Chris to re-run.
 *
 * This does not release anything: it prepares the package and notifies Chris, who releases it
 * (brief s9 step 5).
 */
app.post('/jobs/:jobId/discharge/prepare', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(c.env, jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const row = await latestDischarge(c.env, jobId)
  if (!row) return c.json({ error: 'not_found', detail: 'No discharge has been requested.' }, 404)

  const version = job.current_version
  const [buildRow, planRow, stored, assets] = await Promise.all([
    c.env.DB.prepare('SELECT r2_key FROM builds WHERE job_id = ? AND version = ?')
      .bind(jobId, version)
      .first<{ r2_key: string }>(),
    c.env.DB.prepare('SELECT plan_json FROM plans WHERE job_id = ? AND version = ?')
      .bind(jobId, version)
      .first<{ plan_json: string }>(),
    getIntake(c.env, jobId),
    listAssets(c.env, jobId),
  ])

  if (!buildRow || !planRow) {
    return c.json({ error: 'not_found', detail: 'The current build could not be loaded.' }, 404)
  }
  const object = await c.env.BUCKET.get(buildRow.r2_key)
  if (!object) return c.json({ error: 'not_found', detail: 'Build missing from storage.' }, 404)

  const parsed = intakeSchema.safeParse(stored?.payload)
  if (!parsed.success) return c.json({ error: 'invalid_intake' }, 422)

  const facts = buildFacts(c.env, parsed.data as IntakePayload, assets)
  const plan = JSON.parse(planRow.plan_json) as ContentPlan

  const pkg = await buildDischargePackage(c.env, {
    jobId,
    html: await object.text(),
    plan,
    facts,
    assets,
    customerWeb3FormsKey: row.customer_web3forms_key,
  })

  const expires = new Date(Date.now() + DOWNLOAD_TTL_DAYS * 86_400_000).toISOString()

  await c.env.DB.prepare(
    `UPDATE discharges SET status = 'prepared', version = ?, r2_key = ?, file_count = ?, bytes = ?,
       used_placeholder = ?, prepared_at = ?, expires_at = ? WHERE id = ?`,
  )
    .bind(
      version,
      pkg.r2Key,
      pkg.files.length,
      pkg.zip.length,
      pkg.usedPlaceholder ? 1 : 0,
      nowIso(),
      expires,
      row.id,
    )
    .run()

  await recordEvent(c.env, jobId, 'discharge.prepared', {
    dischargeId: row.id,
    files: pkg.files,
    bytes: pkg.zip.length,
    usedPlaceholder: pkg.usedPlaceholder,
    // The automation prepares it, Chris releases it.
    notify: 'chris',
    action: 'review and release',
  })

  return c.json({
    ok: true,
    files: pkg.files,
    bytes: pkg.zip.length,
    usedPlaceholder: pkg.usedPlaceholder,
    expiresAt: expires,
    status: 'prepared',
    note: 'Prepared and waiting on a human to release it.',
  })
})

/**
 * Release the package to the customer. Human step. Returns the signed download link.
 * PHASE 6: this moves behind an admin check once auth exists.
 */
app.post('/jobs/:jobId/discharge/release', async (c) => {
  const jobId = c.req.param('jobId')
  const row = await latestDischarge(c.env, jobId)
  if (!row) return c.json({ error: 'not_found' }, 404)
  if (row.status !== 'prepared' && row.status !== 'released') {
    return c.json(
      { error: 'not_ready', detail: `The package is ${row.status}, so there is nothing to release yet.` },
      409,
    )
  }

  const expiresAt = row.expires_at ?? new Date(Date.now() + DOWNLOAD_TTL_DAYS * 86_400_000).toISOString()

  const token = await signClaims(c.env, {
    kind: 'download',
    jobId,
    dischargeId: row.id,
    exp: Math.floor(new Date(expiresAt).getTime() / 1000),
  })

  await c.env.DB.prepare("UPDATE discharges SET status = 'released', released_at = ?, expires_at = ? WHERE id = ?")
    .bind(nowIso(), expiresAt, row.id)
    .run()

  await setJobStatus(c.env, jobId, 'discharged')
  await recordEvent(c.env, jobId, 'discharge.released', { dischargeId: row.id, expiresAt })

  const base = c.env.PUBLIC_APP_URL ?? new URL(c.req.url).origin
  return c.json({
    ok: true,
    downloadUrl: `${base}/api/discharge/download?t=${encodeURIComponent(token)}`,
    expiresAt,
  })
})

/**
 * Signed download. The token carries the job, the discharge and the expiry, and is signed with
 * APP_SECRET, so the link works for 30 days and cannot be edited into a link for someone else's
 * files. `kind` is checked so a session cookie can never be replayed as a download token.
 */
app.get('/discharge/download', async (c) => {
  const token = c.req.query('t') ?? ''
  const claims = await readClaims(c.env, token, 'download')
  if (!claims) {
    return c.json(
      {
        error: 'link_expired',
        detail:
          'That download link is not valid any more. They last 30 days. Get in touch and we will send a fresh one.',
      },
      403,
    )
  }

  const row = await c.env.DB.prepare('SELECT * FROM discharges WHERE id = ?')
    .bind(String(claims.dischargeId))
    .first<DischargeRow>()

  if (!row || row.job_id !== claims.jobId || !row.r2_key) {
    return c.json({ error: 'not_found' }, 404)
  }
  if (row.status !== 'released') {
    return c.json(
      { error: 'not_released', detail: 'This package has not been released yet. We will email you when it is.' },
      403,
    )
  }

  const object = await c.env.BUCKET.get(row.r2_key)
  if (!object) return c.json({ error: 'not_found', detail: 'The package is no longer in storage.' }, 404)

  const filename = row.r2_key.split('/').pop() ?? 'website-files.zip'
  await recordEvent(c.env, row.job_id, 'discharge.downloaded', { dischargeId: row.id })

  return new Response(object.body, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  })
})

export default app
