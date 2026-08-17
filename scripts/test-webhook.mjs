import { createHmac } from 'node:crypto'

/**
 * Fire a correctly signed Shopify orders/paid webhook at a running dev server.
 *
 * Usage:
 *   SHOPIFY_WEBHOOK_SECRET=... node scripts/test-webhook.mjs [order-id] [email]
 *
 * The secret must match the one in .dev.vars, because the Worker verifies the signature against
 * the raw body and refuses anything that does not check out. That is the point of the script:
 * it proves the real path works, rather than a path with verification switched off.
 */

const BASE = process.env.BASE ?? 'http://localhost:5173'
const SECRET = process.env.SHOPIFY_WEBHOOK_SECRET
const orderId = process.argv[2] ?? String(Date.now())
const email = process.argv[3] ?? 'webhook-test@example.com'

if (!SECRET) {
  console.error('Set SHOPIFY_WEBHOOK_SECRET to the same value as .dev.vars')
  process.exit(1)
}

const order = {
  id: Number(orderId),
  email,
  financial_status: 'paid',
  currency: 'AUD',
  total_price: '220.00',
  created_at: new Date().toISOString(),
  customer: { id: 555001, email, first_name: 'Test', last_name: 'Tradie', phone: '+61412345678' },
  line_items: [
    { product_id: 111, variant_id: 222, sku: 'build-token', title: 'Website Build Token', quantity: 1, price: '200.00' },
  ],
  note_attributes: [],
}

const body = JSON.stringify(order)
const signature = createHmac('sha256', SECRET).update(body, 'utf8').digest('base64')

const send = async (sig, label) => {
  const res = await fetch(`${BASE}/api/webhooks/shopify`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-topic': 'orders/paid',
      'x-shopify-hmac-sha256': sig,
    },
    body,
  })
  console.log(`${label}: ${res.status} ${(await res.text()).slice(0, 300)}`)
  return res.status
}

console.log(`Order ${orderId} for ${email}`)
await send('this-is-not-the-right-signature', 'tampered signature (must be 401)')
await send(signature, 'valid signature   (must be 200)')
await send(signature, 'replayed          (must be 200, and do nothing twice)')
