import type { Trade } from './trades'

/**
 * Design styles.
 *
 * The customer picks how their site should feel. This is the one place in the product where they
 * get to express taste, so it has to actually change the output: typography scale, section
 * density, corner radii, shadow weight, header treatment and hero composition all come from here.
 * A style that only swapped a font would be a lie.
 *
 * WHAT STYLE DOES NOT CONTROL: hue. The palette is sampled from the customer's logo and stays
 * theirs. Style decides how those colours are used, never what they are. See `resolveSurfaces`
 * for the one place the two interact, and how it is resolved when they disagree.
 *
 * COPY IS NOT APPROVED. The labels and descriptions below are a proposal and need Chris's sign
 * off before a customer sees them. See DECISIONS.md D28.
 */

export const DESIGN_STYLES = ['industrial', 'modern', 'established', 'refined', 'auto'] as const
export type DesignStyleId = (typeof DESIGN_STYLES)[number]

/** The four real styles. `auto` is a request for us to choose, not a style in itself. */
export const NAMED_STYLES = ['industrial', 'modern', 'established', 'refined'] as const
export type NamedStyleId = (typeof NAMED_STYLES)[number]

export interface DesignStyleOption {
  id: DesignStyleId
  /** DRAFT COPY, pending approval. */
  label: string
  /** DRAFT COPY, pending approval. */
  blurb: string
  /** Trades this style tends to suit. Drives the soft suggestion, never a restriction. */
  suits: Trade[]
  recommended?: boolean
}

export const DESIGN_STYLE_OPTIONS: DesignStyleOption[] = [
  {
    id: 'industrial',
    label: 'Bold and industrial',
    blurb: 'Heavy condensed type, dark surfaces, high contrast, chunky blocks.',
    suits: ['excavation', 'concreter', 'fencing'],
  },
  {
    id: 'modern',
    label: 'Clean and modern',
    blurb: 'Light and airy, generous whitespace, crisp type, restrained.',
    suits: ['electrician', 'hvac', 'plumber'],
  },
  {
    id: 'established',
    label: 'Warm and established',
    blurb: 'Warmer neutrals, a serif for headings, softer edges, family business feel.',
    suits: ['builder', 'landscaper', 'painter', 'tiler'],
  },
  {
    id: 'refined',
    label: 'Premium and refined',
    blurb: 'Restrained, wide spacing, smaller type set with more room around it.',
    suits: [],
  },
  {
    id: 'auto',
    label: 'Not sure, pick for me',
    blurb: 'We will choose the one that suits your trade and your logo. Most people pick this.',
    suits: [],
    recommended: true,
  },
]

/** Suggested style per trade. A hint in the UI, never a preselection and never a lock. */
export const TRADE_STYLE_SUGGESTION: Record<Trade, NamedStyleId> = {
  excavation: 'industrial',
  concreter: 'industrial',
  fencing: 'industrial',
  roofer: 'industrial',
  electrician: 'modern',
  hvac: 'modern',
  plumber: 'modern',
  pest: 'modern',
  builder: 'established',
  landscaper: 'established',
  painter: 'established',
  tiler: 'established',
  other: 'modern',
}

// ---------------------------------------------------------------------------------------------
// The concrete design values
// ---------------------------------------------------------------------------------------------

export type HeaderTreatment = 'solid-heavy' | 'transparent-light' | 'solid-warm' | 'minimal-thin'
export type HeroComposition = 'stacked-block' | 'split-card' | 'centred-panel' | 'quiet-wide'
export type CardTreatment = 'blocked' | 'soft' | 'warm' | 'hairline'
export type SurfaceMode = 'dark' | 'light' | 'warm' | 'pale'

/**
 * Everything a style decides, as values rather than adjectives.
 *
 * These are consumed directly by the site renderer and are also read out to the model as a
 * directive, so the offline fixture and a real build make the same decisions.
 */
