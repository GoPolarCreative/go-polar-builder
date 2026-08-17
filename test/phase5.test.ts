import { describe, expect, it } from 'vitest'
import { createZip, crc32 } from '../server/lib/zip'
import { PLACEHOLDER_KEY, generateFavicon, isValidWeb3FormsKey, swapWeb3FormsKey } from '../server/lib/discharge'
import { normaliseDomain, requiresAuEligibility } from '../server/lib/domains'
import {
  ShopifyConfigError,
  centsFromPrice,
  createCheckout,
  handleForLineItem,
  kindForHandle,
  orderEmail,
  orderJobIdAttribute,
} from '../server/lib/shopify'
import { hashToken, mintToken, readClaims, signClaims, verifyShopifyHmac } from '../server/lib/signing'
import { rewriteAssetPaths } from '../server/lib/publish'
import { makeFixture, testConfig } from './fixtures/site'

const fixture = makeFixture()

describe('zip writer', () => {
  it('produces a file with the right signatures and entry count', () => {
    const encoder = new TextEncoder()
    const zip = createZip(
      [
        { path: 'index.html', data: encoder.encode('<!DOCTYPE html><html></html>') },
        { path: 'assets/photo-01.webp', data: encoder.encode('not really a webp') },
      ],
      new Date('2026-08-17T10:00:00Z'),
    )

    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    expect(view.getUint32(0, true)).toBe(0x04034b50) // first local file header

    const eocd = zip.length - 22
    expect(view.getUint32(eocd, true)).toBe(0x06054b50)
    expect(view.getUint16(eocd + 8, true)).toBe(2)
    expect(view.getUint16(eocd + 10, true)).toBe(2)
  })

  it('stores file contents verbatim, because nothing is compressed', () => {
    const content = 'Website by Go Polar Creative'
    const zip = createZip([{ path: 'a.txt', data: new TextEncoder().encode(content) }])
    expect(new TextDecoder().decode(zip)).toContain(content)
  })

  it('computes a CRC32 that matches the known value for a known input', () => {
    // "123456789" has a published CRC32 of 0xCBF43926, which is how you tell a broken table.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('writes the file name into both the local and the central header', () => {
    const zip = createZip([{ path: 'READ-ME-FIRST.txt', data: new Uint8Array([1, 2, 3]) }])
    expect(new TextDecoder().decode(zip).split('READ-ME-FIRST.txt')).toHaveLength(3)
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
    expect((out.html.match(/IMPORTANT: the form below/g) ?? []).length).toBe(2)
  })
})

