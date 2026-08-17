import type { AuditFlag } from '../../shared/types'
import type { BuildFacts, ContentPlan } from '../../shared/plan'
import type { IntakePayload } from '../../shared/intake'
import { TRADE_LABELS, TRADE_SCHEMA_TYPE } from '../../shared/trades'

/**
 * OFFLINE FIXTURE GENERATOR. NOT THE PRODUCT.
 *
 * This produces a deterministic content plan and a deterministic index.html without calling the
 * Anthropic API. It exists for exactly two reasons:
 *   1. the generation and verification pipeline can be run and tested end to end with no API key
 *   2. it is a worked reference implementation of the house rules, so the rules are provably
 *      satisfiable and the checks are provably correct
 *
 * It is NOT the quality bar and it is NOT what a customer gets. The real output comes from the
 * two Anthropic calls in lib/generate.ts. Switched on only by DEV_OFFLINE_GENERATION=1, which
 * must never be set in production.
 */

// ---------------------------------------------------------------------------------------------
// Small colour helpers, so tokens are derived rather than guessed
// ---------------------------------------------------------------------------------------------

function clamp(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

function toRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('')}`
}

function shade(hex: string, amount: number): string {
  const [r, g, b] = toRgb(hex)
  return amount < 0
    ? toHex(r * (1 + amount), g * (1 + amount), b * (1 + amount))
    : toHex(r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount)
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Primary carries white text, so it cannot be pale. Darken until it can. */
function ensureDarkEnough(hex: string): string {
  let out = hex
  let guard = 0
  while (relativeLuminance(out) > 0.3 && guard < 12) {
    out = shade(out, -0.12)
    guard++
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Deterministic content plan
// ---------------------------------------------------------------------------------------------

export function offlinePlan(
  intake: IntakePayload,
  facts: BuildFacts,
  auditFlags: AuditFlag[],
  photoInventory: Array<{ assetId: string; path: string; note: string }>,
): ContentPlan {
  const trade = TRADE_LABELS[intake.trade].toLowerCase()
  const base = intake.baseSuburb.name
  const primary = ensureDarkEnough(intake.palette.primary)
  const quoteWord = intake.freeQuotes ? 'free quote' : 'quote'
  const galleryOn = photoInventory.length >= 3

  const logoTreatment: ContentPlan['brand']['logoTreatment'] = !facts.logoPath
    ? 'css-logotype'
    : auditFlags.some((f) => f.code === 'logo_mockup_render')
      ? 'css-logotype'
      : auditFlags.some((f) => f.code === 'logo_wide_lockup')
        ? 'cropped-mark'
        : 'image'

  const assumptions: string[] = []
  if (intake.hours.isDefault) {
    assumptions.push(
      'Opening hours are our standard trade defaults, Monday to Friday 7am to 5pm. The customer did not set them.',
    )
  }
  for (const f of auditFlags) {
    if (f.code === 'years_contradicts_story') assumptions.push(f.message)
  }

  const clientToSupply: string[] = []
  if (!galleryOn) {
    clientToSupply.push(
      'Three or more job photos so the Our Work gallery can be built. No stock photography is used in the meantime.',
    )
  }
  if (logoTreatment === 'css-logotype') {
    clientToSupply.push('Logo artwork as a transparent PNG or an SVG, so the header can carry it.')
  }

  return {
    meta: {
      title: `${intake.primaryService} in ${base} | ${intake.businessName}`.slice(0, 70),
      metaDescription: padTo(
        `${intake.businessName} are ${trade}s in ${base} covering ${intake.suburbsServiced
          .slice(0, 3)
          .map((s) => s.name)
          .join(', ')} and nearby. ${intake.yearsInBusiness} years in the trade. Call today for a ${quoteWord}.`,
        70,
        165,
        ' Local, licensed and on time.',
      ),
      ogTitle: `${intake.primaryService} in ${base}`.slice(0, 80),
      ogDescription:
        `${intake.businessName}, local ${trade}s covering ${base} and the surrounding suburbs. Straight answers and a price before we start.`.slice(
          0,
          200,
        ),
      lang: 'en-AU',
      geoRegion: `AU-${intake.baseSuburb.state}`,
      geoPlacename: base,
      geoPosition: { lat: intake.baseSuburb.lat, lng: intake.baseSuburb.lng },
    },
    brand: {
      businessName: intake.businessName,
      tagline: `${intake.primaryService} done properly in ${base}`.slice(0, 90),
      logoTreatment,
      wordmarkText: intake.businessName,
    },
    tokens: {
      primary,
      primaryDark: shade(primary, -0.35),
      primaryLight: shade(primary, 0.85),
      accent: intake.palette.accent,
      ink: '#16191d',
      inkMuted: '#5b646e',
      surface: '#ffffff',
      surfaceAlt: '#f4f6f8',
      line: '#e2e6ea',
      white: '#ffffff',
      black: '#000000',
      success: '#1f8a4c',
    },
    hero: {
      h1: `${intake.primaryService} in ${base}`.slice(0, 90),
      sub: `${intake.businessName} has been on the tools for ${intake.yearsInBusiness} years. We turn up when we say we will, and you get the price before we start.`.slice(
        0,
        220,
      ),
      ctaPrimary: { label: `Call ${facts.phoneDisplay}`, href: `tel:${facts.phoneE164}` },
      ctaSecondary: { label: `Request a ${quoteWord}`, href: '#contact' },
      trustPoints: [
        `${intake.yearsInBusiness} years in the trade`,
        intake.emergency ? 'After hours available' : 'Turn up on time',
        'Licensed and insured',
        'Tidy work, no mess left',
      ],
      formHeading: `Request a ${quoteWord}`,
      formButtonLabel: 'Send it through',
    },
    trustStrip: [
      { label: 'Local', detail: `Based in ${base}` },
      { label: 'Experienced', detail: `${intake.yearsInBusiness} years on the tools` },
      { label: 'Upfront', detail: 'Price before we start' },
      {
        label: intake.emergency ? 'After hours' : 'Reliable',
        detail: intake.emergency ? 'We answer after hours' : 'We turn up when we say',
      },
    ],
    about: {
      heading: `Local ${trade}s who answer the phone`,
      body: [
        truncateTo(intake.about, 40, 600),
        `We cover ${intake.suburbsServiced
          .slice(0, 6)
          .map((s) => s.name)
          .join(', ')} and the suburbs around them. Same crew every time, so you are not explaining the job twice.`,
        intake.different
          ? truncateTo(intake.different, 40, 600)
          : `Every job gets a price before it starts, and we clean up before we leave. That is the whole trick, and it is why most of our work comes from people who have used us before.`,
      ],
      pullQuote: 'You get a price before we start, and the price is the price.',
    },
    services: intake.services.slice(0, 8).map((name) => ({
      name,
      blurb: `${name} handled start to finish, with a price agreed before any work begins. We carry the common parts on the van so most jobs are sorted in one visit.`,
      iconHint: 'tool outline',
    })),
    gallery: {
      enabled: galleryOn,
      heading: 'Our work',
      items: galleryOn
        ? photoInventory.map((p, i) => ({
            assetId: p.assetId,
            alt: `${intake.primaryService} job completed by ${intake.businessName} in ${base}, photo ${i + 1}`.slice(
              0,
              125,
            ),
          }))
        : [],
    },
    whyUs: [
      {
        title: 'We answer the phone',
        body: 'You get a person, not a message bank. If we cannot take the call we ring you back the same day.',
      },
      {
        title: 'The price is the price',
        body: 'You get the number before we start. If something changes on site we tell you first and you decide.',
      },
      {
        title: 'Licensed and insured',
        body: 'Fully licensed for the work we do and covered by public liability insurance, so your home is protected.',
      },
      {
        title: 'We leave it tidy',
        body: 'Drop sheets down, offcuts taken away, floors swept. You should not be able to tell we were there except for the work.',
      },
    ],
    stats: [
      { value: intake.yearsInBusiness, suffix: '+', label: 'Years in the trade', source: 'yearsInBusiness' },
      {
        value: intake.suburbsServiced.length,
        suffix: '',
        label: 'Suburbs serviced',
        source: 'suburbsServiced.length',
      },
      { value: intake.services.length, suffix: '', label: 'Services offered', source: 'services.length' },
    ],
    process: [
      { title: 'Give us a ring', body: 'Tell us what is going on. We ask the questions that matter and book a time that suits you.' },
      { title: 'We take a look', body: 'We come out, work out what is actually wrong, and explain it in plain English.' },
      { title: 'You get the price', body: 'A clear number before any work starts. No surprises added on at the end.' },
      { title: 'We get it done', body: 'The job done properly, the site left clean, and you know who to ring next time.' },
    ],
    serviceAreas: {
      heading: `Suburbs we cover around ${base}`,
      blurb: `We are based in ${base} and work across the surrounding suburbs. If you are just outside this list give us a ring anyway, we will tell you straight whether we can get to you.`,
      suburbs: intake.suburbsServiced.map((s) => s.name),
    },
    testimonials: {
      enabled: intake.reviews.length > 0,
      heading: 'What our customers say',
      items: intake.reviews.map((r) => ({ quote: r.quote, name: r.firstName, suburb: r.suburb })),
    },
    faq: buildFaq(intake, facts, quoteWord),
    ctaBand: {
      heading: `Need a ${trade} in ${base}?`,
      body: 'Give us a ring and tell us what is going on. We will tell you what it takes to fix it.',
      ctaLabel: `Call ${facts.phoneDisplay}`,
    },
    contact: {
      heading: 'Get in touch',
      blurb: `Ring us, or send the form through and we will come back to you. We cover ${base} and the surrounding suburbs.`,
      formHeading: `Request a ${quoteWord}`,
      formButtonLabel: 'Send it through',
    },
    schema: {
      businessType: TRADE_SCHEMA_TYPE[intake.trade],
      areaServed:
        intake.travelRadius === 'statewide'
          ? {
              mode: 'geocircle',
              lat: intake.baseSuburb.lat,
              lng: intake.baseSuburb.lng,
              radiusMetres: 250_000,
            }
          : { mode: 'city', cities: intake.suburbsServiced.map((s) => s.name) },
      sameAs: Object.values(intake.socials).filter((v): v is string => Boolean(v)),
    },
    assumptions,
    clientToSupply,
  }
}

/** Keep a string inside a schema-enforced length band without ever losing the start of it. */
function padTo(text: string, min: number, max: number, filler: string): string {
  let out = text.trim()
  while (out.length < min) out += filler
  return out.slice(0, max)
}

function truncateTo(text: string, min: number, max: number): string {
  const t = text.trim()
  if (t.length >= min) return t.slice(0, max)
  return `${t} We are a local business and we take the work seriously.`.slice(0, max)
}

function buildFaq(intake: IntakePayload, facts: BuildFacts, quoteWord: string): ContentPlan['faq'] {
  const base = intake.baseSuburb.name
  const areas = intake.suburbsServiced.map((s) => s.name).join(', ')
  const faq: ContentPlan['faq'] = [
    {
      q: `What suburbs do you cover?`,
      a: `We are based in ${base} and cover ${areas}. If your suburb is not on the list, give us a ring anyway and we will tell you straight whether we can get to you.`,
    },
    {
      q: `How do I get a ${quoteWord}?`,
      a: `Ring us on ${facts.phoneDisplay} or send the form on this page through with a few details about the job. We will come back to you with what it involves and what it costs.`,
    },
    {
      q: `What are your hours?`,
      a: `${facts.byAppointment ? 'We work by appointment, so give us a ring and we will find a time that suits.' : facts.hoursLines.join('. ') + '.'} ${intake.emergency ? 'We also take after hours calls when something cannot wait.' : ''}`.trim(),
    },
    {
      q: `Are you licensed and insured?`,
      a: `Yes. We hold the licences required for the work we do and we carry public liability insurance. If you would like to see the paperwork before we start, just ask and we will send it through.`,
    },
    {
      q: `How long have you been going?`,
      a: `${intake.yearsInBusiness} years. Most of our work now comes from people who have used us before, or from someone they told about us, which is the way we like it.`,
    },
    {
      q: `Do you clean up afterwards?`,
      a: `Always. Drop sheets go down before we start, offcuts and old parts leave with us, and the area gets swept before we go. You should only be able to tell we were there by the work itself.`,
    },
  ]
  return faq
}

// ---------------------------------------------------------------------------------------------
// Deterministic HTML
// ---------------------------------------------------------------------------------------------

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Strip anything the house rules ban from copy that came from a human. */
function clean(text: string): string {
  return text.replace(/—/g, ', ').replace(/–/g, ' to ').replace(/\p{Extended_Pictographic}/gu, '')
}

function icon(path: string): string {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`
}