export interface StyleSpec {
  id: NamedStyleId
  /** Google Fonts query, the only external request a generated site makes. */
  fontsQuery: string
  headingFamily: string
  bodyFamily: string
  headingWeight: number
  headingTransform: 'uppercase' | 'none'
  headingTracking: string
  /** clamp() values for the h1 through h3 scale. */
  scale: { h1: string; h2: string; h3: string; body: string; lead: string }
  /** Section rhythm. Density is most of what separates these styles at a glance. */
  spacing: { sectionMobile: string; sectionDesktop: string; gap: string; measure: string }
  radius: { card: string; button: string; input: string }
  shadow: { card: string; raised: string; hover: string }
  border: { hairline: string; strong: string }
  header: HeaderTreatment
  hero: HeroComposition
  card: CardTreatment
  /** Which surface the alternating sections use. */
  altSurface: SurfaceMode
  /** Whether the hero sits on a dark ground. */
  heroSurface: SurfaceMode
  buttonTransform: 'uppercase' | 'none'
  buttonTracking: string
  eyebrowTracking: string
  /** A one-line summary used in the prompt directive. */
  feel: string
}

export const STYLE_SPECS: Record<NamedStyleId, StyleSpec> = {
  industrial: {
    id: 'industrial',
    fontsQuery: 'family=Barlow+Condensed:wght@600;700;800&family=Inter:wght@400;500;600;700',
    headingFamily: '"Barlow Condensed", Impact, sans-serif',
    bodyFamily: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
    headingWeight: 800,
    headingTransform: 'uppercase',
    headingTracking: '0.01em',
    scale: {
      h1: 'clamp(2.9rem, 1.8rem + 5vw, 5.4rem)',
      h2: 'clamp(2.1rem, 1.5rem + 2.6vw, 3.4rem)',
      h3: '1.35rem',
      body: '1.0625rem',
      lead: '1.2rem',
    },
    // Tight and blocky: sections butt into each other rather than floating.
    spacing: { sectionMobile: '3.5rem', sectionDesktop: '5rem', gap: '1rem', measure: '68ch' },
    radius: { card: '0px', button: '0px', input: '0px' },
    shadow: {
      card: 'none',
      raised: '10px 10px 0 var(--shadow-hard)',
      hover: '14px 14px 0 var(--shadow-hard)',
    },
    border: { hairline: '2px', strong: '4px' },
    header: 'solid-heavy',
    hero: 'stacked-block',
    card: 'blocked',
    altSurface: 'dark',
    heroSurface: 'dark',
    buttonTransform: 'uppercase',
    buttonTracking: '0.06em',
    eyebrowTracking: '0.2em',
    feel: 'heavy, high contrast, built out of solid blocks with hard edges and no rounding',
  },

  modern: {
    id: 'modern',
    fontsQuery: 'family=Inter:wght@400;500;600;700',
    headingFamily: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
    bodyFamily: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
    headingWeight: 600,
    headingTransform: 'none',
    headingTracking: '-0.02em',
    scale: {
      h1: 'clamp(2.4rem, 1.6rem + 3.4vw, 4rem)',
      h2: 'clamp(1.8rem, 1.4rem + 1.8vw, 2.6rem)',
      h3: '1.2rem',
      body: '1.0625rem',
      lead: '1.15rem',
    },
    spacing: { sectionMobile: '4.5rem', sectionDesktop: '7rem', gap: '1.5rem', measure: '62ch' },
    radius: { card: '16px', button: '10px', input: '10px' },
    shadow: {
      card: '0 1px 2px var(--shadow-soft)',
      raised: '0 12px 32px var(--shadow-soft)',
      hover: '0 18px 44px var(--shadow-medium)',
    },
    border: { hairline: '1px', strong: '1px' },
    header: 'transparent-light',
    hero: 'split-card',
    card: 'soft',
    altSurface: 'pale',
    heroSurface: 'dark',
    buttonTransform: 'none',
    buttonTracking: '0',
    eyebrowTracking: '0.14em',
    feel: 'light and uncluttered, generous whitespace, soft corners and quiet shadows',
  },

  established: {
    id: 'established',
    fontsQuery: 'family=Lora:wght@500;600;700&family=Inter:wght@400;500;600',
    headingFamily: 'Lora, Georgia, "Times New Roman", serif',
    bodyFamily: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
    headingWeight: 600,
    headingTransform: 'none',
    headingTracking: '-0.01em',
    scale: {
      h1: 'clamp(2.3rem, 1.6rem + 3vw, 3.7rem)',
      h2: 'clamp(1.75rem, 1.35rem + 1.7vw, 2.5rem)',
      h3: '1.25rem',
      body: '1.09rem',
      lead: '1.18rem',
    },
    spacing: { sectionMobile: '4rem', sectionDesktop: '6rem', gap: '1.35rem', measure: '65ch' },
    radius: { card: '10px', button: '999px', input: '10px' },
    shadow: {
      card: '0 2px 6px var(--shadow-soft)',
      raised: '0 10px 26px var(--shadow-soft)',
      hover: '0 14px 34px var(--shadow-medium)',
    },
    border: { hairline: '1px', strong: '2px' },
    header: 'solid-warm',
    hero: 'centred-panel',
    card: 'warm',
    altSurface: 'warm',
    heroSurface: 'dark',
    buttonTransform: 'none',
    buttonTracking: '0.01em',
    eyebrowTracking: '0.16em',
    feel: 'warm and settled, a serif for headings, rounded edges, the feel of a family business',
  },

  refined: {
    id: 'refined',
    fontsQuery: 'family=Jost:wght@300;400;500&family=Inter:wght@300;400;500',
    headingFamily: 'Jost, "Helvetica Neue", system-ui, sans-serif',
    bodyFamily: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
    headingWeight: 400,
    headingTransform: 'uppercase',
    // Smaller type, much more room around and between the letters.
    headingTracking: '0.16em',
    scale: {
      h1: 'clamp(1.7rem, 1.3rem + 1.8vw, 2.6rem)',
      h2: 'clamp(1.25rem, 1.05rem + 0.9vw, 1.75rem)',
      h3: '1rem',
      body: '1rem',
      lead: '1.05rem',
    },
    // The most generous rhythm of the four, and a narrower measure.
    spacing: { sectionMobile: '5.5rem', sectionDesktop: '9rem', gap: '2rem', measure: '54ch' },
    radius: { card: '2px', button: '2px', input: '2px' },
    shadow: { card: 'none', raised: 'none', hover: '0 6px 18px var(--shadow-soft)' },
    border: { hairline: '1px', strong: '1px' },
    header: 'minimal-thin',
    hero: 'quiet-wide',
    card: 'hairline',
    altSurface: 'pale',
    heroSurface: 'dark',
    buttonTransform: 'uppercase',
    buttonTracking: '0.18em',
    eyebrowTracking: '0.3em',
    feel: 'understated and spacious, small type set with wide letter spacing, almost no ornament',
  },
}

