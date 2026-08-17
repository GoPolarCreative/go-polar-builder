import { describe, expect, it } from 'vitest'
import type { Env } from '../worker/env'
import { createZip, crc32 } from '../worker/lib/zip'
import { PLACEHOLDER_KEY, generateFavicon, isValidWeb3FormsKey, swapWeb3FormsKey } from '../worker/lib/discharge'
import { normaliseDomain, requiresAuEligibility } from '../worker/lib/domains'
import { ShopifyConfigError, centsFromPrice, createCheckout, handleForLineItem, kindForHandle, orderEmail, orderJobIdAttribute } from '../worker/lib/shopify'
import { hashToken, mintToken, readClaims, signClaims, verifyShopifyHmac } from '../worker/lib/signing'
import { makeFixture } from './fixtures/site'

const fixture = makeFixture()

const SIGNING_ENV = { APP_SECRET: 'test-secret-not-a-real-one' } as unknown as Env

describe('zip writer', () => {
  it('produces a file with the right signatures and entry count', () => {
    const encoder = new TextEncoder()
    const zip = createZip(
      [
        { path: 'index.html', data: encoder.encode('<!DOCTYPE html><html></html>') },
        { path: 'assets/photo-01.png', data: encoder.encode('not really a png') },
      ],
      new Date('2026-08-17T10:00:00Z'),
    )

    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    expect(view.getUint32(0, true)).toBe(0x04034b50) // first local file header

    // End of central directory: last 22 bytes, entry count in both places.
    const eocd = zip.length - 22
    expect(view.getUint32(eocd, true)).toBe(0x06054b50)
    expect(view.getUint16(eocd + 8, true)).toBe(2)
    expect(view.getUint16(eocd + 10, true)).toBe(2)
  })

  it('stores file contents verbatim, because nothing is compressed', () => {
    const encoder = new TextEncoder()
    const content = 'Website by Go Polar Creative'
    const zip = createZip([{ path: 'a.txt', data: encoder.encode(content) }])
    expect(new TextDecoder().decode(zip)).toContain(content)
  })

  it('computes a CRC32 that matches the known value for a known input', () => {
    // "123456789" has a published CRC32 of 0xCBF43926, which is how you tell a broken table.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('writes the file name into both the local and the central header', () => {
    const zip = createZip([{ path: 'READ-ME-FIRST.txt', data: new Uint8Array([1, 2, 3]) }])
    const text = new TextDecoder().decode(zip)
    expect(text.split('READ-ME-FIRST.txt')).toHaveLength(3) // appears twice
  })
})

describe('Web3Forms key swap on discharge', () => {
  const goPolarKey = fixture.facts.web3formsKey

  it('the built site ships with the Go Polar key', () => {
    expect(fixture.html).toContain(goPolarKey)
  })

  it("replaces it with the customer's own key when they supply one", () => {
    const customer = '1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809'
    const out = swapWeb3FormsKey(fixture.html, goPolarKey, customer)
    expect(out.html).not.toContain(goPolarKey)
    expect(out.html).toContain(customer)
    expect(out.usedPlaceholder).toBe(false)
  })

  it('replaces it with a commented placeholder when they do not', () => {
    const out = swapWeb3FormsKey(fixture.html, goPolarKey, null)
    expect(out.html).not.toContain(goPolarKey)
    expect(out.html).toContain(PLACEHOLDER_KEY)
    expect(out.usedPlaceholder).toBe(true)
    expect(out.html).toContain('will not send anywhere until you replace')
  })

  it('never lets an invalid key through as if it were real', () => {
    const out = swapWeb3FormsKey(fixture.html, goPolarKey, 'jobs@coldfront.com.au')
    expect(out.html).not.toContain('jobs@coldfront.com.au')
    expect(out.usedPlaceholder).toBe(true)
  })

  it('validates keys as UUIDs, which is what stopped emails ending up in that field', () => {
    expect(isValidWeb3FormsKey('1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809')).toBe(true)
    expect(isValidWeb3FormsKey('  1A2B3C4D-5E6F-7081-92A3-B4C5D6E7F809 ')).toBe(true)
    expect(isValidWeb3FormsKey('jobs@coldfront.com.au')).toBe(false)
    expect(isValidWeb3FormsKey('12345678')).toBe(false)
    expect(isValidWeb3FormsKey('')).toBe(false)
  })

  it('comments every form, not just the first', () => {
    const out = swapWeb3FormsKey(fixture.html, goPolarKey, null)
    const comments = out.html.match(/IMPORTANT: the form below/g) ?? []
    expect(comments.length).toBe(2)
  })
})

