import { describe, expect, it } from 'vitest'
import {
  NAMED_STYLES,
  TRADE_STYLE_SUGGESTION,
  constraintsFor,
  paletteCarriesDarkSurfaces,
  resolveDesignStyle,
  styleSpec,
} from '../shared/styles'
import type { ContentPlan } from '../shared/plan'
import { runStaticChecks } from '../server/lib/checks/static'
import { renderSite } from '../server/lib/render/site'
import { verify } from '../server/lib/verify'
import { makeFixture } from './fixtures/site'

/** Local, so the test does not depend on colour internals it is not testing. */
function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max === min) return 0
  const d = max - min
  const h =
    max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}

/**
 * The design style has to actually change the site.
 *
 * The customer is offered a choice of look, so if two styles produced the same page with a
 * different font the choice would be a lie and worse than not offering one. These tests build the
 * same business four ways and hold two things down at once: the four are visibly different from
 * each other, and every one of them still passes every verification check.
 */

const built = Object.fromEntries(
  NAMED_STYLES.map((style) => [style, makeFixture({ designStyle: style })]),
) as Record<(typeof NAMED_STYLES)[number], ReturnType<typeof makeFixture>>

/** The values a person would actually notice, pulled back out of the rendered CSS. */
function signals(html: string) {
  const token = (name: string) => html.match(new RegExp(`--${name}:([^;]+);`))?.[1]?.trim() ?? null
  return {
    headingFamily: token('font-head'),
    headingWeight: token('weight-head'),
    headingTracking: token('track-head'),
    h1: token('h1'),
    bodySize: token('step-body'),
    sectionPadding: token('section-pad-lg'),
    gap: token('gap'),
    measure: token('measure'),
    radius: token('radius'),
    buttonRadius: token('radius-btn'),
    shadowRaised: token('shadow-raised'),
    borderStrong: token('border-strong'),
    // Structural, not just tokens: does the header start solid, is there a hero rule, are cards
    // filled or hairline separated?
    headerStartsSolid: /\.site-header\{[^}]*background:var\(--(dark-block|surface-alt)\)/.test(html),
    heroHasRule: html.includes('hero__rule'),
    cardsAreHairline: /\.card\{background:transparent/.test(html),
    cardsAreBlocked: /\.card\{background:var\(--surface\);border:var\(--border-strong\)/.test(html),
    uppercaseHeadings: /h1,h2,h3\{[^}]*text-transform:uppercase/.test(html),
    fontsQuery: html.match(/css2\?([^"]+)"/)?.[1] ?? null,
  }
}

function differences(a: ReturnType<typeof signals>, b: ReturnType<typeof signals>): string[] {
  return (Object.keys(a) as Array<keyof typeof a>).filter((k) => a[k] !== b[k])
}

describe('every style still produces a valid site', () => {
  for (const style of NAMED_STYLES) {
    it(`${style}: passes all thirteen static checks`, async () => {
      const { html, facts } = built[style]
      const results = await runStaticChecks(html, facts)
      const failed = results.filter((r) => r.status === 'fail')
      expect(failed.map((f) => `${f.id}: ${f.detail}`)).toEqual([])
      expect(results).toHaveLength(13)
    })

    it(`${style}: passes verification overall`, async () => {
      const { html, facts } = built[style]
      const report = await verify(html, facts, { runRender: false })
      expect(report.passed).toBe(true)
    })

    it(`${style}: keeps the page weight budget`, async () => {
      const { html, facts } = built[style]
      const report = await verify(html, facts, { runRender: false })
      expect(report.pageWeightBytes).toBeLessThan(2 * 1024 * 1024)
    })
  }
})

describe('the four styles are materially different', () => {
  // Not "a different font": a different shape. Anything less and the choice is decoration.
  const MINIMUM_DIFFERING_SIGNALS = 6

  for (const a of NAMED_STYLES) {
    for (const b of NAMED_STYLES) {
      if (a >= b) continue
      it(`${a} and ${b} differ in at least ${MINIMUM_DIFFERING_SIGNALS} visible ways`, () => {
        const diff = differences(signals(built[a].html), signals(built[b].html))
        expect(diff.length, `only differed in: ${diff.join(', ')}`).toBeGreaterThanOrEqual(
          MINIMUM_DIFFERING_SIGNALS,
        )
      })
    }
  }

  it('each style has its own typography, density and shape', () => {
    const all = NAMED_STYLES.map((s) => signals(built[s].html))
    for (const key of ['headingFamily', 'h1', 'sectionPadding', 'radius'] as const) {
      const values = new Set(all.map((s) => s[key]))
      expect(values.size, `every style should set its own ${key}`).toBe(NAMED_STYLES.length)
    }
  })

  // The copy is the same business either way, so the document as a whole is expected to overlap.
  // What has to move is the stylesheet and the shape of the header and hero.
  const stylesheetOf = (html: string) => html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ''
  const heroOf = (html: string) =>
    html.match(/<section class="hero[\s\S]*?<\/section>/)?.[0] ?? ''

  // A floor, not a target. Roughly half the sheet is scaffolding that has no business changing
  // with the style: the reset, the form fields, the mobile panel, the grid plumbing. Anything
  // above this and the difference is in the visible layer rather than a font swap. The real
  // weight is carried by the signal tests above, which name what changed.
  const MINIMUM_STYLESHEET_DIFFERENCE = 0.15

  it('the stylesheets are not near-identical', () => {
    for (const a of NAMED_STYLES) {
      for (const b of NAMED_STYLES) {
        if (a >= b) continue
        const linesA = stylesheetOf(built[a].html).split('\n')
        const linesB = new Set(stylesheetOf(built[b].html).split('\n'))
        expect(linesA.length).toBeGreaterThan(100)
        const changed = linesA.filter((line) => !linesB.has(line)).length
        const ratio = changed / linesA.length
        expect(
          ratio,
          `${a} vs ${b} only differed by ${(ratio * 100).toFixed(1)}% of stylesheet lines`,
        ).toBeGreaterThan(MINIMUM_STYLESHEET_DIFFERENCE)
      }
    }
  })

  it('the hero is built differently under each style', () => {
    const heroes = NAMED_STYLES.map((s) => heroOf(built[s].html))
    for (const hero of heroes) expect(hero.length).toBeGreaterThan(200)
    expect(new Set(heroes).size, 'two styles produced the same hero markup').toBe(NAMED_STYLES.length)
  })

  it('industrial is heavy and square where refined is light and open', () => {
    const industrial = signals(built.industrial.html)
    const refined = signals(built.refined.html)

    expect(industrial.radius).toBe('0px')
    expect(industrial.uppercaseHeadings).toBe(true)
    expect(industrial.headerStartsSolid).toBe(true)
    expect(industrial.cardsAreBlocked).toBe(true)

    expect(refined.cardsAreHairline).toBe(true)
    expect(refined.heroHasRule).toBe(true)
    expect(refined.shadowRaised).toBe('none')
    // Smaller type set with much more room around it, which is the whole point of that style.
    expect(parseFloat(refined.sectionPadding ?? '0')).toBeGreaterThan(
      parseFloat(industrial.sectionPadding ?? '0'),
    )
  })

  it('established is the only one that uses a serif for headings', () => {
    expect(built.established.html).toContain('Lora')
    for (const other of ['industrial', 'modern', 'refined'] as const) {
      expect(built[other].html).not.toContain('Lora')
    }
  })
})

describe('style never touches the palette', () => {
  it('every style ships the identical brand colours', () => {
    const colourTokens = NAMED_STYLES.map((style) => {
      const root = built[style].html.match(/:root\{([\s\S]*?)\}/)?.[1] ?? ''
      return ['primary', 'primary-dark', 'primary-light', 'accent', 'ink', 'surface']
        .map((name) => root.match(new RegExp(`--${name}:([^;]+);`))?.[1])
        .join('|')
    })
    expect(new Set(colourTokens).size, 'a style changed a colour').toBe(1)
  })

  it('no style introduces a colour outside :root', async () => {
    for (const style of NAMED_STYLES) {
      const { html, facts } = built[style]
      const results = await runStaticChecks(html, facts)
      const hex = results.find((r) => r.id === 'hex_outside_root')!
      expect(hex.status, `${style}: ${hex.detail}`).toBe('pass')
    }
  })

  it('a light logo palette is resolved in favour of the logo, and the compromise is recorded', () => {
    const palette = {
      primary: '#ffd166',
      accent: '#f4a261',
      source: 'logo' as const,
    }
    const constraints = constraintsFor('industrial', palette)
    expect(constraints.length).toBeGreaterThan(0)
    expect(constraints[0]).toMatch(/too light/i)

    const light = makeFixture({
      designStyle: 'industrial',
      palette: { ...palette, secondary: '#ffe6a7', dark: '#14171a', light: '#fffaf0' },
    })
    expect(light.plan.style.constraints.length).toBeGreaterThan(0)
    expect(light.html).toContain('STYLE NOTE:')

    // The logo wins over the style, so the hue is kept and deepened rather than thrown away for
    // the neutral. Same hue family, dark enough to carry white text.
    expect(light.html).toContain('--dark-block:var(--primary)')
    expect(Math.abs(hue(light.plan.tokens.primary) - hue(palette.primary))).toBeLessThan(3)
    expect(paletteCarriesDarkSurfaces({ primary: light.plan.tokens.primary })).toBe(true)
    expect(light.html).toMatch(/STYLE NOTE: Resolved: the dark areas use #[0-9a-f]{6}/i)
  })

  it('falls back to the neutral dark when the colour cannot be deepened enough', () => {
    // The offline generator always deepens the brand colour, so this is the model path: the plan
    // comes back with a light primary token. The renderer has to catch that itself.
    const base = makeFixture({ designStyle: 'industrial' })
    const plan: ContentPlan = {
      ...base.plan,
      tokens: { ...base.plan.tokens, primary: '#ffd166', primaryLight: '#fff3d6' },
      style: { ...base.plan.style, constraints: ['The industrial style wants dark blocks.'] },
    }
    const html = renderSite(plan, base.facts)
    expect(html).toContain('--dark-block:var(--ink)')
    expect(html).toContain('STYLE NOTE: Resolved: the dark areas use the neutral dark')
  })

  it('a dark logo palette lets the style use the brand colour for dark blocks', () => {
    expect(built.industrial.html).toContain('--dark-block:var(--primary)')
    expect(built.industrial.plan.style.constraints).toEqual([])
  })
})

describe('choosing on the customer behalf', () => {
  it('an explicit choice is taken at face value and recorded as theirs', () => {
    const resolved = resolveDesignStyle({
      chosen: 'refined',
      trade: 'plumber',
      palette: { primary: '#0d3b66', accent: '#f4a261', source: 'logo' },
      description: 'We do drains.',
    })
    expect(resolved.resolved).toBe('refined')
    expect(resolved.chosen).toBe('refined')
    expect(resolved.reason).toMatch(/customer/i)
  })

  it('starts from the trade when they say they are not sure', () => {
    for (const [trade, expected] of Object.entries(TRADE_STYLE_SUGGESTION)) {
      const resolved = resolveDesignStyle({
        chosen: 'auto',
        trade: trade as never,
        palette: { primary: '#0d3b66', accent: '#f4a261', source: 'logo' },
        description: 'We do good work for people around here and we turn up on time.',
      })
      // The trade sets the starting point; the logo and the description may move it.
      expect(['industrial', 'modern', 'established', 'refined']).toContain(resolved.resolved)
      if (resolved.reason.includes('trade is')) expect(resolved.reason).toContain(expected)
    }
  })

  it('reads a family business out of their own words', () => {
    const resolved = resolveDesignStyle({
      chosen: 'auto',
      trade: 'plumber',
      palette: { primary: '#0d3b66', accent: '#f4a261', source: 'logo' },
      description: 'Dad started this out of a ute in 1998 and I took it over.',
    })
    expect(resolved.resolved).toBe('established')
    expect(resolved.reason).toMatch(/family/i)
  })

  it('backs away from heavy blocks when the logo is pale', () => {
    const resolved = resolveDesignStyle({
      chosen: 'auto',
      trade: 'excavation',
      palette: { primary: '#f7e8c8', accent: '#e9d8a6', source: 'logo' },
      description: 'Earthworks and site prep.',
    })
    expect(resolved.resolved).not.toBe('industrial')
    expect(resolved.reason).toMatch(/pale/i)
  })

  it('records why, and the reasoning stays off the page', () => {
    const fixture = makeFixture({ designStyle: 'auto' })
    expect(fixture.plan.style.chosen).toBe('auto')
    expect(fixture.plan.style.reason.length).toBeGreaterThan(10)
    // The customer asked us to pick, not to explain ourselves.
    expect(fixture.html).not.toContain(fixture.plan.style.reason)
    expect(fixture.html).not.toContain('Chosen for them')
  })
})

describe('the style spec itself', () => {
  it('every named style has a complete spec', () => {
    for (const style of NAMED_STYLES) {
      const spec = styleSpec(style)
      expect(spec.fontsQuery).toBeTruthy()
      expect(spec.scale.h1).toBeTruthy()
      expect(spec.spacing.sectionDesktop).toBeTruthy()
      expect(spec.feel.length).toBeGreaterThan(20)
    }
  })

  it('only requests fonts it actually uses', () => {
    for (const style of NAMED_STYLES) {
      const spec = styleSpec(style)
      const families = [...spec.fontsQuery.matchAll(/family=([^:&]+)/g)].map((m) =>
        m[1]!.replace(/\+/g, ' '),
      )
      for (const family of families) {
        const used = `${spec.headingFamily} ${spec.bodyFamily}`.includes(family)
        expect(used, `${style} loads ${family} without using it`).toBe(true)
      }
    }
  })
})