export function styleOption(id: DesignStyleId): DesignStyleOption {
  return DESIGN_STYLE_OPTIONS.find((o) => o.id === id) ?? DESIGN_STYLE_OPTIONS[4]!
}

export function styleSpec(id: NamedStyleId): StyleSpec {
  return STYLE_SPECS[id]
}

// ---------------------------------------------------------------------------------------------
// Choosing on the customer's behalf
// ---------------------------------------------------------------------------------------------

export interface ResolvedStyle {
  /** What the customer picked, including 'auto'. */
  chosen: DesignStyleId
  /** The style actually being built. */
  resolved: NamedStyleId
  /** Why, when we chose. Internal only: never shown to the customer. */
  reason: string
  /** Anything the style wanted that the customer's palette would not allow. */
  constraints: string[]
}

function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function saturation(hex: string): number {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max === min) return 0
  const l = (max + min) / 2
  return l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min)
}

/**
 * Pick a style when the customer said "not sure".
 *
 * Trade first, because it is the strongest signal and it is the one the customer would recognise
 * if they ever asked. Then the logo, which can override: a very dark, unsaturated mark on a
 * plumber points at industrial more than the trade does, and a pale, low-contrast mark does not
 * survive the industrial treatment. The description is the tiebreaker.
 *
 * The reasoning is recorded on the plan and never shown to the customer. They asked us to pick,
 * not to explain ourselves.
 */
