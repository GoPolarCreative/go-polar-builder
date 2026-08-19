import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { getDb, schema } from '../db/client'
import { EXTRA_EDITS_QUANTITY } from '../../shared/pricing'
import { createUserAndJob, recordEvent, setJobStatus } from './db'
import { id } from './ids'
import { buildLink, createBuildToken } from './auth'
import { buildLinkEmail, sendSafely } from './email'
import { builderLoginLink, notifyGhlSafely, previewLink } from './ghl'
import {
  centsFromPrice,
  refForLineItem,
  kindForRef,
  orderEmail,
  orderJobIdAttribute,
  type ShopifyLineItem,
  type ShopifyOrder,
} from './shopify'

/**
 * Turning a paid order into work.
 *
 * Shared by the Shopify webhook, the hourly reconciliation sweep and the demo checkout, so a
 * dropped webhook is repaired by exactly the code path that would have handled it, and the local
 * demo exercises the production logic rather than a parallel imitation.
 *
 * Everything here is idempotent. The unique index on (shopify_order_id, product_ref) means
 * replaying an order does nothing twice, which matters because Shopify retries and because the
 * sweep deliberately re-examines recent orders.
 */

export interface ProcessResult {
  orderId: string
  jobId: string | null
  handled: Array<{ ref: string; kind: string; action: string }>
  skipped: Array<{ reason: string; detail?: string }>
}

async function alreadyRecorded(orderId: string, ref: string): Promise<boolean> {
  const db = await getDb()
  const rows = await db
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(and(eq(schema.orders.shopifyOrderId, orderId), eq(schema.orders.productHandle, ref)))
    .limit(1)
  return rows.length > 0
}

/**
 * Which job does a non-build order belong to?
 * The job_id attribute attached to every generated checkout, first. Otherwise the customer's most
 * recent job that is not already discharged, which is the only sensible reading.
 */
async function resolveJob(order: ShopifyOrder, email: string | null): Promise<string | null> {
  const db = await getDb()
  const attribute = orderJobIdAttribute(order)

  if (attribute) {
    const rows = await db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, attribute))
      .limit(1)
    if (rows[0]) return rows[0].id
  }
  if (!email) return null

  const rows = await db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .innerJoin(schema.users, eq(schema.users.id, schema.jobs.userId))
    .where(and(eq(schema.users.email, email), sql`${schema.jobs.status} <> 'discharged'`))
    .orderBy(desc(schema.jobs.createdAt))
    .limit(1)
  return rows[0]?.id ?? null
}

export async function processPaidOrder(order: ShopifyOrder): Promise<ProcessResult> {
  const db = await getDb()
  const orderId = String(order.id)
  const email = orderEmail(order)
  const result: ProcessResult = { orderId, jobId: null, handled: [], skipped: [] }

  if (!email) {
    result.skipped.push({ reason: 'no_email', detail: 'Order has no email address to match on.' })
    await recordEvent(null, 'order.unmatched', { orderId, reason: 'no_email' })
    return result
  }

  const lineItems = [...(order.line_items ?? [])].sort((a, b) => {
    // Build token first, everything else after it, order otherwise preserved.
    const rank = (item: ShopifyLineItem) => (kindForRef(refForLineItem(item) ?? '') === 'build' ? 0 : 1)
    return rank(a) - rank(b)
  })
  if (lineItems.length === 0) {
    result.skipped.push({ reason: 'no_line_items' })
    return result
  }

  for (const item of lineItems) {
    const ref = refForLineItem(item)
    if (!ref) {
      result.skipped.push({ reason: 'unknown_product', detail: item.title ?? 'untitled line' })
      await recordEvent(null, 'order.unmatched_line', { orderId, title: item.title ?? null })
      continue
    }

    const kind = kindForRef(ref)
    if (!kind) {
      result.skipped.push({ reason: 'unknown_kind', detail: ref })
      continue
    }

    if (await alreadyRecorded(orderId, ref)) {
      result.skipped.push({ reason: 'already_processed', detail: ref })
      continue
    }

    const amount = centsFromPrice(item.price)

    if (kind === 'build') {
      const jobId = await refBuildToken(order, email, orderId, ref, amount)
      result.jobId = jobId
      result.handled.push({ ref, kind, action: 'job created and build link emailed' })
      continue
    }

    const jobId = await resolveJob(order, email)
    if (!jobId) {
      result.skipped.push({ reason: 'no_matching_job', detail: ref })
      await recordEvent(null, 'order.unmatched', { orderId, ref, email, reason: 'no_matching_job' })
      continue
    }
    result.jobId = jobId

    await db.insert(schema.orders).values({
      id: id('ord'),
      jobId,
      shopifyOrderId: orderId,
      shopifyCustomerId: order.customer?.id != null ? String(order.customer.id) : null,
      productHandle: ref,
      amountExGst: amount,
      kind,
      status: 'paid',
      raw: item,
    })

    if (kind === 'hosting' || kind === 'domain' || kind === 'email') {
      await refGoLivePayment(jobId, email)
      result.handled.push({ ref, kind, action: 'go live payment recorded' })
    } else if (kind === 'discharge') {
      await refDischargePayment(jobId, email)
      result.handled.push({ ref, kind, action: 'discharge marked paid, packaging queued' })
    } else if (kind === 'page') {
      const granted = Math.max(1, Math.trunc(Number(item.quantity ?? 1)) || 1)
      const total = await grantPages(jobId, granted)
      result.handled.push({
        ref,
        kind,
        action: `${granted} additional page(s) granted, ${total} total`,
      })
    } else if (kind === 'edit') {
      await refEditPayment(jobId, ref)
      result.handled.push({
        ref,
        kind,
        action:
          ref === 'extra-edits' ? `${EXTRA_EDITS_QUANTITY} extra edits added` : 'post-live update recorded',
      })
    }
  }

  return result
}