const ICON_TICK = '<polyline points="20 6 9 17 4 12"></polyline>'
const ICON_PHONE =
  '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"></path>'
const ICON_PIN =
  '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle>'
const ICON_CLOCK = '<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>'
const ICON_SHIELD = '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>'
const ICON_TOOL =
  '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>'
const ICON_MAIL =
  '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22 6 12 13 2 6"></polyline>'
const ICON_CHEVRON = '<polyline points="6 9 12 15 18 9"></polyline>'
const ICON_MENU =
  '<line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="18" x2="21" y2="18"></line>'

export function offlineHtml(plan: ContentPlan, facts: BuildFacts): string {
  const t = plan.tokens
  const heroPhoto = facts.photoPaths[0]?.path ?? null
  const aboutPhoto = facts.photoPaths[1]?.path ?? null

  const jsonLd = buildJsonLd(plan, facts)

  const navItems = [
    { href: '#about', label: 'About' },
    { href: '#services', label: 'Services' },
    ...(plan.gallery.enabled ? [{ href: '#work', label: 'Our work' }] : []),
    { href: '#areas', label: 'Areas' },
    { href: '#faq', label: 'FAQ' },
    { href: '#contact', label: 'Contact' },
  ]

  const assumptionComments = plan.assumptions
    .map((a) => `<!-- CONFIRM WITH CLIENT BEFORE LAUNCH: ${clean(a)} -->`)
    .join('\n')
  const supplyComments = plan.clientToSupply
    .map((c) => `<!-- CLIENT TO SUPPLY: ${clean(c)} -->`)
    .join('\n')

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
<meta name="twitter:card" content="summary_large_image">
<meta name="geo.region" content="${esc(plan.meta.geoRegion)}">
<meta name="geo.placename" content="${esc(plan.meta.geoPlacename)}">
<meta name="geo.position" content="${plan.meta.geoPosition.lat};${plan.meta.geoPosition.lng}">
<meta name="ICBM" content="${plan.meta.geoPosition.lat}, ${plan.meta.geoPosition.lng}">
<meta name="theme-color" content="${t.primary}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Inter:wght@400;500;600&display=swap">
<script type="application/ld+json">
${JSON.stringify(jsonLd, null, 2)}
</script>
<style>
:root{
--primary:${t.primary};
--primary-dark:${t.primaryDark};
--primary-light:${t.primaryLight};
--accent:${t.accent};
--ink:${t.ink};
--ink-muted:${t.inkMuted};
--surface:${t.surface};
--surface-alt:${t.surfaceAlt};
--line:${t.line};
--white:${t.white};
--black:${t.black};
--success:${t.success};
--overlay-strong:rgba(0,0,0,0.72);
--overlay-soft:rgba(0,0,0,0.45);
--shadow-sm:0 1px 2px rgba(16,24,32,0.06);
--shadow-md:0 10px 30px rgba(16,24,32,0.10);
--shadow-lg:0 24px 60px rgba(16,24,32,0.16);
--on-primary:${t.white};
--font-head:"Barlow Condensed",Impact,sans-serif;
--font-body:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
--step-0:1.0625rem;
--step-1:1.25rem;
--step-2:clamp(1.5rem,1.2rem + 1.2vw,2rem);
--step-3:clamp(1.9rem,1.4rem + 2.2vw,2.9rem);
--step-4:clamp(2.4rem,1.6rem + 3.6vw,4.2rem);
--space-1:0.5rem;
--space-2:1rem;
--space-3:1.5rem;
--space-4:2.5rem;
--space-5:4rem;
--space-6:5rem;
--radius:14px;
--radius-sm:8px;
--wrap:1200px;
--header-h:74px;
}
*,*::before,*::after{box-sizing:border-box;}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%;}
body{margin:0;font-family:var(--font-body);font-size:var(--step-0);line-height:1.7;color:var(--ink);background:var(--surface);overflow-x:hidden;}
img{max-width:100%;height:auto;display:block;}
h1,h2,h3{font-family:var(--font-head);line-height:1.05;letter-spacing:0.01em;text-transform:uppercase;margin:0 0 var(--space-2);}
h1{font-size:var(--step-4);}
h2{font-size:var(--step-3);}
h3{font-size:var(--step-1);text-transform:none;letter-spacing:0;}
p{margin:0 0 var(--space-2);}
a{color:var(--primary);}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px;}
.wrap{width:100%;max-width:var(--wrap);margin:0 auto;padding:0 20px;}
.section{padding:var(--space-5) 0;}
.section--alt{background:var(--surface-alt);}
.eyebrow{font-family:var(--font-head);text-transform:uppercase;letter-spacing:0.14em;color:var(--accent);font-size:0.95rem;margin:0 0 var(--space-1);}
.lead{color:var(--ink-muted);max-width:62ch;}
.icon{width:22px;height:22px;flex:0 0 auto;}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;font-weight:600;border-radius:var(--radius-sm);padding:14px 22px;text-decoration:none;border:2px solid transparent;cursor:pointer;font-size:1rem;transition:transform .18s ease,box-shadow .18s ease,background-color .18s ease;}
.btn--primary{background:var(--accent);color:var(--on-primary);}
.btn--primary:hover{transform:translateY(-2px);box-shadow:var(--shadow-md);}
.btn--ghost{border-color:var(--white);color:var(--white);}
.btn--ghost:hover{background:var(--overlay-soft);}
.btn--solid{background:var(--primary);color:var(--on-primary);}
.btn--solid:hover{transform:translateY(-2px);box-shadow:var(--shadow-md);}
.btn--block{width:100%;}
.site-header{position:fixed;top:0;left:0;right:0;z-index:60;transition:background-color .25s ease,box-shadow .25s ease;}
.site-header__inner{display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);height:var(--header-h);}
.site-header--solid{background:var(--surface);box-shadow:var(--shadow-sm);border-bottom:1px solid var(--line);}
.brand{display:flex;align-items:center;gap:10px;text-decoration:none;}
.brand__mark{width:42px;height:42px;border-radius:10px;background:var(--primary);color:var(--on-primary);display:grid;place-items:center;font-family:var(--font-head);font-size:1.35rem;}
.brand__logo{max-height:46px;width:auto;}
.brand__name{font-family:var(--font-head);font-size:1.35rem;text-transform:uppercase;color:var(--white);letter-spacing:0.02em;}
.site-header--solid .brand__name{color:var(--ink);}
.nav{display:none;}
.nav a{color:var(--white);text-decoration:none;font-weight:500;padding:8px 10px;}
.site-header--solid .nav a{color:var(--ink);}
.nav a:hover{color:var(--accent);}
.header__cta{display:none;}
.menu-toggle{display:inline-flex;align-items:center;justify-content:center;background:var(--overlay-soft);color:var(--white);border:0;border-radius:var(--radius-sm);width:44px;height:44px;cursor:pointer;}
.site-header--solid .menu-toggle{background:var(--surface-alt);color:var(--ink);}
.mobile-panel{position:fixed;inset:var(--header-h) 0 auto 0;background:var(--surface);border-bottom:1px solid var(--line);box-shadow:var(--shadow-md);padding:var(--space-2) 20px var(--space-3);display:none;z-index:55;}
.mobile-panel[data-open="true"]{display:block;}
.mobile-panel a{display:block;padding:12px 0;color:var(--ink);text-decoration:none;border-bottom:1px solid var(--line);font-weight:500;}
.hero{position:relative;padding:calc(var(--header-h) + var(--space-4)) 0 var(--space-5);color:var(--white);background:linear-gradient(140deg,var(--primary-dark),var(--primary));}
.hero__bg{position:absolute;inset:0;overflow:hidden;}
.hero__bg img{width:100%;height:100%;object-fit:cover;}
.hero__scrim{position:absolute;inset:0;background:linear-gradient(120deg,var(--overlay-strong),var(--overlay-soft));}
.hero__inner{position:relative;display:grid;gap:var(--space-4);}
.hero__sub{font-size:var(--step-1);color:var(--white);max-width:52ch;}
.hero__ctas{display:flex;flex-wrap:wrap;gap:var(--space-2);margin-bottom:var(--space-3);}
.hero__points{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;list-style:none;padding:0;margin:0;}
.hero__points li{display:flex;align-items:center;gap:8px;font-size:0.95rem;}
.hero__points .icon{color:var(--accent);width:18px;height:18px;}
.card-form{background:var(--surface);color:var(--ink);border-radius:var(--radius);padding:var(--space-3);box-shadow:var(--shadow-lg);}
.card-form h2{font-size:var(--step-2);}
.field{display:block;margin-bottom:var(--space-2);}
.field span{display:block;font-weight:600;font-size:0.92rem;margin-bottom:6px;}
.field input,.field textarea,.field select{width:100%;padding:12px 14px;border:1px solid var(--line);border-radius:var(--radius-sm);font:inherit;background:var(--surface);color:var(--ink);}
.field textarea{min-height:110px;resize:vertical;}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;}
.form-note{font-size:0.85rem;color:var(--ink-muted);margin:0;}
.form-status{margin-top:var(--space-2);font-weight:600;}
.form-status[data-state="ok"]{color:var(--success);}
.form-status[data-state="error"]{color:var(--accent);}
.trust-strip{background:var(--primary-dark);color:var(--white);padding:var(--space-3) 0;}
.trust-strip__grid{display:grid;grid-template-columns:repeat(2,1fr);gap:var(--space-3);}
.trust-strip__item{display:flex;gap:12px;align-items:flex-start;}
.trust-strip__item .icon{color:var(--accent);}
.trust-strip__label{font-family:var(--font-head);text-transform:uppercase;font-size:1.1rem;display:block;}
.trust-strip__detail{font-size:0.92rem;opacity:0.85;}
.about__grid{display:grid;gap:var(--space-4);}
.about__media{border-radius:var(--radius);overflow:hidden;min-height:280px;background:linear-gradient(150deg,var(--primary),var(--primary-dark));box-shadow:var(--shadow-md);}
.about__media img{width:100%;height:100%;object-fit:cover;}
.pull-quote{border-left:4px solid var(--accent);padding:6px 0 6px var(--space-2);margin:var(--space-3) 0;font-family:var(--font-head);font-size:var(--step-2);text-transform:none;color:var(--primary);}
.grid-cards{display:grid;gap:var(--space-3);}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:var(--space-3);transition:transform .18s ease,box-shadow .18s ease;}
.card:hover{transform:translateY(-4px);box-shadow:var(--shadow-md);}
.card--feature{border-color:var(--primary);box-shadow:var(--shadow-sm);}
.card__icon{width:52px;height:52px;border-radius:50%;background:var(--primary-light);color:var(--primary);display:grid;place-items:center;margin-bottom:var(--space-2);}
.card__link{font-weight:600;text-decoration:none;display:inline-flex;gap:6px;align-items:center;}
.gallery__grid{display:grid;gap:var(--space-2);grid-template-columns:repeat(2,1fr);}
.gallery__item{margin:0;border-radius:var(--radius);overflow:hidden;background:var(--surface-alt);}
.gallery__item img{width:100%;aspect-ratio:4/3;object-fit:cover;}
.why__num{font-family:var(--font-head);font-size:2.6rem;color:var(--primary-light);line-height:1;}
.stats{background:var(--primary);color:var(--white);}
.stats__grid{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--space-3);text-align:center;}
.stats__value{font-family:var(--font-head);font-size:clamp(2.4rem,6vw,3.6rem);line-height:1;color:var(--white);}
.stats__label{font-size:0.95rem;opacity:0.85;}
.process__list{list-style:none;counter-reset:step;padding:0;margin:0;display:grid;gap:var(--space-3);}
.process__item{counter-increment:step;position:relative;padding-left:64px;}
.process__item::before{content:counter(step);position:absolute;left:0;top:0;width:46px;height:46px;border-radius:50%;background:var(--accent);color:var(--on-primary);display:grid;place-items:center;font-family:var(--font-head);font-size:1.4rem;}
.areas__list{display:flex;flex-wrap:wrap;gap:10px;list-style:none;padding:0;margin:var(--space-3) 0 0;}
.areas__list li{background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:8px 16px;font-size:0.95rem;}
.quotes{display:grid;gap:var(--space-3);}
.quote{background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:var(--radius);padding:var(--space-3);}
.quote__who{font-weight:600;color:var(--ink-muted);font-size:0.92rem;}
.faq__item{border-bottom:1px solid var(--line);}
.faq__item summary{cursor:pointer;list-style:none;padding:var(--space-2) 0;font-weight:600;font-size:1.08rem;display:flex;justify-content:space-between;gap:var(--space-2);align-items:center;}
.faq__item summary::-webkit-details-marker{display:none;}
.faq__item summary .icon{transition:transform .2s ease;color:var(--primary);}
.faq__item[open] summary .icon{transform:rotate(180deg);}
.faq__answer{padding:0 0 var(--space-2);color:var(--ink-muted);max-width:70ch;}
.cta-band{background:var(--primary);color:var(--white);text-align:center;}
.cta-band h2{color:var(--white);}
.cta-band p{max-width:56ch;margin-left:auto;margin-right:auto;opacity:0.9;}
.contact__grid{display:grid;gap:var(--space-4);}
.contact__list{list-style:none;padding:0;margin:0 0 var(--space-3);display:grid;gap:var(--space-2);}
.contact__list li{display:flex;gap:12px;align-items:flex-start;}
.contact__list .icon{color:var(--primary);}
.contact__list a{text-decoration:none;font-weight:600;}
.hours{margin:0;padding:0;list-style:none;color:var(--ink-muted);font-size:0.95rem;}
.socials{display:flex;gap:var(--space-2);flex-wrap:wrap;margin-top:var(--space-2);}
.site-footer{background:var(--ink);color:var(--white);padding:var(--space-4) 0 calc(var(--space-4) + 76px);}
.site-footer a{color:var(--white);}
.site-footer__grid{display:grid;gap:var(--space-3);}
.site-footer__nav{display:flex;flex-wrap:wrap;gap:var(--space-2);list-style:none;padding:0;margin:0;}
.site-footer__nav a{text-decoration:none;opacity:0.85;}
.site-footer__legal{border-top:1px solid var(--overlay-soft);margin-top:var(--space-3);padding-top:var(--space-2);font-size:0.88rem;opacity:0.8;display:grid;gap:6px;}
.site-footer__logo{max-height:70px;width:auto;margin-bottom:var(--space-2);}
.mobile-bar{position:fixed;left:0;right:0;bottom:0;z-index:70;display:grid;grid-template-columns:1fr 1fr;box-shadow:var(--shadow-lg);}
.mobile-bar a{padding:16px 8px;text-align:center;font-weight:600;text-decoration:none;display:flex;align-items:center;justify-content:center;gap:8px;}
.mobile-bar a:first-child{background:var(--primary);color:var(--on-primary);}
.mobile-bar a:last-child{background:var(--accent);color:var(--on-primary);}
@media (min-width:768px){
.section{padding:var(--space-6) 0;}
.hero__inner{grid-template-columns:1.15fr 0.85fr;align-items:center;gap:var(--space-4);}
.hero__points{grid-template-columns:repeat(2,1fr);}
.trust-strip__grid{grid-template-columns:repeat(4,1fr);}
.about__grid{grid-template-columns:1.05fr 0.95fr;align-items:center;}
.grid-cards{grid-template-columns:repeat(2,1fr);}
.gallery__grid{grid-template-columns:repeat(3,1fr);}
.process__list{grid-template-columns:repeat(2,1fr);}
.quotes{grid-template-columns:repeat(2,1fr);}
.contact__grid{grid-template-columns:0.9fr 1.1fr;}
.site-footer{padding-bottom:var(--space-4);}
.site-footer__grid{grid-template-columns:1.2fr 1fr;}
.mobile-bar{display:none;}
}
@media (min-width:1024px){
.nav{display:flex;align-items:center;gap:var(--space-1);}
.header__cta{display:inline-flex;}
.menu-toggle{display:none;}
.grid-cards{grid-template-columns:repeat(3,1fr);}
.process__list{grid-template-columns:repeat(4,1fr);}
}
@media (prefers-reduced-motion:reduce){
html{scroll-behavior:auto;}
*,*::before,*::after{animation-duration:0.001ms !important;transition-duration:0.001ms !important;}
.card:hover,.btn--primary:hover,.btn--solid:hover{transform:none;}
}
</style>
</head>
<body>
${assumptionComments}
${supplyComments}
<header class="site-header" id="siteHeader">
  <div class="wrap site-header__inner">
    ${brandMarkup(plan, facts, 'header')}
    <nav class="nav" aria-label="Main">
      ${navItems.map((n) => `<a href="${n.href}">${esc(n.label)}</a>`).join('\n      ')}
    </nav>
    <a class="btn btn--primary header__cta" href="tel:${esc(facts.phoneE164)}">${icon(ICON_PHONE)}${esc(facts.phoneDisplay)}</a>
    <button class="menu-toggle" id="menuToggle" aria-expanded="false" aria-controls="mobilePanel" aria-label="Open menu">${icon(ICON_MENU)}</button>
  </div>
