import type { BuildFacts, ContentPlan } from '../../../shared/plan.js'
import { headMetaTags } from './headMeta.js'
import {
  paletteCarriesDarkSurfaces,
  styleSpec,
  type SectionKey,
  type StyleSpec,
} from '../../../shared/styles.js'

/*
 * data-gp ATTRIBUTES. Every landmark below carries one, matching the vocabulary in
 * server/lib/sections.ts and the house rule the model is given. They are how an edit addresses a
 * single section instead of rewriting the document. Nothing styles them and nothing reads them at
 * runtime; removing one silently costs the fast edit path for that section.
 */

/**
 * The site renderer.
 *
 * Deterministic HTML from a content plan. Used by the offline fixture, by the sample site, and by
 * every test that needs a known-good document. The real product path builds this same structure
 * through the model, working from the same style directive.
 *
 * THE STYLE HAS TO SHOW. Typography scale, section density, corner radii, shadow weight, header
 * treatment, hero composition and card treatment all come from the chosen style. If two styles
 * produced the same page with a different font, the choice offered to the customer would be a
 * lie. test/styles.test.ts holds that down.
 *
 * THE STYLE NEVER TOUCHES HUE. Every colour comes from the palette sampled off the customer's
 * logo and is declared once in :root. Style decides where those colours go, never what they are.
 * Where a style wants something the palette cannot carry, the palette wins and the compromise is
 * recorded on the plan.
 */

export function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Strip anything the house rules ban from copy that came from a human. */
export function clean(text: string): string {
  return text.replace(/—/g, ', ').replace(/–/g, ' to ').replace(/\p{Extended_Pictographic}/gu, '')
}

