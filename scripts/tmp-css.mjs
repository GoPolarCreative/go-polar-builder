import { readFileSync, writeFileSync } from 'node:fs'

const p = 'server/lib/render/site.ts'
const src = readFileSync(p, 'utf8')
const lines = src.split('\n')

// Replace from `interface Surfaces` (the surfaces block) through the end of heroMarkup.
const start = lines.findIndex((l) => l.startsWith('interface Surfaces'))
const heroStart = lines.findIndex((l) => l.startsWith('function heroMarkup'))
let end = heroStart
let depth = 0
let seen = false
for (let i = heroStart; i < lines.length; i++) {
  for (const ch of lines[i]) {
    if (ch === '{') { depth++; seen = true }
    else if (ch === '}') depth--
  }
  if (seen && depth === 0) { end = i; break }
}
if (start < 0 || heroStart < 0) throw new Error('markers not found')

const block = String.raw`interface Surfaces {
  /** Token name used for large dark areas. */
  darkBlock: 'primary' | 'ink'
  /** Whether alternating sections are tinted. */
  altTinted: boolean
}

function resolveSurfaces(plan: ContentPlan, spec: StyleSpec): Surfaces {
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
function stylesheet(plan: ContentPlan, spec: StyleSpec, surfaces: Surfaces): string {
  const t = plan.tokens
  const dark = surfaces.darkBlock === 'ink' ? 'var(--ink)' : 'var(--primary)'
  const onDarkPage = spec.rhythm === 'dark-on-dark'

  // Every colour in the document is declared here and nowhere else, which is house rule 2 and
  // static check 1. The style values live here too so the rest of the sheet reads as intent.
  const root = ':root{\n' +
    '--primary:' + t.primary + ';\n' +
    '--primary-dark:' + t.primaryDark + ';\n' +
    '--primary-light:' + t.primaryLight + ';\n' +
    '--accent:' + t.accent + ';\n' +
    '--ink:' + t.ink + ';\n' +
    '--ink-muted:' + t.inkMuted + ';\n' +
    '--surface:' + t.surface + ';\n' +
    '--surface-alt:' + t.surfaceAlt + ';\n' +
    '--line:' + t.line + ';\n' +
    '--white:' + t.white + ';\n' +
    '--black:' + t.black + ';\n' +
    '--success:' + t.success + ';\n' +
    '--shadow-soft:rgba(16,24,32,0.10);\n' +
    '--shadow-medium:rgba(16,24,32,0.16);\n' +
    '--on-primary:var(--white);\n' +
    '--on-dark:var(--white);\n' +
    '--dark-block:' + dark + ';\n' +
    // The hero scrim, as three stops so the copy side is readable and the photo still reads.
    '--scrim-1:rgba(0,0,0,' + spec.heroOverlay[0] + ');\n' +
    '--scrim-2:rgba(0,0,0,' + spec.heroOverlay[1] + ');\n' +
    '--scrim-3:rgba(0,0,0,' + spec.heroOverlay[2] + ');\n' +
    // Page ground. A dark-on-dark style inverts the whole document rather than one section.
    '--page-bg:' + (onDarkPage ? 'var(--ink)' : 'var(--surface)') + ';\n' +
    '--page-fg:' + (onDarkPage ? 'var(--white)' : 'var(--ink)') + ';\n' +
    '--page-muted:' + (onDarkPage ? 'rgba(255,255,255,0.68)' : 'var(--ink-muted)') + ';\n' +
    '--alt-bg:' + (onDarkPage ? 'var(--primary-dark)' : surfaces.altTinted ? 'var(--surface-alt)' : 'var(--surface)') + ';\n' +
    '--card-bg:' + (onDarkPage ? 'var(--primary-dark)' : 'var(--surface)') + ';\n' +
    '--card-fg:' + (onDarkPage ? 'var(--white)' : 'var(--ink)') + ';\n' +
    '--card-line:' + (onDarkPage ? 'var(--accent)' : 'var(--line)') + ';\n' +
    '--hairline:' + (onDarkPage ? 'rgba(255,255,255,0.14)' : 'var(--line)') + ';\n' +
    '--font-head:' + spec.headingFamily + ';\n' +
    '--font-body:' + spec.bodyFamily + ';\n' +
    '--weight-head:' + spec.headingWeight + ';\n' +
    '--track-head:' + spec.headingTracking + ';\n' +
    '--track-btn:' + spec.buttonTracking + ';\n' +
    '--track-eyebrow:' + spec.eyebrowTracking + ';\n' +
    '--eyebrow-size:' + spec.eyebrowSize + ';\n' +
    '--h1:' + spec.scale.h1 + ';\n' +
    '--h2:' + spec.scale.h2 + ';\n' +
    '--h3:' + spec.scale.h3 + ';\n' +
    '--step-body:' + spec.scale.body + ';\n' +
    '--step-lead:' + spec.scale.lead + ';\n' +
    '--section-pad:' + spec.spacing.sectionMobile + ';\n' +
    '--section-pad-lg:' + spec.spacing.sectionDesktop + ';\n' +
    '--gap:' + spec.spacing.gap + ';\n' +
    '--measure:' + spec.spacing.measure + ';\n' +
    '--radius:' + spec.radius.card + ';\n' +
    '--radius-btn:' + spec.radius.button + ';\n' +
    '--radius-input:' + spec.radius.input + ';\n' +
    '--shadow-card:' + spec.shadow.card + ';\n' +
    '--shadow-raised:' + spec.shadow.raised + ';\n' +
    '--shadow-hover:' + spec.shadow.hover + ';\n' +
    '--border-hairline:' + spec.border.hairline + ';\n' +
    '--border-strong:' + spec.border.strong + ';\n' +
    '--header-h:76px;\n' +
    '--wrap:1200px;\n' +
    '}'

  const base = `*,*::before,*::after{box-sizing:border-box;}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth;}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto;}*{animation:none!important;transition:none!important;}}
