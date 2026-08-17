import { Hono } from 'hono'
import { config } from '../config'
import { processPaidOrder } from '../lib/orders'
import { runSweep } from '../lib/sweep'
import { getJob, recordEvent } from '../lib/db'
import { id } from '../lib/ids'
import { fakeLog } from '../lib/integrations/fakes'
import type { ShopifyOrder } from '../lib/shopify'

const app = new Hono()

/**
 * Demo mode routes. Local preview only.
 *
 * Every route here refuses to run unless DEMO_MODE is on, and demo mode itself turns off the
 * moment real credentials are configured. Nothing in this file can charge anyone, email anyone
 * or change DNS.
 *
 * The point is that the flows a customer would go through after paying can be clicked all the
 * way through on a laptop with no accounts: the demo checkout runs the very same
 * processPaidOrder the real Shopify webhook runs, so what gets exercised is the production path.
 */

function requireDemo(c: { json: (body: unknown, status?: 403) => Response }): Response | null {
  if (config().demoMode) return null
  return c.json(
    {
      error: 'not_demo_mode',
      detail: 'Demo routes are only available when DEMO_MODE is on. This install has real credentials.',
    },
    403,
  )
}

/** Confirm a fake purchase. The customer is sent here by the fake checkout link. */
app.post('/demo/checkout/complete', async (c) => {
  const blocked = requireDemo(c)
  if (blocked) return blocked

  const body = await c.req
    .json<{ jobId?: string; email?: string; lines?: string }>()
    .catch(() => ({}) as { jobId?: string; email?: string; lines?: string })

  const jobId = (body.jobId ?? '').trim()
  const email = (body.email ?? '').trim().toLowerCase()
  const lines = (body.lines ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [handle, quantity] = part.split(':')
      return { handle: handle ?? '', quantity: Number(quantity ?? 1) || 1 }
    })
    .filter((l) => l.handle)

  if (!email || lines.length === 0) {
    return c.json({ error: 'bad_request', detail: 'Need an email and at least one line item.' }, 400)
  }

  // A synthetic order in exactly the shape Shopify sends, so the code under test is the real one.
  const order: ShopifyOrder = {
    id: `demo_${id('ord')}`,
    email,
    financial_status: 'paid',
    currency: 'AUD',
    customer: { id: 'demo_customer', email },
    note_attributes: jobId ? [{ name: 'job_id', value: jobId }] : [],
    line_items: lines.map((l) => ({
      sku: l.handle,
      title: l.handle,
      quantity: l.quantity,
      price: '0.00',
    })),
  }

  fakeLog('shopify', 'receive an orders/paid webhook', { jobId, lines: lines.map((l) => l.handle).join(',') })

  const result = await processPaidOrder(order)
  await recordEvent(result.jobId ?? jobId ?? null, 'demo.checkout.completed', {
    lines: lines.map((l) => l.handle),
    handled: result.handled,
  })

  return c.json({ ok: true, ...result })
})

/** Run the hourly sweep by hand, so the recovery paths can be watched. */
app.post('/demo/sweep', async (c) => {
  const blocked = requireDemo(c)
  if (blocked) return blocked
  return c.json(await runSweep())
})

/** What state is this job in? Handy while clicking through the flows. */
app.get('/demo/job/:jobId', async (c) => {
  const blocked = requireDemo(c)
  if (blocked) return blocked

  const job = await getJob(c.req.param('jobId'))
  if (!job) return c.json({ error: 'not_found' }, 404)
  return c.json({ job })
})

export default app
