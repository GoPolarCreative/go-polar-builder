import type { AuditFlag } from '../../shared/types.js'
import type { BuildFacts, ContentPlan } from '../../shared/plan.js'
import type { IntakePayload } from '../../shared/intake.js'
import { TRADE_LABELS, TRADE_SCHEMA_TYPE } from '../../shared/trades.js'
import { formatAuPhone } from '../../shared/phone.js'
import { styleDirective, styleSpec, type NamedStyleId } from '../../shared/styles.js'

/**
 * User-message builders for both generation calls.
 *
 * Kept apart from houseRules.ts because these change per job and the house rules must not:
 * the cached prefix is the system block, and interpolating a business name into it would
 * invalidate the cache on every single build.
 */

// ---------------------------------------------------------------------------------------------
// Call 1 - content plan
// ---------------------------------------------------------------------------------------------

/** The literal shape the model must return. Mirrors shared/plan.ts, which validates it. */
const PLAN_SHAPE = `{
  "meta": {
    "title": "50 to 70 chars, primary service + base suburb + business name",
    "metaDescription": "70 to 165 chars, what they do, where, and one reason to ring",
    "ogTitle": "string",
    "ogDescription": "string",
    "lang": "en-AU",
    "geoRegion": "AU-QLD style code for the base suburb state",
    "geoPlacename": "base suburb name",
    "geoPosition": { "lat": number, "lng": number }
  },
  "brand": {
    "businessName": "string",
    "tagline": "5 to 90 chars",
    "logoTreatment": "image | cropped-mark | css-logotype",
    "wordmarkText": "text for the CSS wordmark, usually the business name"
  },
  "tokens": {
    "primary": "#rrggbb", "primaryDark": "#rrggbb", "primaryLight": "#rrggbb",
    "accent": "#rrggbb", "ink": "#rrggbb", "inkMuted": "#rrggbb",
    "surface": "#rrggbb", "surfaceAlt": "#rrggbb", "line": "#rrggbb",
    "white": "#ffffff", "black": "#000000", "success": "#rrggbb"
  },
  "hero": {
    "h1": "10 to 90 chars, primary service plus location",
    "sub": "30 to 220 chars",
    "ctaPrimary": { "label": "string", "href": "tel:+61..." },
    "ctaSecondary": { "label": "string", "href": "#contact" },
    "trustPoints": ["exactly", "four", "short", "items"],
    "formHeading": "string",
    "formButtonLabel": "string"
  },
  "trustStrip": [ { "label": "string", "detail": "string" } ],
  "about": { "heading": "string", "body": ["2 to 4 paragraphs"], "pullQuote": "string" },
  "services": [ { "name": "string", "blurb": "30 to 300 chars", "iconHint": "what to draw, e.g. water drop" } ],
  "gallery": { "enabled": boolean, "heading": "string", "items": [ { "assetId": "id from the photo list", "alt": "5 to 125 chars" } ] },
  "whyUs": [ { "title": "string", "body": "string" } ],
  "stats": [ { "value": number, "suffix": "+ or none", "label": "string", "source": "which intake field this came from" } ],
  "process": [ { "title": "string", "body": "string" } ],
  "serviceAreas": { "heading": "string", "blurb": "string", "suburbs": ["every suburb supplied"] },
  "testimonials": { "enabled": boolean, "heading": "string", "items": [ { "quote": "verbatim", "name": "first name", "suburb": "string" } ] },
  "faq": [ { "q": "string", "a": "40 to 700 chars" } ],
  "ctaBand": { "heading": "string", "body": "string", "ctaLabel": "string" },
  "contact": { "heading": "string", "blurb": "string", "formHeading": "string", "formButtonLabel": "string" },
  "schema": {
    "businessType": "schema.org type given below, use it exactly",
    "areaServed": { "mode": "city", "cities": ["..."] },
    "sameAs": ["social urls supplied, else empty array"],
    "priceRange": "optional, only if you were told"
  },
  "assumptions": ["plain English, empty array if none"],
  "clientToSupply": ["things still missing, empty array if none"]
}`

