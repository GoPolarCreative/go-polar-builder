import { describe, expect, it } from 'vitest'
import { ghlEventEnabled } from '../server/lib/ghl.js'
import { testConfig } from './fixtures/site.js'

/**
 * Which CRM events are worth paying for.
 *
 * GoHighLevel's inbound webhook is a premium trigger: every delivery costs an execution whether or
 * not the workflow does anything with it. This app sends seven event types to one URL, so a
 * customer with only a payment_received workflow was paying seven times to deliver one useful
 * message. This is a spend control and nothing downstream depends on it.
 */

const cfg = (events: string[]) => ({ ...testConfig(), ghlEvents: events })

describe('the GHL event whitelist', () => {
  it('sends everything when it is not configured, which is how this behaved before', () => {
    const all = cfg([])
    for (const event of ['payment_received', 'build_complete', 'discharge_requested'] as const) {
      expect(ghlEventEnabled(event, all)).toBe(true)
    }
  })

  it('sends only what is listed', () => {
    const only = cfg(['payment_received'])
    expect(ghlEventEnabled('payment_received', only)).toBe(true)
    expect(ghlEventEnabled('build_complete', only)).toBe(false)
    expect(ghlEventEnabled('go_live_requested', only)).toBe(false)
    expect(ghlEventEnabled('discharge_requested', only)).toBe(false)
  })

  it('handles more than one', () => {
    const two = cfg(['payment_received', 'build_complete'])
    expect(ghlEventEnabled('payment_received', two)).toBe(true)
    expect(ghlEventEnabled('build_complete', two)).toBe(true)
    expect(ghlEventEnabled('editing_stalled', two)).toBe(false)
  })

  it('never blocks the one that delivers the build link, unless explicitly told to', () => {
    // payment_received is the only event a paying customer actually depends on. Everything else is
    // recovery or convenience. Worth its own test so nobody trims it by accident.
    expect(ghlEventEnabled('payment_received', cfg([]))).toBe(true)
    expect(ghlEventEnabled('payment_received', cfg(['payment_received']))).toBe(true)
  })
})
