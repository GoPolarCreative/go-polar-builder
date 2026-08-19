import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The customer's own enquiry inbox.
 *
 * The failure this guards against is specific and quiet: a key that is shaped like a key but is
 * not the customer's, or not real. The site looks finished, the forms submit, the little success
 * message appears, and every enquiry goes nowhere. A tradie paying for lead generation would have
 * no way of knowing until they wondered why the phone stopped ringing.
 *
 * So the rules under test are: name the mistake, never trust the shape, never save an untested
 * key, never let a Go Polar key onto a live site, and do not take payment for going live until
 * all of that is settled.
 *
 * DEMO_MODE is off here on purpose, so the real fetch path runs. It is pointed at a local stub
 * that behaves the way Web3Forms does, so the test is deterministic and never touches the network.
 */

const GO_POLAR_KEY = '11111111-2222-3333-4444-555555555555'
const WORKING_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const WRONG_BUT_VALID_KEY = 'ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb'

let dir: string
let stub: Server
let submissions: Array<{ access_key?: string; subject?: string; message?: string }> = []
let api: typeof import('../server/index').api
let jobId: string
let session: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gopolar-w3f-'))

  // Web3Forms, as far as this test is concerned: it accepts one key and refuses the other with a
  // reason, which is exactly the signal the verification depends on.
  stub = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { access_key?: string }
      submissions.push(parsed)
      res.writeHead(200, { 'content-type': 'application/json' })
      if (parsed.access_key === WORKING_KEY) {
        res.end(JSON.stringify({ success: true, message: 'Email sent successfully' }))
      } else {
        res.end(JSON.stringify({ success: false, message: 'Access key is invalid or not verified' }))
      }
    })
  })
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  const port = (stub.address() as { port: number }).port

  // Not demo mode: the real verification path has to run, including the live-action gate.
  process.env.DEMO_MODE = '0'
  process.env.ENABLE_LIVE_EMAIL = '1'
  process.env.DATABASE_DRIVER = 'pglite'
  process.env.PGLITE_DIR = join(dir, 'db')
  process.env.STORAGE_DRIVER = 'local'
  process.env.LOCAL_STORAGE_DIR = join(dir, 'blob')
  process.env.APP_SECRET = 'web3forms-test-secret'
  process.env.PUBLIC_APP_URL = 'http://localhost:5173'
  process.env.WEB3FORMS_ACCESS_KEY = GO_POLAR_KEY
  process.env.WEB3FORMS_API_URL = `http://127.0.0.1:${port}/submit`
  process.env.DEV_ALLOW_UNSIGNED = '1'
  delete process.env.ANTHROPIC_API_KEY
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
    body: JSON.stringify({ email: 'inbox@example.com' }),
  })
  const body = (await created.json()) as { jobId: string; session: string }
  jobId = body.jobId
  session = body.session

  const { getDb, schema } = await import('../server/db/client')
  const { storage } = await import('../server/lib/storage')
  const { eq } = await import('drizzle-orm')

  // A built site carrying Go Polar's key in both forms, which is the state every job is in when
  // it reaches go-live.
  const fixture = makeFixture()
  const db = await getDb()
  const blobKey = `jobs/${jobId}/builds/v1/index.html`
  await storage().put(blobKey, fixture.html, 'text/html; charset=utf-8')

  await db.insert(schema.plans).values({ id: 'pln_w', jobId, version: 1, plan: fixture.plan })
  await db.insert(schema.builds).values({
    id: 'bld_w',
    jobId,
    version: 1,
    blobKey,
    bytes: fixture.html.length,
    passed: true,
  })
  await db.insert(schema.intake).values({ jobId, payload: fixture.intake, submittedAt: new Date() })
  await db
    .update(schema.jobs)
    .set({ currentVersion: 1, businessName: 'Cold Front Plumbing' })
    .where(eq(schema.jobs.id, jobId))
})