body{margin:0;font-family:var(--font-body);font-size:var(--step-body);line-height:1.65;color:var(--page-fg);background:var(--page-bg);-webkit-font-smoothing:antialiased;}
img{max-width:100%;display:block;}
a{color:inherit;}
h1,h2,h3,h4{font-family:var(--font-head);font-weight:var(--weight-head);line-height:1.08;letter-spacing:var(--track-head);margin:0 0 1rem;${spec.headingTransform === 'uppercase' ? 'text-transform:uppercase;' : ''}}
h1{font-size:var(--h1);}
h2{font-size:var(--h2);}
h3{font-size:var(--h3);line-height:1.25;}
p{margin:0 0 1rem;}
/* The two-tone heading device: the payoff phrase of a heading, set in the accent colour. */
em{font-style:normal;color:var(--accent);}
.wrap{width:100%;max-width:var(--wrap);margin:0 auto;padding:0 20px;}
.section{padding:var(--section-pad) 0;}
@media (min-width:900px){.section{padding:var(--section-pad-lg) 0;}}
.section--alt{background:var(--alt-bg);}
.section--dark{background:var(--dark-block);color:var(--on-dark);}
.section--dark h2,.section--dark h3{color:var(--on-dark);}
.section--dark p{color:rgba(255,255,255,0.72);}
.eyebrow{display:block;color:var(--accent);text-transform:uppercase;letter-spacing:var(--track-eyebrow);font-size:var(--eyebrow-size);font-weight:700;margin:0 0 14px;}
.section-head{margin-bottom:2.5rem;${spec.headingAlign === 'centred' ? 'text-align:center;' : ''}}
.section-head p{color:var(--page-muted);max-width:var(--measure);font-size:var(--step-lead);${spec.headingAlign === 'centred' ? 'margin-left:auto;margin-right:auto;' : ''}}
.section--dark .section-head p{color:rgba(255,255,255,0.7);}
.icon{width:22px;height:22px;flex:0 0 auto;}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}`

  const buttons = `.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:var(--border-hairline) solid transparent;border-radius:var(--radius-btn);padding:14px 26px;font-family:var(--font-body);font-size:0.95rem;font-weight:700;letter-spacing:var(--track-btn);${spec.buttonTransform === 'uppercase' ? 'text-transform:uppercase;' : ''}text-decoration:none;cursor:pointer;transition:transform .2s ease,background-color .2s ease,box-shadow .2s ease,color .2s ease;}
