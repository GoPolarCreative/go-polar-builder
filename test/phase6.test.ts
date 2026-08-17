import { describe, expect, it } from 'vitest'
import type { Env } from '../worker/env'
import { SESSION_COOKIE, buildLink, clearCookie, sessionCookie } from '../worker/lib/auth'
import { readClaims, signClaims } from '../worker/lib/signing'
import {
  buildCompleteEmail,
  buildLinkEmail,
  dischargeReadyEmail,
  goLiveReceiptEmail,
  resendLinkEmail,
  send,
} from '../worker/lib/email'
import { GhlConfigError, builderLoginLink, notifyGhl, previewLink } from '../worker/lib/ghl'

const ENV = {
  APP_SECRET: 'test-secret-not-a-real-one',
  PUBLIC_APP_URL: 'https://build.itscold.com.au',
} as unknown as Env

describe('build links and cookies', () => {
  it('builds a link on the configured public URL', () => {
    expect(buildLink(ENV, 'abc123')).toBe('https://build.itscold.com.au/start?t=abc123')
  })

  it('url encodes the token', () => {
    expect(buildLink(ENV, 'a+b/c=')).toContain('t=a%2Bb%2Fc%3D')
  })

  it('sets an HttpOnly, SameSite=Lax cookie, secure on https', () => {
    const cookie = sessionCookie(ENV, 'value')
    expect(cookie).toContain(`${SESSION_COOKIE}=value`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('Max-Age=7776000') // 90 days, matching the token life
  })

  it('does not mark the cookie secure on a plain http dev origin', () => {
    const dev = { ...ENV, PUBLIC_APP_URL: 'http://localhost:5173' } as unknown as Env
    expect(sessionCookie(dev, 'value')).not.toContain('Secure')
  })

  it('clears the cookie by expiring it', () => {
    expect(clearCookie()).toContain('Max-Age=0')
  })
})

describe('session claims', () => {
  it('ties a session to one job', async () => {
    const session = await signClaims(ENV, {
      kind: 'session',
      jobId: 'job_one',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    const claims = await readClaims(ENV, session, 'session')
    expect(claims?.jobId).toBe('job_one')
  })

  it('cannot be re-signed for another job without the secret', async () => {
    const other = { ...ENV, APP_SECRET: 'a-different-secret' } as unknown as Env
    const session = await signClaims(other, {
      kind: 'session',
      jobId: 'job_two',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    expect(await readClaims(ENV, session, 'session')).toBeNull()
  })
})

describe('emails', () => {
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

  it('refuses to send with no API key, naming the variable', async () => {
    await expect(send({} as unknown as Env, { to: 'a@b.com', subject: 's', text: 't' })).rejects.toThrow(
      /RESEND_API_KEY/,
    )
  })
})

describe('GoHighLevel', () => {
  it('refuses to post with no webhook URL, naming the variable', async () => {
    await expect(
      notifyGhl({} as unknown as Env, {
        event: 'payment_received',
        contact: { email: 'a@b.com' },
        jobId: 'job_1',
        customValues: {},
      }),
    ).rejects.toBeInstanceOf(GhlConfigError)

    await expect(
      notifyGhl({} as unknown as Env, {
        event: 'payment_received',
        contact: { email: 'a@b.com' },
        jobId: 'job_1',
        customValues: {},
      }),
    ).rejects.toThrow(/GHL_INBOUND_WEBHOOK_URL/)
  })

  it('builds the two custom values the brief asks us to add', () => {
    expect(builderLoginLink(ENV, 'tok')).toBe('https://build.itscold.com.au/start?t=tok')
    expect(previewLink(ENV, 'job_1')).toBe('https://build.itscold.com.au/preview/job_1')
  })
})