afterAll(async () => {
  const { closeDb } = await import('../server/db/client')
  await closeDb()
  await new Promise<void>((resolve) => stub.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
  delete process.env.ENABLE_LIVE_EMAIL
  delete process.env.WEB3FORMS_API_URL
  delete process.env.DEV_ALLOW_UNSIGNED
})

function authed(path: string, init: RequestInit = {}) {
  return api.request(path, {
    ...init,
    headers: { ...((init.headers as Record<string, string>) ?? {}), authorization: `Bearer ${session}` },
  })
}

async function submitKey(key: string) {
  const res = await authed(`/api/jobs/${jobId}/golive/forms-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function goLiveState() {
  const res = await authed(`/api/jobs/${jobId}/golive`)
  return (await res.json()) as {
    currentVersion: number
    formsKey: { verified: boolean; blocksGoLive: boolean; keyMasked: string | null }
  }
}

async function currentHtml(): Promise<string> {
  const { currentVersion } = await goLiveState()
  const res = await authed(`/api/jobs/${jobId}/builds/${currentVersion}/html`)
  return res.text()
}

// -----------------------------------------------------------------------------------------------

describe('naming what they actually pasted', () => {
  it('catches an email address and says so', async () => {
    const { status, body } = await submitKey('jobs@coldfrontplumbing.com.au')
    expect(status).toBe(422)
    expect(body.reason).toBe('email')
    expect(String(body.detail)).toMatch(/looks like an email address/i)
    expect(body.saved).toBe(false)
  })

  it('catches a phone number and says so', async () => {
    const { status, body } = await submitKey('0412 345 678')
    expect(status).toBe(422)
    expect(body.reason).toBe('phone')
    expect(String(body.detail)).toMatch(/looks like a phone number/i)
  })

  it('catches the web address instead of the key', async () => {
    const { body } = await submitKey('https://web3forms.com/')
    expect(body.reason).toBe('url')
  })

  it('catches the example text being pasted back', async () => {
    const { body } = await submitKey('YOUR-ACCESS-KEY-HERE')
    expect(body.reason).toBe('placeholder')
  })

  it('rejects anything else without pretending to know what it was', async () => {
    const { body } = await submitKey('12345')
    expect(body.reason).toBe('not_uuid')
    expect(String(body.detail)).toMatch(/five parts separated by dashes/i)
  })

  it('never sent any of those to Web3Forms, because none of them could be a key', () => {
    expect(submissions).toHaveLength(0)
  })

  it('and none of it changed the job', async () => {
    const state = await goLiveState()
    expect(state.formsKey.verified).toBe(false)
    expect(state.currentVersion).toBe(1)
  })
})

describe('a key that looks right but is not', () => {
  it('is tested for real, then refused with what Web3Forms said', async () => {
    const before = await goLiveState()
    const { status, body } = await submitKey(WRONG_BUT_VALID_KEY)

    expect(status).toBe(422)
    expect(body.error).toBe('key_rejected')
    expect(body.tested).toBe(true)
    // The customer is told what happened, in Web3Forms' own words.
    expect(String(body.detail)).toMatch(/Access key is invalid or not verified/)

    // It really was tested. This is the whole point: shape alone proves nothing.
    expect(submissions.at(-1)?.access_key).toBe(WRONG_BUT_VALID_KEY)

    const after = await goLiveState()
    expect(after.formsKey.verified).toBe(false)
    expect(after.formsKey.keyMasked).toBeNull()
    // No new version, because nothing about their site changed.
    expect(after.currentVersion).toBe(before.currentVersion)
  })

  it('IS NOT SAVED, so nothing downstream can assume it was checked', async () => {
    const { getVerifiedFormsKey } = await import('../server/lib/db')
    expect(await getVerifiedFormsKey(jobId)).toBeNull()
  })

  it('leaves the built site posting to Go Polar, unchanged', async () => {
    const html = await currentHtml()
    expect(html).toContain(GO_POLAR_KEY)
    expect(html).not.toContain(WRONG_BUT_VALID_KEY)
  })
})

describe('going live is blocked until the inbox is sorted', () => {
  it('refuses to build a checkout, and says why in plain language', async () => {
    const res = await authed(`/api/jobs/${jobId}/golive/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emailAddon: false, domainAddon: false }),
    })
    const body = (await res.json()) as Record<string, unknown>

    expect(res.status).toBe(409)
    expect(body.error).toBe('forms_key_required')
    expect(String(body.detail)).toMatch(/enquiries come to you/i)
    // Nobody has been charged, and it says so.
    expect(String(body.detail)).toMatch(/Nothing has been charged/i)
  })

  it('says the same thing on the go-live screen before they touch anything', async () => {
    const state = await goLiveState()
    expect(state.formsKey.blocksGoLive).toBe(true)
  })

  it('refuses to publish a document that still carries the Go Polar key', async () => {
    const { assertNoGoPolarKey } = await import('../server/lib/web3forms')
    const html = await currentHtml()
    expect(() => assertNoGoPolarKey(html, GO_POLAR_KEY)).toThrow(/never receive their own enquiries/i)
  })
})