</header>
<div class="mobile-panel" id="mobilePanel" data-open="false">
  ${navItems.map((n) => `<a href="${n.href}">${esc(n.label)}</a>`).join('\n  ')}
  <a class="btn btn--solid btn--block" href="tel:${esc(facts.phoneE164)}" style="margin-top:1rem">${esc(plan.hero.ctaPrimary.label)}</a>
</div>

<section class="hero" id="top">
  <div class="hero__bg">
    ${
      heroPhoto
        ? `<img src="${esc(heroPhoto)}" alt="${esc(clean(plan.gallery.items[0]?.alt ?? `${plan.brand.businessName} at work in ${plan.meta.geoPlacename}`))}" width="1600" height="900" fetchpriority="high">`
        : `<!-- CLIENT TO SUPPLY: a wide photo of the team or a finished job for the hero background. A gradient is used until then. -->`
    }
    <div class="hero__scrim"></div>
  </div>
  <div class="wrap hero__inner">
    <div>
      <p class="eyebrow">${esc(clean(plan.brand.tagline))}</p>
      <h1>${esc(clean(plan.hero.h1))}</h1>
      <p class="hero__sub">${esc(clean(plan.hero.sub))}</p>
      <div class="hero__ctas">
        <a class="btn btn--primary" href="${esc(plan.hero.ctaPrimary.href)}">${icon(ICON_PHONE)}${esc(clean(plan.hero.ctaPrimary.label))}</a>
        <a class="btn btn--ghost" href="${esc(plan.hero.ctaSecondary.href)}">${esc(clean(plan.hero.ctaSecondary.label))}</a>
      </div>
      <ul class="hero__points">
        ${plan.hero.trustPoints.map((p) => `<li>${icon(ICON_TICK)}<span>${esc(clean(p))}</span></li>`).join('\n        ')}
      </ul>
    </div>
    ${formMarkup({
      id: 'heroForm',
      heading: plan.hero.formHeading,
      button: plan.hero.formButtonLabel,
      subject: facts.heroFormSubject,
      key: facts.web3formsKey,
      headingLevel: 2,
    })}
  </div>
