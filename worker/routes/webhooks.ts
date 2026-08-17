import { Hono } from 'hono'
import type { Env } from '../env'
import { verifyShopifyHmac } from '../lib/signing'
import { recordEvent } from '../lib/db'
import { processPaidOrder } from '../lib/orders'
import type { ShopifyOrder } from '../lib/shopify'

const app = new Hono<{ Bindings: Env }>()

/**
 * Shopify webhooks. Brief s3a steps 3 to 7.
 *
 * The signature is verified against the raw body BEFORE the body is parsed, and anything that
 * fails verification is rejected outright. Nothing in the payload is trusted otherwise: the
 * email, the line items and the job id attribute are all treated as claims to be matched, never
 * as instructions.
 */
app.post('/webhooks/shopify', async (c) => {
  const secret = c.env.SHOPIFY_WEBHOOK_SECRET?.trim()
  if (!secret) {
    // Refusing is the only safe answer. Accepting unverified payment webhooks would let anyone
    // mint themselves a paid job.
    await recordEvent(c.env, null, 'webhook.refused', { reason: 'no_secret_configured' })
    return c.json(
      {
        error: 'not_configured',
        detail:
          'SHOPIFY_WEBHOOK_SECRET is not set, so webhooks cannot be verified and are refused. Set it with "npx wrangler secret put SHOPIFY_WEBHOOK_SECRET".',
      },
      503,
    )
  }

  const raw = await c.req.text()
  const signature = c.req.header('x-shopify-hmac-sha256') ?? null

  if (!(await verifyShopifyHmac(secret, raw, signature))) {
    await recordEvent(c.env, null, 'webhook.rejected', {
      reason: 'bad_signature',
      topic: c.req.header('x-shopify-topic') ?? null,
    })
    return c.json({ error: 'invalid_signature' }, 401)
  }

  const topic = c.req.header('x-shopify-topic') ?? 'unknown'

  let order: ShopifyOrder
  try {
    order = JSON.parse(raw) as ShopifyOrder
  } catch {
    return c.json({ error: 'bad_json' }, 400)
  }

  await recordEvent(c.env, null, 'webhook.received', { topic, orderId: String(order.id) })

  if (topic !== 'orders/paid') {
    // Acknowledged so Shopify stops retrying, but nothing is done with it.
    return c.json({ ok: true, ignored: topic })
  }

  try {
    const result = await processPaidOrder(c.env, order)
    return c.json({ ok: true, ...result })
  } catch (err) {
    // A 500 makes Shopify retry, which is what we want if our side broke. The event trail says
    // what happened either way.
    await recordEvent(c.env, null, 'webhook.failed', {
      topic,
      orderId: String(order.id),
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
})

export default app
