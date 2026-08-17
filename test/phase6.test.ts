import { describe, expect, it } from 'vitest'
import { SESSION_COOKIE, buildLink, clearCookie, jobIdFromPath, sessionCookie } from '../server/lib/auth'
import { readClaims, signClaims } from '../server/lib/signing'
import {
  buildCompleteEmail,
  buildLinkEmail,
  dischargeReadyEmail,
  goLiveReceiptEmail,
  resendLinkEmail,
  send,
} from '../server/lib/email'
import { GhlConfigError, builderLoginLink, notifyGhl, previewLink } from '../server/lib/ghl'
import { LiveActionBlockedError, assertLiveEnabled } from '../server/config'
import { testConfig } from './fixtures/site'

describe('build links and cookies', () => {
  it('builds a link on the configured public URL', () => {
    expect(buildLink('abc123')).toBe('https://build.itscold.com.au/start?t=abc123')
  })

  it('url encodes the token', () => {
    expect(buildLink('a+b/c=')).toContain('t=a%2Bb%2Fc%3D')
  })

  it('sets an HttpOnly, SameSite=Lax cookie, secure on https', () => {
    const cookie = sessionCookie('value')
    expect(cookie).toContain(`${SESSION_COOKIE}=value`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('Max-Age=7776000') // 90 days, matching the token life
  })

  it('does not mark the cookie secure on a plain http dev origin', () => {
    const dev = testConfig({ publicAppUrl: 'http://localhost:5173' })
    expect(sessionCookie('value', dev)).not.toContain('Secure')
    testConfig()
  })

  it('clears the cookie by expiring it', () => {
    expect(clearCookie()).toContain('Max-Age=0')
  })
})

describe('job ownership is read from the path', () => {
  // This is the check that stops one valid session reading another customer's build. It reads the
  // path directly because the middleware runs on a wildcard route, where c.req.param() is
  // undefined. That bug shipped once and is the reason these tests exist.
  it('finds the job id on every job route shape', () => {
    expect(jobIdFromPath('/api/jobs/job_abc')).toBe('job_abc')
    expect(jobIdFromPath('/api/jobs/job_abc/intake')).toBe('job_abc')
    expect(jobIdFromPath('/api/jobs/job_abc/builds/2/preview')).toBe('job_abc')
    expect(jobIdFromPath('/api/jobs/job_abc/golive/domain/inspect')).toBe('job_abc')
    expect(jobIdFromPath('/api/jobs/job_abc/discharge/release')).toBe('job_abc')
  })

  it('returns nothing for paths that are not job routes', () => {
    expect(jobIdFromPath('/api/health')).toBeNull()
    expect(jobIdFromPath('/api/assets/ast_1/raw')).toBeNull()
    expect(jobIdFromPath('/api/jobs/')).toBeNull()
    expect(jobIdFromPath('/api/auth/me')).toBeNull()
  })

  it('is not fooled by a query string', () => {
    expect(jobIdFromPath('/api/jobs/job_abc?version=2')).toBe('job_abc')
  })
})

describe('session claims', () => {
  it('ties a session to one job', async () => {
    const session = await signClaims({
      kind: 'session',
      jobId: 'job_one',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    expect((await readClaims(session, 'session'))?.jobId).toBe('job_one')
  })

  it('cannot be re-signed for another job without the secret', async () => {
    const other = testConfig({ appSecret: 'a-different-secret' })
    const session = await signClaims(
      { kind: 'session', jobId: 'job_two', exp: Math.floor(Date.now() / 1000) + 3600 },
      other,
    )
    const ours = testConfig()
    expect(await readClaims(session, 'session', ours)).toBeNull()
  })
})

describe('live action gating', () => {
  // The safety rail behind local preview: nothing charges, emails or touches DNS unless a flag
  // is explicitly on, and a blocked action throws rather than quietly doing nothing.
  it('blocks every capability by default', () => {
    const cfg = testConfig({ demoMode: false, live: { payments: false, email: false, crm: false, domains: false } })
    for (const capability of ['payments', 'email', 'crm', 'domains'] as const) {
      expect(() => assertLiveEnabled(capability, cfg)).toThrow(LiveActionBlockedError)
    }
    testConfig()
  })

  it('names the flag that would turn it on', () => {
    const cfg = testConfig({ demoMode: false, live: { payments: false, email: false, crm: false, domains: false } })
    expect(() => assertLiveEnabled('email', cfg)).toThrow(/ENABLE_LIVE_EMAIL/)
    expect(() => assertLiveEnabled('domains', cfg)).toThrow(/ENABLE_LIVE_DOMAINS/)
    testConfig()
  })

  it('allows a capability once it is explicitly enabled', () => {
    const cfg = testConfig({ demoMode: false, live: { payments: true, email: false, crm: false, domains: false } })
    expect(() => assertLiveEnabled('payments', cfg)).not.toThrow()
    testConfig()
  })
})

describe('emails', () => {
  it('sends nothing in demo mode and logs what it would have sent', async () => {
    testConfig({ demoMode: true })
    const result = await send({ to: 'someone@example.com', subject: 'Test', text: 'Body' })
    expect(result.id).toMatch(/^fake_email_/)
  })

  it('refuses to send for real unless live email is switched on', async () => {
    testConfig({ demoMode: false, live: { payments: false, email: false, crm: false, domains: false } })
    await expect(send({ to: 'a@b.com', subject: 's', text: 't' })).rejects.toThrow(/ENABLE_LIVE_EMAIL/)
    testConfig()
  })

  it('names RESEND_API_KEY when live email is on but the key is missing', async () => {
    testConfig({
      demoMode: false,
      live: { payments: false, email: true, crm: false, domains: false },
      resendApiKey: undefined,
    })
    await expect(send({ to: 'a@b.com', subject: 's', text: 't' })).rejects.toThrow(/RESEND_API_KEY/)
    testConfig()
  })

  it('the build link email carries the link and the 90 day promise', () => {
    const message = buildLinkEmail({ link: 'https://build.itscold.com.au/start?t=xyz' })
    expect(message.text).toContain('https://build.itscold.com.au/start?t=xyz')
    expect(message.text).toContain('90 days')
    expect(message.text).toContain('10 rounds of changes')
  })

  it('the go live receipt restates the monthly cost and never promises a connection time', () => {
    const message = goLiveReceiptEmail({
      businessName: 'Cold Front Plumbing',
      domain: 'coldfront.com.au',
      monthly: ['Hosting: $30/month + GST'],
    })
    expect(message.text).toContain('$30/month + GST')
    expect(message.text).toContain('within one business day')
    expect(message.text).not.toMatch(/connected within|live within|24 hours/i)
  })

  it('the discharge email leads with the key swap when a placeholder was used', () => {
    const withPlaceholder = dischargeReadyEmail({
      businessName: 'Cold Front',
      downloadLink: 'https://x/y',
      expiresAt: '2026-09-16T00:00:00.000Z',
      usedPlaceholder: true,
    })
    expect(withPlaceholder.text).toContain('will not send anywhere')

    const withKey = dischargeReadyEmail({
      businessName: 'Cold Front',
      downloadLink: 'https://x/y',
      expiresAt: '2026-09-16T00:00:00.000Z',
      usedPlaceholder: false,
    })
    expect(withKey.text).toContain('come straight to you')
    expect(withKey.text).not.toContain('will not send anywhere')
  })

  it('no email contains an em dash or an emoji, same as the sites we build', () => {
    const messages = [
      buildLinkEmail({ link: 'https://x' }),
      resendLinkEmail({ link: 'https://x' }),
      buildCompleteEmail({ businessName: 'X', previewLink: 'https://x' }),
      goLiveReceiptEmail({ businessName: 'X', domain: 'x.com.au', monthly: ['Hosting: $30/month + GST'] }),
      dischargeReadyEmail({
        businessName: 'X',
        downloadLink: 'https://x',
        expiresAt: '2026-09-16T00:00:00.000Z',
        usedPlaceholder: true,
      }),
    ]
    for (const message of messages) {
      expect(message.text).not.toContain('—')
      expect(message.text).not.toMatch(/\p{Extended_Pictographic}/u)
      expect(message.subject).not.toContain('—')
    }
  })
})

describe('GoHighLevel', () => {
  const payload = {
    event: 'payment_received' as const,
    contact: { email: 'a@b.com' },
    jobId: 'job_1',
    customValues: {},
  }

  it('posts nothing in demo mode', async () => {
    testConfig({ demoMode: true })
    await expect(notifyGhl(payload)).resolves.toBeUndefined()
  })

  it('refuses to post for real unless live CRM is switched on', async () => {
    testConfig({ demoMode: false, live: { payments: false, email: false, crm: false, domains: false } })
    await expect(notifyGhl(payload)).rejects.toThrow(/ENABLE_LIVE_CRM/)
    testConfig()
  })

  it('names the webhook variable when live CRM is on but the URL is missing', async () => {
    testConfig({
      demoMode: false,
      live: { payments: false, email: false, crm: true, domains: false },
      ghlWebhookUrl: undefined,
    })
    await expect(notifyGhl(payload)).rejects.toBeInstanceOf(GhlConfigError)
    await expect(notifyGhl(payload)).rejects.toThrow(/GHL_INBOUND_WEBHOOK_URL/)
    testConfig()
  })

  it('builds the two custom values the brief asks us to add', () => {
    expect(builderLoginLink('tok')).toBe('https://build.itscold.com.au/start?t=tok')
    expect(previewLink('job_1')).toBe('https://build.itscold.com.au/preview/job_1')
  })
})
