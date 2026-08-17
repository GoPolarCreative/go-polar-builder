import type { Env } from '../env'
import { EXTRA_EDITS_QUANTITY } from '../../shared/pricing'
import { recordEvent, setJobStatus } from './db'
import { id, nowIso } from './ids'
import { createBuildToken } from './auth'
import { buildLink } from './auth'
import { buildLinkEmail, sendSafely } from './email'
import { builderLoginLink, notifyGhlSafely, previewLink } from './ghl'
import {
  centsFromPrice,
  handleForLineItem,
  kindForHandle,
  orderEmail,
  orderJobIdAttribute,
  type ShopifyOrder,
} from './shopify'

/**
 * Turning a paid Shopify order into work.
 *
 * Shared by the webhook and by the hourly reconciliation sweep, so a dropped webhook is repaired
 * by exactly the same code path that would have handled it (brief s3a).
 *
 * Everything here is idempotent. The unique index on (shopify_order_id, product_handle) means
 * replaying the same order does nothing twice, which matters because Shopify retries and because
 * the sweep deliberately re-examines recent orders.
 */

export interface ProcessResult {
  orderId: string
  jobId: string | null
  handled: Array<{ handle: string; kind: string; action: string }>
  skipped: Array<{ reason: string; detail?: string }>
}

async function alreadyRecorded(env: Env, orderId: string, handle: string): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT id FROM orders WHERE shopify_order_id = ? AND product_handle = ?',
  )
    .bind(orderId, handle)
    .first<{ id: string }>()
  return Boolean(row)
}