describe('publishing a live site', () => {
  it('rewrites every asset path to an absolute URL so images never pass through a function', () => {
    const { html, count } = rewriteAssetPaths(fixture.html, fixture.facts, (key) => `https://cdn.example/${key}`)
    expect(count).toBeGreaterThan(0)
    expect(html).not.toMatch(/src="assets\//)
    expect(html).not.toMatch(/srcset="assets\//)
    expect(html).toContain('https://cdn.example/')
  })

  it('does not corrupt a thumbnail path by matching the shorter full-size path inside it', () => {
    const { html } = rewriteAssetPaths(fixture.html, fixture.facts, (key) => `https://cdn.example/${key}`)
    // Both survive as distinct URLs. The failure mode being guarded against is the shorter
    // path matching inside the longer one and producing something like <cdn>/photo-01.webp-thumb.
    expect(html).not.toContain('assets/photo-01')
    expect(html).toContain('ast_p1-web.webp')
    expect(html).toContain('ast_p1-thumb.webp')
    expect(html).not.toContain('.webp-thumb')
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

describe('checkout', () => {
  it('returns a local demo checkout in demo mode, and never contacts Shopify', async () => {
    testConfig({ demoMode: true })
    const result = await createCheckout({
      jobId: 'job_1',
      email: 'a@b.com',
      lines: [{ handle: 'hosting-monthly', quantity: 1 }],
    })
    expect(result.method).toBe('demo')
    expect(result.url).toContain('/demo/checkout')
    expect(result.url).toContain('job_1')
  })

  it('refuses to build a real checkout unless live payments are switched on', async () => {
    testConfig({ demoMode: false, live: { payments: false, email: false, crm: false, domains: false } })
    await expect(
      createCheckout({ jobId: 'job_1', email: 'a@b.com', lines: [{ handle: 'discharge', quantity: 1 }] }),
    ).rejects.toThrow(/ENABLE_LIVE_PAYMENTS/)
    testConfig()
  })

  it('names the exact missing variable when a product is not configured', async () => {
    testConfig({
      demoMode: false,
      live: { payments: true, email: false, crm: false, domains: false },
      shopify: { storeDomain: 'itscold.myshopify.com' },
    })
    await expect(
      createCheckout({ jobId: 'job_1', email: 'a@b.com', lines: [{ handle: 'hosting-monthly', quantity: 1 }] }),
    ).rejects.toThrow(/SHOPIFY_VARIANT_HOSTING_MONTHLY/)
    testConfig()
  })

  it('builds a cart permalink carrying the job id and the selling plan', async () => {
    testConfig({
      demoMode: false,
      live: { payments: true, email: false, crm: false, domains: false },
      shopify: { storeDomain: 'itscold.myshopify.com' },
    })
    process.env.SHOPIFY_VARIANT_HOSTING_MONTHLY = '45012345678901'
    process.env.SHOPIFY_SELLING_PLAN_HOSTING_MONTHLY = '6890123456'

    const result = await createCheckout({
      jobId: 'job_abc',
      email: 'jobs@coldfront.com.au',
      lines: [{ handle: 'hosting-monthly', quantity: 1 }],
    })

    expect(result.method).toBe('permalink')
    expect(result.url).toContain('itscold.myshopify.com/cart/45012345678901:1')
    expect(result.url).toContain('selling_plan=6890123456')
    expect(result.url).toContain('job_abc')

    delete process.env.SHOPIFY_VARIANT_HOSTING_MONTHLY
    delete process.env.SHOPIFY_SELLING_PLAN_HOSTING_MONTHLY
    testConfig()
  })

  it('refuses to silently drop an add-on a permalink cannot carry', async () => {
    testConfig({
      demoMode: false,
      live: { payments: true, email: false, crm: false, domains: false },
      shopify: { storeDomain: 'itscold.myshopify.com' },
    })
    process.env.SHOPIFY_VARIANT_HOSTING_MONTHLY = '1'
    process.env.SHOPIFY_SELLING_PLAN_HOSTING_MONTHLY = '10'
    process.env.SHOPIFY_VARIANT_EMAIL_MONTHLY = '2'
    process.env.SHOPIFY_SELLING_PLAN_EMAIL_MONTHLY = '20'

    await expect(
      createCheckout({
        jobId: 'job_abc',
        email: 'a@b.com',
        lines: [
          { handle: 'hosting-monthly', quantity: 1 },
          { handle: 'email-monthly', quantity: 1 },
        ],
      }),
    ).rejects.toThrow(/SHOPIFY_STOREFRONT_TOKEN/)

    for (const key of [
      'SHOPIFY_VARIANT_HOSTING_MONTHLY',
      'SHOPIFY_SELLING_PLAN_HOSTING_MONTHLY',
      'SHOPIFY_VARIANT_EMAIL_MONTHLY',
      'SHOPIFY_SELLING_PLAN_EMAIL_MONTHLY',
    ]) {
      delete process.env[key]
    }
    testConfig()
  })

  it('config errors are a named type, so the UI can tell them from an outage', async () => {
    testConfig({ demoMode: false, live: { payments: true, email: false, crm: false, domains: false } })
    await expect(
      createCheckout({ jobId: 'job_1', email: 'a@b.com', lines: [{ handle: 'discharge', quantity: 1 }] }),
    ).rejects.toBeInstanceOf(ShopifyConfigError)
    testConfig()
  })
})

describe('order parsing', () => {
  it('matches a line item by configured variant id first', () => {
    process.env.SHOPIFY_VARIANT_BUILD_TOKEN = '999'
    expect(handleForLineItem({ variant_id: 999, title: 'Something else' })).toBe('build-token')
    delete process.env.SHOPIFY_VARIANT_BUILD_TOKEN
  })

  it('falls back to the SKU', () => {
    expect(handleForLineItem({ sku: 'hosting-monthly', title: 'Whatever' })).toBe('hosting-monthly')
  })

  it('falls back to the title, and reports nothing rather than guessing wrong', () => {
    expect(handleForLineItem({ title: 'Website Build Token' })).toBe('build-token')
    expect(handleForLineItem({ title: 'A tin of paint' })).toBeNull()
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
    const token = await signClaims({ kind: 'download', jobId: 'job_1', exp: Math.floor(Date.now() / 1000) + 60 })
    expect((await readClaims(token, 'download'))?.jobId).toBe('job_1')
  })

  it('rejects a tampered payload', async () => {
    const token = await signClaims({ kind: 'download', jobId: 'job_1', exp: Math.floor(Date.now() / 1000) + 60 })
    const [, signature] = token.split('.')
    const forged = `${btoa(JSON.stringify({ kind: 'download', jobId: 'job_someone_else', exp: 9999999999 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')}.${signature}`
    expect(await readClaims(forged, 'download')).toBeNull()
  })

  it('rejects an expired token', async () => {
    const token = await signClaims({ kind: 'download', jobId: 'job_1', exp: Math.floor(Date.now() / 1000) - 5 })
    expect(await readClaims(token, 'download')).toBeNull()
  })

  it('will not let a session cookie be replayed as a download link', async () => {
    const session = await signClaims({ kind: 'session', jobId: 'job_1', exp: Math.floor(Date.now() / 1000) + 60 })
    expect(await readClaims(session, 'download')).toBeNull()
    expect(await readClaims(session, 'session')).not.toBeNull()
  })

  it('fails loudly when APP_SECRET is missing rather than signing with nothing', async () => {
    const noSecret = testConfig({ appSecret: undefined })
    await expect(signClaims({ kind: 'session', jobId: 'j', exp: 9999999999 }, noSecret)).rejects.toThrow(
      /APP_SECRET/,
    )
    testConfig()
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
    expect(await verifyShopifyHmac(secret, body.replace('12345', '99999'), await realSignature())).toBe(false)
  })

  it('rejects a missing or rubbish header', async () => {
    expect(await verifyShopifyHmac(secret, body, null)).toBe(false)
    expect(await verifyShopifyHmac(secret, body, 'not-base64!!')).toBe(false)
  })
})
