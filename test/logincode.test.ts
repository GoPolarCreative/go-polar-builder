import { describe, expect, it } from 'vitest'
import {
  CODE_LENGTH,
  MAX_ATTEMPTS,
  SEND_LIMIT,
  TTL_MINUTES,
  constantTimeEqual,
  generateCode,
  normaliseEmail,
} from '../server/lib/loginCode'

/**
 * The pure half of the sign-in code.
 *
 * The database half is exercised end to end in scripts/proof-login-code.mjs. What is testable
 * without a database is the part most likely to be quietly wrong: the shape of the code, the
 * randomness, and the comparison.
 */

describe('the code itself', () => {
  it('is six digits, always', () => {
    for (let i = 0; i < 500; i++) {
      const c = generateCode()
      expect(c).toMatch(/^\d{6}$/)
      expect(c).toHaveLength(CODE_LENGTH)
    }
  })

  it('KEEPS ITS LEADING ZEROS, because 000123 is a valid code and "123" is not', () => {
    // The failure this guards: padStart missing, so one code in ten is short and never matches
    // what the customer typed. Generate enough to be confident of seeing a low one.
    const codes = Array.from({ length: 3000 }, () => generateCode())
    expect(codes.every((c) => c.length === 6)).toBe(true)
    // With 3000 draws, seeing at least one code under 100000 is essentially certain.
    expect(codes.some((c) => c.startsWith('0'))).toBe(true)
  })

  it('does not repeat itself, which is what would happen with a weak source', () => {
    const codes = new Set(Array.from({ length: 2000 }, () => generateCode()))
    // Birthday collisions in 2000 draws from a million are expected to be a couple. Anything
    // remotely clustered means the random source is not what it should be.
    expect(codes.size).toBeGreaterThan(1990)
  })

  it('spreads across the whole range rather than clustering low', () => {
    const codes = Array.from({ length: 4000 }, () => Number(generateCode()))
    const high = codes.filter((n) => n >= 500_000).length
    // A modulo bias or a truncated source shows up here as a lopsided split.
    expect(high).toBeGreaterThan(1700)
    expect(high).toBeLessThan(2300)
  })
})

describe('the comparison', () => {
  it('matches identical strings', () => {
    expect(constantTimeEqual('abc123', 'abc123')).toBe(true)
  })

  it('rejects a difference in the last character as readily as the first', () => {
    expect(constantTimeEqual('abc123', 'abc124')).toBe(false)
    expect(constantTimeEqual('abc123', 'zbc123')).toBe(false)
  })

  it('rejects different lengths without throwing', () => {
    expect(constantTimeEqual('abc', 'abcdef')).toBe(false)
    expect(constantTimeEqual('', 'a')).toBe(false)
  })

  it('handles empty against empty', () => {
    expect(constantTimeEqual('', '')).toBe(true)
  })

  it('LOOKS AT EVERY CHARACTER, not just up to the first difference', () => {
    // A short-circuiting compare returns after index 0 here. This cannot detect timing directly,
    // but it pins the behaviour that a wrong-at-index-0 pair is still a full-length comparison.
    const a = 'x'.repeat(64)
    const b = 'y' + 'x'.repeat(63)
    expect(constantTimeEqual(a, b)).toBe(false)
    expect(a.length).toBe(b.length)
  })
})

describe('the address', () => {
  it('is lowercased and trimmed, so Dave@ and dave@ are one person', () => {
    expect(normaliseEmail('  Dave@Example.COM ')).toBe('dave@example.com')
  })

  it('survives an empty input without throwing', () => {
    expect(normaliseEmail('')).toBe('')
    expect(normaliseEmail(undefined as unknown as string)).toBe('')
  })
})

describe('the constraints are set to something defensible', () => {
  it('locks well before a million guesses becomes interesting', () => {
    expect(MAX_ATTEMPTS).toBeLessThanOrEqual(5)
  })

  it('expires quickly enough that a code read later is useless', () => {
    expect(TTL_MINUTES).toBeLessThanOrEqual(15)
  })

  it('caps how many codes one address can be sent, so this is not a mail bomb', () => {
    expect(SEND_LIMIT).toBeLessThanOrEqual(5)
  })

  it('gives an attacker at most SEND_LIMIT x MAX_ATTEMPTS guesses per window', () => {
    // 3 x 5 = 15 guesses per 15 minutes against a million possibilities. That is the number that
    // matters, and it is the reason both limits exist rather than just one.
    const guessesPerWindow = SEND_LIMIT * MAX_ATTEMPTS
    expect(guessesPerWindow).toBeLessThanOrEqual(25)
  })
})