async function refBuildToken(
  order: ShopifyOrder,
  email: string,
  orderId: string,
  ref: string,
  amount: number,
): Promise<string> {
  const db = await getDb()

  const { jobId } = await createUserAndJob({
    email,
    name: [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ') || null,
    phone: order.customer?.phone ?? null,
    shopifyCustomerId: order.customer?.id != null ? String(order.customer.id) : null,
  })

  await db.insert(schema.orders).values({
    id: id('ord'),
    jobId,
    shopifyOrderId: orderId,
    shopifyCustomerId: order.customer?.id != null ? String(order.customer.id) : null,
    productHandle: ref,
    amountExGst: amount,
    kind: 'build',
    status: 'paid',
    raw: order.line_items ?? [],
  })

  // Database work is committed before anything that can fail on someone else's infrastructure.
  const token = await createBuildToken(jobId)
  const link = buildLink(token)

  await sendSafely(jobId, 'build_link', { ...buildLinkEmail({ link }), to: email })

  await notifyGhlSafely({
    event: 'payment_received',
    contact: {
      email,
      phone: order.customer?.phone ?? null,
      firstName: order.customer?.first_name ?? null,
    },
    jobId,
    customValues: { builder_login_link: builderLoginLink(token) },
    data: { orderId, amountExGstCents: amount },
  })

  await recordEvent(jobId, 'order.paid.build', { orderId, email })
  return jobId
}

/**
 * Add to a job's page allowance.
 *
 * An INCREMENT, never a set. Additional pages can be bought at the original checkout or months
 * later through a generated link, and a later purchase has to top up the job the customer already
 * has rather than starting again or overwriting what they already paid for.
 */
async function grantPages(jobId: string, count: number): Promise<number> {
  const db = await getDb()
  const rows = await db
    .update(schema.jobs)
    .set({ pagesAllowed: sql`${schema.jobs.pagesAllowed} + ${count}`, updatedAt: new Date() })
    .where(eq(schema.jobs.id, jobId))
    .returning()

  const total = rows[0]?.pagesAllowed ?? count + 1
  await recordEvent(jobId, 'pages.granted', { granted: count, pagesAllowed: total, notify: 'chris' })
  return total
}

async function refGoLivePayment(jobId: string, email: string): Promise<void> {
  const db = await getDb()
  const now = new Date()

  await db
    .insert(schema.golive)
    .values({ jobId, hosting: true, paidAt: now, status: 'paid', updatedAt: now })
    .onConflictDoUpdate({
      target: schema.golive.jobId,
      set: { paidAt: now, status: 'paid', updatedAt: now },
    })

  // Only now does the job move on. Hosting billing starts here and nowhere earlier.
  await setJobStatus(jobId, 'go_live_pending')
  await recordEvent(jobId, 'golive.paid', { email, notify: 'chris' })

  await notifyGhlSafely({
    event: 'go_live_requested',
    contact: { email },
    jobId,
    customValues: { preview_link: previewLink(jobId) },
  })
}

async function refDischargePayment(jobId: string, email: string): Promise<void> {
  const db = await getDb()
  const now = new Date()

  const pending = await db
    .select({ id: schema.discharges.id })
    .from(schema.discharges)
    .where(
      and(
        eq(schema.discharges.jobId, jobId),
        inArray(schema.discharges.status, ['requested', 'awaiting_payment']),
      ),
    )
    .orderBy(desc(schema.discharges.createdAt))
    .limit(1)

  if (pending[0]) {
    await db
      .update(schema.discharges)
      .set({ status: 'paid', paidAt: now })
      .where(eq(schema.discharges.id, pending[0].id))
  } else {
    // Paid without going through the app, which is unusual but should not be lost.
    await db.insert(schema.discharges).values({ id: id('dis'), jobId, status: 'paid', paidAt: now })
  }

  await recordEvent(jobId, 'discharge.paid', { email, notify: 'chris', action: 'package and release' })
  await notifyGhlSafely({ event: 'discharge_requested', contact: { email }, jobId, customValues: {} })
}

async function refEditPayment(jobId: string, ref: string): Promise<void> {
  const db = await getDb()

  if (ref === 'extra-edits') {
    await db
      .update(schema.jobs)
      .set({
        editsAllowed: sql`${schema.jobs.editsAllowed} + ${EXTRA_EDITS_QUANTITY}`,
        held: false,
        updatedAt: new Date(),
      })
      .where(eq(schema.jobs.id, jobId))
    await recordEvent(jobId, 'edits.extended', { added: EXTRA_EDITS_QUANTITY })
  } else {
    await recordEvent(jobId, 'post_live_edit.paid', { notify: 'chris', action: 'make the change' })
  }
}
