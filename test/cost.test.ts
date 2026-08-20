import { describe, expect, it } from 'vitest'
import { estimateCostUsd, type TokenUsage } from '../server/lib/anthropic.js'

/**
 * What a build costs.
 *
 * The usage block comes back on every call and was being discarded, so the only answer to "what
 * does this cost me per customer" was arithmetic on a napkin. These numbers decide whether the
 * $220 price works, so they are worth getting from the meter rather than from an estimate.
 */

const usage = (over: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  calls: 0,
  ...over,
})

describe('cost estimation', () => {
  it('prices input and output at the published rates', () => {
    // 1M input + 1M output on Sonnet 5 at $3 and $15.
    const cost = estimateCostUsd(
      usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      'claude-sonnet-5',
    )
    expect(cost).toBeCloseTo(18, 2)
  })

  it('charges more for a cache write and much less for a cache read', () => {
    const write = estimateCostUsd(usage({ cacheWriteTokens: 1_000_000 }), 'claude-sonnet-5')
    const read = estimateCostUsd(usage({ cacheReadTokens: 1_000_000 }), 'claude-sonnet-5')
    const plain = estimateCostUsd(usage({ inputTokens: 1_000_000 }), 'claude-sonnet-5')

    expect(write).toBeCloseTo(plain * 1.25, 2)
    expect(read).toBeCloseTo(plain * 0.1, 2)
    // Which is the whole reason the house rules carry a cache breakpoint.
    expect(read).toBeLessThan(plain)
  })

  it('knows Opus costs more than Sonnet for identical work', () => {
    const work = usage({ inputTokens: 100_000, outputTokens: 50_000 })
    expect(estimateCostUsd(work, 'claude-opus-5')).toBeGreaterThan(
      estimateCostUsd(work, 'claude-sonnet-5'),
    )
  })

  it('falls back rather than returning zero for a model it has never heard of', () => {
    // A zero would read as free, which is the one answer that is certainly wrong.
    const cost = estimateCostUsd(usage({ inputTokens: 100_000, outputTokens: 50_000 }), 'claude-9')
    expect(cost).toBeGreaterThan(0)
  })

  it('costs nothing when nothing was spent', () => {
    expect(estimateCostUsd(usage(), 'claude-sonnet-5')).toBe(0)
  })
})
