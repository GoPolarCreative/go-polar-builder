import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { getDb, schema } from '../db/client.js'
import { createUserAndJob, getJob, recordEvent, setJobStatus } from './db.js'
import { config } from '../config.js'
import { id } from './ids.js'
import { createBuildToken } from './auth.js'
import { builderLoginLink, previewLink, trackKlaviyoSafely } from './klaviyo.js'
import {
  centsFromPrice,
  refForLineItem,
  kindForRef,
  orderEmail,
  orderJobIdAttribute,
  type ShopifyLineItem,
  type ShopifyOrder,
} from './shopify.js'

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

/**
 * The order number a customer can actually read off their receipt.
 *
 * PREFER `name`, NOT `order_number`. Shopify sends both and they are not the same thing: on a
 * store with a custom prefix, order_number is the bare integer 1258 while name is "#GPC1258", and
 * "#GPC1258" is the only one the customer has ever seen. Preferring the integer stored a value no
 * customer could ever type, which failed every claim on this store.
 *
 * The leading hash goes, because half of them type it and half do not.
 */
export function orderNumberOf(order: ShopifyOrder): string | null {
  const name = (order.name ?? '').trim().replace(/^#/, '')
  if (name) return name
  const number = order.order_number == null ? '' : String(order.order_number).trim().replace(/^#/, '')
  return number || null
}

/**
 * The other number on the receipt.
 *
 * Shopify's thank-you page shows a **confirmation number** — "6M2EGNICA" — in larger type than the
 * order number, and calls the page a confirmation. Asking someone for "the order number from your
 * confirmation" and expecting them to skip past it is asking them to read our minds. The first
 * person to use this door typed the confirmation number, and he wrote the store.
 *
 * So both are stored and both are accepted. They are equally private, equally per-order, and
 * equally useless to anyone who did not buy.
 */
export function confirmationNumberOf(order: ShopifyOrder): string | null {
  const value = (order.confirmation_number ?? '').trim()
  return value || null
}

/**
 * Everything the same order could reasonably be typed as.
 *
 * A customer reads "#GPC1258" and types "GPC1258", "#gpc1258", or just "1258" because the prefix
 * looks like decoration. All three mean one order, and refusing two of them turns a working
 * purchase into a support email.
 *
 * The bare-number form is only offered for the shape it was built for: letters followed by digits.
 * A confirmation number like "6M2EGNICA" would otherwise reduce to "62", which means nothing and
 * exists only to match something it should not.
 */
export function orderNumberForms(value: string): string[] {
  const clean = value.trim().replace(/^#/, '').trim().toLowerCase()
  if (!clean) return []

  const prefixed = /^[a-z]*(\d+)$/.exec(clean)
  return [...new Set([clean, prefixed?.[1]].filter((form): form is string => Boolean(form)))]
}

/**
 * What gets kept on the order row for later.
 *
 * The line items alone used to be stored, which threw away the one field that turned out to matter:
 * the customer-facing order number. When a bug left `shopify_order_number` null for a batch of
 * orders there was nothing on the row to rebuild it from, and the only repair was asking the
 * customer to buy again. Keep the identity next to the goods.
 *
 * Trimmed rather than wholesale: the full payload carries a shipping address this product has no
 * use for, and the customer's name, email and phone are already columns on `users`.
 */
function auditTrail(order: ShopifyOrder): unknown {
  return {
    id: order.id,
    name: order.name ?? null,
    order_number: order.order_number ?? null,
    created_at: order.created_at ?? null,
    confirmation_number: order.confirmation_number ?? null,
    line_items: order.line_items ?? [],
  }
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
      shopifyOrderNumber: orderNumberOf(order),
      shopifyConfirmationNumber: confirmationNumberOf(order),
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
          'post-live update recorded',
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
    shopifyOrderNumber: orderNumberOf(order),
    shopifyConfirmationNumber: confirmationNumberOf(order),
    shopifyCustomerId: order.customer?.id != null ? String(order.customer.id) : null,
    productHandle: ref,
    amountExGst: amount,
    kind: 'build',
    status: 'paid',
    raw: auditTrail(order),
  })

  // Database work is committed before anything that can fail on someone else's infrastructure.
  const token = await createBuildToken(jobId)

  // The email that gets them into the builder. This is the one a paying customer depends on, so
  // the link travels with the event rather than being looked up by whatever sends it.
  await trackKlaviyoSafely({
    metric: 'build_purchased',
    profile: {
      email,
      firstName: order.customer?.first_name ?? null,
      lastName: order.customer?.last_name ?? null,
      phone: order.customer?.phone ?? null,
    },
    jobId,
    properties: {
      builder_login_link: builderLoginLink(token),
      order_id: orderId,
      amount_ex_gst_cents: amount,
    },
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

  /*
   * WHAT THE CONFIRMATION EMAIL NEEDS TO KNOW.
   *
   * This event used to carry a preview link and nothing else, which is not enough to write an
   * honest "here is what happens next". The next step genuinely differs by branch: a domain they
   * already own gets connected, one they asked us to buy gets registered first, and one they
   * cannot get into is a recovery job with no timeframe anybody can promise. A single generic
   * paragraph covering all three either overpromises or says nothing.
   */
  const [domainRow] = await db
    .select({
      name: schema.domains.name,
      branch: schema.domains.branch,
      // Where the customer says they bought it. The first question on the connection call is
      // always "where do we log in", and WHOIS answers with the reseller rather than the brand
      // on the login page. See D57.
      registrar: schema.domains.registrar,
    })
    .from(schema.domains)
    .where(eq(schema.domains.jobId, jobId))
    .orderBy(desc(schema.domains.createdAt))
    .limit(1)

  const jobForEmail = await getJob(jobId)

  await trackKlaviyoSafely({
    metric: 'go_live_requested',
    profile: { email, businessName: jobForEmail?.businessName ?? null },
    jobId,
    properties: {
      preview_link: previewLink(jobId),
      business_name: jobForEmail?.businessName ?? '',
      // '' rather than null: a Klaviyo template comparing against an empty string is easier to
      // get right than one that has to know the difference between null and missing.
      domain_name: domainRow?.name ?? '',
      domain_branch: domainRow?.branch ?? '',
    },
  })

  /*
   * AND TELL CHRIS, because this is the moment the work becomes his.
   *
   * The operator alert used to fire only when somebody PRESSED go live, which is a statement of
   * intent that a fair number of people will not follow through on. Nothing at all fired when the
   * money actually arrived, so the one event that creates an obligation - hosting is now billing,
   * and a domain has to be connected - was the one he was not told about.
   *
   * Both alerts now exist and they mean different things. `alert: go_live_requested` is
   * "somebody wants to", `alert: go_live_paid` is "somebody has, go and do it". A flow can send
   * the first quietly and the second to his phone.
   */
  const cfgOps = config()
  const jobRow = await getJob(jobId)
  await trackKlaviyoSafely({
    metric: 'operator_alert',
    profile: { email: cfgOps.operatorEmail },
    jobId,
    properties: {
      alert: 'go_live_paid',
      business_name: jobRow?.businessName ?? 'Unnamed business',
      customer_email: email,
      job_id: jobId,
      preview_link: previewLink(jobId),
      ops_link: `${cfgOps.publicAppUrl.replace(/\/$/, '')}/ops#job-${jobId}`,
      /*
       * THE DOMAIN, IN THE ALERT ITSELF.
       *
       * The customer answers the domain question BEFORE they pay (D57: domain first, money
       * second), so all of this is known by the time this fires. It was not being passed on,
       * which meant the alert said "somebody paid" and left the operator to go and look up the
       * only three facts the phone call is actually about.
       *
       * domain_action is derived rather than passing the raw branch, because "own" and "locked"
       * mean nothing to somebody reading an email on a phone at 7am.
       */
      domain_name: domainRow?.name ?? '',
      domain_registrar: domainRow?.registrar ?? 'Not stated',
      domain_action:
        domainRow?.branch === 'new'
          ? 'REGISTER this for them, they do not own it yet'
          : domainRow?.branch === 'locked'
            ? 'RECOVERY. Somebody else is holding it and not answering'
            : domainRow?.branch === 'own'
              ? 'CONNECT it. They already own it, get their logins'
              : 'No domain recorded. Ask them what they want to use',
    },
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
  await trackKlaviyoSafely({ metric: 'files_ready', profile: { email }, jobId, properties: {} })
}

async function refEditPayment(jobId: string, ref: string): Promise<void> {
  const db = await getDb()

  /*
   * ONLY THE POST-LIVE UPDATE REACHES HERE NOW.
   *
   * 'extra-edits' was removed in D66: the DIY tier includes ten changes a month, so selling five
   * more pre-launch rounds made no sense once running out simply means going live. There is no
   * product, no price and no path to buy it, so there is nothing to grant.
   *
   * The $110 post-live update product stays on the store because Chris's OTHER website customers
   * use it. A DIY customer never sees it and never should: it would be selling them something the
   * $42.90 they already pay includes.
   */
  void db
  await recordEvent(jobId, 'post_live_edit.paid', { notify: 'chris', action: 'make the change', ref })
}