.btn--primary{background:var(--accent);color:var(--on-primary);border-color:var(--accent);}
.btn--primary:hover{transform:translateY(-2px);box-shadow:var(--shadow-raised);}
.btn--dark{background:var(--dark-block);color:var(--on-dark);border-color:var(--dark-block);}
.btn--dark:hover{transform:translateY(-2px);}
.btn--ghost{background:transparent;color:var(--on-dark);border-color:rgba(255,255,255,0.5);}
.btn--ghost:hover{background:rgba(255,255,255,0.1);border-color:var(--white);transform:translateY(-2px);}
.btn--outline{background:transparent;color:var(--page-fg);border-color:var(--page-fg);}
.btn--outline:hover{background:var(--page-fg);color:var(--page-bg);}
.btn--block{width:100%;}
/* A phrase with an arrow. The arrow moves on hover, not the text, so nothing reflows. */
.link-arrow{display:inline-flex;align-items:center;gap:7px;color:var(--page-fg);font-size:0.8rem;font-weight:700;text-decoration:none;text-transform:uppercase;letter-spacing:0.06em;}
.link-arrow .icon{width:16px;height:16px;color:var(--accent);transition:transform .2s ease;}
.link-arrow:hover .icon{transform:translateX(4px);}
.section--dark .link-arrow{color:var(--on-dark);}`

  const header = `.site-header{position:fixed;top:0;left:0;right:0;z-index:60;height:var(--header-h);display:flex;align-items:center;transition:background-color .3s ease,box-shadow .3s ease;${spec.header === 'solid-dark' ? 'background:var(--dark-block);' : ''}}
.site-header--solid{background:var(--dark-block);box-shadow:var(--shadow-raised);}
.site-header__inner{display:flex;align-items:center;justify-content:space-between;gap:1rem;width:100%;}
.brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--on-dark);}
.brand__mark{width:40px;height:40px;border-radius:var(--radius-btn);background:var(--accent);color:var(--on-primary);display:grid;place-items:center;font-family:var(--font-head);font-size:1.15rem;}
.brand__logo{max-height:42px;width:auto;}
.brand__name{font-family:var(--font-head);font-size:1.2rem;letter-spacing:var(--track-head);${spec.headingTransform === 'uppercase' ? 'text-transform:uppercase;' : ''}}
.nav{display:none;gap:4px;}
.nav a{text-decoration:none;font-size:0.92rem;font-weight:500;padding:8px 12px;border-radius:var(--radius-btn);color:rgba(255,255,255,0.78);transition:color .2s ease,background-color .2s ease;}
.nav a:hover{color:var(--white);background:rgba(255,255,255,0.08);}
.header__actions{display:none;align-items:center;gap:14px;}
.header__phone{color:rgba(255,255,255,0.8);text-decoration:none;font-weight:600;font-size:0.9rem;display:inline-flex;align-items:center;gap:7px;}
.header__phone:hover{color:var(--white);}
.menu-toggle{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:var(--radius-btn);width:44px;height:44px;cursor:pointer;background:rgba(255,255,255,0.1);color:var(--white);}
.mobile-panel{position:fixed;inset:var(--header-h) 0 auto 0;background:var(--dark-block);padding:1rem 20px 1.5rem;display:none;z-index:55;}
.mobile-panel[data-open="true"]{display:block;}
.mobile-panel a{display:block;padding:12px 0;color:var(--on-dark);text-decoration:none;border-bottom:1px solid rgba(255,255,255,0.12);font-weight:500;}
@media (min-width:980px){.nav{display:flex;}.header__actions{display:flex;}.menu-toggle{display:none;}}`

  // The hero every one of the four reference sites builds: full-bleed photo, dark gradient scrim
  // over it, copy left, enquiry form card right, trust points under the copy.
  const hero = `.hero{position:relative;display:flex;align-items:center;min-height:660px;overflow:hidden;background:var(--dark-block);color:var(--white);padding:calc(var(--header-h) + 3rem) 0 3.5rem;}