export function icon(path: string): string {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`
}

export const ICON_TICK = '<polyline points="20 6 9 17 4 12"></polyline>'
export const ICON_PHONE =
  '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"></path>'
export const ICON_PIN =
  '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle>'
export const ICON_CLOCK = '<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>'
export const ICON_SHIELD = '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>'
export const ICON_TOOL =
  '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>'
export const ICON_MAIL =
  '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22 6 12 13 2 6"></polyline>'
export const ICON_CHEVRON = '<polyline points="6 9 12 15 18 9"></polyline>'
export const ICON_ARROW = '<line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline>'
export const ICON_STAR =
  '<polygon points="12 2 15.1 8.6 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.6 12 2" fill="currentColor" stroke="none"></polygon>'
/*
 * The Google G, drawn rather than fetched.
 *
 * No generated site makes an external image request, so the mark is inline. The four paths carry
 * classes instead of fill attributes because check 1 rejects a literal colour in an SVG attribute
 * and a presentation attribute cannot take a var() anyway. Used only to attribute reviews to the
 * profile they actually came from, beside a link to that profile.
 */
export const ICON_GOOGLE_G =
  '<path class="g-b" d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.44a5.5 5.5 0 0 1-2.39 3.62v3h3.86c2.26-2.09 3.58-5.17 3.58-8.86z"></path>' +
  '<path class="g-g" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24z"></path>' +
  '<path class="g-y" d="M5.27 14.29a7.2 7.2 0 0 1 0-4.58V6.62H1.29a12 12 0 0 0 0 10.76l3.98-3.09z"></path>' +
  '<path class="g-r" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.7 0 3.99 2.47 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"></path>'

export const ICON_MENU =
  '<line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="18" x2="21" y2="18"></line>'

/**
 * A responsive image. WebP first, JPEG fallback, both produced at upload.
 *
 * Every image goes through here. A plain <img> pointing at an original phone photo is the single
 * biggest cost on these sites: whatever is referenced is downloaded by every visitor on every
 * visit, and Vercel bills the bandwidth. See DECISIONS.md D25.
 */
export function picture(args: {
  webp: string
  jpeg: string
  alt: string
  width: number
  height: number
  eager?: boolean
  sizes?: string
}): string {
  const loading = args.eager ? 'eager" fetchpriority="high' : 'lazy" decoding="async'
  return `<picture>
        <source type="image/webp" srcset="${esc(args.webp)}"${args.sizes ? ` sizes="${esc(args.sizes)}"` : ''}>
        <img src="${esc(args.jpeg)}" alt="${esc(args.alt)}" width="${args.width}" height="${args.height}" loading="${loading}">
      </picture>`
}

// ---------------------------------------------------------------------------------------------
// Colour, and the one place style and palette have to be reconciled
// ---------------------------------------------------------------------------------------------

interface Surfaces {
  /** Token name used for large dark areas. */
  darkBlock: 'primary' | 'ink'
  /** Whether alternating sections are tinted. */
  altTinted: boolean
}

export function resolveSurfaces(plan: ContentPlan, spec: StyleSpec): Surfaces {
  const wantsDark = spec.heroSurface === 'dark' || spec.altSurface === 'dark'
  // The style may ask for the brand colour behind white text. If the sampled logo colour is too
  // light to carry that, the neutral dark is used instead and the brand colour keeps its job as
  // an accent. The palette is the customer's; the style is ours.
  const carries = paletteCarriesDarkSurfaces({ primary: plan.tokens.primary })
  return {
    darkBlock: wantsDark && !carries ? 'ink' : 'primary',
    altTinted: spec.altSurface !== 'pale',
  }
}

/**
 * Split a heading so its payoff phrase can be set in the accent colour.
 *
 * The device every reference site uses: "Water, gas and plumbing handled with <em>care.</em>" and
 * "Boutique Homes Built <em>Without Compromise.</em>". The last few words carry the emphasis, so
 * the split is on the final clause where there is one and the last words otherwise.
 * Returns escaped HTML, ready to drop straight into a heading.
 */
export function twoTone(text: string, enabled: boolean): string {
  const copy = clean(text).trim()
  if (!enabled) return esc(copy)

  // A payoff is a second sentence, or a clause after a comma. Anything shorter is left alone.
  //
  // A LOCATIVE IS NOT A PAYOFF. Gildon accents "Without Compromise." and that reads as design, so
  // a preposition is not the problem in itself. "Blocked drains in Chermside" accented as
  // "in Chermside" is the problem: highlighting a place name reads as a highlighting accident
  // rather than as emphasis. So the locatives are refused and the rest are allowed.
  const isLocative = (phrase: string) => /^(in|at|near|around|across|throughout)\s/i.test(phrase)

  const sentence = copy.match(/^(.+?[.!?]\s+)(.{6,}?)$/)
  if (sentence && !isLocative(sentence[2]!.trim())) {
    return esc(sentence[1]!.trim()) + ' <em>' + esc(sentence[2]!.trim()) + '</em>'
  }

  const comma = copy.match(/^(.+?,\s+)(.{6,}?)$/)
  if (comma && !isLocative(comma[2]!.trim())) {
    return esc(comma[1]!.trim()) + ' <em>' + esc(comma[2]!.trim()) + '</em>'
  }

  return esc(copy)
}

/**
 * The words for a section, with the template wording as a fallback.
 *
 * Every string this returns used to be a literal in the markup below, which made it invisible
 * to the edit step: the customer could ask to change it and the model had nothing to change.
 * The fallback is still the wording that ships on a fresh build, so nothing moves until
 * somebody asks for it to.
 */
/**
 * Every word the template supplies that is not in the plan, and what it says by default.
 *
 * A LIST, NOT A HABIT. These were literals spread through the markup, and the only way to know
 * whether one was reachable from the editor was to read the renderer and hope. Collected here,
 * a test can walk every key, render with all of them replaced, and fail if any default word
 * survives onto the page: that is the difference between believing they are editable and
 * knowing it.
 *
 * Adding a literal to the markup instead of a key here is the bug this exists to stop.
 */
export const DEFAULT_LABELS: Record<string, string> = {
  'form.name': 'Your name',
  'form.message': 'What do you need done?',
  'form.note': 'We will get back to you as soon as we can. If it is urgent, ring us instead.',
  'about.servicesLink': 'Our services',
  'services.cardCta': 'Request a quote',
  'services.cardPageCta': 'More on',
  'contact.hours': 'Opening hours',
  'footer.company': 'Company',
  'footer.services': 'Services',
  'footer.allServices': 'All services',
  'mobileBar.call': 'Call now',
  'servicePage.allServices': 'All our services',
}

/**
 * A word the template supplies, which the customer can replace.
 *
 * The fallback is what ships on a fresh build, so nothing moves until somebody asks. Use this
 * for ANY string that reaches the page and does not come from the plan or the facts: a literal
 * in the markup is a word on a customer's website that no edit can reach.
 */
export function label(plan: ContentPlan, key: keyof typeof DEFAULT_LABELS | string): string {
  return plan.labels?.[key] ?? DEFAULT_LABELS[key] ?? key
}

export function sectionCopy(
  plan: ContentPlan,
  section: string,
  field: 'eyebrow' | 'heading' | 'blurb',
  fallback: string,
): string {
  return plan.sectionCopy?.[section]?.[field] ?? fallback
}

/** The small ALL CAPS label that sits above a section heading on every reference site. */
export function sectionHead(args: {
  eyebrow: string
  heading: string
  blurb?: string | null
  spec: StyleSpec
  dark?: boolean
}): string {
  const blurb = args.blurb ? '<p>' + esc(clean(args.blurb)) + '</p>' : ''
  return (
    '<div class="section-head">' +
    '<span class="eyebrow">' +
    esc(clean(args.eyebrow)) +
    '</span>' +
    '<h2>' +
    twoTone(args.heading, args.spec.twoTone) +
    '</h2>' +
    blurb +
    '</div>'
  )
}

// ---------------------------------------------------------------------------------------------
// Stylesheet
// ---------------------------------------------------------------------------------------------

/**
 * THE COMPONENT VOCABULARY.
 *
 * Every value below was measured off one of the four reference sites rather than invented. The
 * skeleton is identical across all four; what changes is palette, heading case and weight, and
 * density. See shared/styles.ts for which site each style came from, and DECISIONS.md D40.
 */
export function stylesheet(plan: ContentPlan, spec: StyleSpec, surfaces: Surfaces): string {
  const t = plan.tokens
  const darkToken = surfaces.darkBlock === 'ink' ? 'var(--ink)' : 'var(--primary)'
  const onDarkPage = spec.rhythm === 'dark-on-dark'
  const outlined = spec.card === 'outlined-dark'
  const accentBand = spec.statBand === 'accent'

  const cardFieldBg = outlined ? 'var(--veil-05)' : 'var(--surface)'
  const cardFieldLine = outlined ? 'var(--veil-18)' : 'var(--line)'
  const cardFormBg = outlined ? 'var(--primary-dark)' : 'var(--surface)'
  const cardFormFg = outlined ? 'var(--white)' : 'var(--ink)'
  const mutedOnCard = onDarkPage ? 'var(--on-dark-66)' : 'var(--ink-muted)'

  // Every colour in the document is declared here and nowhere else, which is house rule 2 and
  // static check 1. The style values live here too so the rest of the sheet reads as intent.
  const root = [
    ':root{',
    '--primary:' + t.primary + ';',
    '--primary-dark:' + t.primaryDark + ';',
    '--primary-light:' + t.primaryLight + ';',
    '--accent:' + t.accent + ';',
    '--ink:' + t.ink + ';',
    '--ink-muted:' + t.inkMuted + ';',
    '--surface:' + t.surface + ';',
    '--surface-alt:' + t.surfaceAlt + ';',
    '--line:' + t.line + ';',
    '--white:' + t.white + ';',
    '--black:' + t.black + ';',
    '--success:' + t.success + ';',
    '--shadow-soft:rgba(16,24,32,0.10);',
    '--shadow-medium:rgba(16,24,32,0.16);',
    '--on-dark-80:rgba(255,255,255,0.8);',
    '--on-dark-78:rgba(255,255,255,0.78);',
    '--on-dark-72:rgba(255,255,255,0.72);',
    '--on-dark-70:rgba(255,255,255,0.7);',
    '--on-dark-68:rgba(255,255,255,0.68);',
    '--on-dark-66:rgba(255,255,255,0.66);',
    '--on-dark-55:rgba(255,255,255,0.55);',
    '--on-dark-50:rgba(255,255,255,0.5);',
    '--veil-18:rgba(255,255,255,0.18);',
    '--veil-14:rgba(255,255,255,0.14);',
    '--veil-12:rgba(255,255,255,0.12);',
    '--veil-10:rgba(255,255,255,0.10);',
    '--veil-08:rgba(255,255,255,0.08);',
    '--veil-06:rgba(255,255,255,0.06);',
    '--veil-05:rgba(255,255,255,0.05);',
    '--shade-18:rgba(0,0,0,0.18);',
    '--on-primary:var(--white);',
    '--on-dark:var(--white);',
    '--dark-block:' + darkToken + ';',
    // The hero scrim as three stops, so the copy side stays readable and the photo still reads.
    '--scrim-1:rgba(0,0,0,' + spec.heroOverlay[0] + ');',
    '--scrim-2:rgba(0,0,0,' + spec.heroOverlay[1] + ');',
    '--scrim-3:rgba(0,0,0,' + spec.heroOverlay[2] + ');',
    // Page ground. A dark-on-dark style inverts the whole document rather than one section.
    '--page-bg:' + (onDarkPage ? 'var(--ink)' : 'var(--surface)') + ';',
    '--page-fg:' + (onDarkPage ? 'var(--white)' : 'var(--ink)') + ';',
    '--page-muted:' + (onDarkPage ? 'var(--on-dark-68)' : 'var(--ink-muted)') + ';',
    '--alt-bg:' +
      (onDarkPage ? 'var(--primary-dark)' : surfaces.altTinted ? 'var(--surface-alt)' : 'var(--surface)') +
      ';',
    '--card-fg:' + (onDarkPage ? 'var(--white)' : 'var(--ink)') + ';',
    '--hairline:' + (onDarkPage ? 'var(--veil-14)' : 'var(--line)') + ';',
    '--font-head:' + spec.headingFamily + ';',
    '--font-body:' + spec.bodyFamily + ';',
    // The face the payoff phrase of a heading switches to. See the em rule below for why.
    '--font-accent:' + spec.accentFamily + ';',
    '--accent-style:' + spec.accentStyle + ';',
    '--accent-weight:' + spec.accentWeight + ';',
    '--accent-track:' + spec.accentTracking + ';',
    '--weight-head:' + spec.headingWeight + ';',
    '--track-head:' + spec.headingTracking + ';',
    '--track-btn:' + spec.buttonTracking + ';',
    '--track-eyebrow:' + spec.eyebrowTracking + ';',
    // Both fall back to the accent, which is what they always were.
    '--eyebrow-color:' + (t.eyebrow ?? t.accent) + ';',
    '--btn-bg:' + (t.button ?? t.accent) + ';',
    '--eyebrow-size:' + spec.eyebrowSize + ';',
    '--h1:' + spec.scale.h1 + ';',
    '--h2:' + spec.scale.h2 + ';',
    '--h3:' + spec.scale.h3 + ';',
    '--step-body:' + spec.scale.body + ';',
    '--step-lead:' + spec.scale.lead + ';',
    '--section-pad:' + spec.spacing.sectionMobile + ';',
    '--section-pad-lg:' + spec.spacing.sectionDesktop + ';',
    '--gap:' + spec.spacing.gap + ';',
    '--measure:' + spec.spacing.measure + ';',
    '--radius:' + spec.radius.card + ';',
    '--radius-btn:' + spec.radius.button + ';',
    '--radius-input:' + spec.radius.input + ';',
    '--shadow-card:' + spec.shadow.card + ';',
    '--shadow-raised:' + spec.shadow.raised + ';',
    '--shadow-hover:' + spec.shadow.hover + ';',
    '--border-hairline:' + spec.border.hairline + ';',
    '--border-strong:' + spec.border.strong + ';',
    '--header-h:76px;',
    '--wrap:1200px;',
    /*
     * GOOGLE'S OWN FOUR COLOURS, AND THE STAR GOLD.
     *
     * These are the only colours on a generated site that are not derived from the customer's
     * palette, because they are not ours to restyle: a G in the brand's blue is what makes a
     * reader believe the reviews came from Google rather than from us. They live in :root like
     * every other colour so check 1 stays satisfied, and the paths reference them through classes,
     * because a presentation attribute cannot take a var().
     *
     * The star gold is separate from --accent deliberately. A rating rendered in the customer's
     * accent reads as decoration; rendered in the gold everybody already associates with a star
     * rating, it reads as a rating.
     */
    '--google-blue:#4285f4;',
    '--google-green:#34a853;',
    '--google-yellow:#fbbc05;',
    '--google-red:#ea4335;',
    '--star:#fbbc05;',
    '}',
  ].join('\n')

  const base = [
    '*,*::before,*::after{box-sizing:border-box;}',
    'html{-webkit-text-size-adjust:100%;scroll-behavior:smooth;}',
    '@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto;}*{animation:none!important;transition:none!important;}}',
    'body{margin:0;font-family:var(--font-body);font-size:var(--step-body);line-height:1.65;color:var(--page-fg);background:var(--page-bg);-webkit-font-smoothing:antialiased;}',
    'img{max-width:100%;display:block;}',
    'a{color:inherit;}',
    'h1,h2,h3,h4{font-family:var(--font-head);font-weight:var(--weight-head);line-height:1.08;letter-spacing:var(--track-head);margin:0 0 1rem;' +
      (spec.headingTransform === 'uppercase' ? 'text-transform:uppercase;' : '') +
      '}',
    'h1{font-size:var(--h1);}',
    'h2{font-size:var(--h2);}',
    'h3{font-size:var(--h3);line-height:1.25;}',
    'p{margin:0 0 1rem;}',
    '/* The two-tone heading device: the payoff phrase of a heading, set in the accent colour. */',
    /*
     * THE PAYOFF PHRASE CHANGES TYPEFACE, NOT JUST COLOUR.
     *
     * This rule used to be font-style:normal, which actively threw away the one device that makes
     * Driftwood look designed: "Solid work. *Beautifully* considered." changes FACE mid-heading,
     * into a serif italic. Ours only recoloured the words, so every heading was one voice in two
     * colours, which reads as a highlighter rather than as typography.
     *
     * The face is per style, so this lands differently on each: a serif italic where the style is
     * settled, the display face itself where the style is loud.
     */
    'em{font-family:var(--font-accent);font-style:var(--accent-style);font-weight:var(--accent-weight);color:var(--accent);letter-spacing:var(--accent-track);}',
    '.wrap{width:100%;max-width:var(--wrap);margin:0 auto;padding:0 20px;}',
    '.section{padding:var(--section-pad) 0;}',
    '@media (min-width:900px){.section{padding:var(--section-pad-lg) 0;}}',
    '.section--alt{background:var(--alt-bg);}',
    '.section--dark{background:var(--dark-block);color:var(--on-dark);}',
    /*
     * PARALLAX, REBUILT, AND NOW ON EVERY STYLE INCLUDING ON A PHONE.
     *
     * WHAT WAS HERE BEFORE BARELY EXISTED. It was background-attachment:fixed, which has never
     * worked on iOS Safari: it rescales and crops the image instead of scrolling it, so it was
     * fenced behind a pointer:fine query that excludes every touch device. It was also only
     * switched on for two of the four styles. The net effect was an effect almost nobody saw, on
     * the device almost everybody uses.
     *
     * This version translates the image instead, driven by the section's own position through the
     * viewport, which is what the reference sites Chris pointed at actually do. Transform is
     * composited, so it moves on a phone without repainting, and it needs no fixed attachment.
     *
     * The movement is deliberately small. A hero photo that slides further than its own overscan
     * shows the edge of the image, and 12% of extra height is what buys the travel below.
     */
    '.hero__bg,.section--dark,.stats-band{overflow:hidden;}',
    ...(spec.layout.parallax
      ? [
          '@media (prefers-reduced-motion:no-preference){',
          '[data-parallax] .parallax-layer{will-change:transform;}',
          '}',
        ]
      : []),
    // Extra height is what there is to travel through. Without it the image would pull away from
    // its own edge and show the section behind.
    ...(spec.layout.parallax
      ? [
          // Extra height is the travel. Without it the image pulls away from its own edge.
          '[data-parallax] .hero__bg img,[data-parallax] .hero__bg picture{height:112%;object-fit:cover;}',
          '@media (prefers-reduced-motion:reduce){',
          '[data-parallax] .parallax-layer{transform:none!important;}',
          '}',
        ]
      : []),
    '.section--dark h2,.section--dark h3{color:var(--on-dark);}',
    '.section--dark p{color:var(--on-dark-72);}',
    '.eyebrow{display:block;color:var(--eyebrow-color);text-transform:uppercase;letter-spacing:var(--track-eyebrow);font-size:var(--eyebrow-size);font-weight:700;margin:0 0 14px;}',
    '.section-head{margin-bottom:2.5rem;' + (spec.headingAlign === 'centred' ? 'text-align:center;' : '') + '}',
    '.section-head p{color:var(--page-muted);max-width:var(--measure);font-size:var(--step-lead);' +
      (spec.headingAlign === 'centred' ? 'margin-left:auto;margin-right:auto;' : '') +
      '}',
    '.section--dark .section-head p{color:var(--on-dark-70);}',
    '.icon{width:22px;height:22px;flex:0 0 auto;}',
    '.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}',
  ].join('\n')

  const buttons = [
    '.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:var(--border-hairline) solid transparent;border-radius:var(--radius-btn);padding:14px 26px;font-family:var(--font-body);font-size:0.95rem;font-weight:700;letter-spacing:var(--track-btn);' +
      (spec.buttonTransform === 'uppercase' ? 'text-transform:uppercase;' : '') +
      'text-decoration:none;cursor:pointer;transition:transform .2s ease,background-color .2s ease,box-shadow .2s ease,color .2s ease;}',
    /*
     * The button follows --btn-bg, which falls back to the accent and always has. It is
     * separate because the accent also paints eyebrows, links and icons, so a customer who
     * wants a green Call Now button should not have to turn every small label green with it.
     */
    '.btn--primary{background:var(--btn-bg);color:var(--on-primary);border-color:var(--btn-bg);}',
    '.btn--primary:hover{transform:translateY(-2px);box-shadow:var(--shadow-raised);}',
    '.btn--dark{background:var(--dark-block);color:var(--on-dark);border-color:var(--dark-block);}',
    '.btn--dark:hover{transform:translateY(-2px);}',
    '.btn--ghost{background:transparent;color:var(--white);border-color:var(--on-dark-50);}',
    '.btn--ghost:hover{background:var(--veil-10);border-color:var(--white);transform:translateY(-2px);}',
    '.btn--outline{background:transparent;color:var(--page-fg);border-color:var(--page-fg);}',
    '.btn--outline:hover{background:var(--page-fg);color:var(--page-bg);}',
    '.btn--block{width:100%;}',
    '/* A phrase with an arrow. The arrow moves on hover, not the text, so nothing reflows. */',
    '.link-arrow{display:inline-flex;align-items:center;gap:7px;color:var(--page-fg);font-size:0.78rem;font-weight:700;text-decoration:none;text-transform:uppercase;letter-spacing:0.06em;}',
    '.link-arrow .icon{width:15px;height:15px;color:var(--accent);transition:transform .2s ease;}',
    '.link-arrow:hover .icon{transform:translateX(4px);}',
    '.section--dark .link-arrow{color:var(--on-dark);}',
  ].join('\n')

  const header = [
    '.site-header{position:fixed;top:0;left:0;right:0;z-index:60;height:var(--header-h);display:flex;align-items:center;transition:background-color .3s ease,box-shadow .3s ease;' +
      (spec.header === 'solid-dark' ? 'background:var(--dark-block);' : '') +
      '}',
    '.site-header--solid{background:var(--dark-block);box-shadow:var(--shadow-raised);}',
    '.site-header__inner{display:flex;align-items:center;justify-content:space-between;gap:1rem;width:100%;}',
    '.brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--white);}',
    '.brand__mark{width:40px;height:40px;border-radius:var(--radius-btn);background:var(--accent);color:var(--on-primary);display:grid;place-items:center;font-family:var(--font-head);font-size:1.15rem;}',
    '.brand__logo{max-height:60px;max-width:300px;width:auto;height:auto;object-fit:contain;}',
    /*
     * The services dropdown. display:none at rest rather than opacity or visibility, so there
     * is nothing to catch a stray hover and nothing for check 23 to find hanging open.
     */
    '.nav__group{position:relative;display:inline-flex;align-items:center;}',
    '.nav__sub{display:none;position:absolute;top:100%;left:0;min-width:230px;padding:8px;z-index:60;'
      + 'background:var(--white);border:1px solid var(--hairline);border-radius:var(--radius);box-shadow:var(--shadow-hover);}',
    '.nav__group:hover .nav__sub,.nav__group:focus-within .nav__sub{display:block;}',
    /*
     * .nav .nav__sub, NOT .nav__sub, AND THE EXTRA CLASS IS THE WHOLE POINT.
     *
     * These rules sit above ".nav a", which paints the header links near-white for the dark
     * header and has exactly the same specificity, so it won and every link in the dropdown
     * rendered white on a white panel. It shipped: the menu opened as an empty white box.
     *
     * That is the same fault as the invisible card headings an hour earlier, in the code
     * written to fix them, which says something about relying on source order. One extra class
     * makes these win wherever they sit in the sheet.
     */
    '.nav .nav__sub a{display:block;padding:8px 12px;border-radius:calc(var(--radius) / 2);white-space:nowrap;color:var(--ink);}',
    '.nav .nav__sub a:hover,.nav .nav__sub a:focus{background:var(--wash);color:var(--accent);}',
    // A group of pages under Services, on a phone, where there is no hover to reveal anything.
    '.mobile-panel__sub{display:flex;flex-direction:column;padding-left:14px;margin:2px 0 6px;border-left:2px solid var(--hairline);}',
    '.mobile-panel__sub a{font-size:0.92rem;opacity:0.86;}',
    '.brand__name{font-family:var(--font-head);font-size:1.2rem;letter-spacing:var(--track-head);' +
      (spec.headingTransform === 'uppercase' ? 'text-transform:uppercase;' : '') +
      '}',
    '.nav{display:none;gap:4px;}',
    '.nav a{text-decoration:none;font-size:0.92rem;font-weight:500;padding:8px 12px;border-radius:var(--radius-btn);color:var(--on-dark-78);transition:color .2s ease,background-color .2s ease;}',
    '.nav a:hover{color:var(--white);background:var(--veil-08);}',
    '.header__actions{display:none;align-items:center;gap:14px;}',
    '.header__phone{color:var(--on-dark-80);text-decoration:none;font-weight:600;font-size:0.9rem;display:inline-flex;align-items:center;gap:7px;}',
    '.header__phone:hover{color:var(--white);}',
    '.menu-toggle{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:var(--radius-btn);width:44px;height:44px;cursor:pointer;background:var(--veil-10);color:var(--white);}',
    '.mobile-panel{position:fixed;inset:var(--header-h) 0 auto 0;background:var(--dark-block);padding:1rem 20px 1.5rem;display:none;z-index:55;}',
    '.mobile-panel[data-open="true"]{display:block;}',
    '.mobile-panel a{display:block;padding:12px 0;color:var(--white);text-decoration:none;border-bottom:1px solid var(--veil-12);font-weight:500;}',
    '@media (min-width:980px){.nav{display:flex;}.header__actions{display:flex;}.menu-toggle{display:none;}}',
  ].join('\n')

  // The hero all four reference sites build: full-bleed photo, dark gradient scrim over it, copy
  // on the left, enquiry form card on the right, trust points under the copy.
  const hero = [
    '.hero{position:relative;display:flex;align-items:center;min-height:660px;overflow:hidden;background:var(--dark-block);color:var(--white);padding:calc(var(--header-h) + 3rem) 0 3.5rem;}',
    '.hero__bg{position:absolute;inset:0;}',
    '.hero__bg picture,.hero__bg img{width:100%;height:100%;object-fit:cover;}',
    '.hero__scrim{position:absolute;inset:0;background:linear-gradient(100deg,var(--scrim-1) 0%,var(--scrim-2) 55%,var(--scrim-3) 100%);}',
    '.hero__glow{position:absolute;right:-6%;top:4%;width:640px;height:640px;border-radius:50%;background:radial-gradient(circle,var(--accent),transparent 68%);opacity:0.16;pointer-events:none;}',
    '.hero__inner{position:relative;z-index:1;display:grid;gap:2.5rem;align-items:center;}',
    '.hero h1{color:var(--white);margin-bottom:1.25rem;}',
    '.hero__sub{font-size:var(--step-lead);color:var(--on-dark-72);max-width:52ch;line-height:1.7;}',
    '.hero__ctas{display:flex;flex-wrap:wrap;gap:14px;margin:1.75rem 0 1.5rem;}',
    '.hero__points{display:flex;flex-wrap:wrap;gap:10px 22px;list-style:none;padding:0;margin:0;}',
    '.hero__points li{display:flex;align-items:center;gap:8px;font-size:0.82rem;font-weight:500;color:var(--on-dark-66);}',
    '.hero__points .icon{width:16px;height:16px;color:var(--accent);}',
    '@media (min-width:1000px){.hero__inner{grid-template-columns:1fr 440px;gap:3.75rem;}}',

    // ---- hero variants ----------------------------------------------------------------
    // The two-column rule above is the split hero. The other two override it, so a style that
    // asks for centred or editorial does not inherit a 440px column it has nothing to put in.

    // Centred: one column, everything stacked and centred under the h1. Where the form stays
    // in the hero it sits below the CTAs at a readable width rather than beside them.
    '.hero--centred .hero__inner{justify-items:center;text-align:center;}',
    '.hero--centred .hero__copy{max-width:56rem;}',
    /*
     * hero__sub is capped at 52ch so the line length stays readable. On a centred hero that
     * cap left the BOX against the left edge of a much wider column while the text inside it
     * was centred, which reads as text that has slipped rather than text that is centred.
     */
    '.hero--centred .hero__sub{margin-inline:auto;}',
    '.hero--centred .hero__ctas{justify-content:center;}',
    '.hero--centred .hero__points{justify-content:center;}',
    '@media (min-width:1000px){.hero--centred .hero__inner{grid-template-columns:minmax(0,1fr);}',
    '.hero--centred .form-card{max-width:34rem;margin-inline:auto;}}',

    // Editorial: copy sits low and left over a full-bleed photo, with room under it. Taller,
    // because the point of it is the photograph rather than what is written on top.
    '.hero--editorial{min-height:78vh;align-items:flex-end;padding-bottom:5rem;}',
    '.hero--editorial .hero__copy{max-width:44rem;}',
    '@media (min-width:1000px){.hero--editorial .hero__inner{grid-template-columns:minmax(0,1fr);}}',

    // No form in the hero at all: the copy is free to use the width.
    '@media (min-width:1000px){.hero--noform .hero__inner{grid-template-columns:minmax(0,1fr);}}',

    // The standalone quote section, used by the styles whose hero has no form.
    '.section--quote .quote-wrap{display:grid;gap:2rem;align-items:center;}',
    '@media (min-width:900px){.section--quote .quote-wrap{grid-template-columns:1fr 460px;gap:3rem;}}',
    '.quote-intro p{color:var(--muted);max-width:34rem;}',
  ].join('\n')

  const form = [
    '.card-form{background:' +
      cardFormBg +
      ';color:' +
      cardFormFg +
      ';border:' +
      (outlined ? 'var(--border-hairline) solid var(--accent)' : '0') +
      ';border-radius:var(--radius);padding:1.75rem;box-shadow:var(--shadow-raised);}',
    '.card-form h2,.card-form h3{margin-bottom:1.25rem;color:' + cardFormFg + ';}',
    '.field{display:block;margin-bottom:0.9rem;}',
    '.field span{display:block;font-weight:600;font-size:0.76rem;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;color:' +
      (outlined ? 'var(--on-dark-70)' : 'var(--ink-muted)') +
      ';}',
    '.field input,.field textarea{width:100%;padding:12px 14px;border:1px solid ' +
      cardFieldLine +
      ';border-radius:var(--radius-input);font:inherit;font-size:0.95rem;background:' +
      cardFieldBg +
      ';color:' +
      cardFormFg +
      ';}',
    '.field input:focus,.field textarea:focus{outline:2px solid var(--accent);outline-offset:1px;}',
    '.field textarea{min-height:96px;resize:vertical;}',
    '.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;}',
    '.form-note{font-size:0.78rem;color:' +
      (outlined ? 'var(--on-dark-55)' : 'var(--ink-muted)') +
      ';margin:0.75rem 0 0;}',
    '.form-status{margin-top:0.75rem;font-weight:600;font-size:0.9rem;}',
    '.form-status[data-state="ok"]{color:var(--success);}',
    '.form-status[data-state="error"]{color:var(--accent);}',
  ].join('\n')

  // Trust bar: four items with rules between them, straight under the hero.
  const trust = [
    '.trust-bar{background:' + (onDarkPage ? 'var(--primary-dark)' : 'var(--alt-bg)') + ';border-bottom:1px solid var(--hairline);}',
    '.trust-grid{display:grid;grid-template-columns:repeat(2,1fr);}',
    '.trust-item{display:flex;align-items:center;gap:12px;padding:18px 20px;border-right:1px solid var(--hairline);border-bottom:1px solid var(--hairline);}',
    '.trust-item .icon{color:var(--accent);}',
    '.trust-item b{display:block;font-size:0.85rem;font-weight:700;}',
    '.trust-item small{display:block;font-size:0.74rem;color:var(--page-muted);margin-top:2px;}',
    '@media (min-width:900px){.trust-grid{grid-template-columns:repeat(4,1fr);}.trust-item{border-bottom:0;}.trust-item:last-child{border-right:0;}}',
  ].join('\n')

  const cardSkin = {
    'outlined-dark': 'background:var(--primary-dark);border:var(--border-hairline) solid var(--accent);',
    'soft-light': 'background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow-card);',
    'warm-bordered': 'background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow-card);',
    'flat-tinted': 'background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow-card);',
  }[spec.card]

  const numberRule =
    spec.cardNumber === 'corner-small'
      ? '.card__num{position:absolute;right:18px;top:16px;font-family:var(--font-head);font-size:0.78rem;font-weight:700;color:var(--page-muted);opacity:0.6;}'
      : spec.cardNumber === 'large-faint'
        ? '.card__num{display:block;font-family:var(--font-head);font-size:2.4rem;font-weight:var(--weight-head);line-height:1;color:var(--accent);opacity:0.3;margin-bottom:0.5rem;}'
        : '.card__num{display:none;}'

  const cards = [
    '.grid{display:grid;gap:var(--gap);}',
    '@media (min-width:700px){.grid--2{grid-template-columns:repeat(2,1fr);}.grid--3{grid-template-columns:repeat(2,1fr);}.grid--4{grid-template-columns:repeat(2,1fr);}}',
    '@media (min-width:1000px){.grid--3{grid-template-columns:repeat(3,1fr);}.grid--4{grid-template-columns:repeat(4,1fr);}}',
    '.card{position:relative;display:flex;flex-direction:column;padding:1.75rem;border-radius:var(--radius);color:var(--card-fg);' +
      cardSkin +
      'transition:transform .2s ease,box-shadow .2s ease,border-color .2s ease;}',
    '.card:hover{transform:translateY(-5px);box-shadow:var(--shadow-hover);border-color:var(--accent);}',
    /*
     * THE COLOUR IS SET HERE ON PURPOSE, AND REMOVING IT MAKES THE HEADING DISAPPEAR.
     *
     * .card sets color on itself and the h3 used to inherit it, which works everywhere except
     * the one place it matters. Inside section--dark there is a rule ".section--dark h3" that
     * paints headings white for the dark ground, and a rule beats inheritance however close
     * the parent is. The why choose us cards are light cards sitting on a dark section, so
     * every card heading rendered white on white and Callum's build shipped four invisible
     * headings. .card p already carries its own colour for exactly this reason.
     */
    '.card h3{margin-bottom:0.55rem;color:var(--card-fg);}',
    '.card p{color:' + mutedOnCard + ';font-size:0.92rem;margin-bottom:1rem;}',
    '.card__icon{display:grid;place-items:center;width:46px;height:46px;border-radius:' +
      (spec.radius.card === '0px' ? '0' : '12px') +
      ';background:' +
      (onDarkPage ? 'var(--veil-06)' : 'var(--surface-alt)') +
      ';color:var(--accent);margin-bottom:1.1rem;}',
    '.card__icon .icon{width:22px;height:22px;}',
    '.card .link-arrow{margin-top:auto;color:var(--card-fg);}',
    numberRule,
  ].join('\n')

  // The stat band: full-width, large figures over small caps labels.
  const stats = [
    '.stats-band{background:' +
      (accentBand ? 'var(--accent)' : 'var(--dark-block)') +
      ';color:' +
      (accentBand ? 'var(--ink)' : 'var(--on-dark)') +
      ';padding:2.5rem 0;}',
    '.stats-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:1.5rem;}',
    '.stat{padding:0 1.25rem;border-right:1px solid ' +
      (accentBand ? 'var(--shade-18)' : 'var(--veil-18)') +
      ';}',
    '.stat:last-child{border-right:0;}',
    '.stat strong{display:block;font-family:var(--font-head);font-size:2.7rem;font-weight:var(--weight-head);letter-spacing:var(--track-head);line-height:1;}',
    '.stat span{display:block;text-transform:uppercase;letter-spacing:0.13em;font-size:0.65rem;font-weight:700;margin-top:8px;opacity:0.78;}',
    '@media (min-width:900px){.stats-grid{grid-template-columns:repeat(4,1fr);}.stat:first-child{padding-left:0;}}',
  ].join('\n')

  const about = [
    '.about-grid{display:grid;gap:2.5rem;align-items:center;}',
    '.about__copy p{color:var(--page-muted);max-width:var(--measure);}',
    '.pull-quote{margin:1.5rem 0;padding:1.1rem 1.4rem;border-left:3px solid var(--accent);background:var(--alt-bg);font-style:italic;color:var(--page-fg);border-radius:0 var(--radius) var(--radius) 0;}',
    '.about__media img{border-radius:var(--radius);width:100%;height:100%;object-fit:cover;}',
    '.about__actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:1.5rem;}',
    '@media (min-width:900px){.about-grid{grid-template-columns:1fr 1fr;gap:3.5rem;}}',
  ].join('\n')

  /*
   * ONE SIZE, AND A COLUMN COUNT THAT LANDS ON TWO ROWS.
   *
   * This was an asymmetric mosaic: the first tile spanned two columns and two rows, the
   * fourth spanned two columns, and the rest filled in around them. It photographs well in a
   * design mock and it does not survive real content. Job photos arrive in whatever crop the
   * phone took them in, so the big tile got a portrait shot squashed into a landscape hole
   * while its neighbours were fine, and the wall of tiles read as a mistake rather than a
   * layout.
   *
   * Every tile is now the same shape and the columns come from the count, set as --cols on the
   * element itself: six photos give three across on two rows, eight give four across on two
   * rows. One column on a phone, always, because two columns of job photos on a 390px screen
   * are too small to show what the work looks like, which is the only reason the section is
   * there.
   */
  const gallery = [
    '.gallery{display:grid;gap:12px;grid-template-columns:1fr;}',
    '.gallery figure{margin:0;overflow:hidden;border-radius:var(--radius);aspect-ratio:4/3;}',
    '.gallery img{width:100%;height:100%;object-fit:cover;transition:transform .4s ease;}',
    '.gallery figure:hover img{transform:scale(1.04);}',
    // Two across from tablet, then the count decides. --cols is set on the element.
    '@media (min-width:640px){.gallery{grid-template-columns:repeat(2,1fr);}}',
    '@media (min-width:900px){.gallery{grid-template-columns:repeat(var(--cols,3),1fr);}}',
  ].join('\n')

  const process = [
    '.process-grid{display:grid;gap:var(--gap);}',
    '.step{position:relative;padding-top:1.25rem;border-top:2px solid var(--hairline);}',
    '.step__num{display:block;font-family:var(--font-head);font-size:2rem;font-weight:var(--weight-head);line-height:1;color:var(--accent);opacity:0.5;margin-bottom:0.5rem;}',
    '.step h3{margin-bottom:0.4rem;}',
    '.step p{color:var(--page-muted);font-size:0.9rem;}',
    '@media (min-width:900px){.process-grid{grid-template-columns:repeat(4,1fr);}}',
  ].join('\n')

  const areas = [
    '.areas-grid{display:grid;gap:2rem;}',
    '.suburbs{display:flex;flex-wrap:wrap;gap:8px;list-style:none;padding:0;margin:0;}',
    '.suburbs li{font-size:0.85rem;font-weight:600;padding:8px 14px;border-radius:999px;background:var(--alt-bg);border:1px solid var(--hairline);}',
    '@media (min-width:900px){.areas-grid{grid-template-columns:1fr 1.2fr;gap:3rem;align-items:center;}}',
  ].join('\n')

  const quotes = [
    '.quote{display:flex;flex-direction:column;padding:1.75rem;border-radius:var(--radius);' + cardSkin + '}',
    // Star gold, not the customer's accent. A rating in the brand colour reads as decoration.
    '.stars{display:flex;gap:3px;color:var(--star);margin-bottom:0.9rem;}',
    '.stars .icon{width:16px;height:16px;}',

    /*
     * THE GOOGLE ATTRIBUTION.
     *
     * We were already collecting the review link and the reviewer names and rendering them as
     * anonymous pull quotes, which is the weakest form the same information can take. A reader
     * cannot tell whether we wrote them. The mark, the rating and a link to the profile turn the
     * identical words into something checkable in one tap.
     */
    '.g-b{fill:var(--google-blue);}.g-g{fill:var(--google-green);}',
    '.g-y{fill:var(--google-yellow);}.g-r{fill:var(--google-red);}',
    '.g-mark{width:20px;height:20px;flex-shrink:0;}',

    '.rating-badge{display:inline-flex;align-items:center;gap:12px;padding:12px 18px;' +
      'border:1px solid var(--hairline);border-radius:var(--radius);background:var(--surface);' +
      'margin-bottom:1.75rem;}',
    '.rating-badge__score{font-family:var(--font-head);font-size:1.6rem;font-weight:800;line-height:1;}',
    '.rating-badge__meta{display:flex;flex-direction:column;gap:3px;}',
    '.rating-badge .stars{margin:0;}',
    '.rating-badge small{color:var(--page-muted);font-size:0.8rem;}',

    '.quote__source{display:flex;align-items:center;gap:7px;margin-top:0.9rem;' +
      'color:var(--page-muted);font-size:0.76rem;}',
    /*
     * ONE ROW, ALWAYS, AND IT MOVES.
     *
     * Reviews were a three column grid, so five reviews became a row of three and a row of two
     * with a hole beside it, and the hole is the first thing the eye lands on. A single track
     * cannot have a ragged second row because there is no second row.
     *
     * The animation is CSS, not JavaScript, so it runs on a page whose script never loaded and
     * stops dead for anyone who has asked their machine to stop things moving. The list is
     * rendered twice and the track travels exactly half its width, which is what makes the
     * wrap invisible; the duplicate is aria-hidden so a screen reader hears each review once.
     * Hovering pauses it, because a review you are halfway through reading should not leave.
     */
    /*
     * The soft edges are a MASK, not two gradients painted in the page colour.
     *
     * They were ::before and ::after filled with var(--page-bg), which is right only while the
     * rail sits on the page background. The reviews section can be a dark block, and then the two
     * fades were lighter rectangles sitting over a darker ground with a visible edge on each side.
     * A mask fades the content itself, so it is correct on any background. Only the alpha of the
     * gradient matters, and the colour stops are tokens because check 1 rejects a literal here.
     */
    '.reviews-rail{position:relative;overflow:hidden;'
      + '-webkit-mask-image:linear-gradient(to right,transparent 0,var(--ink) 56px,var(--ink) calc(100% - 56px),transparent 100%);'
      + 'mask-image:linear-gradient(to right,transparent 0,var(--ink) 56px,var(--ink) calc(100% - 56px),transparent 100%);}',
    '.reviews-track{display:flex;gap:var(--gap);width:max-content;}',
    '.reviews-track .quote{width:340px;flex:0 0 340px;}',
    // The clone is a wrapper, so it has to pass the row layout straight through to its cards.
    '.reviews-clone{display:contents;}',
    // Only once the track is wide enough to need it. A short list just sits still.
    '.reviews-track[data-marquee]{animation:reviews-scroll 46s linear infinite;}',
    '.reviews-rail:hover .reviews-track[data-marquee]{animation-play-state:paused;}',
    '@keyframes reviews-scroll{from{transform:translateX(0);}to{transform:translateX(calc(-50% - (var(--gap) / 2)));}}',
    '@media (prefers-reduced-motion:reduce){.reviews-track[data-marquee]{animation:none;}}',
    '.reviews-cta{margin-top:2rem;display:flex;flex-wrap:wrap;gap:12px;align-items:center;}',
    // The mark sits on a button that may be dark, so it must not inherit a fill from the label.
    '.btn .g-mark{width:18px;height:18px;}',
    '.quote p{font-size:0.94rem;line-height:1.7;color:' + mutedOnCard + ';}',
    '.quote__who{margin-top:auto;padding-top:1rem;font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--card-fg);}',
    '.quote__who span{display:block;font-weight:500;text-transform:none;letter-spacing:0;color:var(--page-muted);margin-top:3px;}',
  ].join('\n')

  const faq = [
    '.faq-item{border-bottom:1px solid var(--hairline);}',
    '.faq-item button{width:100%;display:flex;justify-content:space-between;align-items:center;gap:1rem;text-align:left;background:none;border:0;padding:1.15rem 0;font:inherit;font-weight:700;color:var(--page-fg);cursor:pointer;}',
    '.faq-item button .icon{color:var(--accent);transition:transform .25s ease;}',
    '.faq-item[data-open="true"] button .icon{transform:rotate(180deg);}',
    '.faq-answer{display:none;padding-bottom:1.15rem;color:var(--page-muted);max-width:var(--measure);}',
    '.faq-item[data-open="true"] .faq-answer{display:block;}',
  ].join('\n')

  const cta = [
    '.cta-band{background:var(--dark-block);color:var(--on-dark);text-align:center;}',

    /*
     * THE PARALLAX IMAGE BAND.
     *
     * What was here before was a flat block of colour, and the only thing carrying parallax was
     * the hero photo, which a reader has scrolled past within a second. Chris asked twice for a
     * parallax image SECTION and was right that there was not one: the dark bands held no picture
     * at all, so there was nothing to move.
     *
     * This is the band you scroll through while the photo behind it travels the other way. The
     * image is 130% of the band's height, which is the room the movement needs; without the extra
     * height it would pull away from its own edge and show the section behind.
     */
    '.cta-band--photo{position:relative;overflow:hidden;isolation:isolate;' +
      'padding-top:calc(var(--section-pad) * 1.4);padding-bottom:calc(var(--section-pad) * 1.4);}',
    '.band__bg{position:absolute;inset:0;z-index:-1;overflow:hidden;}',
    '.band__bg [data-parallax-layer]{position:absolute;inset:-15% 0;}',
    '.band__bg img,.band__bg picture{width:100%;height:100%;object-fit:cover;display:block;}',
    // Dark enough that white type is readable over any photo a tradie sends us.
    '.band__scrim{position:absolute;inset:0;background:var(--dark-block);opacity:0.72;}',
    '.cta-band--photo .wrap{position:relative;}',
    '.cta-band h2{color:var(--on-dark);}',
    '.cta-band p{color:var(--on-dark-72);max-width:56ch;margin-left:auto;margin-right:auto;}',
    '.cta-band__actions{display:flex;flex-wrap:wrap;gap:14px;justify-content:center;margin-top:1.75rem;}',
  ].join('\n')

  const contact = [
    '.contact-grid{display:grid;gap:2.5rem;}',
    '.contact-list{list-style:none;padding:0;margin:0 0 1.5rem;display:grid;gap:1.1rem;}',
    '.contact-list li{display:flex;gap:14px;align-items:flex-start;}',
    '.contact-list .icon{color:var(--accent);margin-top:3px;}',
    '.contact-list b{display:block;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.1em;color:var(--page-muted);margin-bottom:3px;}',
    '.contact-list a{text-decoration:none;font-weight:600;}',
    '.contact-list a:hover{color:var(--accent);}',
    '.hours{list-style:none;padding:0;margin:0;font-size:0.88rem;color:var(--page-muted);}',
    '@media (min-width:900px){.contact-grid{grid-template-columns:1fr 1.05fr;gap:3.5rem;}}',
  ].join('\n')

  const footer = [
    '.site-footer{background:var(--dark-block);color:var(--on-dark-66);padding:3.5rem 0 0;}',
    '.footer-grid{display:grid;gap:2rem;padding-bottom:2.5rem;}',
    '.site-footer h4{color:var(--white);font-size:0.76rem;text-transform:uppercase;letter-spacing:0.14em;margin-bottom:1rem;font-family:var(--font-body);font-weight:700;}',
    '.site-footer ul{list-style:none;padding:0;margin:0;display:grid;gap:9px;font-size:0.88rem;}',
    '.site-footer a{text-decoration:none;}',
    '.site-footer a:hover{color:var(--accent);}',
    '.site-footer__logo{max-height:56px;max-width:min(280px,60vw);width:auto;height:auto;object-fit:contain;margin-bottom:1rem;}',
    '.site-footer__blurb{font-size:0.88rem;max-width:34ch;}',
    '.footer-bottom{border-top:1px solid var(--veil-12);padding:1.25rem 0;display:flex;flex-wrap:wrap;gap:10px;justify-content:space-between;font-size:0.79rem;}',
    '.footer-bottom a{color:var(--accent);}',
    '@media (min-width:900px){.footer-grid{grid-template-columns:1.6fr 1fr 1fr 1fr;gap:3rem;}}',
  ].join('\n')

  /*
   * THE PHONE. Everything above is written desktop-out; this block is what a tradie actually
   * holds, and it is last so it wins on equal specificity.
   *
   * Every rule here is a defect found by measuring a real Chrome at 320, 360, 390 and 414 across
   * all sixteen exported pages, not by reading the CSS. The audit is scripts/mobile-audit.mjs.
   */
  const mobile = [
    /*
     * THE STICKY CALL BAR HAD NO STYLES AT ALL.
     *
     * Both renderers emit <div class="mobile-bar"> and nothing anywhere styled it, so on every
     * service page of every site it was two unstyled links sitting in the normal flow nine
     * thousand pixels down the document, under the footer. Measured on Pest-Aside: position
     * static, transparent background, never visible as a bar.
     *
     * Check 5 passed throughout, because it asks whether exactly one element carries the class,
     * which was true. Nothing asked whether it was a bar.
     */
    '.mobile-bar{position:fixed;left:0;right:0;bottom:0;z-index:60;display:grid;' +
      'grid-template-columns:1fr 1fr;gap:1px;background:var(--hairline);' +
      'border-top:1px solid var(--hairline);box-shadow:0 -6px 24px var(--shadow-medium);' +
      'padding-bottom:env(safe-area-inset-bottom,0px);}',
    '.mobile-bar a{display:flex;align-items:center;justify-content:center;gap:8px;' +
      'min-height:56px;padding:14px 12px;font-family:var(--font-body);font-weight:700;' +
      'font-size:0.95rem;text-decoration:none;white-space:nowrap;background:var(--surface);' +
      'color:var(--ink);}',
    '.mobile-bar a:first-child{background:var(--accent);color:var(--on-primary);}',
    // Above the breakpoint there is a header CTA doing this job, so the bar is not just hidden,
    // it is removed from the layout entirely.
    '@media (min-width:768px){.mobile-bar{display:none;}}',
    /*
     * ROOM FOR IT. Rule 16 says the bar must not cover the footer credit. The footer carried
     * padding-bottom:0, so the credit sat underneath the bar on every page that had one.
     */
    '@media (max-width:767px){.site-footer{padding-bottom:calc(56px + env(safe-area-inset-bottom,0px));}}',

    /*
     * A PHONE NUMBER NEVER WRAPS.
     *
     * "0424 111 201" broke across three lines inside the header button, which grew the button to
     * 80px and the header to 104px. Only tel: links get nowrap: a worded label like "Request a
     * free quote" still needs to wrap or it would overflow a narrow screen instead.
     */
    '[href^="tel:"]{white-space:nowrap;}',
    /*
     * THE HEADER PHONE BUTTON IS NOT SHOWN ON A PHONE.
     *
     * .header__cta is a direct child of .site-header__inner, not a child of .header__actions, so
     * the display:none that hides the desktop actions below 980px never applied to it. On a phone
     * the header therefore carried brand + full phone button + hamburger, which does not fit 390
     * pixels: measured, the button reached x=436 and the hamburger x=486, both clipped. A
     * hamburger a thumb cannot reach is the whole navigation gone.
     *
     * Hiding it loses nothing. The sticky bar at the bottom is a call button, and the mobile panel
     * carries another. Making it nowrap without hiding it, which is what this rule did first, only
     * converted a wrap into an overflow.
     */
    '@media (max-width:979px){.header__cta{display:none;}}',
    '.header__cta{white-space:nowrap;}',
    '.menu-toggle{flex-shrink:0;}',

    /*
     * THE TRUST STRIP WAS TWO COLUMNS ON A PHONE.
     *
     * Two columns at 390px leaves each label about 73px of text width, so "Same-day service"
     * came out as two words over three lines and "No obligation pricing before any work starts"
     * as seven words over six. A strip meant to be scanned in a second became most of a screen.
     * One column until there is room for two.
     */
    '@media (max-width:559px){.trust-grid{grid-template-columns:minmax(0,1fr);}}',
    '@media (min-width:560px) and (max-width:899px){.trust-grid{grid-template-columns:repeat(2,1fr);}}',
    // Same reasoning for the stat counters and the hero trust points.
    '@media (max-width:559px){.stats-grid{grid-template-columns:minmax(0,1fr);}' +
      '.hero__points{grid-template-columns:minmax(0,1fr);}}',

    /*
     * NOTHING IN A GRID MAY REFUSE TO SHRINK. A grid or flex child defaults to min-width:auto,
     * which is its content width, and that is what turns one long word or a phone number into
     * horizontal overflow rather than a wrap.
     */
    '.trust-item,.stat,.card,.step,.faq-item,.contact-list li,.contact-list div{min-width:0;}',
    '.trust-item>div,.stat>div{min-width:0;}',

    /*
     * THUMBS. The contact block and the footer nav rendered links 20 to 23 pixels tall, which is
     * half what a thumb needs. Only on touch layouts, so the desktop rhythm is untouched.
     */
    '@media (max-width:767px){.site-footer ul a,.contact-list a,.footer-bottom a{display:inline-block;' +
      'padding:11px 0;min-height:44px;}',
    '.site-footer ul{gap:2px;}}',

    // The wordmark is a name, not a sentence, and it broke over two lines beside the logo.
    '.brand__name{white-space:nowrap;}',

    // Long email addresses are the other reliable source of a sideways scroll.
    '.contact-list a[href^="mailto:"]{word-break:break-word;overflow-wrap:anywhere;}',

    /*
     * THE RATING UNDER THE HERO BUTTONS. One line, sitting on the hero's dark ground, so it has to
     * read against a photo rather than against a card.
     */
    '.hero__rating{display:inline-flex;align-items:center;gap:9px;margin:0 0 1.5rem;padding:9px 15px;' +
      'border:1px solid var(--veil-18);border-radius:999px;' +
      'background:var(--veil-10);text-decoration:none;font-size:0.84rem;color:var(--on-dark);' +
      'transition:background-color .2s ease;}',
    '.hero__rating:hover{background:var(--veil-18);}',
    '.hero__rating strong{font-family:var(--font-head);font-size:1.05rem;line-height:1;}',
    '.hero__rating .stars{margin:0;gap:2px;}',
    '.hero__rating .stars .icon{width:13px;height:13px;}',
    '.hero--light .hero__rating{color:var(--page-fg);border-color:var(--hairline);background:var(--surface);}',

    /*
     * THE TRUST LINE. A row of small notes on a hairline band, closer to a caption than a section.
     * It centres when there is room and wraps to two neat rows on a phone.
     */
    '.trust-line{display:flex;flex-wrap:wrap;gap:14px 32px;justify-content:center;padding:15px 20px;}',
    '.trust-note{display:inline-flex;align-items:center;gap:8px;white-space:nowrap;}',
    '.trust-note .icon{width:15px;height:15px;color:var(--accent);}',
    ...(spec.layout.sectionJoin === 'hard'
      ? [
          // Stated, not whispered. Small capitals on the dark ground the rest of the style uses.
          '.trust-bar{background:var(--dark-block);border-bottom:1px solid var(--veil-12);}',
          '.trust-note{font-size:0.74rem;font-weight:700;text-transform:uppercase;' +
            'letter-spacing:0.10em;color:var(--on-dark-72);}',
        ]
      : [
          // A caption on a hairline. Sentence case, so it sits under the hero rather than shouting.
          '.trust-bar{background:var(--surface);border-top:1px solid var(--hairline);' +
            'border-bottom:1px solid var(--hairline);}',
          '.trust-note{font-size:0.82rem;font-weight:600;color:var(--page-muted);}',
        ]),

    /*
     * THE FIGURES INSIDE ABOUT. A definition list, because that is what they are: a number and
     * what it counts. Sized to sit under the paragraphs rather than compete with the heading.
     */
    '.about__figures{display:flex;flex-wrap:wrap;gap:10px 40px;margin:1.75rem 0 0;padding:1.35rem 0 0;' +
      'border-top:1px solid var(--hairline);}',
    '.about__figures div{min-width:0;}',
    '.about__figures dt{font-family:var(--font-head);font-size:1.6rem;line-height:1;font-weight:var(--weight-head);' +
      'letter-spacing:var(--track-head);color:var(--accent);}',
    '.about__figures dd{margin:5px 0 0;font-size:0.79rem;color:var(--page-muted);max-width:16ch;line-height:1.35;}',

    /*
     * NO HARD CUTS BETWEEN SECTIONS.
     *
     * Alternating a tinted section against a white one produced a visible ruled line every time
     * the ground changed, which is what makes a page read as blocks stacked by a machine. A tinted
     * section now fades out of the one above it and back into the one below, so the joins are
     * transitions rather than edges. Two pseudo elements, no extra markup, and it costs nothing on
     * a section whose neighbour is the same colour because the gradient ends in the same value.
     */
    ...(spec.layout.sectionJoin === 'soft'
      ? [
          '.section--alt{position:relative;}',
          '.section--alt::before,.section--alt::after{content:"";position:absolute;left:0;right:0;' +
            'height:56px;pointer-events:none;}',
          '.section--alt::before{top:0;background:linear-gradient(to bottom,var(--page-bg),transparent);}',
          '.section--alt::after{bottom:0;background:linear-gradient(to top,var(--page-bg),transparent);}',
        ]
      : []),

    /*
     * SECTIONS RISE IN AS THEY ARRIVE.
     *
     * EVERY RULE HERE IS BEHIND [data-reveal], WHICH ONLY THE SCRIPT SETS. Nothing in the markup
     * carries it, so a page whose JavaScript never ran is a page with all of its text on screen.
     * The alternative, hiding sections in the stylesheet and revealing them with script, means one
     * error blanks a customer's website. An animation is not worth that.
     *
     * Small movement on purpose: 18px and a fade. Sites that throw sections halfway up the screen
     * read as a template showing off, and these are trade businesses, not agency showreels.
     */
    '@media (prefers-reduced-motion:no-preference){',
    '[data-reveal] .reveal{opacity:0;transform:translateY(18px);' +
      'transition:opacity .55s var(--ease-out,cubic-bezier(.16,1,.3,1)),transform .55s var(--ease-out,cubic-bezier(.16,1,.3,1));}',
    '[data-reveal] .reveal.is-in{opacity:1;transform:none;}',
    '}',
    /*
     * The belt to the script's braces. Someone who has asked their OS for less movement gets the
     * finished state outright, even if the observer has already added the class.
     */
    '@media (prefers-reduced-motion:reduce){',
    '[data-reveal] .reveal{opacity:1;transform:none;transition:none;}',
    '}',
  ]

  return [
    root,
    base,
    buttons,
    header,
    hero,
    form,
    trust,
    cards,
    stats,
    about,
    gallery,
    process,
    areas,
    quotes,
    faq,
    cta,
    contact,
    footer,
    mobile,
  ]
    .flat()
    .join('\n')
}

/**
 * The rendered box for a logo, from its REAL dimensions rather than a guess.
 *
 * FAILURE THIS FIXES, reported from a dress rehearsal on 2026-08-26: "logo in the footer is
 * squished". The header emitted width="180" height="44" and the footer width="240" height="70",
 * both hardcoded, neither having anything to do with the artwork. Those attributes are what the
 * browser uses to reserve space before the image loads, so every logo that was not 4.09:1 in the
 * header or 3.43:1 in the footer was laid out in the wrong shape and then jumped when it arrived.
 * On a slow phone connection that wrong shape is what you look at for the first second, and the
 * footer's 3.43:1 is wide enough that a squarish mark reserved a box more than three times too
 * wide.
 *
 * Capped on width as well as height. A wide lockup, which the audit already flags at 3.2:1 and
 * above, is over 190px wide at the footer's 56px cap, and there are phones narrower than that
 * once padding is taken off.
 */
function logoBox(logo: { width: number; height: number }, maxH: number, maxW: number) {
  const aspect = logo.width && logo.height ? logo.width / logo.height : 4
  let height = Math.min(maxH, logo.height || maxH)
  let width = Math.round(height * aspect)
  if (width > maxW) {
    width = maxW
    height = Math.round(width / aspect)
  }
  return { width, height: Math.max(1, height) }
}

/**
 * How many columns a gallery of n photos gets on desktop.
 *
 * Aim for two rows, because two rows of job photos is a body of work and four rows is a
 * contact sheet. Six photos give three across, eight give four across, and the result is
 * clamped to between two and four: one column of huge tiles looks broken and five across
 * makes every photo too small to read at a glance.
 *
 * An odd count leaves a gap on the last row rather than restretching a tile to fill it. A
 * tile that is a different size to its neighbours is the thing this replaced.
 */
export interface NavLink {
  href: string
  label: string
}

/**
 * The header nav, with the service pages folded under Services.
 *
 * THE BAR THIS REPLACED. Every service page was a top level nav item, so Callum's ten page
 * landscaping build put fourteen links across the header. They wrapped onto three lines, the
 * logo was squeezed into a corner, and the first thing anybody saw was a wall of tiny text.
 * A nav bar is a handful of destinations; a list of every page on the site is a sitemap, and
 * it belongs in the footer, which already has one.
 *
 * DESKTOP is hover and focus-within, with no JavaScript. The panel is display:none at rest,
 * which is what check 23 exists to enforce: a dropdown that is open when nobody has asked for
 * it hangs over the hero and was shipped once already.
 *
 * MOBILE has no hover, so there is nothing to reveal. The panel lists Services and then the
 * pages under it as an indented group, which is the same information without a gesture that
 * does not exist on a phone.
 */
export function navMarkup(items: NavLink[], services: NavLink[], mobile = false): string {
  const link = (n: NavLink) => `<a href="${esc(n.href)}">${esc(n.label)}</a>`

  return items
    .map((n) => {
      const isServices = n.label === 'Services' && services.length > 0
      if (!isServices) return link(n)

      if (mobile) {
        return (
          link(n) +
          '\n  <div class="mobile-panel__sub">' +
          services.map(link).join('\n    ') +
          '</div>'
        )
      }

      return (
        '<span class="nav__group">' +
        link(n) +
        '<span class="nav__sub">' +
        services.map(link).join('') +
        '</span></span>'
      )
    })
    .join(mobile ? '\n  ' : '\n      ')
}

export function galleryColumns(count: number): number {
  return Math.min(4, Math.max(2, Math.ceil(count / 2)))
}

export function brandMarkup(plan: ContentPlan, facts: BuildFacts): string {
  const name = esc(plan.brand.wordmarkText)


  if (plan.brand.logoTreatment === 'image' && facts.logo) {
    return `<a class="brand" href="#top"><img class="brand__logo" src="${esc(facts.logo.path)}" alt="${esc(plan.brand.businessName)} logo" width="${logoBox(facts.logo, 60, 300).width}" height="${logoBox(facts.logo, 60, 300).height}"></a>`
  }
  if (plan.brand.logoTreatment === 'cropped-mark' && facts.logo) {
    return `<a class="brand" href="#top"><img class="brand__logo" src="${esc(facts.logo.path)}" alt="${esc(plan.brand.businessName)} logo" width="${logoBox(facts.logo, 60, 300).width}" height="${logoBox(facts.logo, 60, 300).height}"><span class="brand__name">${name}</span></a>`
  }

  const initials = plan.brand.wordmarkText
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase()

  return `<!-- CLIENT TO SUPPLY: logo artwork as a transparent PNG or SVG. A CSS logotype is used until then. -->
    <a class="brand" href="#top"><span class="brand__mark">${esc(initials)}</span><span class="brand__name">${name}</span></a>`
}

export function formMarkup(args: {
  /** The plan, so the field labels and the note under the form are the customer’s to change. */
  plan: ContentPlan
  id: string
  heading: string
  button: string
  subject: string
  key: string
  headingLevel: 2 | 3
  eyebrow?: string
}): string {
  const h = `h${args.headingLevel}`
  return `<div class="card-form">
      ${args.eyebrow ? `<span class="eyebrow">${esc(clean(args.eyebrow))}</span>` : ''}
      <${h}>${esc(clean(args.heading))}</${h}>
      <form action="https://api.web3forms.com/submit" method="POST" data-web3form id="${args.id}">
        <input type="hidden" name="access_key" value="${esc(args.key)}">
        <input type="hidden" name="subject" value="${esc(args.subject)}">
        <input type="checkbox" name="botcheck" class="hp" tabindex="-1" autocomplete="off">
        <label class="field"><span>${esc(label(args.plan, 'form.name'))}</span><input type="text" name="name" required autocomplete="name"></label>
        <label class="field"><span>Phone</span><input type="tel" name="phone" required autocomplete="tel"></label>
        <label class="field"><span>Email</span><input type="email" name="email" required autocomplete="email"></label>
        <label class="field"><span>${esc(label(args.plan, 'form.message'))}</span><textarea name="message" required></textarea></label>
        <button class="btn btn--primary btn--block" type="submit">${esc(clean(args.button))}</button>
        <p class="form-status" role="status"></p>
        <p class="form-note">${esc(label(args.plan, 'form.note'))}</p>
      </form>
    </div>`
}

/**
 * The hero every reference site builds: a full-bleed photo under a dark gradient scrim, the
 * headline and supporting copy on the left, and the enquiry form sitting in the hero on the right.
 * Chris was explicit that all four do this and that a generated site must too.
 */
function heroMarkup(plan: ContentPlan, facts: BuildFacts, spec: StyleSpec): string {
  const photo = facts.photos[0] ?? null
  const background = photo
    ? picture({
        webp: photo.webWebp,
        jpeg: photo.webJpeg,
        alt: clean(
          plan.gallery.items[0]?.alt ?? `${plan.brand.businessName} at work in ${plan.meta.geoPlacename}`,
        ),
        width: photo.width,
        height: photo.height,
        eager: true,
        sizes: '100vw',
      })
    : `<!-- CLIENT TO SUPPLY: a wide photo of the team or a finished job for the hero background. A gradient is used until then. -->`

  const points = plan.hero.trustPoints
    .map((p) => `<li>${icon(ICON_TICK)}<span>${esc(clean(p))}</span></li>`)
    .join('\n        ')

  const L = spec.layout

  // The form card, only when this style keeps it in the hero. When it does not, the same card
  // is rendered by the standalone quote section instead, so the page still has two forms.
  const heroFormCard = L.heroForm
    ? formMarkup({
      plan,
        id: 'heroForm',
        heading: plan.hero.formHeading,
        button: plan.hero.formButtonLabel,
        subject: facts.heroFormSubject,
        key: facts.web3formsKey,
        headingLevel: 2,
        eyebrow: sectionCopy(plan, 'hero_form', 'eyebrow', 'Start a conversation'),
      })
    : ''

  return `<section class="hero hero--${L.hero}${L.heroForm ? '' : ' hero--noform'}" id="top" data-gp="hero">
  <div class="hero__bg">
    ${background}
    <div class="hero__scrim"></div>
    <div class="hero__glow"></div>
  </div>
  <div class="wrap hero__inner">
    <div class="hero__copy">
      <span class="eyebrow">${esc(clean(plan.brand.tagline))}</span>
      <h1>${twoTone(plan.hero.h1, spec.twoTone)}</h1>
      <p class="hero__sub">${esc(clean(plan.hero.sub))}</p>
      <div class="hero__ctas">
        <a class="btn btn--primary" href="${esc(plan.hero.ctaPrimary.href)}">${icon(ICON_PHONE)}${esc(clean(plan.hero.ctaPrimary.label))}</a>
        <a class="btn btn--ghost" href="${esc(plan.hero.ctaSecondary.href)}">${esc(clean(plan.hero.ctaSecondary.label))}</a>
      </div>
      ${
        /*
         * RIGHT UNDER THE BUTTONS, WHERE THE EYE ALREADY IS.
         *
         * A rating is the strongest thing most of these businesses have and it was buried two
         * thirds down the page. One line, the mark, the score, five stars and a link to the
         * profile, so it is checkable in a tap rather than a number we typed.
         *
         * Only when there is a profile AND a score. A rating with nothing behind it is exactly
         * the unverifiable claim the house rules exist to stop.
         */
        facts.googleReviewLink && facts.googleRating
          ? `<a class="hero__rating" href="${esc(facts.googleReviewLink)}" target="_blank" rel="noopener">
        <svg class="g-mark" viewBox="0 0 24 24" aria-hidden="true">${ICON_GOOGLE_G}</svg>
        <strong>${facts.googleRating.toFixed(1)}</strong>
        <span class="stars" aria-hidden="true">${icon(ICON_STAR).repeat(Math.round(facts.googleRating))}</span>
        <!-- The count is deliberately absent. The about panel counted the quotes supplied and
             this line counted the Google profile, so one page carried two different review
             numbers. Both were honest about different things and neither said so. The score
             and the link to the profile are the checkable part; the count added nothing but a
             second number to disagree with. -->
        <span>rated on Google</span>
      </a>`
          : ''
      }
      <ul class="hero__points">
        ${points}
      </ul>
    </div>
    ${heroFormCard}
  </div>
</section>`
}
export function renderSite(plan: ContentPlan, facts: BuildFacts): string {
  const spec = styleSpec(plan.style.resolved)
  const surfaces = resolveSurfaces(plan, spec)
  const t = plan.tokens

  // Service pages sit in the nav between Services and Areas, on desktop and in the mobile panel,
  // because a page nobody can navigate to is a page nobody reads. Relative links, so the same
  // markup works served and opened from disk out of a discharge zip.
  const serviceLinks = plan.servicePages.map((sp) => ({
    href: `services/${sp.slug}/index.html`,
    label: sp.service,
  }))
  const navItems = [
    { href: '#about', label: 'About' },
    { href: '#services', label: 'Services' },
    ...(plan.gallery.enabled ? [{ href: '#work', label: 'Our work' }] : []),
    { href: '#areas', label: 'Areas' },
    { href: '#faq', label: 'FAQ' },
    { href: '#contact', label: 'Contact' },
  ]

  const aboutPhoto = facts.photos[1] ?? null
  /*
   * The photo behind the parallax band. Third if there is one, so the hero, the about panel and
   * this band are three different pictures: a page showing the same job three times reads as a
   * business with one job. Falls back rather than going empty, and the band stays flat colour when
   * there are no photos at all.
   */
  /*
   * Stats, minus anything that counts reviews. See the note beside about__figures: the only
   * review count worth printing is the one on the Google profile, which is checkable and links
   * to itself. Matching on both source and label because the model names the source freely.
   */
  const visibleStats = plan.stats.filter(
    (st) => !/review/i.test(st.source) && !/review/i.test(st.label),
  )

  const bandPhoto = facts.photos[2] ?? facts.photos[0] ?? null
  const jsonLd = buildJsonLd(plan, facts)

  const assumptionComments = plan.assumptions
    .map((a) => `<!-- CONFIRM WITH CLIENT BEFORE LAUNCH: ${clean(a)} -->`)
    .join('\n')
  const supplyComments = plan.clientToSupply
    .map((c) => `<!-- CLIENT TO SUPPLY: ${clean(c)} -->`)
    .join('\n')
  // Where the style wanted something the customer's palette could not carry. Recorded in the
  // document so the compromise is visible to whoever opens it next.
  const styleComments = [
    ...plan.style.constraints,
    ...(plan.style.constraints.length > 0
      ? [
          surfaces.darkBlock === 'ink'
            ? 'Resolved: the dark areas use the neutral dark. The brand colour is used for accents only.'
            : `Resolved: the dark areas use ${plan.tokens.primary}, a deepened version of the sampled colour, so they stay the brand colour.`,
        ]
      : []),
  ]
    .map((c) => `<!-- STYLE NOTE: ${clean(c)} -->`)
    .join('\n')

  // THE BODY IS ASSEMBLED, NOT WRITTEN OUT IN ORDER.
  //
  // It used to be one template literal with the eleven sections hardcoded in a fixed order, so
  // every style produced the same page with different fonts on it. The customer was being asked
  // to choose between four skins and told it was a choice of layout. These are the same eleven
  // sections, keyed, and the style says which ones appear and in what order.
  const bodySections: Record<SectionKey, string> = {
    quote: `
<section class="section section--quote" id="quote">
  <div class="wrap quote-wrap">
    <div class="quote-intro">
      <span class="eyebrow">${esc(sectionCopy(plan, 'hero', 'eyebrow', 'Start a conversation'))}</span>
      <h2>${twoTone(plan.hero.formHeading, spec.twoTone)}</h2>
      <p>${esc(clean(plan.hero.sub))}</p>
    </div>
    ${formMarkup({
      plan,
      id: 'heroForm',
      heading: plan.hero.formHeading,
      button: plan.hero.formButtonLabel,
      subject: facts.heroFormSubject,
      key: facts.web3formsKey,
      headingLevel: 3,
    })}
  </div>
</section>
`,
    /*
     * ONE QUIET LINE, NOT FOUR CARDS.
     *
     * This was a bordered grid of four cards, each with an icon, a bold label and a line of
     * detail, and it rendered as a tall panel immediately under the hero: the second thing on
     * every page and one of the largest, for content that is genuinely a footnote. Licensed and
     * insured is worth saying once, quietly, on the way past.
     *
     * The detail line is dropped rather than shrunk. Four labels read in a second; four labels
     * each with a subtitle is a paragraph pretending to be a strip.
     */
    trust: `
<section class="trust-bar" data-gp="trust_strip">
  <div class="wrap trust-line">
    ${plan.trustStrip
      .map(
        (item, i) =>
          `<span class="trust-note">${icon([ICON_SHIELD, ICON_CLOCK, ICON_TICK, ICON_PIN][i % 4]!)}${esc(clean(item.label))}</span>`,
      )
      .join('\n    ')}
  </div>
</section>

`,
    about: `
<section class="section" id="about" data-gp="about">
  <div class="wrap about-grid">
    <div class="about__copy">
      <span class="eyebrow">${esc(sectionCopy(plan, 'about', 'eyebrow', 'About us'))}</span>
      <h2>${twoTone(plan.about.heading, spec.twoTone)}</h2>
      ${plan.about.body.map((b) => `<p>${esc(clean(b))}</p>`).join('\n      ')}
      <blockquote class="pull-quote">${esc(clean(plan.about.pullQuote))}</blockquote>
      ${
        /*
         * THE NUMBERS LIVE HERE NOW, AS A LINE UNDER THE STORY.
         *
         * They used to own a full-width band of their own, animated counters and all, which made
         * "10+ years" and "free quotes" the tallest thing between two sections that were actually
         * about the business. They are supporting evidence for the paragraph above them, not a
         * chapter, so they read as one quiet row at the end of it.
         */
        /*
         * NEVER A REVIEW COUNT HERE.
         *
         * The about panel said "5 Customer Reviews" while the Google line further down the same
         * page said 29. Both were honest about what they counted, and neither said so: one was
         * the number of quotes the customer typed into the intake, the other the real total on
         * their Google profile. A reader does not see two definitions, they see a site that
         * cannot keep its story straight, on the one number a tradie is judged by.
         *
         * Only the Google figure is a review count worth printing, because it is theirs, it is
         * checkable, and it links to the profile it came from. Counting the testimonials we were
         * handed and calling that a review count is a number we made up. Filtered here rather
         * than only asked for in the prompt, because a house rule is a hope.
         */
        visibleStats.length > 0
          ? `<dl class="about__figures">
        ${visibleStats
          .map(
            (st) =>
              `<div><dt>${st.value}${esc(st.suffix)}</dt><dd>${esc(clean(st.label))}</dd></div>`,
          )
          .join('\n        ')}
      </dl>`
          : ''
      }
      <div class="about__actions">
        <a class="btn btn--primary" href="#contact">${esc(clean(plan.hero.ctaSecondary.label))}</a>
        <a class="btn btn--outline" href="#services">${esc(label(plan, 'about.servicesLink'))}</a>
      </div>
    </div>
    <div class="about__media">
      ${
        aboutPhoto
          ? picture({
              webp: aboutPhoto.webWebp,
              jpeg: aboutPhoto.webJpeg,
              alt: clean(`${plan.brand.businessName} on the job in ${plan.meta.geoPlacename}`),
              width: aboutPhoto.width,
              height: aboutPhoto.height,
              sizes: '(min-width:900px) 50vw, 100vw',
            })
          : `<!-- CLIENT TO SUPPLY: a photo of the owner or the team for the about section. -->`
      }
    </div>
  </div>
</section>

`,
    services: `
<section class="section section--alt" id="services" data-gp="services">
  <div class="wrap">
    ${sectionHead({
      eyebrow: sectionCopy(plan, 'services', 'eyebrow', 'What we do'),
      heading: sectionCopy(plan, 'services', 'heading', 'What we do, and how we work'),
      blurb: sectionCopy(
        plan,
        'services',
        'blurb',
        `Practical, carefully managed work across ${plan.meta.geoPlacename} and the surrounding suburbs.`,
      ),
      spec,
    })}
    <div class="grid grid--3">
      ${plan.services
        .map(
          (s, i) => `<article class="card">
        <span class="card__num">${String(i + 1).padStart(2, '0')}</span>
        <span class="card__icon">${icon([ICON_TOOL, ICON_SHIELD, ICON_CLOCK, ICON_TICK, ICON_PIN, ICON_PHONE][i % 6]!)}</span>
        <h3>${esc(clean(s.name))}</h3>
        <p>${esc(clean(s.blurb))}</p>
        ${(() => {
          /*
           * TO THE PAGE THEY PAID FOR, WHEN THERE IS ONE.
           *
           * Every card pointed at #contact. A customer who bought ten service pages had ten
           * cards on the home page describing those services and not one of them went to the
           * page. The only way in was the nav dropdown, which is the second place anybody
           * looks, and the pages are the thing they actually paid for.
           */
          const page = plan.servicePages.find((sp) => sp.service === s.name)
          return page
            ? `<a class="link-arrow" href="services/${page.slug}/index.html">${esc(label(plan, 'services.cardPageCta'))} ${esc(clean(s.name.toLowerCase()))}${icon(ICON_ARROW)}</a>`
            : `<a class="link-arrow" href="#contact">${esc(label(plan, 'services.cardCta'))}${icon(ICON_ARROW)}</a>`
        })()}
      </article>`,
        )
        .join('\n      ')}
    </div>
  </div>
</section>

`,
    work: `
${
  plan.gallery.enabled
    ? `<section class="section" id="work" data-gp="gallery">
  <div class="wrap">
    ${sectionHead({
      eyebrow: sectionCopy(plan, 'gallery', 'eyebrow', 'Our work'),
      heading: plan.gallery.heading,
      blurb: sectionCopy(plan, 'gallery', 'blurb', 'Real jobs, photographed on site. No stock photography.'),
      spec,
    })}
    <div class="gallery" style="--cols:${plan.layout?.galleryColumns ?? galleryColumns(plan.gallery.items.length)}">
      ${plan.gallery.items
        .map((item) => {
          const photo = facts.photos.find((p) => p.assetId === item.assetId)
          if (!photo) return ''
          return `<figure>${picture({
            webp: photo.thumbWebp,
            jpeg: photo.thumbJpeg,
            alt: clean(item.alt),
            width: photo.width,
            height: photo.height,
            sizes: '(min-width:900px) 33vw, 50vw',
          })}</figure>`
        })
        .join('\n      ')}
    </div>
  </div>
</section>`
    : `<!-- CLIENT TO SUPPLY: three or more job photos so the Our Work gallery can be built. No stock photography has been used. -->`
}

`,
    why: `
<section class="section section--dark" id="why" data-gp="why_us">
  <div class="wrap">
    ${sectionHead({
      eyebrow: sectionCopy(plan, 'why_us', 'eyebrow', 'Why choose us'),
      heading: sectionCopy(plan, 'why_us', 'heading', 'A better experience, from the first call'),
      blurb: sectionCopy(plan, 'why_us', 'blurb', `${plan.whyUs.length} reasons our clients keep working with us.`),
      spec,
      dark: true,
    })}
    <div class="grid grid--4">
      ${plan.whyUs
        .map(
          (w, i) => `<article class="card">
        <span class="card__num">${String(i + 1).padStart(2, '0')}</span>
        <h3>${esc(clean(w.title))}</h3>
        <p>${esc(clean(w.body))}</p>
      </article>`,
        )
        .join('\n      ')}
    </div>
  </div>
</section>

`,
    /*
     * Deliberately empty. The numbers moved into About, and every style's order still lists
     * 'stats', so this stays as a key that renders nothing rather than becoming an undefined
     * lookup in the join below. The marker comment keeps the section addressable for edits.
     */
    stats: `<!-- data-gp="stats": the figures are rendered inside the about section. -->\n`,
    process: `
<section class="section" id="process" data-gp="process">
  <div class="wrap">
    ${sectionHead({
      eyebrow: sectionCopy(plan, 'process', 'eyebrow', 'How it works'),
      heading: sectionCopy(plan, 'process', 'heading', 'A clear path, from first call to finished job'),
      blurb: sectionCopy(plan, 'process', 'blurb', 'Four steps, so you always know what happens next.'),
      spec,
    })}
    <div class="process-grid">
      ${plan.process
        .map(
          (p, i) => `<div class="step">
        <span class="step__num">${String(i + 1).padStart(2, '0')}</span>
        <h3>${esc(clean(p.title))}</h3>
        <p>${esc(clean(p.body))}</p>
      </div>`,
        )
        .join('\n      ')}
    </div>
  </div>
</section>

`,
    areas: `
<section class="section section--alt" id="areas" data-gp="service_areas">
  <div class="wrap areas-grid">
    <div>
      <span class="eyebrow">${esc(sectionCopy(plan, 'service_areas', 'eyebrow', 'Service areas'))}</span>
      <h2>${twoTone(plan.serviceAreas.heading, spec.twoTone)}</h2>
      <p>${esc(clean(plan.serviceAreas.blurb))}</p>
    </div>
    <ul class="suburbs">
      ${plan.serviceAreas.suburbs.map((s) => `<li>${esc(clean(s))}</li>`).join('\n      ')}
    </ul>
  </div>
</section>

`,
    reviews: `
${
  plan.testimonials.enabled && plan.testimonials.items.length > 0
    ? `<section class="section" id="reviews" data-gp="testimonials">
  <div class="wrap">
    ${sectionHead({
      eyebrow: sectionCopy(plan, 'testimonials', 'eyebrow', 'What clients say'),
      heading: plan.testimonials.heading,
      blurb: facts.googleReviewLink ? 'Straight from our Google business profile.' : null,
      spec,
    })}
    ${
      /*
       * The aggregate, when we have it. Rating and count only ever arrive together with a profile
       * link, so this block is either fully checkable or absent. There is deliberately no partial
       * version showing a score with nothing to verify it against.
       */
      facts.googleRating && facts.googleReviewCount
        ? `<div class="rating-badge">
      <svg class="g-mark" viewBox="0 0 24 24" aria-hidden="true">${ICON_GOOGLE_G}</svg>
      <span class="rating-badge__score">${facts.googleRating.toFixed(1)}</span>
      <span class="rating-badge__meta">
        <span class="stars" aria-hidden="true">${icon(ICON_STAR).repeat(Math.round(facts.googleRating))}</span>
        <small>from ${facts.googleReviewCount} review${facts.googleReviewCount === 1 ? '' : 's'} on Google</small>
      </span>
    </div>`
        : ''
    }
    ${(() => {
      /*
       * ONE ROW THAT SCROLLS, RATHER THAN A GRID THAT WRAPS.
       *
       * Five reviews in a three column grid is a row of three and a row of two with a hole
       * beside it, and the hole is the first thing anyone looks at. A rail has no second row.
       *
       * The list is rendered twice and the CSS travels the track exactly half its width, which
       * is what makes the wrap seamless. The second copy is aria-hidden and its links are taken
       * out of the tab order, so a keyboard and a screen reader each meet every review once.
       *
       * Only marquee when there is enough to be worth moving. Three short reviews that fit on
       * screen should sit still; a rail sliding a card and a half back and forth looks broken.
       */
      const card = (q: { quote: string; name: string; suburb: string }) =>
        `<blockquote class="quote">
        <div class="stars" aria-label="5 out of 5">${icon(ICON_STAR).repeat(5)}</div>
        <p>${esc(clean(q.quote))}</p>
        <footer class="quote__who">${esc(clean(q.name))}<span>${esc(clean(q.suburb))}</span></footer>
        ${
          facts.googleReviewLink
            ? `<div class="quote__source"><svg class="g-mark" viewBox="0 0 24 24" aria-hidden="true">${ICON_GOOGLE_G}</svg><span>Posted on Google</span></div>`
            : ''
        }
      </blockquote>`

      const items = plan.testimonials.items
      const moves = items.length >= 4
      const once = items.map(card).join('\n      ')

      return `<div class="reviews-rail">
      <div class="reviews-track"${moves ? ' data-marquee' : ''}>
      ${once}
      ${moves ? `<div class="reviews-clone" aria-hidden="true">${once}</div>` : ''}
      </div>
    </div>`
    })()}
    ${
      // Somewhere to go and check, and somewhere to add one. Both point at the same profile.
      facts.googleReviewLink
        ? `<div class="reviews-cta">
      <a class="btn btn--outline" href="${esc(facts.googleReviewLink)}" target="_blank" rel="noopener">
        <svg class="g-mark" viewBox="0 0 24 24" aria-hidden="true">${ICON_GOOGLE_G}</svg>Read our reviews on Google
      </a>
      <a class="btn btn--ghost" href="${esc(facts.googleReviewLink)}" target="_blank" rel="noopener">Leave a Google review</a>
    </div>`
        : ''
    }
  </div>
</section>`
    : `<!-- No testimonials section: the client supplied no reviews. Nothing has been invented. -->`
}

`,
    faq: `
<section class="section section--alt" id="faq" data-gp="faq">
  <div class="wrap">
    ${sectionHead({
      eyebrow: sectionCopy(plan, 'faq', 'eyebrow', 'Common questions'),
      heading: sectionCopy(plan, 'faq', 'heading', 'Questions, answered'),
      blurb: null,
      spec,
    })}
    <div class="faq">
      ${plan.faq
        .map(
          (f, i) => `<div class="faq-item" data-faq data-open="${i === 0 ? 'true' : 'false'}">
        <button type="button" aria-expanded="${i === 0 ? 'true' : 'false'}">${esc(clean(f.q))}${icon(ICON_CHEVRON)}</button>
        <div class="faq-answer"><p>${esc(clean(f.a))}</p></div>
      </div>`,
        )
        .join('\n      ')}
    </div>
  </div>
</section>

<section class="section cta-band${bandPhoto ? ' cta-band--photo' : ''}" data-gp="cta_band">
  ${
    bandPhoto
      ? `<div class="band__bg"><div data-parallax-layer>${picture({
          webp: bandPhoto.webWebp,
          jpeg: bandPhoto.webJpeg,
          alt: clean(`${plan.brand.businessName} at work in ${plan.meta.geoPlacename}`),
          width: bandPhoto.width,
          height: bandPhoto.height,
          sizes: '100vw',
        })}</div><div class="band__scrim"></div></div>`
      : ''
  }
  <div class="wrap">
    <span class="eyebrow">${esc(sectionCopy(plan, 'cta_band', 'eyebrow', 'Get started'))}</span>
    <h2>${twoTone(plan.ctaBand.heading, spec.twoTone)}</h2>
    <p>${esc(clean(plan.ctaBand.body))}</p>
    <div class="cta-band__actions">
      <a class="btn btn--primary" href="tel:${esc(facts.phoneE164)}">${icon(ICON_PHONE)}${esc(facts.phoneDisplay)}</a>
      <a class="btn btn--ghost" href="#contact">${esc(clean(plan.ctaBand.ctaLabel))}</a>
    </div>
  </div>
</section>

`,
    contact: `
<section class="section" id="contact" data-gp="contact">
  <div class="wrap contact-grid">
    <div>
      <span class="eyebrow">${esc(sectionCopy(plan, 'contact', 'eyebrow', 'Get in touch'))}</span>
      <h2>${twoTone(plan.contact.heading, spec.twoTone)}</h2>
      <p>${esc(clean(plan.contact.blurb))}</p>
      <ul class="contact-list">
        <li>${icon(ICON_PHONE)}<div><b>Phone</b><a href="tel:${esc(facts.phoneE164)}">${esc(facts.phoneDisplay)}</a></div></li>
        <li>${icon(ICON_MAIL)}<div><b>Email</b><a href="mailto:${esc(facts.email)}">${esc(facts.email)}</a></div></li>
        <li>${icon(ICON_PIN)}<div><b>Based in</b><span>${
          facts.address && facts.address.line1
            ? esc(`${facts.address.line1}, ${facts.address.suburb} ${facts.address.state} ${facts.address.postcode}`)
            : esc(`${plan.meta.geoPlacename} and surrounding suburbs`)
        }</span></div></li>
      </ul>
      <h3>${esc(label(plan, 'contact.hours'))}</h3>
      ${plan.assumptions.some((a) => /hours/i.test(a)) ? '<!-- CONFIRM WITH CLIENT BEFORE LAUNCH: these are our default trade hours, the client did not set them. -->' : ''}
      <ul class="hours">
        ${facts.hoursLines.map((l) => `<li>${esc(l)}</li>`).join('\n        ')}
      </ul>
      ${
        plan.schema.sameAs.length > 0
          ? `<div class="socials">${plan.schema.sameAs
              .map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(socialLabel(u))}</a>`)
              .join('')}</div>`
          : ''
      }
    </div>
    ${formMarkup({
      plan,
      id: 'contactForm',
      heading: plan.contact.formHeading,
      button: plan.contact.formButtonLabel,
      subject: facts.contactFormSubject,
      key: facts.web3formsKey,
      headingLevel: 3,
      eyebrow: sectionCopy(plan, 'contact', 'eyebrow', 'Send an enquiry'),
    })}
  </div>
</section>
`,
  }

  // A style whose hero holds the form must not also render the standalone quote section, or
  // the page gets the same card twice under two headings. Enforced here rather than trusted to
  // the data, because the spec is hand written and this is a silent duplication if it is wrong.
  const orderedBody = spec.layout.order
    .filter((key) => key !== 'quote' || !spec.layout.heroForm)
    .map((key) => bodySections[key])
    .join(`\n`)

  // The tab icon and the share card. See headMeta.ts for why both were missing.
  const headMeta = headMetaTags(plan, facts, { esc })

  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(clean(plan.meta.title))}</title>