</section>

<section class="trust-strip">
  <div class="wrap trust-strip__grid">
    ${plan.trustStrip
      .map(
        (item, i) => `<div class="trust-strip__item">${icon([ICON_PIN, ICON_CLOCK, ICON_TICK, ICON_SHIELD][i % 4]!)}<div><span class="trust-strip__label">${esc(clean(item.label))}</span><span class="trust-strip__detail">${esc(clean(item.detail))}</span></div></div>`,
      )
      .join('\n    ')}
  </div>
</section>

<section class="section" id="about">
  <div class="wrap about__grid">
    <div>
      <p class="eyebrow">About us</p>
      <h2>${esc(clean(plan.about.heading))}</h2>
      ${plan.about.body.map((p) => `<p>${esc(clean(p))}</p>`).join('\n      ')}
      <p class="pull-quote">${esc(clean(plan.about.pullQuote))}</p>
      <a class="btn btn--solid" href="#contact">${esc(clean(plan.hero.ctaSecondary.label))}</a>
    </div>
    <div class="about__media">
      ${
        aboutPhoto
          ? `<img src="${esc(aboutPhoto)}" alt="${esc(clean(plan.gallery.items[1]?.alt ?? `${plan.brand.businessName} on site`))}" width="900" height="700" loading="lazy">`
          : `<!-- CLIENT TO SUPPLY: a photo of the owner or the team for the about section. A gradient panel is used until then. -->`
      }
    </div>
  </div>
