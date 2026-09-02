import { Hono } from 'hono'
import { applySubscriptionStatus } from '../lib/subscription.js'
import { config } from '../config.js'
import { verifyShopifyHmac } from '../lib/signing.js'
import { recordEvent } from '../lib/db.js'
import { processPaidOrder } from '../lib/orders.js'
import type { ShopifyOrder } from '../lib/shopify.js'

const app = new Hono()

/**
 * Shopify webhooks. Brief s3a steps 3 to 7.
 *
 * The signature is verified against the raw body BEFORE the body is parsed, and anything that
 * fails verification is rejected outright. Nothing in the payload is trusted otherwise: the
 * email, the line items and the job id attribute are all treated as claims to be matched, never
 * as instructions.
 *
 * INERT UNLESS EXPLICITLY ENABLED. In demo mode, and on any install with no webhook secret, this
 * route refuses and does nothing. A preview install cannot be turned into a live one by pointing
 * a webhook at it.
 */
app.post('/webhooks/shopify', async (c) => {
  const cfg = config()

  if (cfg.demoMode) {
    await recordEvent(null, 'webhook.refused', { reason: 'demo_mode' })
    return c.json(
      {
        error: 'demo_mode',
        detail:
          'This install is in demo mode, so webhooks are inert. Set DEMO_MODE=0 and configure SHOPIFY_WEBHOOK_SECRET to accept real orders.',
      },
      503,
    )
  }

  if (!cfg.shopify.webhookSecret) {
    // Refusing is the only safe answer. Accepting unverified payment webhooks would let anyone
    // mint themselves a paid job.
    await recordEvent(null, 'webhook.refused', { reason: 'no_secret_configured' })
    return c.json(
      {
        error: 'not_configured',
        detail:
          'SHOPIFY_WEBHOOK_SECRET is not set, so webhooks cannot be verified and are refused. Add it to the Vercel project environment variables.',
      },
      503,
    )
  }

  const raw = await c.req.text()
  const signature = c.req.header('x-shopify-hmac-sha256') ?? null

  if (!(await verifyShopifyHmac(cfg.shopify.webhookSecret, raw, signature))) {
    await recordEvent(null, 'webhook.rejected', {
      reason: 'bad_signature',
      topic: c.req.header('x-shopify-topic') ?? null,
    })
    return c.json({ error: 'invalid_signature' }, 401)
  }

  const topic = c.req.header('x-shopify-topic') ?? 'unknown'

  /*
   * SUBSCRIPTION TOPICS ARE HANDLED BEFORE THE ORDER PARSE, because their payload is a
   * subscription contract and casting it to an order would produce an object whose every field is
   * undefined and whose id is missing. Nothing consumed these at all until now, which meant a
   * cancelled customer kept their site, kept editing it, and kept costing money.
   *
   * Shopify's own topics rather than Appstle's, because these arrive signed with the same secret
   * this route already verifies. An Appstle-specific webhook would be a second integration with a
   * second secret and a second thing to go wrong.
   */
  if (topic.startsWith('subscription_contracts/') || topic.startsWith('subscription_billing_attempts/')) {
    /*
     * THE CONTRACT, NOT AN ORDER. Shopify sends { id, customer_id, status, origin_order_id, ... }
     * and no email at any depth, which is why reading one gave '' on every real cancellation.
     */
    let payload: { status?: string; customer_id?: number | string; origin_order_id?: number | string } = {}
    try {
      payload = JSON.parse(raw)
    } catch {
      return c.json({ error: 'bad_json' }, 400)
    }

    const idOf = (v: number | string | undefined) => (v == null ? null : String(v))
    // A failed billing attempt is not a cancellation. Shopify retries, and cards recover. Only
    // the contract's own status decides, so a failure topic with no status changes nothing.
    const status = payload.status ?? ''
    const out = await applySubscriptionStatus({
      originOrderId: idOf(payload.origin_order_id),
      customerId: idOf(payload.customer_id),
      status,
      raw: payload,
    })
    return c.json({ ok: true, topic, ...out })
  }

  let order: ShopifyOrder
  try {
    order = JSON.parse(raw) as ShopifyOrder
  } catch {
    return c.json({ error: 'bad_json' }, 400)
  }

  await recordEvent(null, 'webhook.received', { topic, orderId: String(order.id) })

  if (topic !== 'orders/paid') {
    // Acknowledged so Shopify stops retrying, but nothing is done with it.
    return c.json({ ok: true, ignored: topic })
  }

  try {
    return c.json({ ok: true, ...(await processPaidOrder(order)) })
  } catch (err) {
    // A 500 makes Shopify retry, which is what we want if our side broke. The event trail says
    // what happened either way.
    await recordEvent(null, 'webhook.failed', {
      topic,
      orderId: String(order.id),
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
})

export default app