.hero__bg{position:absolute;inset:0;}
.hero__bg picture,.hero__bg img{width:100%;height:100%;object-fit:cover;}
.hero__scrim{position:absolute;inset:0;background:linear-gradient(100deg,var(--scrim-1) 0%,var(--scrim-2) 55%,var(--scrim-3) 100%);}
.hero__glow{position:absolute;right:-6%;top:4%;width:640px;height:640px;border-radius:50%;background:radial-gradient(circle,var(--accent),transparent 68%);opacity:0.16;pointer-events:none;}
.hero__inner{position:relative;z-index:1;display:grid;gap:2.5rem;align-items:center;}
.hero h1{color:var(--white);margin-bottom:1.25rem;max-width:16ch;}
.hero__sub{font-size:var(--step-lead);color:rgba(255,255,255,0.72);max-width:52ch;line-height:1.7;}
.hero__ctas{display:flex;flex-wrap:wrap;gap:14px;margin:1.75rem 0 1.5rem;}
.hero__points{display:flex;flex-wrap:wrap;gap:10px 22px;list-style:none;padding:0;margin:0;}
.hero__points li{display:flex;align-items:center;gap:8px;font-size:0.82rem;font-weight:500;color:rgba(255,255,255,0.66);}
.hero__points .icon{width:16px;height:16px;color:var(--accent);}
@media (min-width:1000px){.hero__inner{grid-template-columns:1fr 440px;gap:3.75rem;}.hero h1{max-width:none;}}`

  // The enquiry card. On a dark-on-dark style it is a panel outlined in the accent; everywhere
  // else it is a white card lifted off the photo.
  const outlinedCard = spec.card === 'outlined-dark'
  const form = `.card-form{background:${outlinedCard ? 'var(--primary-dark)' : 'var(--surface)'};color:${outlinedCard ? 'var(--white)' : 'var(--ink)'};border:${outlinedCard ? 'var(--border-hairline) solid var(--accent)' : '0'};border-radius:var(--radius);padding:1.75rem;box-shadow:var(--shadow-raised);}
.card-form h2,.card-form h3{margin-bottom:1.25rem;color:${outlinedCard ? 'var(--white)' : 'var(--ink)'};}
.field{display:block;margin-bottom:0.9rem;}
.field span{display:block;font-weight:600;font-size:0.78rem;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;color:${outlinedCard ? 'rgba(255,255,255,0.7)' : 'var(--ink-muted)'};}
.field input,.field textarea{width:100%;padding:12px 14px;border:1px solid ${outlinedCard ? 'rgba(255,255,255,0.18)' : 'var(--line)'};border-radius:var(--radius-input);font:inherit;font-size:0.95rem;background:${outlinedCard ? 'rgba(255,255,255,0.05)' : 'var(--surface)'};color:${outlinedCard ? 'var(--white)' : 'var(--ink)'};}
.field input:focus,.field textarea:focus{outline:2px solid var(--accent);outline-offset:1px;}
.field textarea{min-height:96px;resize:vertical;}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;}
.form-note{font-size:0.78rem;color:${outlinedCard ? 'rgba(255,255,255,0.55)' : 'var(--ink-muted)'};margin:0.75rem 0 0;}
.form-status{margin-top:0.75rem;font-weight:600;font-size:0.9rem;}
.form-status[data-state="ok"]{color:var(--success);}
.form-status[data-state="error"]{color:var(--accent);}`

  // Trust bar: four items with rules between them, straight under the hero.
  const trust = `.trust-bar{background:${onDarkPage ? 'var(--primary-dark)' : 'var(--alt-bg)'};border-bottom:1px solid var(--hairline);}
