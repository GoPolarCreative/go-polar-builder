import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerationEvent } from '../shared/types'

/**
 * What happens when the model call itself fails.
 *
 * The install here is fully configured: a key is present, so the edit panel offers to edit. The
 * model endpoint then returns an error, which is the ordinary bad day: an expired key, a rate
 * limit, an outage.
 *
 * Two things must hold, and the second one is the one that costs a customer money:
 *   1. the real reason reaches the customer, not a spinner that stops
 *   2. the failed change does not consume one of their ten included edits
 *
 * The model endpoint is pointed at a local stub, so this is deterministic and never touches the
 * network.
 */

let dir: string
let stub: Server
let stubCalls = 0
let api: typeof import('../server/index').api
let jobId: string
let session: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gopolar-editfail-'))

  // A stub that fails the way a real outage or a dead key does.
  stub = createServer((_req, res) => {
    stubCalls++
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: 'API key is invalid.' },
      }),
    )
  })
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  const port = (stub.address() as { port: number }).port

  process.env.DEMO_MODE = '1'
  process.env.DATABASE_DRIVER = 'pglite'
  process.env.PGLITE_DIR = join(dir, 'db')
  process.env.STORAGE_DRIVER = 'local'
  process.env.LOCAL_STORAGE_DIR = join(dir, 'blob')
  process.env.APP_SECRET = 'edit-failure-test-secret'
  process.env.PUBLIC_APP_URL = 'http://localhost:5173'
  // A key IS present, so edits are offered. The endpoint behind it is the failing stub.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-that-the-stub-rejects'
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}/v1/messages`
  delete process.env.DEV_OFFLINE_GENERATION
  delete process.env.SHOPIFY_WEBHOOK_SECRET

  const { makeFixture } = await import('./fixtures/site')
  const { setConfigForTests } = await import('../server/config')
  setConfigForTests(null)

  const { migrate } = await import('../server/db/migrate')
  await migrate()
  api = (await import('../server/index')).api

  const created = await api.request('/api/dev/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'editfail@example.com' }),
  })
  const body = (await created.json()) as { jobId: string; session: string }
  jobId = body.jobId
  session = body.session

  const { getDb, schema } = await import('../server/db/client')
  const { storage } = await import('../server/lib/storage')
  const { eq } = await import('drizzle-orm')

  const fixture = makeFixture()
  const db = await getDb()
  const blobKey = `jobs/${jobId}/builds/v1/index.html`
  await storage().put(blobKey, fixture.html, 'text/html; charset=utf-8')

  await db.insert(schema.plans).values({ id: 'pln_f', jobId, version: 1, plan: fixture.plan })
  await db.insert(schema.builds).values({
    id: 'bld_f',
    jobId,
    version: 1,
    blobKey,
    bytes: fixture.html.length,
    passed: true,
  })
  await db.insert(schema.intake).values({ jobId, payload: fixture.intake, submittedAt: new Date() })
  await db.update(schema.jobs).set({ currentVersion: 1 }).where(eq(schema.jobs.id, jobId))
})

afterAll(async () => {
  const { closeDb } = await import('../server/db/client')
  await closeDb()
  await new Promise<void>((resolve) => stub.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

function authed(path: string, init: RequestInit = {}) {
  return api.request(path, {
    ...init,
    headers: { ...((init.headers as Record<string, string>) ?? {}), authorization: `Bearer ${session}` },
  })
}

async function versions() {
  const res = await authed(`/api/jobs/${jobId}/versions`)
  return (await res.json()) as {
    currentVersion: number
    editsUsed: number
    editsRemaining: number
    builds: unknown[]
    capability: { available: boolean; reason: string | null }
  }
}

/** Read the whole event stream an edit produces. */
async function submitEdit(request: string): Promise<GenerationEvent[]> {
  const res = await authed(`/api/jobs/${jobId}/edits`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request }),
  })
  const text = await res.text()
  return text
    .split('\n\n')
    .map((frame) => frame.split('\n').find((l) => l.startsWith('data:')))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice(5).trim()) as GenerationEvent)
}

describe('when the model call fails', () => {
  it('offers to edit in the first place, because a key is configured', async () => {
    expect((await versions()).capability.available).toBe(true)
  })

  /*
   * This used to assert the upstream error text appeared in what the customer is shown. The intent
   * was right - never fail silently - but the implementation put "401 authentication_error" and, on
   * the build screen, "go to Plans & Billing to purchase credits" in front of a tradie who had
   * already paid. Our billing problem, phrased as an instruction only we can act on.
   *
   * The intent is kept and moved: the real reason must still be captured, in the event log, where
   * a diagnosis belongs. What the customer sees must say only what is true and useful to them.
   */
  it('never shows the customer the upstream error text', async () => {
    const events = await submitEdit('Make the header darker')

    const error = events.find((e) => e.type === 'error')
    expect(error, 'the stream ended without an error event').toBeDefined()

    const detail = (error as { detail?: string }).detail ?? ''
    expect(detail).not.toMatch(/401|authentication_error|API key|credit balance|Plans & Billing/i)

    // What they do get: it was not their fault, and it cost them nothing.
    expect(detail).toMatch(/our end/i)
    expect(detail).toMatch(/has not used up one of your ten changes/i)
    expect((error as { message: string }).message).toMatch(/has not been touched/i)
  })

  it('still records the real reason in the event log, so it is never lost', async () => {
    await submitEdit('Make the footer darker')

    const { getDb, schema } = await import('../server/db/client')
    const { desc, eq, and } = await import('drizzle-orm')
    const db = await getDb()
    const rows = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.jobId, jobId), eq(schema.events.type, 'edit.failed')))
      .orderBy(desc(schema.events.createdAt))
      .limit(1)

    expect(rows.length, 'no edit.failed event was recorded').toBe(1)
    const payload = JSON.stringify(rows[0]?.payload ?? {})
    expect(payload).toMatch(/401|authentication_error|API key/i)
  })

  it('really did call the model, so this is a genuine failure and not a short circuit', () => {
    expect(stubCalls).toBeGreaterThan(0)
  })

  it('DOES NOT COST AN EDIT', async () => {
    const before = await versions()
    await submitEdit('Change the phone number to 0400 111 222')
    await submitEdit('Swap the second and third services around')
    const after = await versions()

    expect(after.editsUsed).toBe(before.editsUsed)
    expect(after.editsRemaining).toBe(before.editsRemaining)
  })

  it('leaves the customer on the version they already had', async () => {
    const before = await versions()
    await submitEdit('Make the buttons rounder')
    const after = await versions()

    expect(after.currentVersion).toBe(before.currentVersion)
    expect(after.builds.length).toBe(before.builds.length)
  })

  it('never emits a done event claiming success', async () => {
    const events = await submitEdit('Try again please')
    expect(events.some((e) => e.type === 'done')).toBe(false)
  })
})
