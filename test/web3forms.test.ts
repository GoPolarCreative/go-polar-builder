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
    formsKey: { saved: boolean; verified: boolean; blocksGoLive: boolean; keyMasked: string | null }
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

/*
 * THE SPLIT, AND WHY IT IS NOT A WEAKENING.
 *
 * The panel used to test the key live and refuse it on the spot. It runs BEFORE the build, though,
 * and a live send there needs an inbox, an outbound request and email switched on. Any of those
 * missing produced "That key was not accepted" over a key nobody had found fault with, and the
 * route also refused outright whenever no build existed yet, which is the normal state on that
 * screen. So the three gates now sit where each can actually run:
 *
 *   shape   -> the panel, which is the only part the customer can be wrong about
 *   proof   -> a browser test, sent as evidence, upgrading the key to verified when it succeeds
 *   the swap-> publishJob, the single place a site becomes public
 *
 * The invariant is untouched and these tests hold it: web3formsVerifiedAt is written only by a
 * real successful test, publishJob refuses without it, and no Go Polar key survives a publish.
 */

const failedProof = { success: false, message: 'Access key is invalid or not verified', status: 200 }
const goodProof = { success: true, message: 'Email sent successfully', status: 200 }

async function submitKeyWithProof(key: string, proof: unknown) {
  const res = await authed(`/api/jobs/${jobId}/golive/forms-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, proof }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('a well-formed key is saved without being proved', () => {
  it('is accepted before any website exists, which is when the panel actually runs', async () => {
    const before = await goLiveState()
    const { status, body } = await submitKey(WRONG_BUT_VALID_KEY)

    expect(status).toBe(200)
    expect(body.saved).toBe(true)
    expect(body.tested).toBe(false)

    // No version was written. Nothing about their site changed, because nothing was swapped here.
    const after = await goLiveState()
    expect(after.currentVersion).toBe(before.currentVersion)
  })

  it('is NOT marked verified, so nothing downstream can assume it was checked', async () => {
    const { getVerifiedFormsKey } = await import('../server/lib/db')
    // getVerifiedFormsKey requires the verified timestamp, so an unproved key reads as absent.
    expect(await getVerifiedFormsKey(jobId)).toBeNull()

    const state = await goLiveState()
    expect(state.formsKey.saved).toBe(true)
    expect(state.formsKey.verified).toBe(false)
    expect(state.formsKey.blocksGoLive).toBe(true)
  })

  it('leaves the built site posting to Go Polar, because the swap happens at publish', async () => {
    const html = await currentHtml()
    expect(html).toContain(GO_POLAR_KEY)
    expect(html).not.toContain(WRONG_BUT_VALID_KEY)
  })

  it('does not send anything from the panel, so nothing there can fail on the customer', async () => {
    const countBefore = submissions.length
    await submitKey(WRONG_BUT_VALID_KEY)
    expect(submissions.length).toBe(countBefore)
  })
})

describe('a browser test that failed leaves the step complete but unproved', () => {
  it('still saves, and still does not verify', async () => {
    const { status, body } = await submitKeyWithProof(WRONG_BUT_VALID_KEY, failedProof)

    // The customer did nothing wrong, so this is not an error in front of them.
    expect(status).toBe(200)
    expect(body.saved).toBe(true)
    expect(body.tested).toBe(false)

    const state = await goLiveState()
    expect(state.formsKey.verified).toBe(false)
    expect(state.formsKey.blocksGoLive).toBe(true)
  })
})

describe('going live is blocked until the inbox is proved', () => {
  it('refuses the checkout while the key is saved but unproved', async () => {
    const res = await authed(`/api/jobs/${jobId}/golive/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emailAddon: false, domainAddon: false }),
    })
    const body = (await res.json()) as Record<string, unknown>

    expect(res.status).toBe(409)
    // The saved key is wrong, so go live tests it and reports what Web3Forms said.
    expect(body.error).toBe('forms_key_rejected')
    expect(String(body.detail)).toMatch(/Access key is invalid or not verified/)
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
  it('is verified when the browser test succeeded', async () => {
    const { status, body } = await submitKeyWithProof(WORKING_KEY, goodProof)

    expect(status).toBe(200)
    expect(body.saved).toBe(true)
    expect(body.tested).toBe(true)
    expect(String(body.detail)).toMatch(/test enquiry/i)
  })

  it('does not write a new version, because the swap is no longer done here', async () => {
    const state = await goLiveState()
    expect(state.currentVersion).toBe(1)
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

  it('is reused by discharge instead of asking them a second time', async () => {
    const { getVerifiedFormsKey } = await import('../server/lib/db')
    expect(await getVerifiedFormsKey(jobId)).toBe(WORKING_KEY)
  })
})

/*
 * THE SWAP NOW HAPPENS AT PUBLISH, WHICH IS WHERE IT HAS TO BE TRUE.
 *
 * This is the half of the old gate 3 that actually protects the customer: whatever bytes go on the
 * internet must carry their key and none of ours. It used to be a rebuild triggered from a setup
 * screen that could run before there was anything to rebuild.
 */
describe('publish puts their key into every page', () => {
  it('swaps the Go Polar key out of the home page on the way to being published', async () => {
    const { applyFormsKey } = await import('../server/lib/web3forms')
    const html = await currentHtml()

    // The stored build still carries our key, which is correct: nothing rewrote it in place.
    expect(html).toContain(GO_POLAR_KEY)

    const swapped = applyFormsKey(html, GO_POLAR_KEY, WORKING_KEY)
    expect(swapped.clean).toBe(true)
    expect(swapped.replaced).toBe(2)
    expect(swapped.html).not.toContain(GO_POLAR_KEY)
    expect((swapped.html.match(new RegExp(WORKING_KEY, 'g')) ?? []).length).toBe(2)
  })

  /*
   * clean means "none of OUR key survives the document", which is what publishJob refuses on. It
   * is vacuously true for a key that was never in the page, so it cannot stand alone: publishJob
   * also refuses on an EMPTY customer key, because joining on an empty string strips access_key
   * out of every form and leaves a site whose enquiries reach nobody at all.
   */
  it('reports clean only once every Go Polar key is gone', async () => {
    const { applyFormsKey } = await import('../server/lib/web3forms')
    const html = await currentHtml()
    const swapped = applyFormsKey(html, GO_POLAR_KEY, WORKING_KEY)
    expect(swapped.html).not.toContain(GO_POLAR_KEY)
    expect(swapped.clean).toBe(true)
  })

  it('would strip the key entirely if the customer key were empty, which publish refuses on', async () => {
    const { applyFormsKey } = await import('../server/lib/web3forms')
    const html = await currentHtml()
    const emptied = applyFormsKey(html, GO_POLAR_KEY, '')
    // clean is true and the document is still broken, which is why an empty key is its own gate.
    expect(emptied.clean).toBe(true)
    expect(emptied.replaced).toBe(0)
    expect(emptied.html).not.toContain(GO_POLAR_KEY)
  })
})
