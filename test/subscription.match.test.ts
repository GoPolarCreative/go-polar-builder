import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PRICING } from '../shared/pricing'

/**
 * A cancellation has to find the job it belongs to.
 *
 * applySubscriptionStatus matched on the customer's email, and the comment above it called that
 * "the only identifier that survives the trip from a subscription contract back to a job". It is
 * not an identifier that arrives at all. Shopify's subscription_contracts/* payload is the
 * contract, documented as:
 *
 *   { admin_graphql_api_id, id, billing_policy, currency_code, customer_id,
 *     admin_graphql_api_customer_id, delivery_policy, status,
 *     admin_graphql_api_origin_order_id, origin_order_id, revision_id }
 *
 * There is no email at any depth. So the route read '', the lookup returned null on its
 * empty-string guard, and every real cancellation would have recorded `subscription.unmatched`
 * and done nothing: no editing lock, no takedown clock, no operator alert. A customer could stop
 * paying and keep the site, which is the one thing the module exists to prevent.
 *
 * Nothing caught it because the only callers were two proof scripts, and both passed a literal
 * email that the webhook never supplies. So these tests drive the REAL PAYLOAD SHAPE through, and
 * one of them asserts that a body carrying only an email matches nothing — the old happy path is
 * now the failing case.
 */

let dir: string
let processPaidOrder: typeof import('../server/lib/orders').processPaidOrder
let applySubscriptionStatus: typeof import('../server/lib/subscription').applySubscriptionStatus
let getDb: typeof import('../server/db/client').getDb
let schema: typeof import('../server/db/client').schema
let eq: typeof import('drizzle-orm').eq

const BUILD_VARIANT = PRICING.build.variantId!
const CUSTOMER_ID = 778899
const BUILD_ORDER_ID = 5001
const HOSTING_ORDER_ID = 5002

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gopolar-subs-'))
  process.env.DEMO_MODE = '1'
  process.env.DATABASE_DRIVER = 'pglite'
  process.env.PGLITE_DIR = join(dir, 'db')
  process.env.STORAGE_DRIVER = 'local'
  process.env.LOCAL_STORAGE_DIR = join(dir, 'blob')
  process.env.APP_SECRET = 'subs-test-secret'
  process.env.PUBLIC_APP_URL = 'http://localhost:5173'

  const { setConfigForTests } = await import('../server/config')
  setConfigForTests(null)
  const { migrate } = await import('../server/db/migrate')
  await migrate()
  ;({ processPaidOrder } = await import('../server/lib/orders'))
  ;({ applySubscriptionStatus } = await import('../server/lib/subscription'))
  ;({ getDb, schema } = await import('../server/db/client'))
  ;({ eq } = await import('drizzle-orm'))

  // A real purchase, so orders carries the ids a contract will later refer to.
  await processPaidOrder({
    id: BUILD_ORDER_ID,
    order_number: 1001,
    email: 'tradie@example.com',
    customer: { id: CUSTOMER_ID, email: 'tradie@example.com' },
    line_items: [{ variant_id: BUILD_VARIANT, quantity: 1, price: '220.00' }],
  } as never)
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Shopify's documented subscription_contracts/cancel body, minus the parts nothing reads. */
const contract = (over: Record<string, unknown> = {}) => ({
  admin_graphql_api_id: 'gid://shopify/SubscriptionContract/9264106522',
  id: 9264106522,
  customer_id: CUSTOMER_ID,
  admin_graphql_api_customer_id: `gid://shopify/Customer/${CUSTOMER_ID}`,
  status: 'cancelled',
  origin_order_id: HOSTING_ORDER_ID,
  admin_graphql_api_origin_order_id: `gid://shopify/Order/${HOSTING_ORDER_ID}`,
  ...over,
})

describe('a subscription contract finds its job without an email', () => {
  it('matches on customer_id when the origin order was never recorded', async () => {
    const c = contract()
    const out = await applySubscriptionStatus({
      originOrderId: String(c.origin_order_id),
      customerId: String(c.customer_id),
      status: c.status,
    })
    expect(out.jobId, 'the contract should resolve to the purchased job').toBeTruthy()
    expect(out.handled).toBe(true)
    expect(out.hostingStatus).toBe('cancelled')
  })

  it('lowercase "cancelled" from Shopify counts as cancelled', async () => {
    const out = await applySubscriptionStatus({
      customerId: String(CUSTOMER_ID),
      status: 'cancelled',
    })
    expect(out.hostingStatus).toBe('cancelled')
  })

  it('matches on origin_order_id, which is exact, in preference to the customer', async () => {
    // Record the hosting order itself, so the contract's origin order is on file.
    const db = await getDb()
    const [job] = await db.select({ id: schema.jobs.id }).from(schema.jobs).limit(1)
    await db.insert(schema.orders).values({
      id: 'ord_hosting_test',
      jobId: job!.id,
      shopifyOrderId: String(HOSTING_ORDER_ID),
      shopifyCustomerId: String(CUSTOMER_ID),
      productHandle: PRICING.hosting.ref ?? 'diy-hosting-monthly',
      amountExGst: 3900,
      kind: 'hosting',
      status: 'paid',
    })

    const out = await applySubscriptionStatus({
      originOrderId: String(HOSTING_ORDER_ID),
      customerId: String(CUSTOMER_ID),
      status: 'CANCELLED',
    })
    expect(out.jobId).toBe(job!.id)
    expect(out.handled).toBe(true)
  })

  it('THE OLD PATH: a body carrying only an email now matches nothing', async () => {
    // This is what the route actually built from the payload, every time.
    const out = await applySubscriptionStatus({
      originOrderId: null,
      customerId: null,
      status: 'CANCELLED',
    })
    expect(out.jobId).toBeNull()
    expect(out.handled).toBe(false)
  })

  it('records what it could not match on, so an unmatched contract is diagnosable', async () => {
    await applySubscriptionStatus({ customerId: '999999', status: 'CANCELLED' })
    const db = await getDb()
    const rows = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.type, 'subscription.unmatched'))
    expect(rows.length).toBeGreaterThan(0)
    const data = rows[rows.length - 1]!.payload as Record<string, unknown>
    expect(Object.keys(data)).toContain('customerId')
    expect(Object.keys(data)).not.toContain('email')
  })

  it('an active contract reactivates rather than locking', async () => {
    const out = await applySubscriptionStatus({
      customerId: String(CUSTOMER_ID),
      status: 'ACTIVE',
    })
    expect(out.hostingStatus).toBe('active')
    expect(out.handled).toBe(true)
  })

  it('a billing failure with no contract status changes nothing', async () => {
    const out = await applySubscriptionStatus({
      customerId: String(CUSTOMER_ID),
      status: '',
    })
    expect(out.hostingStatus).toBe('unknown')
    expect(out.handled).toBe(false)
  })
})