.trust-grid{display:grid;grid-template-columns:repeat(2,1fr);}
.trust-item{display:flex;align-items:center;gap:12px;padding:18px 20px;border-right:1px solid var(--hairline);border-bottom:1px solid var(--hairline);}
.trust-item .icon{color:var(--accent);}
.trust-item b{display:block;font-size:0.85rem;font-weight:700;}
.trust-item small{display:block;font-size:0.75rem;color:var(--page-muted);margin-top:2px;}
@media (min-width:900px){.trust-grid{grid-template-columns:repeat(4,1fr);}.trust-item{border-bottom:0;}.trust-item:last-child{border-right:0;}}`

  const cardSkin = {
    'outlined-dark': 'background:var(--primary-dark);border:var(--border-hairline) solid var(--accent);',
    'soft-light': 'background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow-card);',
    'warm-bordered': 'background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow-card);',
    'flat-tinted': 'background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow-card);',
  }[spec.card]

  const cards = `.grid{display:grid;gap:var(--gap);}
@media (min-width:700px){.grid--2{grid-template-columns:repeat(2,1fr);}.grid--3{grid-template-columns:repeat(2,1fr);}.grid--4{grid-template-columns:repeat(2,1fr);}}
@media (min-width:1000px){.grid--3{grid-template-columns:repeat(3,1fr);}.grid--4{grid-template-columns:repeat(4,1fr);}}
.card{position:relative;display:flex;flex-direction:column;padding:1.75rem;border-radius:var(--radius);color:var(--card-fg);${cardSkin}transition:transform .2s ease,box-shadow .2s ease,border-color .2s ease;}
.card:hover{transform:translateY(-5px);box-shadow:var(--shadow-hover);border-color:var(--accent);}
.card h3{margin-bottom:0.6rem;}
.card p{color:${onDarkPage ? 'rgba(255,255,255,0.66)' : 'var(--ink-muted)'};font-size:0.94rem;margin-bottom:1rem;}
.card__icon{display:grid;place-items:center;width:46px;height:46px;border-radius:${spec.radius.card === '0px' ? '0' : '12px'};background:${onDarkPage ? 'rgba(255,255,255,0.06)' : 'var(--surface-alt)'};color:var(--accent);margin-bottom:1.1rem;}
.card__icon .icon{width:22px;height:22px;}
.card .link-arrow{margin-top:auto;color:var(--card-fg);}
${spec.cardNumber === 'corner-small' ? '.card__num{position:absolute;right:18px;top:16px;font-family:var(--font-head);font-size:0.78rem;font-weight:700;color:var(--page-muted);opacity:0.65;}' : ''}
${spec.cardNumber === 'large-faint' ? '.card__num{font-family:var(--font-head);font-size:2.6rem;font-weight:var(--weight-head);line-height:1;color:var(--accent);opacity:0.28;margin-bottom:0.6rem;}' : ''}
${spec.cardNumber === 'none' ? '.card__num{display:none;}' : ''}`

  // The stat band: full-width, large figures over small caps labels.
  const accentBand = spec.statBand === 'accent'
  const stats = `.stats-band{background:${accentBand ? 'var(--accent)' : 'var(--dark-block)'};color:${accentBand ? 'var(--ink)' : 'var(--on-dark)'};padding:2.5rem 0;}