export function resolveDesignStyle(args: {
  chosen: DesignStyleId | undefined
  trade: Trade
  palette: { primary: string; accent: string; source: 'logo' | 'manual' | 'default' }
  description: string
}): ResolvedStyle {
  const chosen = args.chosen ?? 'auto'

  if (chosen !== 'auto') {
    return {
      chosen,
      resolved: chosen,
      reason: 'Chosen by the customer.',
      constraints: constraintsFor(chosen, args.palette),
    }
  }

  const fromTrade = TRADE_STYLE_SUGGESTION[args.trade]
  const reasons: string[] = [`trade is ${args.trade}, which suggests ${fromTrade}`]
  let resolved: NamedStyleId = fromTrade

  const primaryLuminance = luminance(args.palette.primary)
  const primarySaturation = saturation(args.palette.primary)

  // A dark, punchy mark carries the industrial treatment even on a trade that usually would not.
  if (primaryLuminance < 0.12 && primarySaturation < 0.25 && resolved !== 'industrial') {
    resolved = 'industrial'
    reasons.push('logo is very dark and nearly neutral, which suits the heavy treatment')
  }

  // A pale mark disappears against heavy dark blocks, so back away from industrial.
  if (primaryLuminance > 0.55 && resolved === 'industrial') {
    resolved = 'modern'
    reasons.push('logo is pale, which would be lost against heavy dark blocks')
  }

  // Language in their own words. "Family", "generations", "since 19xx" reads established.
  const text = args.description.toLowerCase()
  if (/\b(family|dad|father|generation|grandfather|since 19|three decades|traditional)\b/.test(text)) {
    if (resolved === 'modern') {
      resolved = 'established'
      reasons.push('the description reads like a long-running family business')
    }
  }
  if (/\b(luxury|high end|architectural|bespoke|custom home|prestige|premium)\b/.test(text)) {
    resolved = 'refined'
    reasons.push('the description describes high end work')
  }

  return {
    chosen: 'auto',
    resolved,
    reason: `Chosen for them: ${reasons.join('; ')}.`,
    constraints: constraintsFor(resolved, args.palette),
  }
}

/**
 * Where style and palette disagree, the palette wins.
 *
 * A style can ask for dark surfaces, but it cannot invent a colour to make them out of, and it
 * cannot decide the customer's brand is the wrong colour. When the sampled palette will not carry
 * the treatment, the treatment gives way and the reason is recorded on the plan.
 */
export function constraintsFor(
  style: NamedStyleId,
  palette: { primary: string; accent: string; source: 'logo' | 'manual' | 'default' },
): string[] {
  const constraints: string[] = []
  const spec = STYLE_SPECS[style]

  if (spec.heroSurface === 'dark' || spec.altSurface === 'dark') {
    if (luminance(palette.primary) > 0.45) {
      // Deliberately does not promise which way it lands. The plan is written before the colour
      // tokens are settled, and a deepened version of the sampled hue is preferred over the
      // neutral wherever it is readable, because the logo wins over the style. The renderer
      // records which of the two actually happened.
      constraints.push(
        `The ${style} style puts white text on large blocks of the brand colour, and the colour sampled from this logo is too light to carry it. The hue does not change: a deeper shade of it is used behind white text, and if that is still not readable the neutral dark is used instead and the brand colour is kept for accents.`,
      )
    }
  }

  if (style === 'industrial' && saturation(palette.accent) < 0.15) {
    constraints.push(
      'The industrial style leans on a strong accent for contrast, and this logo has no saturated second colour, so the accent is a tint of the primary rather than a separate hue.',
    )
  }

  if (palette.source === 'default') {
    constraints.push(
      'No logo colours were available, so the palette is our neutral default. The style still applies in full.',
    )
  }

  return constraints
}

/**
 * Does this palette support the style's dark treatment?
 *
 * Read by the renderer to decide whether to use the brand colour or the neutral dark for large
 * dark areas. Same rule as `constraintsFor`, in one place so they cannot drift apart.
 */
