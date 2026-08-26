import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'

/**
 * What Web3Forms says about the key, versus what its infrastructure says about us.
 *
 * A real customer pasted a correct key and was told "Web3Forms rejected that key". It had not. The
 * request never reached the API: Web3Forms sits behind Cloudflare, our fetch sent no User-Agent,
 * and Cloudflare answered with a "Just a moment..." HTML challenge. The old code could not parse
 * that as JSON, fell through to the rejection branch, and blamed the customer for something they
 * could not possibly fix. They would retype a correct key until they gave up on going live.
 *
 * So two rules are under test here. Send a User-Agent so we are not challenged in the first place.
 * And never read anything except a JSON answer from Web3Forms as a verdict on the key.
 */

const GOOD_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const CHALLENGED = 'cccccccc-1111-2222-3333-444444444444'
const RATE_LIMITED = 'dddddddd-1111-2222-3333-444444444444'
const REALLY_BAD = 'ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb'

let stub: Server
let seen: Array<{ key?: string; ua?: string }> = []
let verify: typeof import('../server/lib/web3forms').verifyWeb3FormsKey
let cfg: () => import('../server/config').AppConfig

const args = { businessName: 'Test Plumbing', jobId: 'job_test' }

beforeAll(async () => {
  stub = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { access_key?: string }
      seen.push({ key: parsed.access_key, ua: req.headers['user-agent'] })

      if (parsed.access_key === CHALLENGED) {
        // Cloudflare, not Web3Forms. This is the exact shape of the reported failure.
        res.writeHead(403, { 'content-type': 'text/html' })
        res.end('<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head></html>')
        return
      }

      if (parsed.access_key === RATE_LIMITED) {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: false, message: 'Too many requests' }))
        return
      }

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        parsed.access_key === GOOD_KEY
          ? JSON.stringify({ success: true, message: 'Email sent successfully' })
          : JSON.stringify({ success: false, message: 'Access key is invalid or not verified' }),
      )
    })
  })
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  const port = (stub.address() as { port: number }).port

  process.env.DEMO_MODE = '0'
  process.env.ENABLE_LIVE_EMAIL = '1'
  process.env.APP_SECRET = 'web3forms-upstream-secret'
  process.env.WEB3FORMS_API_URL = `http://127.0.0.1:${port}/submit`

  const config = await import('../server/config')
  config.setConfigForTests(null)
  cfg = config.config
  verify = (await import('../server/lib/web3forms')).verifyWeb3FormsKey
})

afterAll(async () => {
  await new Promise<void>((resolve) => stub.close(() => resolve()))
})

describe('we identify ourselves, so we are not mistaken for a bot', () => {
  it('sends a User-Agent with every submission', async () => {
    await verify(GOOD_KEY, args, cfg())
    expect(seen.length).toBeGreaterThan(0)
    const last = seen[seen.length - 1]
    expect(last?.ua).toBeTruthy()
    expect(last?.ua).toContain('GoPolarBuilder')
  })
})

describe('an HTML challenge is not a verdict on the key', () => {
  it('does not tell the customer their key was rejected', async () => {
    const result = await verify(CHALLENGED, args, cfg())
    expect(result.ok).toBe(false)
    expect(result.message).not.toContain('rejected')
    expect(result.message).not.toContain('Check you copied')
  })

  it('says plainly that it is our end, so they do not retype a correct key', async () => {
    const result = await verify(CHALLENGED, args, cfg())
    expect(result.message).toContain('our end')
    expect(result.message).toContain('your key is probably fine')
  })

  it('keeps the real cause in the detail, where a diagnosis belongs', async () => {
    const result = await verify(CHALLENGED, args, cfg())
    expect(result.detail).toContain('unreadable:403')
    expect(result.detail).toContain('challenge')
  })

  it('still refuses to save it, because nothing was actually proven', async () => {
    const result = await verify(CHALLENGED, args, cfg())
    expect(result.ok).toBe(false)
    expect(result.live).toBe(false)
  })
})

describe('their outage is not the customer’s mistake either', () => {
  it('reads a 429 as us being throttled rather than the key being wrong', async () => {
    const result = await verify(RATE_LIMITED, args, cfg())
    expect(result.ok).toBe(false)
    expect(result.message).not.toContain('rejected')
    expect(result.detail).toContain('upstream:429')
  })
})

describe('a genuine refusal still reaches the customer unchanged', () => {
  it('quotes what Web3Forms actually said, and tells them what to check', async () => {
    const result = await verify(REALLY_BAD, args, cfg())
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Web3Forms rejected that key')
    expect(result.message).toContain('Access key is invalid or not verified')
    expect(result.detail).toContain('web3forms:200')
  })

  it('and a working key is still accepted, with a real test enquiry sent', async () => {
    const result = await verify(GOOD_KEY, args, cfg())
    expect(result.ok).toBe(true)
    expect(result.live).toBe(true)
    expect(result.message).toBeNull()
  })
})

/**
 * The browser did the test, because our server is not allowed to.
 *
 * These are the cases that matter now that the real submission happens in the customer's browser
 * and this function only reads the verdict. The one that must never regress is the last: no proof
 * and no reachable API has to mean "we could not check", never "your key is wrong".
 */
describe('reading the verdict the browser brought back', () => {
  it('accepts a success, and counts the test enquiry as really sent', async () => {
    const result = await verify(REALLY_BAD, { ...args, proof: { success: true, status: 200 } }, cfg())
    expect(result.ok).toBe(true)
    expect(result.live).toBe(true)
    expect(result.detail).toBe('browser:accepted')
  })

  it('never calls Web3Forms itself when the browser already has the answer', async () => {
    const before = seen.length
    await verify(GOOD_KEY, { ...args, proof: { success: true, status: 200 } }, cfg())
    expect(seen.length).toBe(before)
  })

  it('passes a real refusal through in Web3Forms own words', async () => {
    const result = await verify(
      REALLY_BAD,
      { ...args, proof: { success: false, message: 'Access key is invalid or not verified', status: 200 } },
      cfg(),
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Web3Forms rejected that key')
    expect(result.message).toContain('Access key is invalid or not verified')
    expect(result.live).toBe(false)
  })

  it('refuses a success that shape alone would have waved through', async () => {
    const result = await verify('not-a-uuid', { ...args, proof: { success: true } }, cfg())
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('shape:')
  })

  it('with no proof and no reachable API, blames us and not the customer', async () => {
    const result = await verify(CHALLENGED, args, cfg())
    expect(result.ok).toBe(false)
    expect(result.message).not.toContain('rejected')
    expect(result.message).toContain('our end')
  })
})
