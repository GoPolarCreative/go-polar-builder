import type { Trade } from './trades.js'

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

export const DESIGN_STYLES = ['industrial', 'modern', 'established', 'direct', 'auto'] as const
export type DesignStyleId = (typeof DESIGN_STYLES)[number]

/** The four real styles. `auto` is a request for us to choose, not a style in itself. */
export const NAMED_STYLES = ['industrial', 'modern', 'established', 'direct'] as const
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
    label: 'Heavy and industrial',
    blurb: 'Near black throughout, big condensed capitals, one bright accent. Reads as plant and machinery.',
    suits: ['excavation', 'concreter', 'fencing'],
  },
  {
    id: 'modern',
    label: 'Clean and modern',
    blurb: 'Light and roomy, tight modern type, soft rounded cards. Reads as organised and current.',
    suits: ['electrician', 'hvac', 'plumber'],
  },
  {
    id: 'established',
    label: 'Warm and established',
    blurb: 'Cream and white sections under a deep header, sentence case headings, gold detailing. Reads as settled and premium.',
    suits: ['builder', 'landscaper', 'painter', 'tiler'],
  },
  {
    id: 'direct',
    label: 'Bold and direct',
    blurb: 'Strong colour, everything centred, capitals and hard contrast. Reads as fast, available and easy to ring.',
    suits: ['roofer', 'pest'],
  },
  {
    id: 'auto',
    label: 'Most popular',
    blurb: 'You decide for me. We pick the layout that suits your trade and your logo. Most people choose this.',
    suits: [],
    recommended: true,
  },
]

/** Suggested style per trade. A hint in the UI, never a preselection and never a lock. */
export const TRADE_STYLE_SUGGESTION: Record<Trade, NamedStyleId> = {
  excavation: 'industrial',
  concreter: 'industrial',
  fencing: 'industrial',
  roofer: 'direct',
  electrician: 'modern',
  hvac: 'modern',
  plumber: 'modern',
  pest: 'direct',
  builder: 'established',
  landscaper: 'established',
  painter: 'established',
  tiler: 'established',
  other: 'modern',
}

// ---------------------------------------------------------------------------------------------
// The concrete design values
// ---------------------------------------------------------------------------------------------

export type HeaderTreatment = 'solid-dark' | 'solid-warm' | 'transparent-dark'
export type CardTreatment = 'outlined-dark' | 'soft-light' | 'warm-bordered' | 'flat-tinted'
export type SurfaceMode = 'dark' | 'light' | 'warm' | 'pale'
/** How the section backgrounds alternate down the page. */
export type Rhythm = 'alternating-light' | 'dark-on-dark' | 'navy-and-white'
/** Where the eyebrow and heading sit at the top of a section. */
export type HeadingAlign = 'left' | 'centred'
/** The faint figure on a numbered card. */
export type NumberTreatment = 'corner-small' | 'large-faint' | 'none'

/**
 * Everything a style decides, as values rather than adjectives.
 *
 * EVERY NUMBER HERE CAME OFF A REAL SITE. These four specs are measurements taken from four sites
 * Chris built by hand, read out of the live CSS rather than guessed from a screenshot:
 *
 *   industrial  -> naarmearthmoving.com.au    Bebas Neue on near-black, cyan, dark on dark
 *   direct      -> summithvacr.com.au         navy and red, centred caps, high contrast
 *   established -> gildonconstructions.com.au navy, gold and cream, sentence case, alternating
 *   modern      -> turquoiseplumbing.com.au   Space Grotesk, light and generous, two-tone
 *
 * THE SKELETON USED TO BE FIXED, AND IS NOT ANY MORE. The original reading of those four sites
 * was that they run the same sections in the same order, so style was palette, heading case and
 * density only: one renderer, four treatments, recorded as DECISIONS.md D40.
 *
 * That was true of the reference sites and wrong as a product. Four skins on one skeleton meant
 * a customer choosing "the look of your site" was choosing a typeface, and the four previews
 * looked like the same website four times. Each spec now carries a LayoutSpec: which sections
 * appear, in what order, which of three heroes, and whether the dark bands hold still while the
 * page scrolls. D40 is reversed; see the note there.
 */
/**
 * The sections a page is built from, in no particular order: the order is the style's business.
 *
 * 'quote' is the hero's form card standing on its own. A style whose hero has no form still has
 * to have two forms on the page, because checks/static.ts form_action requires it and because one
 * form at the very bottom is a worse site. So the card is not deleted, it is moved.
 */