async function findOrCreateUser(
  env: Env,
  email: string,
  order: ShopifyOrder,
): Promise<string> {
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string }>()

  const shopifyCustomerId = order.customer?.id != null ? String(order.customer.id) : null

  if (existing) {
    if (shopifyCustomerId) {
      await env.DB.prepare('UPDATE users SET shopify_customer_id = COALESCE(shopify_customer_id, ?) WHERE id = ?')
        .bind(shopifyCustomerId, existing.id)
        .run()
    }
    return existing.id
  }

  const userId = id('usr')
  const name = [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ') || null
  await env.DB.prepare(
    'INSERT INTO users (id, email, phone, name, shopify_customer_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(userId, email, order.customer?.phone ?? null, name, shopifyCustomerId, nowIso())
    .run()
  return userId
}

/**
 * Which job does a non-build order belong to?
 * The job_id attribute we attach to every generated checkout, first. Otherwise the customer's
 * most recent job that is not already discharged, which is the only sensible reading.
 */
async function resolveJob(env: Env, order: ShopifyOrder, email: string | null): Promise<string | null> {
  const attribute = orderJobIdAttribute(order)
  if (attribute) {
    const row = await env.DB.prepare('SELECT id FROM jobs WHERE id = ?').bind(attribute).first<{ id: string }>()
    if (row) return row.id
  }
  if (!email) return null

  const row = await env.DB.prepare(
    `SELECT j.id FROM jobs j JOIN users u ON u.id = j.user_id
     WHERE u.email = ? AND j.status != 'discharged'
     ORDER BY j.created_at DESC LIMIT 1`,
  )
    .bind(email)
    .first<{ id: string }>()
  return row?.id ?? null
}

export async function processPaidOrder(env: Env, order: ShopifyOrder): Promise<ProcessResult> {
  const orderId = String(order.id)
  const email = orderEmail(order)
  const result: ProcessResult = { orderId, jobId: null, handled: [], skipped: [] }

  if (!email) {
    result.skipped.push({ reason: 'no_email', detail: 'Order has no email address to match on.' })
    await recordEvent(env, null, 'order.unmatched', { orderId, reason: 'no_email' })
    return result
  }

  const lineItems = order.line_items ?? []
  if (lineItems.length === 0) {
    result.skipped.push({ reason: 'no_line_items' })
    return result
  }

  for (const item of lineItems) {
    const handle = handleForLineItem(env, item)
    if (!handle) {
      result.skipped.push({ reason: 'unknown_product', detail: item.title ?? 'untitled line' })
      await recordEvent(env, null, 'order.unmatched_line', { orderId, title: item.title ?? null })
      continue
    }

    const kind = kindForHandle(handle)
    if (!kind) {
      result.skipped.push({ reason: 'unknown_kind', detail: handle })
      continue
    }

    if (await alreadyRecorded(env, orderId, handle)) {
      result.skipped.push({ reason: 'already_processed', detail: handle })
      continue
    }

    const amount = centsFromPrice(item.price)

    if (kind === 'build') {
      const jobId = await handleBuildToken(env, order, email, orderId, handle, amount)
      result.jobId = jobId
      result.handled.push({ handle, kind, action: 'job created and build link emailed' })
      continue
    }

    const jobId = await resolveJob(env, order, email)
    if (!jobId) {
      result.skipped.push({ reason: 'no_matching_job', detail: handle })
      await recordEvent(env, null, 'order.unmatched', { orderId, handle, email, reason: 'no_matching_job' })
      continue
    }
    result.jobId = jobId

    await env.DB.prepare(
      `INSERT INTO orders (id, job_id, shopify_order_id, shopify_customer_id, product_handle, amount_ex_gst, kind, status, raw_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?)`,
    )
      .bind(
        id('ord'),
        jobId,
        orderId,
        order.customer?.id != null ? String(order.customer.id) : null,
        handle,
        amount,
        kind,
        JSON.stringify(item),
        nowIso(),
      )
      .run()

    if (kind === 'hosting' || kind === 'domain' || kind === 'email') {
      await handleGoLivePayment(env, jobId, email)
      result.handled.push({ handle, kind, action: 'go live payment recorded' })
    } else if (kind === 'discharge') {
      await handleDischargePayment(env, jobId, email)
      result.handled.push({ handle, kind, action: 'discharge marked paid, packaging queued' })
    } else if (kind === 'edit') {
      await handleEditPayment(env, jobId, handle)
      result.handled.push({
        handle,
        kind,
        action: handle === 'extra-edits' ? `${EXTRA_EDITS_QUANTITY} extra edits added` : 'post-live update recorded',
      })
    }
  }

  return result
}

async function handleBuildToken(
  env: Env,
  order: ShopifyOrder,
  email: string,
  orderId: string,
  handle: string,
  amount: number,
): Promise<string> {
  const userId = await findOrCreateUser(env, email, order)
  const jobId = id('job')
  const now = nowIso()

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO jobs (id, user_id, status, created_at, updated_at) VALUES (?, ?, 'paid', ?, ?)`,
    ).bind(jobId, userId, now, now),
    env.DB.prepare(
      `INSERT INTO orders (id, job_id, shopify_order_id, shopify_customer_id, product_handle, amount_ex_gst, kind, status, raw_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'build', 'paid', ?, ?)`,
    ).bind(
      id('ord'),
      jobId,
      orderId,
      order.customer?.id != null ? String(order.customer.id) : null,
      handle,
      amount,
      JSON.stringify(order.line_items ?? []),
      now,
    ),
  ])

  // Database work is committed before anything that can fail on someone else's infrastructure.
  const token = await createBuildToken(env, jobId)
  const link = buildLink(env, token)

  const message = buildLinkEmail({ link })
  await sendSafely(env, jobId, 'build_link', { ...message, to: email })

  await notifyGhlSafely(env, {
    event: 'payment_received',
    contact: {
      email,
      phone: order.customer?.phone ?? null,
      firstName: order.customer?.first_name ?? null,
    },
    jobId,
    customValues: { builder_login_link: builderLoginLink(env, token) },
    data: { orderId, amountExGstCents: amount },
  })

  await recordEvent(env, jobId, 'order.paid.build', { orderId, email })
  return jobId
}

async function handleGoLivePayment(env: Env, jobId: string, email: string): Promise<void> {
  const now = nowIso()
  await env.DB.prepare(
    `INSERT INTO golive (job_id, hosting, paid_at, status, created_at, updated_at)
     VALUES (?, 1, ?, 'paid', ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET paid_at = excluded.paid_at, status = 'paid', updated_at = excluded.updated_at`,
  )
    .bind(jobId, now, now, now)
    .run()

  // Only now does the job move on. Hosting billing starts here and nowhere earlier.
  await setJobStatus(env, jobId, 'go_live_pending')
  await recordEvent(env, jobId, 'golive.paid', { email, notify: 'chris' })

  await notifyGhlSafely(env, {
    event: 'go_live_requested',
    contact: { email },
    jobId,
    customValues: { preview_link: previewLink(env, jobId) },
  })
}

async function handleDischargePayment(env: Env, jobId: string, email: string): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT id FROM discharges WHERE job_id = ? AND status IN ('requested','awaiting_payment') ORDER BY created_at DESC LIMIT 1",
  )
    .bind(jobId)
    .first<{ id: string }>()

  const now = nowIso()
  if (row) {
    await env.DB.prepare("UPDATE discharges SET status = 'paid', paid_at = ? WHERE id = ?")
      .bind(now, row.id)
      .run()
  } else {
    // Paid without going through the app, which is unusual but should not be lost.
    await env.DB.prepare(
      "INSERT INTO discharges (id, job_id, status, paid_at, created_at) VALUES (?, ?, 'paid', ?, ?)",
    )
      .bind(id('dis'), jobId, now, now)
      .run()
  }

  await recordEvent(env, jobId, 'discharge.paid', {
    email,
    notify: 'chris',
    action: 'package and release',
  })

  await notifyGhlSafely(env, {
    event: 'discharge_requested',
    contact: { email },
    jobId,
    customValues: {},
  })
}

async function handleEditPayment(env: Env, jobId: string, handle: string): Promise<void> {
  if (handle === 'extra-edits') {
    await env.DB.prepare(
      'UPDATE jobs SET edits_allowed = edits_allowed + ?, held = 0, updated_at = ? WHERE id = ?',
    )
      .bind(EXTRA_EDITS_QUANTITY, nowIso(), jobId)
      .run()
    await recordEvent(env, jobId, 'edits.extended', { added: EXTRA_EDITS_QUANTITY })
  } else {
    await recordEvent(env, jobId, 'post_live_edit.paid', { notify: 'chris', action: 'make the change' })
  }
}
