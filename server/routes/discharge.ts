import { Hono } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import { getDb, schema } from '../db/client.js'
import type { ContentPlan } from '../../shared/plan.js'
import { intakeSchema, type IntakePayload } from '../../shared/intake.js'
import { ProductNotOnStoreError, formatPrice } from '../../shared/pricing.js'
import { config } from '../config.js'
import { getIntake, getJob, getUserForJob, getVerifiedFormsKey, listAssets, recordEvent, setJobStatus } from '../lib/db.js'
import { id } from '../lib/ids.js'
import { buildFacts } from '../lib/facts.js'
import { buildDischargePackage } from '../lib/discharge.js'
import { classifyWeb3FormsKey, maskKey, verifyWeb3FormsKey } from '../lib/web3forms.js'
import { ShopifyConfigError, createCheckout } from '../lib/shopify.js'
import { refForCheckout } from '../lib/products.js'
import { readClaims, signClaims } from '../lib/signing.js'
import { requireAdmin } from '../lib/auth.js'
import { dischargeReadyEmail, sendSafely } from '../lib/email.js'
import { storage, toBody } from '../lib/storage.js'
import { loadPageSet } from '../lib/buildSet.js'

const app = new Hono()

/** Brief s9: signed download link, 30 day expiry. */
const DOWNLOAD_TTL_DAYS = 30

async function latestDischarge(jobId: string) {
  const db = await getDb()
  const rows = await db
    .select()
    .from(schema.discharges)
    .where(eq(schema.discharges.jobId, jobId))
    .orderBy(desc(schema.discharges.createdAt))
    .limit(1)
  return rows[0] ?? null
}

/**
 * The discharge offer. Brief s9: available from the go-live screen and at any time after launch,
 * VISIBLE, NOT HIDDEN. So this returns everything needed to decide, including what they do not
 * get.
 */
app.get('/jobs/:jobId/discharge', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const row = await latestDischarge(jobId)

  return c.json({
    price: formatPrice('discharge'),
    includes: [
      'Your index.html, your images already resized for the web, and a favicon',
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
          checkoutUrl: row.checkoutUrl,
          preparedAt: row.preparedAt?.toISOString() ?? null,
          releasedAt: row.releasedAt?.toISOString() ?? null,
          expiresAt: row.expiresAt?.toISOString() ?? null,
          usedPlaceholder: row.usedPlaceholder ?? false,
          fileCount: row.fileCount,
        }
      : null,
  })
})

/**
 * Request a discharge. Validates the customer's own Web3Forms key if they have one, then builds
 * the checkout. Nothing is packaged until payment is confirmed.
 */