export const SECTION_KEYS = [
  'trust',
  'about',
  'services',
  'quote',
  'work',
  'why',
  'stats',
  'process',
  'areas',
  'reviews',
  'faq',
  'contact',
] as const
export type SectionKey = (typeof SECTION_KEYS)[number]

/**
 * The structural half of a style.
 *
 * WHY THIS EXISTS. Until now a StyleSpec was fonts, spacing, radius and surfaces, and the eleven
 * body sections were hardcoded in one fixed order. Four styles meant one page in four skins, and
 * a customer choosing "the look of your site" was choosing a typeface. This is the part that
 * actually changes the shape.
 */
export interface LayoutSpec {
  /**
   * Whether the quote form card sits inside the hero. False moves it to its own 'quote' section,
   * placed wherever the order puts it, and gives the hero back to the headline and the photo.
   */
  heroForm: boolean
  /**
   * split    copy left, form or photo right. The busy, everything-above-the-fold hero.
   * centred  one column, centred, CTAs under the headline. Nothing competing with the h1.
   * editorial  copy over a full-bleed photo with a wide bottom margin. Quietest of the three.
   */
  hero: 'split' | 'centred' | 'editorial'
  /**
   * Fixed-attachment backgrounds on the dark bands. Switched off under prefers-reduced-motion and
   * on touch, where iOS has never supported it and renders a jumping, badly cropped image.
   */
  parallax: boolean
  /** Which sections appear, and in what order. */
  order: SectionKey[]
  /**
   * How a tinted section meets the one above and below it.
   *
   * 'soft' fades the ground in and out over about 56px, so the page reads as one surface. 'hard'
   * leaves the edge, which is what a heavy, high-contrast style is for. Applying soft everywhere
   * made the four styles measurably more alike, and test/styles.test.ts said so.
   */
  sectionJoin: 'soft' | 'hard'
}

export interface StyleSpec {
  id: NamedStyleId
  layout: LayoutSpec
  /** The site this was measured from, so a future change can go and look again. */
  reference: string
  /** Google Fonts query, the only external request a generated site makes. */
  fontsQuery: string
  headingFamily: string
  bodyFamily: string
  /*
   * THE FACE THE PAYOFF PHRASE OF A HEADING SWITCHES TO.
   *
   * twoTone wraps the tail of a heading in <em>, and that used to be recoloured and nothing else,
   * which reads as a highlighter rather than as typography. What makes the reference builds look
   * designed is that the face CHANGES mid-heading: Driftwood runs "Solid work." in its sans and
   * "Beautifully" in a serif italic underneath.
   *
   * Each style gets its own answer, so the device reads as that style's rather than as one trick
   * applied four times.
   */
  accentFamily: string
  accentStyle: 'normal' | 'italic'
  accentWeight: number
  accentTracking: string
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
  card: CardTreatment
  rhythm: Rhythm
  headingAlign: HeadingAlign
  cardNumber: NumberTreatment
  /**
   * The payoff phrase of a heading set in the accent colour. Turquoise runs it on nearly every
   * section, Gildon and Summit run it in the hero. It is the single most recognisable device the
   * four have in common, so three of the four styles use it.
   */
  twoTone: boolean
  /** The full-width stat band under the dark section. */
  statBand: 'accent' | 'dark'
  /** Alpha stops for the hero photo overlay, left to right. Darker on the copy side. */
  /**
   * The three stops of the dark gradient over the hero photo, left to right.
   *
   * LOWERED ACROSS ALL FOUR STYLES. They were tuned for guaranteed contrast against a photo
   * we had never seen, and the result was a hero where the photograph the customer supplied
   * was barely visible under it. The first stop still sits at or above 0.64, which is where
   * white body text stays comfortably readable over a mid tone photo, and the last stop drops
   * far enough that the right hand side of the image reads as a photograph.
   */
  heroOverlay: [number, number, number]
  /** Which surface the alternating sections use. */
  altSurface: SurfaceMode
  /** Whether the hero sits on a dark ground. */
  heroSurface: SurfaceMode
  buttonTransform: 'uppercase' | 'none'
  buttonTracking: string
  eyebrowTracking: string
  eyebrowSize: string
  /** A one-line summary used in the prompt directive. */
  feel: string
}