<meta name="description" content="${esc(clean(plan.meta.metaDescription))}">
<link rel="canonical" href="${esc(facts.canonicalUrl)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(clean(plan.meta.ogTitle))}">
<meta property="og:description" content="${esc(clean(plan.meta.ogDescription))}">
<meta property="og:url" content="${esc(facts.canonicalUrl)}">
<meta property="og:locale" content="en_AU">
${headMeta.social}
<meta name="geo.region" content="${esc(plan.meta.geoRegion)}">
<meta name="geo.placename" content="${esc(plan.meta.geoPlacename)}">
<meta name="geo.position" content="${plan.meta.geoPosition.lat};${plan.meta.geoPosition.lng}">
<meta name="ICBM" content="${plan.meta.geoPosition.lat}, ${plan.meta.geoPosition.lng}">
<meta name="theme-color" content="${t.primary}">
${headMeta.icons}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${spec.fontsQuery}&display=swap">
<script type="application/ld+json">
${JSON.stringify(jsonLd, null, 2)}
</script>
<style>
${stylesheet(plan, spec, surfaces)}
</style>
</head>
<body>
${assumptionComments}
${supplyComments}
${styleComments}
<header class="site-header" id="siteHeader" data-gp="header">
  <div class="wrap site-header__inner">
    ${brandMarkup(plan, facts)}
    <nav class="nav" aria-label="Main">
      ${navMarkup(navItems, serviceLinks)}
    </nav>
    <a class="btn btn--primary header__cta" href="tel:${esc(facts.phoneE164)}">${icon(ICON_PHONE)}${esc(facts.phoneDisplay)}</a>
    <button class="menu-toggle" id="menuToggle" aria-expanded="false" aria-controls="mobilePanel" aria-label="Open menu">${icon(ICON_MENU)}</button>
  </div>
