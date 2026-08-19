import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The operator diagnostic.
 *
 * "I bought the thing and no email arrived" is one symptom of four completely different failures:
 * the webhook never fired, it fired and the signature did not match, it verified but matched no
 * product, or the job was created and the send failed. Each has a different fix, and the symptom
 * does not distinguish them.
 *
 * These tests write the events each of those failures actually produces and check the trace names
 * the right step. If the trace can be fooled here, it is useless at 9pm on a Sunday.
 */

const ADMIN_TOKEN = 'trace-test-admin-token'
let dir: string
let api: typeof import('../server/index').api

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gopolar-trace-'))

  process.env.DEMO_MODE = '1'
  process.env.DATABASE_DRIVER = 'pglite'
  process.env.PGLITE_DIR = join(dir, 'db')
  process.env.STORAGE_DRIVER = 'local'
  process.env.LOCAL_STORAGE_DIR = join(dir, 'blob')
  process.env.APP_SECRET = 'trace-test-secret'
  process.env.ADMIN_TOKEN = ADMIN_TOKEN
  process.env.PUBLIC_APP_URL = 'http://localhost:5173'

  const { setConfigForTests } = await import('../server/config')
  setConfigForTests(null)

  const { migrate } = await import('../server/db/migrate')
  await migrate()
  api = (await import('../server/index')).api
})

afterAll(async () => {
  const { closeDb } = await import('../server/db/client')
  await closeDb()
  await rm(dir, { recursive: true, force: true })
  delete process.env.ADMIN_TOKEN
})

async function clearEvents() {
  const { getDb, schema } = await import('../server/db/client')
  const db = await getDb()
  await db.delete(schema.events)
}

async function event(type: string, payload?: unknown, jobId: string | null = null) {
  const { recordEvent } = await import('../server/lib/db')
  await recordEvent(jobId, type, payload)
}

interface TraceBody {
  verdict: string
  jobId: string | null
  steps: Array<{ step: number; name: string; status: string; detail: string; fix?: string }>
}

async function trace(email?: string): Promise<TraceBody> {
  const res = await api.request(
    `/api/admin/trace${email ? `?email=${encodeURIComponent(email)}` : ''}`,
    { headers: { 'x-admin-token': ADMIN_TOKEN } },
  )
  return (await res.json()) as TraceBody
}

describe('the trace is guarded', () => {
  it('refuses without the admin token', async () => {
    const res = await api.request('/api/admin/trace')
    expect(res.status).toBe(403)
  })

  it('refuses a wrong token', async () => {
    const res = await api.request('/api/admin/trace', { headers: { 'x-admin-token': 'nope' } })
    expect(res.status).toBe(403)
  })
})

describe('it tells you which of the four steps broke', () => {
  it('no webhook at all: step 1, and points at the Shopify webhook page', async () => {
    await clearEvents()
    const body = await trace('nobody@example.com')

    expect(body.verdict).toMatch(/step 1/i)
    expect(body.steps[0]!.status).toBe('waiting')
    expect(body.steps[0]!.fix).toMatch(/Settings, Notifications, Webhooks/i)
    // Nothing downstream claims to have failed, because nothing downstream ran.
    expect(body.steps[3]!.status).toBe('waiting')
  })

  it('bad signature: step 2, and points at the secret rather than anything else', async () => {
    await clearEvents()
    await event('webhook.rejected', { reason: 'bad_hmac' })

    const body = await trace('nobody@example.com')
    expect(body.verdict).toMatch(/step 2/i)
    expect(body.steps[0]!.status).toBe('ok')
    expect(body.steps[1]!.status).toBe('failed')
    expect(body.steps[1]!.fix).toMatch(/SHOPIFY_WEBHOOK_SECRET/)
  })

  it('demo mode: step 2, and says so specifically rather than blaming the secret', async () => {
    await clearEvents()
    await event('webhook.refused', { reason: 'demo_mode' })

    const body = await trace()
    expect(body.steps[1]!.status).toBe('failed')
    expect(body.steps[1]!.fix).toMatch(/DEMO_MODE=0/)
  })

  it('no secret configured: step 2, naming the variable to set', async () => {
    await clearEvents()
    await event('webhook.refused', { reason: 'no_secret_configured' })

    const body = await trace()
    expect(body.steps[1]!.fix).toMatch(/SHOPIFY_WEBHOOK_SECRET is not set/)
  })

  it('verified but no job: step 3, and prints what actually arrived', async () => {
    await clearEvents()
    await event('webhook.received', { topic: 'orders/paid', orderId: '123' })
    await event('order.unmatched_line', { orderId: '123', title: 'Some Other Product' })

    const body = await trace('never-bought@example.com')
    expect(body.verdict).toMatch(/step 3/i)
    expect(body.steps[1]!.status).toBe('ok')
    expect(body.steps[2]!.status).toBe('failed')
    // The actual line item, so the SKU can be compared against the store.
    expect(body.steps[2]!.detail).toMatch(/Some Other Product/)
    expect(body.steps[2]!.fix).toMatch(/SKU/)
  })

  it('cannot check step 3 without an email, and says so instead of guessing', async () => {
    await clearEvents()
    await event('webhook.received', { topic: 'orders/paid' })

    const body = await trace()
    expect(body.steps[2]!.status).toBe('waiting')
    expect(body.steps[2]!.detail).toMatch(/Pass \?email=/)
  })
})