export function planUserMessage(args: {
  intake: IntakePayload
  facts: BuildFacts
  auditFlags: AuditFlag[]
  photoInventory: Array<{ assetId: string; path: string; note: string }>
  usablePhotoCount: number
  /** Already decided, by the customer or on their behalf. Not the model's to choose. */
  style: NamedStyleId
}): string {
  const { intake, facts, auditFlags, photoInventory, usablePhotoCount } = args

  const areaServedGuidance =
    intake.travelRadius === 'statewide'
      ? `Use mode "geocircle" with lat ${intake.baseSuburb.lat}, lng ${intake.baseSuburb.lng} and radiusMetres 250000, because the business services the whole state.`
      : `Use mode "city" and list every suburb supplied as a City. The travel radius is ${intake.travelRadius}km, which is a normal metro service area, so City objects are the right shape.`

  return `# THE BUSINESS

Business name: ${intake.businessName}
Trade: ${TRADE_LABELS[intake.trade]}
${intake.tradingEntityName ? `Trading entity: ${intake.tradingEntityName}\n` : ''}Years in business: ${intake.yearsInBusiness}
Phone: ${formatAuPhone(intake.phone)}
Email: ${intake.email}
${facts.address ? `Address: ${facts.address.line1}, ${facts.address.suburb} ${facts.address.state} ${facts.address.postcode}` : 'Address: not supplied, this is a mobile trade'}
${intake.abn ? `ABN: ${intake.abn}` : 'ABN: not supplied'}

# SERVICES

Services offered: ${intake.services.join(', ')}
Primary service, this drives the h1: ${intake.primaryService}
Free quotes offered: ${intake.freeQuotes ? 'YES, you may use the phrase "free quote"' : 'NO. The phrase "free quote" must not appear anywhere in the plan, in any casing.'}
Emergency or after hours: ${intake.emergency ? 'YES, they take emergency and after hours calls' : 'NO, do not imply 24/7 availability'}

# SERVICE AREA

Base suburb: ${intake.baseSuburb.name}, ${intake.baseSuburb.state} ${intake.baseSuburb.postcode} (lat ${intake.baseSuburb.lat}, lng ${intake.baseSuburb.lng})
Suburbs serviced (${intake.suburbsServiced.length}): ${intake.suburbsServiced.map((s) => s.name).join(', ')}
Travel radius: ${intake.travelRadius === 'statewide' ? 'statewide' : intake.travelRadius + 'km'}
areaServed: ${areaServedGuidance}
geoRegion: AU-${intake.baseSuburb.state}

# IN THEIR OWN WORDS

About the business:
"""
${intake.about}
"""
${intake.different ? `What makes them different:\n"""\n${intake.different}\n"""` : 'What makes them different: not supplied'}

# HOURS

${facts.byAppointment ? 'By appointment only.' : facts.hoursLines.join('\n')}
${intake.hours.isDefault ? 'NOTE: these are our defaults, the customer did not set them. Add an entry to the assumptions array.' : ''}

# REVIEWS

${
  intake.reviews.length === 0
    ? 'None supplied. Set testimonials.enabled to false and items to an empty array. Do not write placeholder reviews.'
    : intake.reviews
        .map((r, i) => `${i + 1}. "${r.quote}" - ${r.firstName}, ${r.suburb}`)
        .join('\n')
}
${intake.googleReviewLink ? `Google review link: ${intake.googleReviewLink}` : ''}

# IMAGES

Logo: ${facts.logo ? `supplied at ${facts.logo.path}` : 'none usable'}
Logo treatment you must use: ${logoTreatmentFor(auditFlags, Boolean(facts.logo))}
Usable photos: ${usablePhotoCount}
${
  photoInventory.length > 0
    ? photoInventory.map((p) => `- assetId ${p.assetId} at ${p.path}: ${p.note}`).join('\n')
    : '- none'
}
Gallery: ${usablePhotoCount >= 3 ? 'set gallery.enabled true and write alt text for each photo' : 'set gallery.enabled false and items to an empty array. Fewer than 3 usable photos. Do not use stock photography.'}

# BRAND COLOURS

Sampled from the logo (source: ${intake.palette.source}):
primary ${intake.palette.primary}, secondary ${intake.palette.secondary}, accent ${intake.palette.accent}, dark ${intake.palette.dark}, light ${intake.palette.light}
Build the full token set from these. Keep primary dark enough to carry white text.

# SOCIAL LINKS

${
  Object.entries(intake.socials)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n') || 'None supplied. sameAs is an empty array.'
}

# SCHEMA TYPE

Use exactly this for schema.businessType: ${TRADE_SCHEMA_TYPE[intake.trade]}

# GAP AUDIT FINDINGS

${
  auditFlags.length === 0
    ? 'None.'
    : auditFlags.map((f) => `- [${f.code}] ${f.message}\n  Build effect: ${f.buildEffect}`).join('\n')
}

${styleDirective(styleSpec(args.style))}

The style is already decided and is not yours to change. It is applied when the site is built, so
do not put it in the JSON. What it should change here is the WRITING: an industrial site wants
short, blunt lines; a refined one wants fewer words with more room around them; a warm one can
afford a longer, more personal about section. Same facts, pitched to match.

# RETURN THIS SHAPE

${PLAN_SHAPE}

Return the JSON object only.`
}