</section>

<section class="section section--alt" id="services">
  <div class="wrap">
    <p class="eyebrow">What we do</p>
    <h2>Our services</h2>
    <p class="lead">Everything below is done by our own crew. If it is not on the list, ring and ask, chances are we still do it.</p>
    <div class="grid-cards" style="margin-top:2rem">
      ${plan.services
        .map(
          (s, i) => `<article class="card${i === 0 ? ' card--feature' : ''}">
        <div class="card__icon">${icon(ICON_TOOL)}</div>
        <h3>${esc(clean(s.name))}</h3>
        <p>${esc(clean(s.blurb))}</p>
        <a class="card__link" href="#contact">Ask about ${esc(clean(s.name.toLowerCase()))}</a>
      </article>`,
        )
        .join('\n      ')}
    </div>
  </div>
</section>

${
  plan.gallery.enabled
    ? `<section class="section" id="work">
  <div class="wrap">
    <p class="eyebrow">Recent jobs</p>
    <h2>${esc(clean(plan.gallery.heading))}</h2>
    <div class="gallery__grid" style="margin-top:2rem">
      ${plan.gallery.items
        .map((item, i) => {
          const path = facts.photoPaths.find((p) => p.assetId === item.assetId)?.path
          if (!path) return ''
          return `<figure class="gallery__item"><img src="${esc(path)}" alt="${esc(clean(item.alt))}" width="800" height="600" loading="${i === 0 ? 'eager' : 'lazy'}"></figure>`
        })
        .filter(Boolean)
        .join('\n      ')}
    </div>
  </div>
</section>`
    : `<!-- CLIENT TO SUPPLY: three or more job photos so the Our Work gallery can be built. No stock photography has been used. -->`
}

