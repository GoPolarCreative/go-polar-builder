import { describe, expect, it } from 'vitest'
import { requestBodyForTests } from '../server/lib/anthropic.js'
import { testConfig } from './fixtures/site.js'

/**
 * What we send to the Anthropic API.
 *
 * The first real generation on the live deployment failed with
 *
 *   400 invalid_request_error: `temperature` is deprecated for this model.
 *
 * Claude 5 removed the sampling parameters and rejects them outright. Every local test passed,
 * because nothing local calls the real API, so the only place this could surface was a customer's
 * build. These tests are cheap and they close that gap.
 */

const base = {
  system: [{ type: 'text' as const, text: 'system' }],
  messages: [{ role: 'user' as const, content: 'hello' }],
  maxTokens: 1000,
}

const parsed = (opts: Parameters<typeof requestBodyForTests>[1], stream = false) =>
  JSON.parse(requestBodyForTests(testConfig(), opts, stream)) as Record<string, unknown>

describe('the request body', () => {
  it('never sends a sampling parameter, because Claude 5 returns 400 for them', () => {
    const body = parsed(base)
    for (const removed of ['temperature', 'top_p', 'top_k']) {
      expect(body[removed], `${removed} must not be sent`).toBeUndefined()
    }
  })

  it('sends effort inside output_config, not at the top level', () => {
    const body = parsed({ ...base, effort: 'low' })
    expect(body.output_config).toEqual({ effort: 'low' })
    expect(body.effort).toBeUndefined()
  })

  it('omits output_config entirely when no effort is asked for', () => {
    // Omitted means the API default, which is high. Sending an empty object would not.
    expect(parsed(base).output_config).toBeUndefined()
  })

  it('carries the things that must be there', () => {
    const body = parsed(base)
    expect(body.model).toBeTruthy()
    expect(body.max_tokens).toBe(1000)
    expect(body.system).toBeTruthy()
    expect(body.messages).toBeTruthy()
  })

  it('only sets stream when streaming', () => {
    expect(parsed(base, false).stream).toBeUndefined()
    expect(parsed(base, true).stream).toBe(true)
  })

  it('never prefills an assistant turn, which Claude 5 also rejects', () => {
    // A trailing assistant message is a prefill and returns 400 on every current model.
    const messages = parsed(base).messages as Array<{ role: string }>
    expect(messages[messages.length - 1]!.role).not.toBe('assistant')
  })
})
