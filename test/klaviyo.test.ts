import { afterEach, describe, expect, it, vi } from 'vitest'
import { KLAVIYO_METRICS, trackKlaviyo } from '../server/lib/klaviyo.js'
import { setConfigForTests } from '../server/config.js'
import { testConfig } from './fixtures/site.js'

/**
 * What we send to Klaviyo.
 *
 * Klaviyo sends every customer email this product produces, so the shape of this request is the
 * shape of the whole delivery path. It is versioned by date and rejects a request whose profile
 * carries no identifier, and neither failure is visible until a customer is waiting on an email
 * that never comes.
 */

const live = (over: Record<string, unknown> = {}) =>
  testConfig({
    demoMode: false,
    live: { payments: false, email: true, domains: false },
    klaviyoApiKey: 'pk_test_key',
    ...over,
  })

const accepted = () => vi.fn().mockResolvedValue({ status: 202, text: async () => '' })

const event = {
  metric: 'build_purchased' as const,
  profile: { email: 'dave@example.com', firstName: 'Dave', phone: '0412 345 678' },
  jobId: 'job_1',
  properties: { builder_login_link: 'https://build.itscold.com.au/start?t=abc' },
}

afterEach(() => vi.unstubAllGlobals())

describe('the Klaviyo request', () => {
  it('posts to the events endpoint with a pinned revision', async () => {
    const fetchMock = accepted()
    vi.stubGlobal('fetch', fetchMock)
    setConfigForTests(live())

    await trackKlaviyo(event)

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://a.klaviyo.com/api/events')
    expect(init.headers.Authorization).toBe('Klaviyo-API-Key pk_test_key')
    // Klaviyo versions by date. Unpinned means a working integration breaks on a morning nobody
    // deployed anything.
    expect(init.headers.revision).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(init.headers['content-type']).toBe('application/vnd.api+json')
  })

  it('nests metric, profile and properties the way the API requires', async () => {
    const fetchMock = accepted()
    vi.stubGlobal('fetch', fetchMock)
    setConfigForTests(live())

    await trackKlaviyo(event)
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body)

    expect(body.data.type).toBe('event')
    expect(body.data.attributes.metric.data.attributes.name).toBe(KLAVIYO_METRICS.build_purchased)
    expect(body.data.attributes.profile.data.attributes.email).toBe('dave@example.com')
    expect(body.data.attributes.properties.builder_login_link).toContain('/start?t=abc')
  })

  it('carries the link, because a flow that looks one up can send a dead button', async () => {
    const fetchMock = accepted()
    vi.stubGlobal('fetch', fetchMock)
    setConfigForTests(live())

    await trackKlaviyo(event)
    const props = JSON.parse(fetchMock.mock.calls[0]![1].body).data.attributes.properties
    expect(props.builder_login_link).toBeTruthy()
    expect(props.job_id).toBe('job_1')
  })

  it('normalises an Australian mobile, and omits one it cannot', async () => {
    const fetchMock = accepted()
    vi.stubGlobal('fetch', fetchMock)
    setConfigForTests(live())

    await trackKlaviyo(event)
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).data.attributes.profile.data.attributes.phone_number).toBe(
      '+61412345678',
    )

    fetchMock.mockClear()
    await trackKlaviyo({ ...event, profile: { email: 'a@b.com', phone: 'call the office' } })
    // A wrong number on a profile is worse than none, because it looks real.
    expect(
      JSON.parse(fetchMock.mock.calls[0]![1].body).data.attributes.profile.data.attributes.phone_number,
    ).toBeUndefined()
  })

  it('treats anything other than 202 as a failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, text: async () => 'odd' }))
    setConfigForTests(live())
    // 202 is the documented success. A 200 means something else answered, and quietly accepting it
    // is how a broken transport looks healthy.
    await expect(trackKlaviyo(event)).rejects.toThrow(/200/)
  })

  it('sends nothing at all in demo mode', async () => {
    const fetchMock = accepted()
    vi.stubGlobal('fetch', fetchMock)
    setConfigForTests(testConfig({ demoMode: true }))
    await trackKlaviyo(event)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('every metric name is unique, so no two flows can collide', () => {
    const names = Object.values(KLAVIYO_METRICS)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name.length).toBeLessThanOrEqual(128)
  })
})