app.post('/jobs/:jobId/discharge/request', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)
  if (job.currentVersion < 1) {
    return c.json({ error: 'not_ready', detail: 'There is no website to hand over yet.' }, 409)
  }

  const body = await c.req.json<{ web3formsKey?: string }>().catch(() => ({}) as { web3formsKey?: string })

  // One validated path, shared with go-live (DECISIONS.md D29). A customer who already went
  // through go-live has a key on the job that is known to work, so they are not asked twice.
  let rawKey = (body.web3formsKey ?? '').trim()
  let keyAlreadyVerified = false

  if (!rawKey && job.web3formsKeyMasked && job.web3formsVerifiedAt) {
    rawKey = (await getVerifiedFormsKey(jobId)) ?? ''
    keyAlreadyVerified = true
  }

  if (rawKey && !keyAlreadyVerified) {
    const shape = classifyWeb3FormsKey(rawKey)
    if (!shape.ok || !shape.key) {
      return c.json({ error: 'invalid_key', reason: shape.reason, detail: shape.message, field: 'web3formsKey' }, 422)
    }

    // Same rule as go-live: a key is not accepted on the strength of its shape. A wrong key here
    // means a handed-over site whose forms silently go nowhere, and by then the customer has left
    // and there is nobody watching it.
    const verification = await verifyWeb3FormsKey(
      shape.key,
      { businessName: job.businessName ?? 'your business', jobId },
      config(),
    )
    if (!verification.ok) {
      await recordEvent(jobId, 'discharge.forms_key_rejected', {
        key: maskKey(shape.key),
        detail: verification.detail,
      })
      return c.json({ error: 'key_rejected', detail: verification.message, field: 'web3formsKey', tested: true }, 422)
    }

    rawKey = shape.key
    // Worth keeping on the job: it has now been tested, and the go-live flow should not ask again.
    const db = await getDb()
    await db
      .update(schema.jobs)
      .set({ customerWeb3formsKey: shape.key, web3formsVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.jobs.id, jobId))
  }

  const user = await getUserForJob(jobId)
  let checkoutUrl: string | null = null
  let configError: { detail: string; missing: string[] } | null = null

  try {
    const checkout = await createCheckout({
      jobId,
      email: user?.email ?? '',
      lines: [{ ref: refForCheckout('discharge'), quantity: 1 }],
      returnTo: `${config().publicAppUrl}/discharge/${jobId}?paid=1`,
    })
    checkoutUrl = checkout.url
  } catch (err) {
    if (err instanceof ShopifyConfigError) configError = { detail: err.message, missing: err.missing }
    else if (err instanceof ProductNotOnStoreError) {
      configError = { detail: err.message, missing: [`Shopify product "${err.proposedRef}"`] }
    }
    else if (err instanceof Error && err.name === 'LiveActionBlockedError') {
      configError = { detail: err.message, missing: ['ENABLE_LIVE_PAYMENTS'] }
    } else throw err
  }

  const db = await getDb()
  const dischargeId = id('dis')
  await db.insert(schema.discharges).values({
    id: dischargeId,
    jobId,
    status: checkoutUrl ? 'awaiting_payment' : 'requested',
    customerWeb3formsKey: rawKey || null,
    checkoutUrl,
  })

  await recordEvent(jobId, 'discharge.requested', {
    dischargeId,
    hasOwnKey: Boolean(rawKey),
    notify: 'chris',
  })

  if (configError) {
    return c.json(
      { error: 'checkout_unavailable', detail: configError.detail, missing: configError.missing, saved: true },
      503,
    )
  }

  return c.json({ dischargeId, checkoutUrl, price: formatPrice('discharge') })
})

/**
 * Package the files. Called after payment is confirmed, and available directly so Chris can
 * re-run it.
 *
 * This does not release anything: it prepares the package and notifies Chris, who releases it
 * (brief s9 step 5).
 */
app.post('/jobs/:jobId/discharge/prepare', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const row = await latestDischarge(jobId)
  if (!row) return c.json({ error: 'not_found', detail: 'No discharge has been requested.' }, 404)

  const db = await getDb()
  const version = job.currentVersion

  const [buildRow, planRow, stored, assets] = await Promise.all([
    db
      .select({ blobKey: schema.builds.blobKey })
      .from(schema.builds)
      .where(and(eq(schema.builds.jobId, jobId), eq(schema.builds.version, version)))
      .limit(1),
    db
      .select({ plan: schema.plans.plan })
      .from(schema.plans)
      .where(and(eq(schema.plans.jobId, jobId), eq(schema.plans.version, version)))
      .limit(1),
    getIntake(jobId),
    listAssets(jobId),
  ])

  if (!buildRow[0] || !planRow[0]) {
    return c.json({ error: 'not_found', detail: 'The current build could not be loaded.' }, 404)
  }
  const store = storage()
  const set = await loadPageSet(jobId, version)

  const homeKey = set.find((pg) => pg.path === 'index.html')?.blobKey ?? buildRow[0].blobKey
  const html = await store.getText(homeKey)
  if (html === null) return c.json({ error: 'not_found', detail: 'Build missing from storage.' }, 404)

  // The rest of the set. A customer who paid for extra pages and got a zip with one page in it
  // has not been handed their website, so a missing page stops the package rather than shrinking
  // it quietly.
  const extraPages: Array<{ path: string; html: string }> = []
  for (const page of set.filter((pg) => pg.path !== 'index.html')) {
    const pageHtml = await store.getText(page.blobKey)
    if (pageHtml === null) {
      return c.json({ error: 'not_found', detail: `${page.path} is missing from storage.` }, 404)
    }
    extraPages.push({ path: page.path, html: pageHtml })
  }

  const extraFiles: Array<{ path: string; content: string }> = []
  if (extraPages.length > 0) {
    for (const name of ['sitemap.xml', 'robots.txt']) {
      const content = await store.getText(`jobs/${jobId}/builds/v${version}/${name}`)
      if (content !== null) extraFiles.push({ path: name, content })
    }
  }

  const parsed = intakeSchema.safeParse(stored?.payload)
  if (!parsed.success) return c.json({ error: 'invalid_intake' }, 422)

  const facts = buildFacts(parsed.data as IntakePayload, assets)
  const plan = planRow[0].plan as ContentPlan

  const pkg = await buildDischargePackage({
    jobId,
    html,
    plan,
    facts,
    customerWeb3FormsKey: row.customerWeb3formsKey,
    extraPages,
    extraFiles,
  })

  const expires = new Date(Date.now() + DOWNLOAD_TTL_DAYS * 86_400_000)

  await db
    .update(schema.discharges)
    .set({
      status: 'prepared',
      version,
      blobKey: pkg.blobKey,
      fileCount: pkg.files.length,
      bytes: pkg.zip.length,
      usedPlaceholder: pkg.usedPlaceholder,
      preparedAt: new Date(),
      expiresAt: expires,
    })
    .where(eq(schema.discharges.id, row.id))

  await recordEvent(jobId, 'discharge.prepared', {
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
    expiresAt: expires.toISOString(),
    status: 'prepared',
    note: 'Prepared and waiting on a human to release it.',
  })
})