</header>
<div class="mobile-panel" id="mobilePanel" data-open="false">
  ${navMarkup(navItems, serviceLinks, true)}
  <a class="btn btn--solid btn--block" href="tel:${esc(facts.phoneE164)}">${esc(clean(plan.hero.ctaPrimary.label))}</a>
</div>

${heroMarkup(plan, facts, spec)}
${orderedBody}

<footer class="site-footer" data-gp="footer">
  <div class="wrap">
    <div class="footer-grid">
      <div>
        ${
          plan.brand.logoTreatment !== 'css-logotype' && facts.logo
            ? `<img class="site-footer__logo" src="${esc(facts.logo.path)}" alt="${esc(plan.brand.businessName)} logo" width="${logoBox(facts.logo, 56, 280).width}" height="${logoBox(facts.logo, 56, 280).height}">`
            : `<p class="brand__name">${esc(plan.brand.wordmarkText)}</p>`
        }
        <p class="site-footer__blurb">${esc(clean(plan.brand.tagline))}</p>
      </div>
      <div>
        <h4>${esc(label(plan, 'footer.services'))}</h4>
        <ul>
          ${plan.services
            .slice(0, 5)
            .map((s) => `<li><a href="#services">${esc(clean(s.name))}</a></li>`)
            .join('\n          ')}
        </ul>
      </div>
      <div>
        <h4>${esc(label(plan, 'footer.company'))}</h4>
        <ul>
          ${navItems.map((n) => `<li><a href="${n.href}">${esc(n.label)}</a></li>`).join('\n          ')}
        </ul>
      </div>
      <div>
        <h4>Contact</h4>
        <ul>
          <li><a href="tel:${esc(facts.phoneE164)}">${esc(facts.phoneDisplay)}</a></li>
          <li><a href="mailto:${esc(facts.email)}">${esc(facts.email)}</a></li>
          <li>${esc(plan.meta.geoPlacename)}</li>
        </ul>
      </div>
    </div>
    <div class="footer-bottom">
      <span>&copy; ${new Date().getUTCFullYear()} ${esc(plan.brand.businessName)}.${facts.abn ? ` ABN ${esc(facts.abn)}.` : ''}</span>
      <span><a href="https://www.itscold.com.au" target="_blank" rel="noopener">Website by Go Polar Creative</a></span>
    </div>
  </div>