describe('generated favicon', () => {
  it('uses the brand colour and the business initials', () => {
    const svg = generateFavicon(fixture.plan)
    expect(svg).toContain(fixture.plan.tokens.primary)
    expect(svg).toContain('>CF<')
    expect(svg.startsWith('<svg')).toBe(true)
  })
})

describe('domain normalising', () => {
  it('strips protocol, www and trailing slash', () => {
    expect(normaliseDomain('https://www.coldfrontplumbing.com.au/')).toBe('coldfrontplumbing.com.au')
    expect(normaliseDomain('  COLDFRONT.com.au ')).toBe('coldfront.com.au')
    expect(normaliseDomain('http://example.com/about?x=1')).toBe('example.com')
  })

  it('rejects things that are not domains', () => {
    expect(normaliseDomain('coldfront')).toBeNull()
    expect(normaliseDomain('not a domain')).toBeNull()
    expect(normaliseDomain('')).toBeNull()
    expect(normaliseDomain('-bad-.com')).toBeNull()
  })

  it('knows which domains need auDA eligibility collected', () => {
    expect(requiresAuEligibility('coldfront.com.au')).toBe(true)
    expect(requiresAuEligibility('coldfront.au')).toBe(true)
    expect(requiresAuEligibility('coldfront.com')).toBe(false)
  })
})

describe('Shopify checkout', () => {
  it('fails with the exact missing variable name when nothing is configured', async () => {
    const env = { SHOPIFY_STORE_DOMAIN: 'itscold.myshopify.com' } as unknown as Env
    await expect(
      createCheckout(env, { jobId: 'job_1', email: 'a@b.com', lines: [{ handle: 'hosting-monthly', quantity: 1 }] }),
    ).rejects.toThrow(/SHOPIFY_VARIANT_HOSTING_MONTHLY/)
  })

  it('fails with a named error type so the UI can tell config apart from a real outage', async () => {
    const env = {} as unknown as Env
    await expect(
      createCheckout(env, { jobId: 'job_1', email: 'a@b.com', lines: [{ handle: 'discharge', quantity: 1 }] }),
    ).rejects.toBeInstanceOf(ShopifyConfigError)
  })

  it('builds a cart permalink carrying the job id and the selling plan', async () => {
    const env = {
      SHOPIFY_STORE_DOMAIN: 'itscold.myshopify.com',
      SHOPIFY_VARIANT_HOSTING_MONTHLY: '45012345678901',
      SHOPIFY_SELLING_PLAN_HOSTING_MONTHLY: '6890123456',
    } as unknown as Env

    const result = await createCheckout(env, {
      jobId: 'job_abc',
      email: 'jobs@coldfront.com.au',
      lines: [{ handle: 'hosting-monthly', quantity: 1 }],
    })

    expect(result.method).toBe('permalink')
    expect(result.url).toContain('itscold.myshopify.com/cart/45012345678901:1')
    expect(result.url).toContain('selling_plan=6890123456')
    expect(result.url).toContain('job_id')
    expect(result.url).toContain('job_abc')
  })

  it('refuses to silently drop an add-on a permalink cannot carry', async () => {
    const env = {
      SHOPIFY_STORE_DOMAIN: 'itscold.myshopify.com',
      SHOPIFY_VARIANT_HOSTING_MONTHLY: '1',
      SHOPIFY_SELLING_PLAN_HOSTING_MONTHLY: '10',
      SHOPIFY_VARIANT_EMAIL_MONTHLY: '2',
      SHOPIFY_SELLING_PLAN_EMAIL_MONTHLY: '20',
    } as unknown as Env

    await expect(
      createCheckout(env, {
        jobId: 'job_abc',
        email: 'a@b.com',
        lines: [
          { handle: 'hosting-monthly', quantity: 1 },
          { handle: 'email-monthly', quantity: 1 },
        ],
      }),
    ).rejects.toThrow(/SHOPIFY_STOREFRONT_TOKEN/)
  })
})

