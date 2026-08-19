import type { AuditFlag } from '../../shared/types'
import type { BuildFacts, ContentPlan } from '../../shared/plan'
import type { IntakePayload } from '../../shared/intake'
import { TRADE_LABELS, TRADE_SCHEMA_TYPE } from '../../shared/trades'
import { resolveDesignStyle } from '../../shared/styles'
import { renderSite } from './render/site'

/**
 * OFFLINE FIXTURE GENERATOR. NOT THE PRODUCT.
 *
 * Produces a deterministic content plan without calling the Anthropic API, so that:
 *   1. the pipeline and every verification check can be run and tested with no API key
 *   2. there is a worked reference showing the house rules are satisfiable
 *   3. the design styles can be proved to produce genuinely different sites
 *
 * It is NOT the quality bar and NOT what a customer gets: the real output comes from the two
 * Anthropic calls. Switched on by DEV_OFFLINE_GENERATION, never set in production.
 *
 * The HTML itself is rendered by lib/render/site.ts, which is shared with the sample site and
 * the style comparison.
 */

export const offlineHtml = renderSite

// ---------------------------------------------------------------------------------------------
// Small colour helpers, so tokens are derived rather than guessed
// ---------------------------------------------------------------------------------------------

function clamp(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

function toRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
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

  // The style the customer picked, or the one we pick for them. Recorded on the plan so it
  // survives edits and rollbacks, with the reasoning kept internal.
  const style = resolveDesignStyle({
    chosen: intake.designStyle,
    trade: intake.trade,
    palette: intake.palette,
    description: `${intake.about} ${intake.different ?? ''}`,
  })

  const logoTreatment: ContentPlan['brand']['logoTreatment'] = !facts.logo
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

    style,

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
      // Two clauses on purpose: the second one carries the accent colour under the two-tone
      // device the reference sites all use. Nothing here claims anything the intake did not.
      h1: `${intake.primaryService} in ${base}. ${
        intake.emergency ? 'Answered day or night.' : 'Done properly.'
      }`.slice(0, 90),
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
      heading: `Local ${trade}s, ${intake.yearsInBusiness} years on the tools`,
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
      heading: 'Our work, photographed on site',
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
      heading: `Where we work, and how far we travel`,
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

  return [
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
}
