import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ShopifyAuthError,
  adminApiToken,
  adminAuthMode,
  missingScopes,
  resetShopifyTokenCache,
} from '../server/lib/shopifyAuth'
import { testConfig } from './fixtures/site'

/**
 * Getting an Admin API token.
 *
 * Shopify removed admin-created custom apps, so there is no permanent shpat_ token to paste any
 * more. A Dev Dashboard app exchanges a client id and secret for a token that dies after 24 hours.
 * The failure this guards against is the quiet one: a token that expires mid-sweep, on the job
 * whose entire purpose is catching customers who paid and never got their link.
 */

const shopify = (extra: Record<string, unknown>) => ({
  ...testConfig().shopify,
  storeDomain: 'itscold.myshopify.com',
  adminApiToken: undefined,
  clientId: undefined,
  clientSecret: undefined,
  ...extra,
})

const cfg = (extra: Record<string, unknown>) => ({ ...testConfig(), shopify: shopify(extra) })

const tokenResponse = (body: unknown, ok = true) =>
  vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 401,
    text: async () => JSON.stringify(body),
  })

afterEach(() => {
  resetShopifyTokenCache()
  vi.unstubAllGlobals()
})

describe('which route this install uses', () => {
  it('prefers a static token, because a legacy app must keep working', () => {
    expect(adminAuthMode(cfg({ adminApiToken: 'shpat_x', clientId: 'a', clientSecret: 'b' }))).toBe('static-token')
  })

  it('uses client credentials when there is no static token', () => {
    expect(adminAuthMode(cfg({ clientId: 'a', clientSecret: 'b' }))).toBe('client-credentials')
  })

  it('says none when neither is configured, rather than guessing', () => {
    expect(adminAuthMode(cfg({}))).toBe('none')
    expect(adminAuthMode(cfg({ clientId: 'a' }))).toBe('none')
  })
})

describe('exchanging credentials for a token', () => {
  it('returns the token and sends the grant Shopify expects', async () => {
    const fetchMock = tokenResponse({ access_token: 'shpat_live', expires_in: 86399, scope: 'read_orders,read_products' })
    vi.stubGlobal('fetch', fetchMock)

    expect(await adminApiToken(cfg({ clientId: 'id', clientSecret: 'secret' }))).toBe('shpat_live')

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://itscold.myshopify.com/admin/oauth/access_token')
    const body = init.body.toString()
    expect(body).toContain('grant_type=client_credentials')
    expect(body).toContain('client_id=id')
    expect(body).toContain('client_secret=secret')
  })

  it('caches, so a sweep over many orders is one token request', async () => {
    const fetchMock = tokenResponse({ access_token: 'shpat_live', expires_in: 86399 })
    vi.stubGlobal('fetch', fetchMock)

    const conf = cfg({ clientId: 'id', clientSecret: 'secret' })
    await adminApiToken(conf)
    await adminApiToken(conf)
    await adminApiToken(conf)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refreshes before the token actually dies, not after', async () => {
    // Four minutes of life left is inside the margin, so it must not be handed out.
    const fetchMock = tokenResponse({ access_token: 'first', expires_in: 240 })
    vi.stubGlobal('fetch', fetchMock)
    const conf = cfg({ clientId: 'id', clientSecret: 'secret' })

    expect(await adminApiToken(conf)).toBe('first')
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'second', expires_in: 86399 }) })

    // The 30 second floor means it is briefly cached, so advance past it.
    vi.useFakeTimers()
    vi.advanceTimersByTime(31_000)
    expect(await adminApiToken(conf)).toBe('second')
    vi.useRealTimers()
  })

  it('names the organisation mismatch, because the raw error does not', async () => {
    vi.stubGlobal('fetch', tokenResponse({ error: 'shop_not_permitted' }, false))
    await expect(adminApiToken(cfg({ clientId: 'id', clientSecret: 'secret' }))).rejects.toThrow(
      ShopifyAuthError,
    )
    await expect(adminApiToken(cfg({ clientId: 'id', clientSecret: 'secret' }))).rejects.toThrow(
      /same organisation/,
    )
  })

  it('does not call Shopify at all when there is nothing to exchange', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await adminApiToken(cfg({}))).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('scopes', () => {
  it('reports a scope that was forgotten on the app version', async () => {
    vi.stubGlobal('fetch', tokenResponse({ access_token: 't', expires_in: 86399, scope: 'read_products' }))
    await adminApiToken(cfg({ clientId: 'id', clientSecret: 'secret' }))
    expect(missingScopes()).toEqual(['read_orders'])
  })

  it('says nothing when every needed scope is granted', async () => {
    vi.stubGlobal('fetch', tokenResponse({ access_token: 't', expires_in: 86399, scope: 'read_orders, read_products' }))
    await adminApiToken(cfg({ clientId: 'id', clientSecret: 'secret' }))
    expect(missingScopes()).toEqual([])
  })

  it('claims nothing about a static token, which reports no scopes', async () => {
    expect(await adminApiToken(cfg({ adminApiToken: 'shpat_x' }))).toBe('shpat_x')
    expect(missingScopes()).toEqual([])
  })
})