.stats-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:1.5rem;}
.stat{padding:0 1.5rem;border-right:1px solid ${accentBand ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.18)'};}
.stat:last-child{border-right:0;}
.stat strong{display:block;font-family:var(--font-head);font-size:2.7rem;font-weight:var(--weight-head);letter-spacing:var(--track-head);line-height:1;}
.stat span{display:block;text-transform:uppercase;letter-spacing:0.13em;font-size:0.66rem;font-weight:700;margin-top:8px;opacity:0.75;}
@media (min-width:900px){.stats-grid{grid-template-columns:repeat(4,1fr);}.stat:first-child{padding-left:0;}}`

  const about = `.about-grid{display:grid;gap:2.5rem;align-items:center;}
.about__copy p{color:var(--page-muted);max-width:var(--measure);}
.pull-quote{margin:1.5rem 0;padding:1.1rem 1.4rem;border-left:3px solid var(--accent);background:var(--alt-bg);font-style:italic;color:var(--page-fg);border-radius:0 var(--radius) var(--radius) 0;}
.about__media img{border-radius:var(--radius);width:100%;height:100%;object-fit:cover;}
.about__actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:1.5rem;}
@media (min-width:900px){.about-grid{grid-template-columns:1fr 1fr;gap:3.5rem;}}`

  // Asymmetric gallery, never a uniform grid of squares.
  const gallery = `.gallery{display:grid;gap:12px;grid-template-columns:repeat(2,1fr);}
.gallery figure{margin:0;overflow:hidden;border-radius:var(--radius);}
.gallery img{width:100%;height:100%;object-fit:cover;transition:transform .4s ease;}
.gallery figure:hover img{transform:scale(1.04);}
@media (min-width:900px){
.gallery{grid-template-columns:repeat(4,1fr);grid-auto-rows:200px;}
.gallery figure:nth-child(1){grid-column:span 2;grid-row:span 2;}
.gallery figure:nth-child(4){grid-column:span 2;}
}`

  const process = `.process-grid{display:grid;gap:var(--gap);counter-reset:step;}
.step{position:relative;padding-top:1.25rem;border-top:2px solid var(--hairline);}
.step__num{display:block;font-family:var(--font-head);font-size:2rem;font-weight:var(--weight-head);line-height:1;color:var(--accent);opacity:0.45;margin-bottom:0.5rem;}
.step h3{margin-bottom:0.4rem;}
.step p{color:var(--page-muted);font-size:0.92rem;}
@media (min-width:900px){.process-grid{grid-template-columns:repeat(4,1fr);}}`

  const areas = `.areas-grid{display:grid;gap:2rem;}
.suburbs{display:flex;flex-wrap:wrap;gap:8px;list-style:none;padding:0;margin:0;}
.suburbs li{font-size:0.85rem;font-weight:600;padding:8px 14px;border-radius:999px;background:var(--alt-bg);border:1px solid var(--hairline);}
@media (min-width:900px){.areas-grid{grid-template-columns:1fr 1.2fr;gap:3rem;align-items:center;}}`

  const quotes = `.quote{display:flex;flex-direction:column;padding:1.75rem;border-radius:var(--radius);${cardSkin}}
.stars{display:flex;gap:3px;color:var(--accent);margin-bottom:0.9rem;}
.stars .icon{width:16px;height:16px;}
.quote p{font-size:0.95rem;line-height:1.7;color:${onDarkPage ? 'rgba(255,255,255,0.72)' : 'var(--ink-muted)'};}
.quote__who{margin-top:auto;padding-top:1rem;font-size:0.8rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;}
.quote__who span{display:block;font-weight:500;text-transform:none;letter-spacing:0;color:var(--page-muted);margin-top:3px;}`

  const faq = `.faq-item{border-bottom:1px solid var(--hairline);}
.faq-item button{width:100%;display:flex;justify-content:space-between;align-items:center;gap:1rem;text-align:left;background:none;border:0;padding:1.15rem 0;font:inherit;font-weight:700;color:var(--page-fg);cursor:pointer;}
.faq-item button .icon{color:var(--accent);transition:transform .25s ease;}
.faq-item[data-open="true"] button .icon{transform:rotate(180deg);}
.faq-answer{display:none;padding-bottom:1.15rem;color:var(--page-muted);max-width:var(--measure);}
.faq-item[data-open="true"] .faq-answer{display:block;}`

  const cta = `.cta-band{background:var(--dark-block);color:var(--on-dark);text-align:center;}
