import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PRICING, blocksPayments, productConfigProblems } from '../shared/pricing'

/**
 * The page allowance, which is money.
 *
 * Two failures matter and they fail in opposite directions. Generating a page nobody paid for is
 * theft from Chris. Leaving a paid-for page unbuilt is theft from the customer, and they will not
 * notice until they go looking for a page that is not there. Both directions are tested.
 *
 * The awkward case is a single order carrying both a build token and additional pages: the job
 * does not exist until the build line is processed, and Shopify does not promise line item order.
 */

let dir: string
let processPaidOrder: typeof import('../server/lib/orders').processPaidOrder
let getDb: typeof import('../server/db/client').getDb
let schema: typeof import('../server/db/client').schema
let eq: typeof import('drizzle-orm').eq

const BUILD_VARIANT = PRICING.build.variantId!
const PAGE_VARIANT = PRICING.additionalPage.variantId!

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gopolar-pages-'))

  process.env.DEMO_MODE = '1'
  process.env.DATABASE_DRIVER = 'pglite'
  process.env.PGLITE_DIR = join(dir, 'db')
  process.env.STORAGE_DRIVER = 'local'
  process.env.LOCAL_STORAGE_DIR = join(dir, 'blob')
  process.env.APP_SECRET = 'pages-test-secret'
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
  const { closeDb } = await import('../server/db/client')
  await closeDb()
  await rm(dir, { recursive: true, force: true })
})

let orderCounter = 5000

function order(args: {
  email: string
  lines: Array<{ variantId: string; quantity?: number; price?: string }>
  id?: string
}) {
  return {
    id: args.id ?? String(orderCounter++),
    email: args.email,
    customer: { email: args.email, first_name: 'Test' },
    line_items: args.lines.map((l) => ({
      variant_id: Number(l.variantId),
      quantity: l.quantity ?? 1,
      price: l.price ?? '25.00',
      title: 'line',
    })),
    financial_status: 'paid',
  }
}

async function allowanceFor(email: string): Promise<number | null> {
  const db = await getDb()
  const users = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1)
  if (!users[0]) return null
  const jobs = await db.select().from(schema.jobs).where(eq(schema.jobs.userId, users[0].id)).limit(1)
  return jobs[0]?.pagesAllowed ?? null
}

describe('the build token grants exactly one page', () => {
  it('a plain build gives one page and no more', async () => {
    const email = 'one@example.com'
    await processPaidOrder(order({ email, lines: [{ variantId: BUILD_VARIANT, price: '220.00' }] }))
    expect(await allowanceFor(email)).toBe(1)
  })
})

describe('additional pages bought at the original checkout', () => {
  it('tops up the job the same order created', async () => {
    const email = 'together@example.com'
    await processPaidOrder(
      order({
        email,
        lines: [
          { variantId: BUILD_VARIANT, price: '220.00' },
          { variantId: PAGE_VARIANT, quantity: 3 },
        ],
      }),
    )
    // One from the build token, three bought.
    expect(await allowanceFor(email)).toBe(4)
  })

  it('works when the page line comes FIRST in the order', async () => {
    // Shopify does not promise line item order, and the job does not exist until the build line is
    // processed. A page line arriving first used to find no job and be dropped silently.
    const email = 'reversed@example.com'
    const result = await processPaidOrder(
      order({
        email,
        lines: [
          { variantId: PAGE_VARIANT, quantity: 2 },
          { variantId: BUILD_VARIANT, price: '220.00' },
        ],
      }),
    )

    expect(await allowanceFor(email)).toBe(3)
    expect(result.skipped.filter((s) => s.reason === 'no_matching_job')).toEqual([])
  })
})

describe('quantity is honoured', () => {
  it('four bought in one go grants four, not one', async () => {
    const email = 'four@example.com'
    await processPaidOrder(order({ email, lines: [{ variantId: BUILD_VARIANT, price: '220.00' }] }))
    await processPaidOrder(order({ email, lines: [{ variantId: PAGE_VARIANT, quantity: 4 }] }))
    expect(await allowanceFor(email)).toBe(5)
  })

  it('a missing or nonsense quantity still grants one rather than none', async () => {
    const email = 'noqty@example.com'
    await processPaidOrder(order({ email, lines: [{ variantId: BUILD_VARIANT, price: '220.00' }] }))
    const raw = order({ email, lines: [{ variantId: PAGE_VARIANT }] })
    // @ts-expect-error deliberately malformed, which is what a real payload sometimes is
    raw.line_items[0].quantity = undefined
    await processPaidOrder(raw)
    expect(await allowanceFor(email)).toBe(2)
  })
})