export const STYLE_SPECS: Record<NamedStyleId, StyleSpec> = {
  // naarmearthmoving.com.au. Near-black on near-black, one cold accent, condensed caps shouting.
  industrial: {
    id: 'industrial',
    // Plant and machinery. The headline gets the hero to itself over a full-bleed photo, the
    // work comes before the talking, and the dark bands hold still while the page moves over
    // them. About is near the bottom: this style sells the jobs, not the founder.
    layout: {
      hero: 'centred',
      heroForm: false,
      parallax: true,
      order: ['trust', 'services', 'work', 'why', 'quote', 'process', 'areas', 'reviews', 'faq', 'about', 'contact'],
      sectionJoin: 'hard',
    },
    reference: 'naarmearthmoving.com.au',
    accentFamily: 'Poppins, system-ui, sans-serif',
    accentStyle: 'italic',
    accentWeight: 700,
    accentTracking: '-0.01em',
    fontsQuery: 'family=Bebas+Neue&family=Poppins:wght@300;400;500;600;700',
    headingFamily: '"Bebas Neue", Impact, sans-serif',
    bodyFamily: 'Poppins, system-ui, -apple-system, "Segoe UI", sans-serif',
    headingWeight: 400,
    headingTransform: 'none',
    // Bebas is already caps. Positive tracking opens it up rather than closing it down.
    headingTracking: '0.04em',
    scale: {
      h1: 'clamp(3rem, 1.9rem + 5.2vw, 5.5rem)',
      h2: 'clamp(2.5rem, 1.8rem + 3vw, 4rem)',
      h3: '1.35rem',
      body: '1rem',
      lead: '1rem',
    },
    spacing: { sectionMobile: '4.5rem', sectionDesktop: '6.5rem', gap: '1.5rem', measure: '68ch' },
    radius: { card: '0px', button: '0px', input: '0px' },
    shadow: { card: 'none', raised: 'none', hover: 'none' },
    border: { hairline: '1px', strong: '1px' },
    header: 'solid-dark',
    card: 'outlined-dark',
    rhythm: 'dark-on-dark',
    headingAlign: 'centred',
    cardNumber: 'none',
    twoTone: false,
    statBand: 'dark',
    heroOverlay: [0.7, 0.54, 0.3],
    altSurface: 'dark',
    heroSurface: 'dark',
    buttonTransform: 'uppercase',
    buttonTracking: '0.06em',
    eyebrowTracking: '0.05em',
    eyebrowSize: '0.78rem',
    feel: 'near-black throughout, one cold accent, heavy condensed capitals, cards outlined in thin accent rules on dark',
  },

  // summithvacr.com.au. Navy and a hot accent, everything centred, high contrast, consumer trade.
  direct: {
    id: 'direct',
    // Fast and easy to ring. Centred hero with the form right under the headline, then services
    // and a second form almost immediately. Somebody who wants a plumber now should not have to
    // scroll past a founder story to find the box.
    layout: {
      hero: 'centred',
      heroForm: true,
      parallax: true,
      order: ['trust', 'services', 'quote', 'work', 'reviews', 'why', 'about', 'process', 'areas', 'faq', 'contact'],
      sectionJoin: 'hard',
    },
    reference: 'summithvacr.com.au',
    accentFamily: 'Poppins, system-ui, sans-serif',
    accentStyle: 'italic',
    accentWeight: 700,
    accentTracking: '-0.01em',
    fontsQuery: 'family=Oswald:wght@500;600;700&family=Poppins:wght@400;500;600;700',
    headingFamily: 'Oswald, "Arial Narrow", sans-serif',
    bodyFamily: 'Poppins, system-ui, -apple-system, "Segoe UI", sans-serif',
    headingWeight: 700,
    headingTransform: 'uppercase',
    headingTracking: '0.01em',
    scale: {
      h1: 'clamp(2.6rem, 1.7rem + 4.4vw, 4.6rem)',
      h2: 'clamp(2rem, 1.5rem + 2.4vw, 3.1rem)',
      h3: '1.15rem',
      body: '1rem',
      lead: '1.1rem',
    },
    spacing: { sectionMobile: '4rem', sectionDesktop: '5.5rem', gap: '1.25rem', measure: '64ch' },
    radius: { card: '10px', button: '6px', input: '6px' },
    shadow: {
      card: '0 2px 10px var(--shadow-soft)',
      raised: '0 10px 30px var(--shadow-medium)',
      hover: '0 16px 38px var(--shadow-medium)',
    },
    border: { hairline: '1px', strong: '2px' },
    header: 'solid-dark',
    card: 'flat-tinted',
    rhythm: 'navy-and-white',
    headingAlign: 'centred',
    cardNumber: 'none',
    twoTone: true,
    statBand: 'accent',
    heroOverlay: [0.66, 0.56, 0.4],
    altSurface: 'dark',
    heroSurface: 'dark',
    buttonTransform: 'uppercase',
    buttonTracking: '0.04em',
    eyebrowTracking: '0.18em',
    eyebrowSize: '0.7rem',
    feel: 'navy and a hot accent, centred capitals, strong contrast, the payoff line of a heading in the accent colour',
  },

  // gildonconstructions.com.au. Navy, gold and cream, sentence case, alternating light sections.
  established: {
    id: 'established',
    // Settled and premium. An editorial hero with no form on it at all, then the reviews third,
    // because this style is selling reputation before it sells a service list. Nothing moves.
    layout: {
      hero: 'editorial',
      heroForm: false,
      parallax: true,
      order: ['trust', 'about', 'reviews', 'services', 'quote', 'work', 'why', 'process', 'areas', 'faq', 'contact'],
      sectionJoin: 'soft',
    },
    reference: 'gildonconstructions.com.au',
    accentFamily: '"Playfair Display", Georgia, "Times New Roman", serif',
    accentStyle: 'italic',
    accentWeight: 500,
    accentTracking: '0',
    fontsQuery: 'family=Playfair+Display:ital,wght@1,500&family=Poppins:wght@400;500;600;700;800',
    headingFamily: 'Poppins, system-ui, -apple-system, "Segoe UI", sans-serif',
    bodyFamily: 'Poppins, system-ui, -apple-system, "Segoe UI", sans-serif',
    headingWeight: 700,
    headingTransform: 'none',
    headingTracking: '-0.005em',
    scale: {
      h1: 'clamp(2rem, 1.4rem + 3vw, 3.25rem)',
      h2: 'clamp(1.6rem, 1.25rem + 1.9vw, 2.5rem)',
      h3: '1.05rem',
      body: '1rem',
      lead: '1.05rem',
    },
    spacing: { sectionMobile: '3.5rem', sectionDesktop: '5rem', gap: '1.5rem', measure: '64ch' },
    radius: { card: '6px', button: '6px', input: '6px' },
    shadow: {
      card: '0 4px 24px var(--shadow-soft)',
      raised: '0 12px 48px var(--shadow-medium)',
      hover: '0 12px 48px var(--shadow-medium)',
    },
    border: { hairline: '1px', strong: '1px' },
    header: 'transparent-dark',
    card: 'warm-bordered',
    rhythm: 'alternating-light',
    headingAlign: 'left',
    cardNumber: 'large-faint',
    twoTone: true,
    statBand: 'accent',
    heroOverlay: [0.64, 0.44, 0.26],
    altSurface: 'warm',
    heroSurface: 'dark',
    buttonTransform: 'none',
    buttonTracking: '0.01em',
    eyebrowTracking: '0.12em',
    eyebrowSize: '0.75rem',
    feel: 'navy with a gold accent over cream and white, sentence case headings, alternating light sections, quiet and settled',
  },

  // turquoiseplumbing.com.au. Light and generous, Space Grotesk, the two-tone device everywhere.
  modern: {
    id: 'modern',
    // The busy one, and the only one that keeps the form in the hero. Everything above the
    // fold: headline, trust points and a form you can start filling without scrolling.
    layout: {
      hero: 'split',
      heroForm: true,
      parallax: true,
      order: ['trust', 'about', 'services', 'work', 'why', 'process', 'areas', 'reviews', 'faq', 'contact'],
      sectionJoin: 'soft',
    },
    reference: 'turquoiseplumbing.com.au',
    accentFamily: '"Playfair Display", Georgia, serif',
    accentStyle: 'italic',
    accentWeight: 500,
    accentTracking: '0',
    fontsQuery: 'family=Playfair+Display:ital,wght@1,500&family=Space+Grotesk:wght@500;600;700&family=DM+Sans:wght@400;500;700',
    headingFamily: '"Space Grotesk", system-ui, sans-serif',
    bodyFamily: '"DM Sans", system-ui, -apple-system, "Segoe UI", sans-serif',
    headingWeight: 700,
    headingTransform: 'none',
    // The tightest tracking of the four, and the thing that makes it read as designed.
    headingTracking: '-0.055em',
    scale: {
      h1: 'clamp(2.9rem, 1.9rem + 4.6vw, 4.9rem)',
      h2: 'clamp(2.1rem, 1.6rem + 2.4vw, 3.2rem)',
      h3: '1.2rem',
      body: '1rem',
      lead: '1.125rem',
    },
    // The most generous rhythm of the four.
    spacing: { sectionMobile: '4.5rem', sectionDesktop: '7.5rem', gap: '1.5rem', measure: '62ch' },
    radius: { card: '18px', button: '10px', input: '10px' },
    shadow: {
      card: 'none',
      raised: '0 18px 55px var(--shadow-soft)',
      hover: '0 18px 55px var(--shadow-medium)',
    },
    border: { hairline: '1px', strong: '1px' },
    header: 'transparent-dark',
    card: 'soft-light',
    rhythm: 'alternating-light',
    headingAlign: 'left',
    cardNumber: 'corner-small',
    twoTone: true,
    statBand: 'accent',
    heroOverlay: [0.68, 0.52, 0.34],
    altSurface: 'pale',
    heroSurface: 'dark',
    buttonTransform: 'none',
    buttonTracking: '0',
    eyebrowTracking: '0.16em',
    eyebrowSize: '0.69rem',
    feel: 'light and generous, tightly tracked sentence case headings with the payoff line in the accent, soft deep-rounded cards',
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
    resolved = 'direct'
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
Cards: ${describeCard(spec.card)}
Section rhythm: ${describeRhythm(spec.rhythm)}
Section headings: ${spec.headingAlign === 'centred' ? 'eyebrow and heading centred, supporting line centred under it' : 'eyebrow and heading left aligned, supporting line in a column to the right or directly under'}
Card numbering: ${spec.cardNumber === 'large-faint' ? 'a large faint 01 02 03 04 above each card heading' : spec.cardNumber === 'corner-small' ? 'a small faint number in the top right corner of each card' : 'no numbers on cards'}
Two-tone headings: ${spec.twoTone ? 'YES. Wrap the payoff phrase of a heading in <em> so it renders in the accent colour. Do this on the h1 and on most section headings.' : 'NO. Headings are a single colour on this style.'}
Stat band: ${spec.statBand === 'accent' ? 'full width band in the accent colour, dark figures' : 'full width band in the dark colour, white figures'}
Buttons: ${spec.buttonTransform === 'uppercase' ? 'UPPERCASE' : 'sentence case'}, letter-spacing ${spec.buttonTracking}
Eyebrow labels: ${spec.eyebrowSize}, weight 700, letter-spacing ${spec.eyebrowTracking}, in the accent colour

THIS STYLE CONTROLS LAYOUT, TYPE, DENSITY AND TREATMENT ONLY. It does not change a single colour.
The palette comes from the customer's logo and is already fixed in the plan's tokens. Use those
tokens and no others, and keep every colour in the :root block as the house rules require.`
}

function describeHeader(treatment: HeaderTreatment): string {
  switch (treatment) {
    case 'solid-dark':
      return 'solid in the dark colour from the top of the page, never transparent over the hero.'
    case 'solid-warm':
      return 'solid in the warm surface colour from the top, with a soft bottom border.'
    case 'transparent-dark':
      return 'transparent over the hero, turning solid dark with a shadow once the page scrolls past 60px.'
  }
}

function describeRhythm(rhythm: Rhythm): string {
  switch (rhythm) {
    case 'dark-on-dark':
      return 'the whole page is dark. Sections alternate between the near black ground and a slightly lifted dark panel. No light sections at all.'
    case 'alternating-light':
      return 'white and a tinted light surface alternate down the page, broken up by two or three full width dark sections.'
    case 'navy-and-white':
      return 'hard alternation between white sections and full width dark sections, roughly every other one.'
  }
}

function describeCard(treatment: CardTreatment): string {
  switch (treatment) {
    case 'outlined-dark':
      return 'panels on the dark ground outlined with a thin accent coloured rule, square corners, no shadow.'
    case 'soft-light':
      return 'white cards with a hairline border and deep rounded corners, lifting on hover with a soft shadow.'
    case 'warm-bordered':
      return 'white cards with a hairline border and small radius, a soft shadow, sitting on the cream sections.'
    case 'flat-tinted':
      return 'white cards with a hairline border and a modest radius, flat until hovered.'
  }
}