<section class="section section--alt" id="why">
  <div class="wrap">
    <p class="eyebrow">Why us</p>
    <h2>Why people call us back</h2>
    <div class="grid-cards" style="margin-top:2rem">
      ${plan.whyUs
        .map(
          (w, i) => `<article class="card">
        <p class="why__num">${String(i + 1).padStart(2, '0')}</p>
        <h3>${esc(clean(w.title))}</h3>
        <p>${esc(clean(w.body))}</p>
      </article>`,
        )
        .join('\n      ')}
    </div>
  </div>
</section>

<section class="section stats" id="stats">
  <div class="wrap stats__grid">
    ${plan.stats
      .map(
        (s) => `<div>
      <p class="stats__value"><span data-count="${s.value}">${s.value}</span>${esc(s.suffix)}</p>
      <p class="stats__label">${esc(clean(s.label))}</p>
    </div>`,
      )
      .join('\n    ')}
  </div>
</section>

<section class="section" id="process">
  <div class="wrap">
    <p class="eyebrow">How it works</p>
    <h2>Four steps, no mucking about</h2>
    <ol class="process__list" style="margin-top:2rem">
      ${plan.process
        .map(
          (p) => `<li class="process__item"><h3>${esc(clean(p.title))}</h3><p>${esc(clean(p.body))}</p></li>`,
        )
        .join('\n      ')}
    </ol>
  </div>