describe('a later purchase tops up rather than replacing', () => {
  it('adds to the existing job instead of creating a second one', async () => {
    const email = 'later@example.com'
    await processPaidOrder(order({ email, lines: [{ variantId: BUILD_VARIANT, price: '220.00' }] }))
    expect(await allowanceFor(email)).toBe(1)

    // Months later, through a generated checkout link.
    await processPaidOrder(order({ email, lines: [{ variantId: PAGE_VARIANT, quantity: 2 }] }))
    expect(await allowanceFor(email)).toBe(3)

    await processPaidOrder(order({ email, lines: [{ variantId: PAGE_VARIANT, quantity: 1 }] }))
    expect(await allowanceFor(email)).toBe(4)

    // And still exactly one job for that customer.
    const db = await getDb()
    const users = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1)
    const jobs = await db.select().from(schema.jobs).where(eq(schema.jobs.userId, users[0]!.id))
    expect(jobs).toHaveLength(1)
  })
})

describe('the same order processed twice never double-grants', () => {
  it('is idempotent, because Shopify retries and the sweep re-examines', async () => {
    const email = 'retry@example.com'
    await processPaidOrder(order({ email, lines: [{ variantId: BUILD_VARIANT, price: '220.00' }] }))

    const topUp = order({ email, lines: [{ variantId: PAGE_VARIANT, quantity: 3 }], id: 'ord-retry' })
    await processPaidOrder(topUp)
    expect(await allowanceFor(email)).toBe(4)

    // The webhook fires again, or the hourly sweep finds the same order.
    const again = await processPaidOrder(topUp)
    expect(await allowanceFor(email)).toBe(4)
    expect(again.skipped.some((s) => s.reason === 'already_processed')).toBe(true)
  })
})

describe('a page nobody paid for is never granted', () => {
  it('an order with no page line leaves the allowance at one', async () => {
    const email = 'nopages@example.com'
    await processPaidOrder(order({ email, lines: [{ variantId: BUILD_VARIANT, price: '220.00' }] }))
    await processPaidOrder(order({ email, lines: [{ variantId: PRICING.hosting.variantId ?? '999', price: '33.00' }] }))
    expect(await allowanceFor(email)).toBe(1)
  })
})

/**
 * Going live with a known gap.
 *
 * `extra-edits` has never been priced, and the app is built to degrade honestly when it is
 * reached: no figure, no button, a conversation offered instead. The boot guard must not turn that
 * deliberate gap into a launch blocker, and must still refuse over a gap that would put a customer
 * at a checkout that does not work.
 */
describe('what stops the app taking payments', () => {
  it('an unpriced product does not block, because it is never offered', () => {
    const problems = productConfigProblems({})
    const unpriced = problems.filter((p) => PRICING[p.key].incGstCents === null)
    expect(unpriced.length).toBeGreaterThan(0)
    for (const problem of unpriced) {
      expect(blocksPayments(problem), `${problem.key} should not block a launch`).toBe(false)
    }
  })

  it('a gap on a product that IS priced does block', () => {
    const priced = (Object.keys(PRICING) as Array<keyof typeof PRICING>).find(
      (key) => PRICING[key].incGstCents !== null,
    )!
    expect(
      blocksPayments({
        key: priced,
        label: PRICING[priced].label,
        missing: 'a variant id',
        detail: '',
        breaks: '',
      }),
    ).toBe(true)
  })

  it('the only things left to paste in are the six subscription ids', () => {
    // These six are the whole gap between this repo and taking money. Everything else about the
    // store is recorded in shared/pricing.ts and needs nothing at deploy time. If this list ever
    // grows, the runbook is out of date and somebody is going to hit it at 9pm on a launch night.
    const blocking = productConfigProblems({}).filter(blocksPayments)
    expect(blocking.map((p) => p.missing).sort()).toEqual(
      [
        'SHOPIFY_SELLING_PLAN_DOMAIN_1_YEAR',
        'SHOPIFY_SELLING_PLAN_EMAIL_HOSTING',
        'SHOPIFY_SELLING_PLAN_WEBSITE_HOSTING_AUSTRALIA',
        'SHOPIFY_VARIANT_DOMAIN_1_YEAR',
        'SHOPIFY_VARIANT_EMAIL_HOSTING',
        'SHOPIFY_VARIANT_WEBSITE_HOSTING_AUSTRALIA',
      ].sort(),
    )
  })

  it('with those six set, nothing blocks a launch', () => {
    const env = {
      SHOPIFY_VARIANT_WEBSITE_HOSTING_AUSTRALIA: '1',
      SHOPIFY_SELLING_PLAN_WEBSITE_HOSTING_AUSTRALIA: '2',
      SHOPIFY_VARIANT_DOMAIN_1_YEAR: '3',
      SHOPIFY_SELLING_PLAN_DOMAIN_1_YEAR: '4',
      SHOPIFY_VARIANT_EMAIL_HOSTING: '5',
      SHOPIFY_SELLING_PLAN_EMAIL_HOSTING: '6',
    }
    const blocking = productConfigProblems(env).filter(blocksPayments)
    expect(blocking.map((p) => `${p.key}: ${p.missing}`)).toEqual([])

    // And the unpriced add-on is still reported, just not as a blocker.
    expect(productConfigProblems(env).length).toBeGreaterThan(0)
  })
})