// Declared as middleware rather than inline, so the route keeps its path-param typing.
app.use('/jobs/:jobId/discharge/release', requireAdmin)

/** Release the package to the customer. Human step. Returns the signed download link. */
app.post('/jobs/:jobId/discharge/release', async (c) => {
  const jobId = c.req.param('jobId')
  const row = await latestDischarge(jobId)
  if (!row) return c.json({ error: 'not_found' }, 404)
  if (row.status !== 'prepared' && row.status !== 'released') {
    return c.json(
      { error: 'not_ready', detail: `The package is ${row.status}, so there is nothing to release yet.` },
      409,
    )
  }

  const expiresAt = row.expiresAt ?? new Date(Date.now() + DOWNLOAD_TTL_DAYS * 86_400_000)

  const token = await signClaims({
    kind: 'download',
    jobId,
    dischargeId: row.id,
    exp: Math.floor(expiresAt.getTime() / 1000),
  })

  const db = await getDb()
  await db
    .update(schema.discharges)
    .set({ status: 'released', releasedAt: new Date(), expiresAt })
    .where(eq(schema.discharges.id, row.id))

  await setJobStatus(jobId, 'discharged')
  await recordEvent(jobId, 'discharge.released', { dischargeId: row.id, expiresAt: expiresAt.toISOString() })

  const base = config().publicAppUrl.replace(/\/$/, '')
  const downloadUrl = `${base}/api/discharge/download?t=${encodeURIComponent(token)}`

  const job = await getJob(jobId)
  const user = await getUserForJob(jobId)
  if (user?.email) {
    await sendSafely(jobId, 'discharge_ready', {
      ...dischargeReadyEmail({
        businessName: job?.businessName ?? 'Your',
        downloadLink: downloadUrl,
        expiresAt: expiresAt.toISOString(),
        usedPlaceholder: row.usedPlaceholder ?? false,
      }),
      to: user.email,
    })
  }

  return c.json({ ok: true, downloadUrl, expiresAt: expiresAt.toISOString() })
})

/**
 * Signed download. The token carries the job, the discharge and the expiry, and is signed with
 * APP_SECRET, so the link works for 30 days and cannot be edited into a link for someone else's
 * files. `kind` is checked so a session cookie can never be replayed as a download token.
 */
app.get('/discharge/download', async (c) => {
  const claims = await readClaims(c.req.query('t') ?? '', 'download')
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

  const db = await getDb()
  const rows = await db
    .select()
    .from(schema.discharges)
    .where(eq(schema.discharges.id, String(claims.dischargeId)))
    .limit(1)
  const row = rows[0]

  if (!row || row.jobId !== claims.jobId || !row.blobKey) return c.json({ error: 'not_found' }, 404)
  if (row.status !== 'released') {
    return c.json(
      { error: 'not_released', detail: 'This package has not been released yet. We will email you when it is.' },
      403,
    )
  }

  const bytes = await storage().get(row.blobKey)
  if (!bytes) return c.json({ error: 'not_found', detail: 'The package is no longer in storage.' }, 404)

  const filename = row.blobKey.split('/').pop() ?? 'website-files.zip'
  await recordEvent(row.jobId, 'discharge.downloaded', { dischargeId: row.id })

  return new Response(toBody(bytes), {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${filename}"`,
      'content-length': String(bytes.byteLength),
      'cache-control': 'no-store',
    },
  })
})

export default app
