import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import * as copy from '../shared/pages-copy'

/**
 * The claims in the additional-pages copy.
 *
 * Chris sells to Australian small businesses. An unsubstantiated performance claim is exposure
 * under the Australian Consumer Law before it is anything else, and it is the kind of thing that
 * destroys trust when it does not come true. So the copy persuades with the mechanism and never
 * with a promise, and that is held down here rather than left to whoever edits the file next.
 */

const ALL_COPY = Object.values(copy)
  .flatMap((v) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []))
  .join(' ')

/** Claims that must never appear. Each one is a promise we cannot keep and cannot substantiate. */
const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\brank(ing|ed|s)?\b/i, why: 'a ranking claim' },
  { pattern: /page one|first page|top of (google|search)/i, why: 'a position claim' },
  // Affirmative forms only. "This is not a guarantee of anything" is a disclaimer and is exactly
  // what we want the copy to say, so a blunt /guarantee/ would ban the honest sentence.
  { pattern: /\b(we guarantee|guaranteed|guarantees)\b/i, why: 'a guarantee' },
  { pattern: /more (customers|leads|enquiries|traffic|calls)/i, why: 'a volume claim' },
  { pattern: /\b(double|triple|increase|boost|grow)\b.{0,20}\b(leads|traffic|enquiries|sales)/i, why: 'a growth claim' },
  { pattern: /within (days|weeks|months)|in \d+ (days|weeks|months)/i, why: 'a timeframe' },
  { pattern: /\bSEO\b.{0,30}\b(results|success)/i, why: 'an outcome claim' },
  { pattern: /get you found|be found first|outrank/i, why: 'an outcome claim' },
]

describe('the additional pages copy makes no performance claim', () => {
  for (const { pattern, why } of FORBIDDEN) {
    it(`contains no ${why}`, () => {
      const hit = ALL_COPY.match(pattern)
      expect(hit, `found ${why}: "${hit?.[0]}"`).toBeNull()
    })
  }

  it('explains the mechanism instead', () => {
    // The persuasion has to be there. Copy that claims nothing AND explains nothing sells nothing.
    expect(copy.PAGE_MECHANISM).toMatch(/competing with itself/i)
    expect(copy.PAGE_MECHANISM).toMatch(/something specific/i)
    expect(copy.PAGE_MECHANISM_SHORT.length).toBeLessThan(copy.PAGE_MECHANISM.length)
  })

  it('states the limit plainly rather than burying it', () => {
    expect(copy.PAGE_CAVEAT).toMatch(/not a guarantee/i)
  })

  it('says what the customer actually gets, so the money buys something concrete', () => {
    expect(copy.PAGE_INCLUDES.length).toBeGreaterThanOrEqual(3)
    expect(copy.PAGE_INCLUDES.join(' ')).toMatch(/\/services\//)
    expect(copy.PAGE_INCLUDES.join(' ')).toMatch(/enquiry form/i)
  })

  it('takes its price from the config module rather than hardcoding one', () => {
    expect(copy.pagePriceLine()).toContain('$25')
    expect(copy.pagePriceLine()).toContain('inc GST')
    // And no second copy of the number anywhere in the file.
    const source = readFileSync('shared/pages-copy.ts', 'utf8')
    expect(source).not.toMatch(/\$\s?25/)
  })
})

describe('the same rule applies to what the builder UI renders', () => {
  it('no performance claim in the intake or preview components', () => {
    const files = ['src/pages/Intake.tsx', 'src/pages/Preview.tsx']
    for (const file of files) {
      // Comments are stripped first. This scan is about what a customer reads, and a comment
      // explaining why the rule exists is allowed to name the thing it bans.
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|\s)\/\/.*$/gm, ' ')
      for (const { pattern, why } of FORBIDDEN) {
        const hit = source.match(pattern)
        expect(hit, `${file} contains ${why}: "${hit?.[0]}"`).toBeNull()
      }
    }
  })
})
