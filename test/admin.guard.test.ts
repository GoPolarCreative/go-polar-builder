import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { requireAdmin } from '../server/lib/auth'
import { setConfigForTests } from '../server/config'
import { testConfig } from './fixtures/site'

/**
 * Who can reach the operator endpoints.
 *
 * /api/admin/* can publish a customer's website and read the event log. The rule that matters is
 * what happens when ADMIN_TOKEN has not been set: open on a laptop, refused on anything real.
 *
 * This used to key off the Shopify webhook secret, which left a window between deploying with
 * DEMO_MODE=0 and registering the webhook where these endpoints answered the public internet.
 */

function app() {
  const a = new Hono()
  a.use('/admin/*', requireAdmin)
  a.get('/admin/thing', (c) => c.json({ ok: true }))
  return a
}

const get = (headers: Record<string, string> = {}) =>
  app().request('/admin/thing', { headers })

describe('the admin guard', () => {
  it('lets an operator through on a demo laptop with no token set', async () => {
    setConfigForTests(testConfig({ demoMode: true, adminToken: '' }))
    expect((await get()).status).toBe(200)
  })

  it('refuses everyone when there is no token and this is not a demo install', async () => {
    // The window this closes: deployed, real domain, webhook not registered yet.
    setConfigForTests(testConfig({ demoMode: false, adminToken: '' }))
    const res = await get()
    expect(res.status).toBe(403)
    expect((await res.json()).detail).toContain('ADMIN_TOKEN')
  })

  it('does not treat a missing Shopify secret as permission', async () => {
    setConfigForTests(
      testConfig({ demoMode: false, adminToken: '', shopify: { ...testConfig().shopify, webhookSecret: '' } }),
    )
    expect((await get()).status).toBe(403)
  })

  it('accepts the right token, in either header', async () => {
    setConfigForTests(testConfig({ demoMode: false, adminToken: 'sekrit-token-value' }))
    expect((await get({ 'x-admin-token': 'sekrit-token-value' })).status).toBe(200)
    expect((await get({ authorization: 'Bearer sekrit-token-value' })).status).toBe(200)
  })

  it('refuses a wrong token even on a demo install', async () => {
    // Setting a token is a deliberate act. Demo mode does not undo it.
    setConfigForTests(testConfig({ demoMode: true, adminToken: 'sekrit-token-value' }))
    expect((await get({ 'x-admin-token': 'wrong' })).status).toBe(403)
    expect((await get()).status).toBe(403)
  })

  it('refuses a token that is merely a prefix of the real one', async () => {
    setConfigForTests(testConfig({ demoMode: false, adminToken: 'sekrit-token-value' }))
    expect((await get({ 'x-admin-token': 'sekrit' })).status).toBe(403)
    expect((await get({ 'x-admin-token': 'sekrit-token-value-and-more' })).status).toBe(403)
  })
})