</footer>

<div class="mobile-bar">
  <a href="tel:${esc(facts.phoneE164)}">${icon(ICON_PHONE)}${esc(label(plan, 'mobileBar.call'))}</a>
  <a href="#contact">${esc(clean(plan.hero.ctaSecondary.label))}</a>
</div>
<script>
(function(){
  "use strict";
  var header=document.getElementById("siteHeader");
  var toggle=document.getElementById("menuToggle");
  var panel=document.getElementById("mobilePanel");

  if(header){
    var onScroll=function(){
      if(window.scrollY>60){header.classList.add("site-header--solid");}
      else{header.classList.remove("site-header--solid");}
    };
    window.addEventListener("scroll",onScroll,{passive:true});
    onScroll();
  }

  if(toggle&&panel){
    var setOpen=function(open){
      panel.setAttribute("data-open",open?"true":"false");
      toggle.setAttribute("aria-expanded",open?"true":"false");
    };
    toggle.addEventListener("click",function(){
      setOpen(panel.getAttribute("data-open")!=="true");
    });
    panel.addEventListener("click",function(e){
      if(e.target&&e.target.tagName==="A"){setOpen(false);}
    });
    document.addEventListener("keydown",function(e){
      if(e.key==="Escape"){setOpen(false);}
    });
  }

  var reduce=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var counters=Array.prototype.slice.call(document.querySelectorAll("[data-count]"));
  if(counters.length&&"IntersectionObserver"in window&&!reduce){
    counters.forEach(function(el){el.textContent="0";});
    var observer=new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if(!entry.isIntersecting){return;}
        var el=entry.target;
        observer.unobserve(el);
        var target=parseInt(el.getAttribute("data-count"),10)||0;
        var started=null;
        var step=function(ts){
          if(started===null){started=ts;}
          var progress=Math.min((ts-started)/1200,1);
          el.textContent=String(Math.round(target*progress));
          if(progress<1){window.requestAnimationFrame(step);}
          else{el.textContent=String(target);}
        };
        window.requestAnimationFrame(step);
      });
    },{threshold:0.4});
    counters.forEach(function(el){observer.observe(el);});
  }

  var headerHeight=header?header.offsetHeight:0;
  Array.prototype.slice.call(document.querySelectorAll('a[href^="#"]')).forEach(function(link){
    link.addEventListener("click",function(e){
      var id=link.getAttribute("href");
      if(!id||id==="#"){return;}
      var target=document.querySelector(id);
      if(!target){return;}
      e.preventDefault();
      var top=target.getBoundingClientRect().top+window.pageYOffset-headerHeight;
      window.scrollTo({top:top,behavior:reduce?"auto":"smooth"});
    });
  });

  Array.prototype.slice.call(document.querySelectorAll("form[data-web3form]")).forEach(function(form){
    var status=form.querySelector(".form-status");
    var button=form.querySelector("button[type=submit]");
    form.addEventListener("submit",function(e){
      e.preventDefault();
      if(!status||!button){return;}
      var original=button.textContent;
      button.disabled=true;
      button.textContent="Sending";
      status.removeAttribute("data-state");
      status.textContent="";
      fetch("https://api.web3forms.com/submit",{
        method:"POST",
        headers:{"Accept":"application/json"},
        body:new FormData(form)
      }).then(function(res){return res.json();}).then(function(data){
        if(data&&data.success){
          form.innerHTML='<h3>Thanks, that has come through.</h3><p>We will be in touch shortly. If it is urgent, ring us instead.</p>';
        }else{
          throw new Error("submit failed");
        }
      }).catch(function(){
        status.setAttribute("data-state","error");
        status.textContent="That did not send. Please ring us instead and we will sort it.";
        button.disabled=false;
        button.textContent=original;
      });
    });
  });

  var reduced=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if(!reduced&&"IntersectionObserver" in window){
    var targets=Array.prototype.slice.call(document.querySelectorAll(".section, .trust-bar, .cta-band"));
    if(targets.length){
      document.documentElement.setAttribute("data-reveal","");
      targets.forEach(function(el){el.classList.add("reveal");});
      var io=new IntersectionObserver(function(entries){
        entries.forEach(function(entry){
          if(!entry.isIntersecting){return;}
          entry.target.classList.add("is-in");
          io.unobserve(entry.target);
        });
      },{rootMargin:"0px 0px -12% 0px",threshold:0.05});
      targets.forEach(function(el){io.observe(el);});
    }
  }

  var parallaxLayers=Array.prototype.slice.call(document.querySelectorAll("[data-parallax-layer]"));
  if(parallaxLayers.length&&!reduced){
    document.documentElement.setAttribute("data-parallax","");
    var ticking=false;
    var place=function(){
      ticking=false;
      for(var i=0;i<parallaxLayers.length;i++){
        var el=parallaxLayers[i];
        var host=el.parentElement&&el.parentElement.parentElement;
        if(!host){continue;}
        var box=host.getBoundingClientRect();
        if(box.bottom<-200||box.top>window.innerHeight+200){continue;}
        var progress=(window.innerHeight-box.top)/(window.innerHeight+box.height);
        var shift=(progress-0.5)*box.height*0.22;
        el.style.transform="translate3d(0,"+shift.toFixed(1)+"px,0)";
      }
    };
    var onScrollParallax=function(){
      if(ticking){return;}
      ticking=true;
      window.requestAnimationFrame(place);
    };
    place();
    window.addEventListener("scroll",onScrollParallax,{passive:true});
    window.addEventListener("resize",onScrollParallax,{passive:true});
  }
})();
</script>
</body>
</html>`
}

function socialLabel(url: string): string {
  const host = url.replace(/^https?:\/\//, '').split('/')[0] ?? url
  if (host.includes('facebook')) return 'Facebook'
  if (host.includes('instagram')) return 'Instagram'
  if (host.includes('linkedin')) return 'LinkedIn'
  if (host.includes('tiktok')) return 'TikTok'
  if (host.includes('youtube')) return 'YouTube'
  return host
}

// ---------------------------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------------------------

function buildJsonLd(plan: ContentPlan, facts: BuildFacts): Record<string, unknown> {
  const url = facts.canonicalUrl
  const business: Record<string, unknown> = {
    '@type': plan.schema.businessType,
    '@id': `${url}#business`,
    name: plan.brand.businessName,
    url,
    telephone: facts.phoneE164,
    email: facts.email,
    description: clean(plan.meta.metaDescription),
    address: facts.address
      ? {
          '@type': 'PostalAddress',
          streetAddress: facts.address.line1,
          addressLocality: facts.address.suburb,
          addressRegion: facts.address.state,
          postalCode: facts.address.postcode,
          addressCountry: 'AU',
        }
      : {
          '@type': 'PostalAddress',
          addressLocality: plan.meta.geoPlacename,
          addressRegion: plan.meta.geoRegion.replace('AU-', ''),
          addressCountry: 'AU',
        },
    geo: {
      '@type': 'GeoCoordinates',
      latitude: plan.meta.geoPosition.lat,
      longitude: plan.meta.geoPosition.lng,
    },
    areaServed:
      plan.schema.areaServed.mode === 'city'
        ? plan.schema.areaServed.cities.map((c) => ({ '@type': 'City', name: c }))
        : {
            '@type': 'GeoCircle',
            geoMidpoint: {
              '@type': 'GeoCoordinates',
              latitude: plan.schema.areaServed.lat,
              longitude: plan.schema.areaServed.lng,
            },
            geoRadius: String(plan.schema.areaServed.radiusMetres),
          },
  }

  if (facts.openingHoursSpec.length > 0) {
    business.openingHoursSpecification = facts.openingHoursSpec.map((s) => ({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: s.days,
      opens: s.opens,
      closes: s.closes,
    }))
  }
  if (plan.schema.sameAs.length > 0) business.sameAs = plan.schema.sameAs
  if (facts.logo) business.image = `${url}${facts.logo.path}`

  return {
    '@context': 'https://schema.org',
    '@graph': [
      business,
      {
        '@type': 'WebSite',
        '@id': `${url}#website`,
        url,
        name: plan.brand.businessName,
        inLanguage: 'en-AU',
        publisher: { '@id': `${url}#business` },
      },
      {
        '@type': 'FAQPage',
        '@id': `${url}#faq`,
        mainEntity: plan.faq.map((f) => ({
          '@type': 'Question',
          name: clean(f.q),
          acceptedAnswer: { '@type': 'Answer', text: clean(f.a) },
        })),
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumb`,
        itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: url }],
      },
    ],
  }
}
