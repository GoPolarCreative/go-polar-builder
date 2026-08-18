import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The edit loop against a real database and the real HTTP routes.
 *
 * This exists because of a specific bug. With no Anthropic key, an edit used to be accepted, a
 * new version written that was byte-for-byte the same site, success reported, and one of the
 * customer's ten included changes spent. Silent, and it cost them something they had paid for.
 *
 * The invariant these tests hold down is simple and worth stating plainly:
 *
 *     A CHANGE THAT WAS NOT MADE MUST NEVER COST AN EDIT.
 *
 * They run against PGlite, which is real Postgres, so the counter arithmetic being asserted is
 * the arithmetic that runs in production.
 */

let dir: string
let api: typeof import('../server/index').api
let jobId: string
let session: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gopolar-edits-'))

  // A completely isolated install: own database, own storage, demo mode, and deliberately no
  // Anthropic key, which is the state being tested.
  process.env.DEMO_MODE = '1'
  process.env.DATABASE_DRIVER = 'pglite'
  process.env.PGLITE_DIR = join(dir, 'db')
  process.env.STORAGE_DRIVER = 'local'
  process.env.LOCAL_STORAGE_DIR = join(dir, 'blob')
  process.env.APP_SECRET = 'integration-test-secret'
  process.env.PUBLIC_APP_URL = 'http://localhost:5173'
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.SHOPIFY_WEBHOOK_SECRET

  // The shared fixture module pins a config for the unit tests when it is imported, which would
  // override the environment set above and leave sessions signed with a different secret than
  // the one that verifies them. Import it first, then hand config back to the environment.
  const { makeFixture } = await import('./fixtures/site')
  const { setConfigForTests } = await import('../server/config')
  setConfigForTests(null)

  const { migrate } = await import('../server/db/migrate')
  await migrate()

  api = (await import('../server/index')).api

  const created = await api.request('/api/dev/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'edits@example.com' }),
  })
  const body = (await created.json()) as { jobId: string; session: string }
  jobId = body.jobId
  session = body.session

  // Give the job something to edit: a stored build and its plan, exactly as generation leaves
  // them.
  const { getDb, schema } = await import('../server/db/client')
  const { storage } = await import('../server/lib/storage')
  const { eq } = await import('drizzle-orm')

  const fixture = makeFixture()
  const db = await getDb()
  const blobKey = `jobs/${jobId}/builds/v1/index.html`
  await storage().put(blobKey, fixture.html, 'text/html; charset=utf-8')

  await db.insert(schema.plans).values({ id: 'pln_test', jobId, version: 1, plan: fixture.plan })
  await db.insert(schema.builds).values({
    id: 'bld_test',
    jobId,
    version: 1,
    blobKey,
    bytes: fixture.html.length,
    pageWeightBytes: 900_000,
    passed: true,
  })
  await db.insert(schema.intake).values({ jobId, payload: fixture.intake, submittedAt: new Date() })
  await db.update(schema.jobs).set({ currentVersion: 1 }).where(eq(schema.jobs.id, jobId))
})

afterAll(async () => {
  const { closeDb } = await import('../server/db/client')
  await closeDb()
  await rm(dir, { recursive: true, force: true })
})

async function authed(path: string, init: RequestInit = {}): Promise<Response> {
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
    editsAllowed: number
    editsRemaining: number
    builds: unknown[]
    edits: unknown[]
    capability: { available: boolean; reason: string | null }
  }
}

describe('an edit that cannot be applied', () => {
  it('says so up front, when the panel loads, before anything is typed', async () => {
    const state = await versions()
    expect(state.capability.available).toBe(false)
    expect(state.capability.reason).toMatch(/ANTHROPIC_API_KEY/)
    // Plain language, not a stack trace or an error code.
    expect(state.capability.reason).toMatch(/changes need the ai model/i)
  })

  it('is refused with a real reason, not a silent success', async () => {
    const res = await authed(`/api/jobs/${jobId}/edits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request: 'Make the header darker' }),
    })

    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string; detail: string; editCharged: boolean }
    expect(body.error).toBe('edits_unavailable')
    expect(body.detail).toMatch(/ANTHROPIC_API_KEY/)
    expect(body.editCharged).toBe(false)
  })

  it('DOES NOT COST AN EDIT', async () => {
    const before = await versions()

    for (const text of ['Make the header darker', 'Change the phone number', 'Swap the services around']) {
      await authed(`/api/jobs/${jobId}/edits`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request: text }),
      })
    }

    const after = await versions()
    expect(after.editsUsed).toBe(before.editsUsed)
    expect(after.editsRemaining).toBe(before.editsRemaining)
    expect(after.editsRemaining).toBe(10)
  })

  it('writes no version, so the customer is not shown an identical site as if it were new', async () => {
    const before = await versions()

    await authed(`/api/jobs/${jobId}/edits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request: 'Make the buttons rounder' }),
    })

    const after = await versions()
    expect(after.currentVersion).toBe(before.currentVersion)
    expect(after.builds.length).toBe(before.builds.length)
    expect(after.edits.length).toBe(before.edits.length)
  })

  it('records the refusal in the event trail, marked as costing nothing', async () => {
    const { getDb, schema } = await import('../server/db/client')
    const { and, eq } = await import('drizzle-orm')
    const db = await getDb()

    const rows = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.jobId, jobId), eq(schema.events.type, 'edit.refused')))

    expect(rows.length).toBeGreaterThan(0)
    expect((rows[0]!.payload as { editCharged: boolean }).editCharged).toBe(false)
  })
})

describe('the rest of the product still works without a key', () => {
  it('the current version is still readable', async () => {
    const res = await authed(`/api/jobs/${jobId}/builds/1/html`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Website by Go Polar Creative')
  })

  it('rolling back still works and still costs nothing', async () => {
    const before = await versions()
    const res = await authed(`/api/jobs/${jobId}/rollback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1 }),
    })
    expect(res.status).toBe(200)

    const after = await versions()
    expect(after.currentVersion).toBe(1)
    expect(after.editsUsed).toBe(before.editsUsed)
  })

  it('going live is still offered', async () => {
    const res = await authed(`/api/jobs/${jobId}/golive`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { pricing: { hosting: { price: string } } }
    expect(body.pricing.hosting.price).toBe('$30/month + GST')
  })
})

describe('an edit is refused for the right reasons only', () => {
  it('an empty request is rejected before anything else', async () => {
    const res = await authed(`/api/jobs/${jobId}/edits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request: '' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()) as { detail: string }).toHaveProperty('detail')
  })

  it('another customer cannot edit this job', async () => {
    const res = await api.request(`/api/jobs/${jobId}/edits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request: 'Make the header darker' }),
    })
    expect(res.status).toBe(401)
  })
})