export function paletteCarriesDarkSurfaces(palette: { primary: string }): boolean {
  return luminance(palette.primary) <= 0.45
}

/**
 * The style as instructions for the model.
 *
 * Concrete values, not adjectives, because "premium" means nothing to a generator that has to
 * decide a padding value. Goes in the user message rather than the cached house-rules prefix, so
 * the prompt cache is not invalidated per style.
 */
export function styleDirective(spec: StyleSpec): string {
  return `# DESIGN STYLE: ${spec.id.toUpperCase()}

Overall feel: ${spec.feel}.

Typography
  Headings: ${spec.headingFamily}, weight ${spec.headingWeight}, ${spec.headingTransform === 'uppercase' ? 'UPPERCASE' : 'sentence case'}, letter-spacing ${spec.headingTracking}
  Body: ${spec.bodyFamily} at ${spec.scale.body}
  h1 ${spec.scale.h1}
  h2 ${spec.scale.h2}
  h3 ${spec.scale.h3}
  Google Fonts query to use: ${spec.fontsQuery}

Density and rhythm
  Section padding: ${spec.spacing.sectionMobile} on mobile, ${spec.spacing.sectionDesktop} on desktop
  Gap between grid items: ${spec.spacing.gap}
  Reading measure: ${spec.spacing.measure}

Shape
  Card radius ${spec.radius.card}, button radius ${spec.radius.button}, input radius ${spec.radius.input}
  Card shadow: ${spec.shadow.card}
  Raised shadow: ${spec.shadow.raised}
  Border widths: ${spec.border.hairline} hairline, ${spec.border.strong} strong

Header treatment: ${describeHeader(spec.header)}
Hero composition: ${describeHero(spec.hero)}
Cards: ${describeCard(spec.card)}
Buttons: ${spec.buttonTransform === 'uppercase' ? 'UPPERCASE' : 'sentence case'}, letter-spacing ${spec.buttonTracking}
Eyebrow labels: letter-spacing ${spec.eyebrowTracking}

THIS STYLE CONTROLS LAYOUT, TYPE, DENSITY AND TREATMENT ONLY. It does not change a single colour.
The palette comes from the customer's logo and is already fixed in the plan's tokens. Use those
tokens and no others, and keep every colour in the :root block as the house rules require.`
}

function describeHeader(treatment: HeaderTreatment): string {
  switch (treatment) {
    case 'solid-heavy':
      return 'solid and dark from the top of the page, with a thick bottom border. Not transparent over the hero.'
    case 'transparent-light':
      return 'transparent over the hero, turning solid with a hairline border once the page scrolls past 60px.'
    case 'solid-warm':
      return 'solid in the warm surface colour from the top, with a soft bottom border.'
    case 'minimal-thin':
      return 'very thin and transparent, with wide letter-spaced nav links and no border until scrolled.'
  }
}

function describeHero(composition: HeroComposition): string {
  switch (composition) {
    case 'stacked-block':
      return 'full width photo with a heavy dark scrim, an oversized left-aligned h1 stacked above the trust points, and the quote form as a hard-edged block below the copy rather than beside it.'
    case 'split-card':
      return 'two columns on desktop: copy on the left, the quote form as a rounded raised card on the right.'
    case 'centred-panel':
      return 'centred copy over a warm overlay, with the quote form in a rounded panel underneath, centred and narrower than the copy.'
    case 'quiet-wide':
      return 'a lot of empty space, small centred heading with wide letter-spacing, one thin rule under it, and the quote form kept small and understated below the fold of the hero.'
  }
}

function describeCard(treatment: CardTreatment): string {
  switch (treatment) {
    case 'blocked':
      return 'solid blocks with thick borders, square corners and an offset hard shadow on hover.'
    case 'soft':
      return 'white cards with a hairline border, rounded corners and a soft shadow that deepens on hover.'
    case 'warm':
      return 'cards on the warm surface tone with rounded corners and a gentle shadow.'
    case 'hairline':
      return 'no card at all: items separated by hairline rules with generous space, no shadow and no fill.'
  }
}