describe('once a job exists', () => {
  let jobId: string
  const email = 'smoke@example.com'

  beforeAll(async () => {
    const created = await api.request('/api/dev/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    jobId = ((await created.json()) as { jobId: string }).jobId
  })

  it('finds it by the email used at the checkout', async () => {
    await clearEvents()
    await event('webhook.received', { topic: 'orders/paid' })

    const body = await trace(email)
    expect(body.jobId).toBe(jobId)
    expect(body.steps[2]!.status).toBe('ok')
  })

  it('a failed send: step 4, with the real reason and the matching fix', async () => {
    await clearEvents()
    await event('webhook.received', { topic: 'orders/paid' })
    await event('email.failed', { kind: 'build_link', error: 'RESEND_API_KEY is not set' }, jobId)

    const body = await trace(email)
    expect(body.verdict).toMatch(/step 4/i)
    expect(body.steps[3]!.status).toBe('failed')
    expect(body.steps[3]!.detail).toMatch(/RESEND_API_KEY is not set/)
    expect(body.steps[3]!.fix).toMatch(/RESEND_API_KEY is not set in Vercel/)
  })

  it('a send blocked by the live flag says that, not "check your domain"', async () => {
    await clearEvents()
    await event('webhook.received', { topic: 'orders/paid' })
    await event('email.failed', { error: 'Refusing to perform a live email action: ENABLE_LIVE_EMAIL' }, jobId)

    const body = await trace(email)
    expect(body.steps[3]!.fix).toMatch(/ENABLE_LIVE_EMAIL/)
  })

  it('an unexplained send failure points at the usual cause without asserting it', async () => {
    await clearEvents()
    await event('webhook.received', { topic: 'orders/paid' })
    await event('email.failed', { error: 'Resend returned 403' }, jobId)

    const body = await trace(email)
    expect(body.steps[3]!.fix).toMatch(/sending domain/i)
    expect(body.steps[3]!.fix).toMatch(/sweep retries/i)
  })

  it('everything worked: no step reports failed, and the verdict says so', async () => {
    await clearEvents()
    await event('webhook.received', { topic: 'orders/paid' })
    await event('email.sent', { kind: 'build_link', to: email }, jobId)

    const body = await trace(email)
    expect(body.steps.every((s) => s.status === 'ok')).toBe(true)
    expect(body.verdict).toMatch(/whole path worked/i)
    // And it does not claim the email was delivered, only that Resend took it.
    expect(body.steps[3]!.detail).toMatch(/accepted/i)
  })
})

describe('the raw event log', () => {
  it('filters by type', async () => {
    await clearEvents()
    await event('email.failed', { error: 'one' })
    await event('webhook.received', {})

    const res = await api.request('/api/admin/events?type=email.failed', {
      headers: { 'x-admin-token': ADMIN_TOKEN },
    })
    const body = (await res.json()) as { count: number; events: Array<{ type: string }> }
    expect(body.count).toBe(1)
    expect(body.events[0]!.type).toBe('email.failed')
  })

  it('is guarded too', async () => {
    const res = await api.request('/api/admin/events')
    expect(res.status).toBe(403)
  })
})