</section>

<section class="section section--alt" id="areas">
  <div class="wrap">
    <p class="eyebrow">Service area</p>
    <h2>${esc(clean(plan.serviceAreas.heading))}</h2>
    <p class="lead">${esc(clean(plan.serviceAreas.blurb))}</p>
    <ul class="areas__list">
      ${plan.serviceAreas.suburbs.map((s) => `<li>${esc(clean(s))}</li>`).join('\n      ')}
    </ul>
  </div>
</section>

${
  plan.testimonials.enabled
    ? `<section class="section" id="reviews">
  <div class="wrap">
    <p class="eyebrow">Reviews</p>
    <h2>${esc(clean(plan.testimonials.heading))}</h2>
    <div class="quotes" style="margin-top:2rem">
      ${plan.testimonials.items
        .map(
          (q) => `<blockquote class="quote"><p>${esc(clean(q.quote))}</p><footer class="quote__who">${esc(clean(q.name))}, ${esc(clean(q.suburb))}</footer></blockquote>`,
        )
        .join('\n      ')}
    </div>
    ${facts.googleReviewLink ? `<p style="margin-top:1.5rem"><a class="btn btn--solid" href="${esc(facts.googleReviewLink)}" target="_blank" rel="noopener">Read our Google reviews</a></p>` : ''}
  </div>
</section>`
    : `<!-- No testimonials section: the client supplied no reviews. Nothing has been invented. -->`
}

