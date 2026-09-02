import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PRICING } from '../shared/pricing'

/**
 * A hosting renewal is money arriving, not a customer asking to go live.
 *
 * Every month the subscription bills, Shopify creates a NEW order carrying the hosting line and
 * fires orders/paid for it. It has an order id nobody has seen, so the already-processed guard
 * lets it through, the line matches the hosting variant, and the go-live path runs again: paidAt
 * is overwritten, the job is pushed back to go_live_pending, the customer is emailed "we have your
 * payment, here is what happens next", and Chris is alerted to go and connect a domain that was
 * connected months ago.
 *
 * Every cycle. Every hosting customer. Forever. Nothing anywhere distinguished the first payment
 * from the fiftieth.
 */

let dir: string
let processPaidOrder: typeof import('../server/lib/orders').processPaidOrder
let getDb: typeof import('../server/db/client').getDb
let schema: typeof import('../server/db/client').schema
let eq: typeof import('drizzle-orm').eq

const BUILD_VARIANT = PRICING.build.variantId!
const HOSTING_VARIANT = PRICING.hosting.variantId!
const EMAIL = 'renewal@example.com'
const CUSTOMER_ID = 5150

const order = (id: number, variantId: string | number, price: string) => ({
  id,
  order_number: id,
  email: EMAIL,
  customer: { id: CUSTOMER_ID, email: EMAIL },
  line_items: [{ variant_id: variantId, quantity: 1, price }],
})

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gopolar-renewal-'))
  process.env.DEMO_MODE = '1'
  process.env.DATABASE_DRIVER = 'pglite'
  process.env.PGLITE_DIR = join(dir, 'db')
  process.env.STORAGE_DRIVER = 'local'
  process.env.LOCAL_STORAGE_DIR = join(dir, 'blob')
  process.env.APP_SECRET = 'renewal-test-secret'
  process.env.PUBLIC_APP_URL = 'http://localhost:5173'

  const { setConfigForTests } = await import('../server/config')
  setConfigForTests(null)
  const { migrate } = await import('../server/db/migrate')
  await migrate()
  ;({ processPaidOrder } = await import('../server/lib/orders'))
  ;({ getDb, schema } = await import('../server/db/client'))
  ;({ eq } = await import('drizzle-orm'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const goliveRow = async (jobId: string) => {
  const db = await getDb()
  const [row] = await db.select().from(schema.golive).where(eq(schema.golive.jobId, jobId)).limit(1)
  return row
}
const jobRow = async (jobId: string) => {
  const db = await getDb()
  const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1)
  return row
}
const eventsOfType = async (jobId: string, type: string) => {
  const db = await getDb()
  return db
    .select()
    .from(schema.events)
    .where(eq(schema.events.jobId, jobId))
    .then((rows) => rows.filter((r) => r.type === type))
}

describe('a hosting renewal does not restart the go-live flow', () => {
  let jobId: string

  it('the first hosting payment does start it', async () => {
    await processPaidOrder(order(9001, BUILD_VARIANT, '220.00') as never)
    const first = await processPaidOrder(order(9002, HOSTING_VARIANT, '39.00') as never)
    jobId = first.jobId!
    expect(jobId).toBeTruthy()

    const golive = await goliveRow(jobId)
    expect(golive?.status).toBe('paid')
    expect(golive?.paidAt).toBeTruthy()
    expect((await jobRow(jobId))?.status).toBe('go_live_pending')
    expect((await eventsOfType(jobId, 'golive.paid')).length).toBe(1)
  })

  it('the site then goes live, the way a real one would', async () => {
    const db = await getDb()
    await db.update(schema.jobs).set({ status: 'live' }).where(eq(schema.jobs.id, jobId))
    expect((await jobRow(jobId))?.status).toBe('live')
  })

  it('NEXT MONTH: the renewal is recorded but changes nothing else', async () => {
    const before = await goliveRow(jobId)
    const renewal = await processPaidOrder(order(9003, HOSTING_VARIANT, '39.00') as never)
    expect(renewal.jobId).toBe(jobId)

    // The money is on file.
    const db = await getDb()
    const orders = await db.select().from(schema.orders).where(eq(schema.orders.jobId, jobId))
    expect(orders.filter((o) => o.kind === 'hosting').length).toBe(2)

    // And nothing else moved.
    expect((await jobRow(jobId))?.status, 'a live site must not go back to go_live_pending').toBe('live')
    expect((await goliveRow(jobId))?.paidAt?.getTime(), 'the original payment date stands').toBe(
      before?.paidAt?.getTime(),
    )
    expect(
      (await eventsOfType(jobId, 'golive.paid')).length,
      'Chris must not be alerted to connect a domain every month',
    ).toBe(1)
  })

  it('and the renewal is written down, so the money is still traceable', async () => {
    const renewals = await eventsOfType(jobId, 'hosting.renewed')
    expect(renewals.length).toBeGreaterThan(0)
  })

  it('a third month behaves the same', async () => {
    await processPaidOrder(order(9004, HOSTING_VARIANT, '39.00') as never)
    expect((await jobRow(jobId))?.status).toBe('live')
    expect((await eventsOfType(jobId, 'golive.paid')).length).toBe(1)
  })
})