describe('a key that works', () => {
  it('is accepted, and a real test enquiry goes through it', async () => {
    const { status, body } = await submitKey(WORKING_KEY)

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.testEnquirySent).toBe(true)
    expect(String(body.detail)).toMatch(/test enquiry/i)

    const sent = submissions.at(-1)
    expect(sent?.access_key).toBe(WORKING_KEY)
    // The tradie is going to read this email, so it has to explain itself.
    expect(sent?.message).toMatch(/test enquiry/i)
    expect(sent?.message).toMatch(/Cold Front Plumbing/)
  })

  it('goes into BOTH forms, and Go Polar is gone from the document', async () => {
    const html = await currentHtml()
    const theirs = html.match(/name="access_key" value="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"/g) ?? []

    expect(theirs.length).toBe(2)
    expect(html).not.toContain(GO_POLAR_KEY)
  })

  it('is written as a new version rather than overwriting what they approved', async () => {
    const state = await goLiveState()
    expect(state.currentVersion).toBe(2)
  })

  it('writes the plan alongside the new version, not just the document', async () => {
    // Found by the end to end run: a build with no plan beside it is a version that cannot be
    // rolled back to or handed over, because both read the plan by version. Discharge returned
    // "the current build could not be loaded" for a site that was sitting right there.
    const { getDb, schema } = await import('../server/db/client')
    const { and, eq } = await import('drizzle-orm')
    const db = await getDb()

    const plans = await db
      .select({ version: schema.plans.version })
      .from(schema.plans)
      .where(and(eq(schema.plans.jobId, jobId), eq(schema.plans.version, 2)))

    expect(plans).toHaveLength(1)
  })

  it('does not cost them an edit, because they did not ask for a change', async () => {
    const res = await authed(`/api/jobs/${jobId}/versions`)
    const body = (await res.json()) as { editsUsed: number }
    expect(body.editsUsed).toBe(0)
  })

  it('shows back masked, never in full', async () => {
    const state = await goLiveState()
    expect(state.formsKey.verified).toBe(true)
    expect(state.formsKey.keyMasked).not.toBe(WORKING_KEY)
    expect(state.formsKey.keyMasked).toMatch(/^aaaaaaaa\*+eeee$/)
  })

  it('unblocks going live', async () => {
    const state = await goLiveState()
    expect(state.formsKey.blocksGoLive).toBe(false)

    const res = await authed(`/api/jobs/${jobId}/golive/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emailAddon: false, domainAddon: false }),
    })
    // Whatever happens next is a Shopify configuration question, not a forms-key one.
    expect(res.status).not.toBe(409)
  })

  it('lets the site be published now that the forms are theirs', async () => {
    const { assertNoGoPolarKey } = await import('../server/lib/web3forms')
    const html = await currentHtml()
    expect(() => assertNoGoPolarKey(html, GO_POLAR_KEY)).not.toThrow()
  })

  it('is reused by discharge instead of asking them a second time', async () => {
    const { getVerifiedFormsKey } = await import('../server/lib/db')
    expect(await getVerifiedFormsKey(jobId)).toBe(WORKING_KEY)
  })
})