.cta-band h2{color:var(--on-dark);}
.cta-band p{color:rgba(255,255,255,0.72);max-width:56ch;margin-left:auto;margin-right:auto;}
.cta-band__actions{display:flex;flex-wrap:wrap;gap:14px;justify-content:center;margin-top:1.75rem;}`

  const contact = `.contact-grid{display:grid;gap:2.5rem;}
.contact-list{list-style:none;padding:0;margin:0 0 1.5rem;display:grid;gap:1.1rem;}
.contact-list li{display:flex;gap:14px;align-items:flex-start;}
.contact-list .icon{color:var(--accent);margin-top:3px;}
.contact-list b{display:block;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.1em;color:var(--page-muted);margin-bottom:3px;}
.contact-list a{text-decoration:none;font-weight:600;}
.contact-list a:hover{color:var(--accent);}
.hours{list-style:none;padding:0;margin:0;font-size:0.9rem;color:var(--page-muted);}
@media (min-width:900px){.contact-grid{grid-template-columns:1fr 1.05fr;gap:3.5rem;}}`

  const footer = `.site-footer{background:var(--dark-block);color:rgba(255,255,255,0.66);padding:3.5rem 0 0;}
.footer-grid{display:grid;gap:2rem;padding-bottom:2.5rem;}
.site-footer h4{color:var(--on-dark);font-size:0.78rem;text-transform:uppercase;letter-spacing:0.14em;margin-bottom:1rem;font-family:var(--font-body);font-weight:700;}
.site-footer ul{list-style:none;padding:0;margin:0;display:grid;gap:9px;font-size:0.9rem;}
.site-footer a{text-decoration:none;}
.site-footer a:hover{color:var(--accent);}
.site-footer__logo{max-height:56px;width:auto;margin-bottom:1rem;}
.site-footer__blurb{font-size:0.9rem;max-width:34ch;}
.footer-bottom{border-top:1px solid rgba(255,255,255,0.12);padding:1.25rem 0;display:flex;flex-wrap:wrap;gap:10px;justify-content:space-between;font-size:0.8rem;}
.footer-bottom a{color:var(--accent);}
@media (min-width:900px){.footer-grid{grid-template-columns:1.6fr 1fr 1fr 1fr;gap:3rem;}}`

  return [root, base, buttons, header, hero, form, trust, cards, stats, about, gallery, process, areas, quotes, faq, cta, contact, footer].join('\n')
}

function brandMarkup(plan: ContentPlan, facts: BuildFacts): string {
  const name = esc(plan.brand.wordmarkText)

  if (plan.brand.logoTreatment === 'image' && facts.logo) {
    return '<a class="brand" href="#top"><img class="brand__logo" src="' + esc(facts.logo.path) + '" alt="' + esc(plan.brand.businessName) + ' logo" width="180" height="44"></a>'
  }
  if (plan.brand.logoTreatment === 'cropped-mark' && facts.logo) {
    return '<a class="brand" href="#top"><img class="brand__logo" src="' + esc(facts.logo.path) + '" alt="' + esc(plan.brand.businessName) + ' logo" width="180" height="44"><span class="brand__name">' + name + '</span></a>'
  }

  const initials = plan.brand.wordmarkText
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase()

  return '<!-- CLIENT TO SUPPLY: logo artwork as a transparent PNG or SVG. A CSS logotype is used until then. -->\n' +
    '    <a class="brand" href="#top"><span class="brand__mark">' + esc(initials) + '</span><span class="brand__name">' + name + '</span></a>'
}

function formMarkup(args: {
  id: string
  heading: string
  button: string
  subject: string
  key: string
  headingLevel: 2 | 3
  eyebrow?: string
}): string {
  const h = 'h' + args.headingLevel
  return `<div class="card-form">
      ${args.eyebrow ? '<span class="eyebrow">' + esc(clean(args.eyebrow)) + '</span>' : ''}
      <${h}>${esc(clean(args.heading))}</${h}>
      <form action="https://api.web3forms.com/submit" method="POST" data-web3form id="${args.id}">
        <input type="hidden" name="access_key" value="${esc(args.key)}">
        <input type="hidden" name="subject" value="${esc(args.subject)}">
        <input type="checkbox" name="botcheck" class="hp" tabindex="-1" autocomplete="off">
        <label class="field"><span>Your name</span><input type="text" name="name" required autocomplete="name"></label>
        <label class="field"><span>Phone</span><input type="tel" name="phone" required autocomplete="tel"></label>
        <label class="field"><span>Email</span><input type="email" name="email" required autocomplete="email"></label>
        <label class="field"><span>What do you need done?</span><textarea name="message" required></textarea></label>
        <button class="btn btn--primary btn--block" type="submit">${esc(clean(args.button))}</button>
        <p class="form-status" role="status"></p>
        <p class="form-note">We will get back to you as soon as we can. If it is urgent, ring us instead.</p>
      </form>
    </div>`
}

/**
 * Split a heading so its payoff phrase can be set in the accent colour.
 *
 * The device every reference site uses: "Water, gas and plumbing handled with <em>care.</em>",
 * "Boutique Homes Built <em>Without Compromise.</em>". The last few words carry the emphasis, so
 * the split is on the final clause where there is one and the last two or three words otherwise.
 * Returns escaped HTML, ready to drop into a heading.
 */
function twoTone(text: string, enabled: boolean): string {
  const clean_ = clean(text)
  if (!enabled) return esc(clean_)

  const words = clean_.trim().split(/\s+/)
  if (words.length < 4) return esc(clean_)

  // Prefer a natural break: the last clause after a comma, otherwise the last two words.
  const commaAt = clean_.lastIndexOf(', ')
  let head: string
  let tail: string
  if (commaAt > 0 && clean_.length - commaAt > 8 && clean_.length - commaAt < clean_.length * 0.6) {
    head = clean_.slice(0, commaAt + 1)
    tail = clean_.slice(commaAt + 2)
  } else {
    const take = words.length > 6 ? 3 : 2
    head = words.slice(0, -take).join(' ')
    tail = words.slice(-take).join(' ')
  }

  return esc(head) + ' <em>' + esc(tail) + '</em>'
}

function heroMarkup(plan: ContentPlan, facts: BuildFacts, spec: StyleSpec): string {
  const photo = facts.photos[0] ?? null
  const background = photo
    ? picture({
        webp: photo.webWebp,
        jpeg: photo.webJpeg,
        alt: clean(
          plan.gallery.items[0]?.alt ?? plan.brand.businessName + ' at work in ' + plan.meta.geoPlacename,
        ),
        width: photo.width,
        height: photo.height,
        eager: true,
        sizes: '100vw',
      })
    : '<!-- CLIENT TO SUPPLY: a wide photo of the team or a finished job for the hero background. A gradient is used until then. -->'

  const points = plan.hero.trustPoints
    .map((p) => '<li>' + icon(ICON_TICK) + '<span>' + esc(clean(p)) + '</span></li>')
    .join('\n        ')

  return `<section class="hero" id="top">
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
      <ul class="hero__points">
        ${points}
      </ul>
    </div>
    ${formMarkup({
      id: 'heroForm',
      heading: plan.hero.formHeading,
      button: plan.hero.formButtonLabel,
      subject: facts.heroFormSubject,
      key: facts.web3formsKey,
      headingLevel: 2,
      eyebrow: 'Start a conversation',
    })}
  </div>
</section>`
}`

lines.splice(start, end - start + 1, block)
writeFileSync(p, lines.join('\n'))
console.log('stylesheet and hero rewritten, lines ' + start + '-' + end)