describe('Shopify order parsing', () => {
  const env = { SHOPIFY_VARIANT_BUILD_TOKEN: '999' } as unknown as Env

  it('matches a line item by configured variant id first', () => {
    expect(handleForLineItem(env, { variant_id: 999, title: 'Something else' })).toBe('build-token')
  })

  it('falls back to the SKU', () => {
    expect(handleForLineItem(env, { sku: 'hosting-monthly', title: 'Whatever' })).toBe('hosting-monthly')
  })

  it('falls back to the title, and reports nothing rather than guessing wrong', () => {
    expect(handleForLineItem(env, { title: 'Website Build Token' })).toBe('build-token')
    expect(handleForLineItem(env, { title: 'A tin of paint' })).toBeNull()
  })

  it('maps handles to order kinds', () => {
    expect(kindForHandle('build-token')).toBe('build')
    expect(kindForHandle('post-live-edit')).toBe('edit')
    expect(kindForHandle('extra-edits')).toBe('edit')
    expect(kindForHandle('nonsense')).toBeNull()
  })

  it('reads the email from wherever Shopify put it', () => {
    expect(orderEmail({ id: 1, email: 'A@B.com' })).toBe('a@b.com')
    expect(orderEmail({ id: 1, customer: { email: 'c@d.com' } })).toBe('c@d.com')
    expect(orderEmail({ id: 1 })).toBeNull()
  })

  it('reads the job id attribute we attach to checkouts', () => {
    expect(orderJobIdAttribute({ id: 1, note_attributes: [{ name: 'job_id', value: 'job_x' }] })).toBe('job_x')
    expect(orderJobIdAttribute({ id: 1 })).toBeNull()
  })

  it('converts prices to whole cents without float drift', () => {
    expect(centsFromPrice('200.00')).toBe(20000)
    expect(centsFromPrice('14.95')).toBe(1495)
    expect(centsFromPrice(undefined)).toBe(0)
  })
})

describe('signing', () => {
  it('round trips claims', async () => {
    const token = await signClaims(SIGNING_ENV, {
      kind: 'download',
      jobId: 'job_1',
      exp: Math.floor(Date.now() / 1000) + 60,
    })
    const claims = await readClaims(SIGNING_ENV, token, 'download')
    expect(claims?.jobId).toBe('job_1')
  })

  it('rejects a tampered payload', async () => {
    const token = await signClaims(SIGNING_ENV, {
      kind: 'download',
      jobId: 'job_1',
      exp: Math.floor(Date.now() / 1000) + 60,
    })
    const [, signature] = token.split('.')
    const forged = `${btoa(JSON.stringify({ kind: 'download', jobId: 'job_someone_else', exp: 9999999999 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')}.${signature}`
    expect(await readClaims(SIGNING_ENV, forged, 'download')).toBeNull()
  })

  it('rejects an expired token', async () => {
    const token = await signClaims(SIGNING_ENV, {
      kind: 'download',
      jobId: 'job_1',
      exp: Math.floor(Date.now() / 1000) - 5,
    })
    expect(await readClaims(SIGNING_ENV, token, 'download')).toBeNull()
  })

  it('will not let a session cookie be replayed as a download link', async () => {
    const session = await signClaims(SIGNING_ENV, {
      kind: 'session',
      jobId: 'job_1',
      exp: Math.floor(Date.now() / 1000) + 60,
    })
    expect(await readClaims(SIGNING_ENV, session, 'download')).toBeNull()
    expect(await readClaims(SIGNING_ENV, session, 'session')).not.toBeNull()
  })

  it('fails loudly when APP_SECRET is missing rather than signing with nothing', async () => {
    await expect(
      signClaims({} as unknown as Env, { kind: 'session', jobId: 'j', exp: 9999999999 }),
    ).rejects.toThrow(/APP_SECRET/)
  })

  it('stores only a hash of a build token', async () => {
    const token = mintToken()
    const hash = await hashToken(token)
    expect(hash).not.toContain(token)
    expect(await hashToken(token)).toBe(hash)
    expect(await hashToken(mintToken())).not.toBe(hash)
  })
})

describe('Shopify webhook verification', () => {
  const secret = 'shpss_test_secret'
  const body = JSON.stringify({ id: 12345, email: 'a@b.com' })

  async function realSignature(): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
    return btoa(String.fromCharCode(...new Uint8Array(sig)))
  }

  it('accepts a correctly signed payload', async () => {
    expect(await verifyShopifyHmac(secret, body, await realSignature())).toBe(true)
  })

  it('rejects a payload signed with the wrong secret', async () => {
    expect(await verifyShopifyHmac('wrong-secret', body, await realSignature())).toBe(false)
  })

  it('rejects a modified body', async () => {
    const signature = await realSignature()
    expect(await verifyShopifyHmac(secret, body.replace('12345', '99999'), signature)).toBe(false)
  })

  it('rejects a missing or rubbish header', async () => {
    expect(await verifyShopifyHmac(secret, body, null)).toBe(false)
    expect(await verifyShopifyHmac(secret, body, 'not-base64!!')).toBe(false)
  })
})