<section class="section section--alt" id="faq">
  <div class="wrap">
    <p class="eyebrow">Questions</p>
    <h2>Frequently asked questions</h2>
    <div style="margin-top:2rem;max-width:820px">
      ${plan.faq
        .map(
          (f) => `<details class="faq__item">
        <summary>${esc(clean(f.q))}${icon(ICON_CHEVRON)}</summary>
        <div class="faq__answer">${esc(clean(f.a))}</div>
      </details>`,
        )
        .join('\n      ')}
    </div>
  </div>
</section>

<section class="section cta-band">
  <div class="wrap">
    <h2>${esc(clean(plan.ctaBand.heading))}</h2>
    <p>${esc(clean(plan.ctaBand.body))}</p>
    <a class="btn btn--primary" href="tel:${esc(facts.phoneE164)}">${icon(ICON_PHONE)}${esc(clean(plan.ctaBand.ctaLabel))}</a>
  </div>
</section>

<section class="section" id="contact">
  <div class="wrap contact__grid">
    <div>
      <p class="eyebrow">Contact</p>
      <h2>${esc(clean(plan.contact.heading))}</h2>
      <p class="lead">${esc(clean(plan.contact.blurb))}</p>
      <ul class="contact__list">
        <li>${icon(ICON_PHONE)}<a href="tel:${esc(facts.phoneE164)}">${esc(facts.phoneDisplay)}</a></li>
        <li>${icon(ICON_MAIL)}<a href="mailto:${esc(facts.email)}">${esc(facts.email)}</a></li>
        <li>${icon(ICON_PIN)}<span>${
          facts.address
            ? esc(`${facts.address.line1}, ${facts.address.suburb} ${facts.address.state} ${facts.address.postcode}`)
            : esc(`${plan.meta.geoPlacename} and surrounding suburbs`)
        }</span></li>
      </ul>
      <h3>Opening hours</h3>
      ${plan.assumptions.some((a) => /hours/i.test(a)) ? '<!-- CONFIRM WITH CLIENT BEFORE LAUNCH: these are our default trade hours, the client did not set them. -->' : ''}
      <ul class="hours">
        ${facts.hoursLines.map((l) => `<li>${esc(l)}</li>`).join('\n        ')}
      </ul>
      ${
        plan.schema.sameAs.length > 0
          ? `<div class="socials">${plan.schema.sameAs
              .map(
                (u) =>
                  `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(socialLabel(u))}</a>`,
              )
              .join('')}</div>`
          : ''
      }
    </div>
    ${formMarkup({
      id: 'contactForm',
      heading: plan.contact.formHeading,
      button: plan.contact.formButtonLabel,
      subject: facts.contactFormSubject,
      key: facts.web3formsKey,
      headingLevel: 3,
    })}
  </div>
</section>

<footer class="site-footer">
  <div class="wrap">
    <div class="site-footer__grid">
      <div>
        ${
          plan.brand.logoTreatment !== 'css-logotype' && facts.logoPath
            ? `<img class="site-footer__logo" src="${esc(facts.logoPath)}" alt="${esc(plan.brand.businessName)} logo" width="240" height="70">`
            : `<p class="brand__name" style="color:var(--white)">${esc(plan.brand.wordmarkText)}</p>`
        }
        <p>${esc(clean(plan.brand.tagline))}</p>
        <p><a href="tel:${esc(facts.phoneE164)}">${esc(facts.phoneDisplay)}</a></p>
      </div>
      <div>
        <ul class="site-footer__nav">
          ${navItems.map((n) => `<li><a href="${n.href}">${esc(n.label)}</a></li>`).join('\n          ')}
        </ul>
      </div>
    </div>
    <div class="site-footer__legal">
      <span>&copy; ${new Date().getUTCFullYear()} ${esc(plan.brand.businessName)}.${facts.abn ? ` ABN ${esc(facts.abn)}.` : ''}</span>
      <span><a href="https://www.itscold.com.au" target="_blank" rel="noopener">Website by Go Polar Creative</a></span>
    </div>
  </div>
</footer>

<div class="mobile-bar">
  <a href="tel:${esc(facts.phoneE164)}">${icon(ICON_PHONE)}Call now</a>
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

function brandMarkup(plan: ContentPlan, facts: BuildFacts, where: 'header' | 'footer'): string {
  const name = esc(plan.brand.wordmarkText)
  if (plan.brand.logoTreatment === 'image' && facts.logoPath) {
    return `<a class="brand" href="#top"><img class="brand__logo" src="${esc(facts.logoPath)}" alt="${esc(plan.brand.businessName)} logo" width="180" height="46"></a>`
  }
  if (plan.brand.logoTreatment === 'cropped-mark' && facts.logoPath) {
    return `<a class="brand" href="#top"><img class="brand__logo" src="${esc(facts.logoPath)}" alt="${esc(plan.brand.businessName)} logo" width="180" height="46"><span class="brand__name">${name}</span></a>`
  }
  const initials = plan.brand.wordmarkText
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase()
  return `<!-- CLIENT TO SUPPLY: logo artwork as a transparent PNG or SVG. A CSS logotype is used in the ${where} until then. -->
    <a class="brand" href="#top"><span class="brand__mark">${esc(initials)}</span><span class="brand__name">${name}</span></a>`
}

function formMarkup(args: {
  id: string
  heading: string
  button: string
  subject: string
  key: string
  headingLevel: 2 | 3
}): string {
  const h = `h${args.headingLevel}`
  return `<div class="card-form">
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
  if (facts.logoPath) business.image = `${url}${facts.logoPath}`

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