function logoTreatmentFor(flags: AuditFlag[], hasLogo: boolean): string {
  if (!hasLogo || flags.some((f) => f.code === 'logo_missing')) {
    return 'css-logotype, because there is no usable logo file'
  }
  if (flags.some((f) => f.code === 'logo_mockup_render')) {
    return 'css-logotype, because the uploaded logo is a mockup render and cannot be used'
  }
  if (flags.some((f) => f.code === 'logo_wide_lockup')) {
    return 'cropped-mark, because the logo is a wide horizontal lockup that goes unreadable at header size'
  }
  return 'image'
}

// ---------------------------------------------------------------------------------------------
// Call 2 - build
// ---------------------------------------------------------------------------------------------

export function factsBlock(facts: BuildFacts, plan: ContentPlan): string {
  return `# FIXED FACTS, USE THESE EXACTLY AS WRITTEN

Business name: ${facts.businessName}
Phone for tel: links (E.164): ${facts.phoneE164}
Phone as displayed on the page: ${facts.phoneDisplay}
Email: ${facts.email}
${facts.abn ? `ABN: ${facts.abn}` : 'ABN: not supplied, omit it from the footer'}
${
  facts.address
    ? `Address: ${facts.address.line1}, ${facts.address.suburb} ${facts.address.state} ${facts.address.postcode}`
    : 'Address: none. Omit streetAddress from PostalAddress entirely, do not emit an empty string. Use addressLocality, addressRegion and postalCode from the base suburb.'
}
Canonical URL: ${facts.canonicalUrl}
Opening hours lines, render these verbatim in the contact section:
${facts.hoursLines.map((l) => `  ${l}`).join('\n')}
openingHoursSpecification for JSON-LD:
${
  facts.openingHoursSpec.length === 0
    ? '  none, the business is by appointment. Omit openingHoursSpecification.'
    : facts.openingHoursSpec
        .map((s) => `  ${s.days.join(', ')} opens ${s.opens} closes ${s.closes}`)
        .join('\n')
}
Emergency or after hours: ${facts.emergency ? 'yes' : 'no, do not imply 24/7'}
Free quotes: ${facts.freeQuotes ? 'yes, the phrase "free quote" is allowed' : 'NO. The string "free quote" must not appear anywhere in the document in any casing.'}

Web3Forms access key: ${facts.web3formsKey}
Hero form subject line: ${facts.heroFormSubject}
Contact form subject line: ${facts.contactFormSubject}

Logo file path: ${facts.logo ? facts.logo.path : 'none, use the CSS logotype treatment'}${
    facts.logo?.fallback ? `\nLogo PNG fallback: ${facts.logo.fallback}` : ''
  }

Photos. Every one has four files, already resized and compressed. Use these exact strings and no
others, and always as a <picture> with the WebP in a <source> and the JPEG on the <img>:
${
  facts.photos.length === 0
    ? '  none supplied. Build every image area with CSS gradients and leave CLIENT TO SUPPLY comments.'
    : facts.photos
        .map(
          (p) =>
            `  assetId ${p.assetId}, ${p.width}x${p.height}\n` +
            `    full width: ${p.webWebp} with fallback ${p.webJpeg}\n` +
            `    thumbnail:  ${p.thumbWebp} with fallback ${p.thumbJpeg}`,
        )
        .join('\n')
}
${facts.googleReviewLink ? `Google review link: ${facts.googleReviewLink}` : ''}

Logo treatment: ${plan.brand.logoTreatment}${
    plan.brand.logoTreatment === 'cropped-mark'
      ? '. Crop the mark for the header and set the wordmark beside it in Barlow Condensed. Use the full logo larger in the footer.'
      : plan.brand.logoTreatment === 'css-logotype'
        ? '. There is no usable logo artwork. Build a CSS logotype from the wordmark text and leave a CLIENT TO SUPPLY comment asking for real artwork.'
        : '.'
  }`
}

export function buildUserMessage(plan: ContentPlan, facts: BuildFacts): string {
  return `${factsBlock(facts, plan)}

${styleDirective(styleSpec(plan.style.resolved))}

# CONTENT PLAN

${JSON.stringify(plan, null, 2)}

Build the complete index.html now. Output the document only.`
}

// ---------------------------------------------------------------------------------------------
// Sectioned fallback (brief s5: build this path from the start, it will be needed)
// ---------------------------------------------------------------------------------------------

export interface SectionSpec {
  id: string
  label: string
  instruction: string
}

/**
 * The sectioned build. Part 1 emits the head and the complete stylesheet, so every later part
 * is writing markup against CSS that already exists. Parts are concatenated server side.
 */
export const SECTION_SPECS: SectionSpec[] = [
  {
    id: 'head',
    label: 'Head and stylesheet',
    instruction: `Output from "<!DOCTYPE html>" down to and including the opening "<body>" tag, and nothing after it.

That means: the doctype, the html tag with lang, the complete head (charset, viewport, title, meta description, canonical, Open Graph, Twitter, geo meta, theme-color, Google Fonts preconnect and stylesheet link), the full JSON-LD @graph script, then a single <style> block containing the ENTIRE stylesheet for the whole page, then the opening body tag.

The stylesheet must be complete. Later parts write markup only and cannot add CSS, so define every class every section will need now, following the section order in the house rules and this class naming convention: block names match section ids (site-header, hero, trust-strip, about, services, gallery, why-us, stats, process, areas, testimonials, faq, cta-band, contact, site-footer, mobile-bar), elements use a double underscore, modifiers use a double hyphen.

Do not output any body content. Stop immediately after "<body>".`,
  },
  { id: 'header', label: 'Sticky header', instruction: 'Output the <header> element only.' },
  { id: 'hero', label: 'Hero', instruction: 'Output the hero <section> only. It contains the single h1 and the quote form.' },
  { id: 'trust_strip', label: 'Trust strip', instruction: 'Output the trust strip <section> only.' },
  { id: 'about', label: 'About', instruction: 'Output the about <section> only.' },
  { id: 'services', label: 'Services grid', instruction: 'Output the services <section> only.' },
  { id: 'gallery', label: 'Gallery', instruction: 'Output the gallery <section> only. If the plan says gallery.enabled is false, output nothing at all, not even a comment.' },
  { id: 'why_us', label: 'Why choose us', instruction: 'Output the why choose us <section> only.' },
  { id: 'stats', label: 'Stat counters', instruction: 'Output the stats <section> only. Each counter element contains its final value in the markup.' },
  { id: 'process', label: 'Process', instruction: 'Output the process <section> only, with exactly four steps.' },
  { id: 'service_areas', label: 'Service areas', instruction: 'Output the service areas <section> only, listing every suburb in the plan.' },
  { id: 'testimonials', label: 'Testimonials', instruction: 'Output the testimonials <section> only. If the plan says testimonials.enabled is false, output nothing at all, not even a comment.' },
  { id: 'faq', label: 'FAQ', instruction: 'Output the FAQ <section> only, using details and summary. The question and answer text must match the FAQPage JSON-LD word for word.' },
  { id: 'cta_band', label: 'CTA band', instruction: 'Output the CTA band <section> only.' },
  { id: 'contact', label: 'Contact', instruction: 'Output the contact <section> only, including the second form and the opening hours lines verbatim.' },
  { id: 'footer', label: 'Footer', instruction: 'Output the <footer> only, including the exact Go Polar credit link, and the mobile sticky bar markup immediately after it.' },
  {
    id: 'script',
    label: 'Scripts and close',
    instruction:
      'Output the single <script> block and then "</body></html>" and nothing else. The script does the five jobs listed in the house rules and guards every element lookup.',
  },
]

export function sectionUserMessage(args: {
  plan: ContentPlan
  facts: BuildFacts
  spec: SectionSpec
  stylesheet: string | null
  previousSectionIds: string[]
}): string {
  const { plan, facts, spec, stylesheet, previousSectionIds } = args

  return `${factsBlock(facts, plan)}

${styleDirective(styleSpec(plan.style.resolved))}

# CONTENT PLAN

${JSON.stringify(plan, null, 2)}
${
  stylesheet
    ? `\n# THE STYLESHEET ALREADY EMITTED\n\nUse these class names. Do not invent new ones, and do not emit any CSS: there is no place left to put it.\n\n${stylesheet}\n`
    : ''
}
${previousSectionIds.length > 0 ? `\n# ALREADY BUILT\n\n${previousSectionIds.join(', ')}\n` : ''}
# THIS PART

${spec.instruction}

Output the markup for this part only. No code fence, no commentary.`
}
