// Content plan. Output of generation call 1, input to call 2, and the editable source of truth
// for the edit loop in Phase 4.
//
// This schema is strict on purpose. If the model returns something that does not parse, that is
// a generation failure worth retrying, not something to paper over: a malformed plan produces a
// malformed site, and the customer is watching.

import { z } from 'zod'
import { DESIGN_STYLES, NAMED_STYLES } from './styles'

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/)

// Section ids in the fixed order from brief s5. Order is not a model decision; only whether a
// section is enabled is, and only for the two sections the brief allows to be dropped.
export const SECTION_IDS = [
  'header',
  'hero',
  'trust_strip',
  'about',
  'services',
  'gallery',
  'why_us',
  'stats',
  'process',
  'service_areas',
  'testimonials',
  'faq',
  'cta_band',
  'contact',
  'footer',
] as const
export type SectionId = (typeof SECTION_IDS)[number]

/** Sections the model may switch off, and only for the reason given in the brief. */
export const OPTIONAL_SECTIONS: SectionId[] = ['gallery', 'testimonials']

export const planSchema = z.object({
  meta: z.object({
    title: z.string().min(10).max(70),
    metaDescription: z.string().min(70).max(165),
    ogTitle: z.string().min(5).max(80),
    ogDescription: z.string().min(40).max(200),
    lang: z.literal('en-AU'),
    geoRegion: z.string().regex(/^AU-(QLD|NSW|VIC|SA|WA|TAS|NT|ACT)$/),
    geoPlacename: z.string().min(2),
    geoPosition: z.object({ lat: z.number(), lng: z.number() }),
  }),

  /**
   * The design style this build was made in. Carried on the plan so it survives an edit and a
   * rollback, and so a later edit can change it like any other part of the plan.
   *
   * `reason` is how the style was arrived at when the customer said 'not sure'. It is internal:
   * nothing renders it to the customer, who asked us to pick rather than to explain.
   */
  style: z.object({
    chosen: z.enum(DESIGN_STYLES),
    resolved: z.enum(NAMED_STYLES),
    reason: z.string(),
    constraints: z.array(z.string()).default([]),
  }),

  brand: z.object({
    businessName: z.string().min(2),
    tagline: z.string().min(5).max(90),
    /**
     * image        - use the uploaded logo as-is in the header
     * cropped-mark - wide horizontal lockup, crop the mark for the header and pair it with a
     *                CSS wordmark, use the full logo larger in the footer
     * css-logotype - no usable artwork (missing, or a mockup render). Build type only and flag
     *                for real artwork.
     */
    logoTreatment: z.enum(['image', 'cropped-mark', 'css-logotype']),
    wordmarkText: z.string().min(1).max(40),
  }),

  // Every colour the build is allowed to use, declared once. The house rules forbid hex values
  // anywhere in the CSS outside :root, so this list is the complete palette.
  tokens: z.object({
    primary: hex,
    primaryDark: hex,
    primaryLight: hex,
    accent: hex,
    ink: hex,
    inkMuted: hex,
    surface: hex,
    surfaceAlt: hex,
    line: hex,
    white: hex,
    black: hex,
    success: hex,
  }),

  hero: z.object({
    h1: z.string().min(10).max(90),
    sub: z.string().min(30).max(220),
    ctaPrimary: z.object({ label: z.string().min(2).max(30), href: z.string().min(1) }),
    ctaSecondary: z.object({ label: z.string().min(2).max(30), href: z.string().min(1) }),
    trustPoints: z.array(z.string().min(3).max(40)).length(4),
    formHeading: z.string().min(3).max(60),
    formButtonLabel: z.string().min(2).max(30),
  }),

  trustStrip: z
    .array(z.object({ label: z.string().min(2).max(30), detail: z.string().min(3).max(60) }))
    .length(4),

  about: z.object({
    heading: z.string().min(5).max(80),
    body: z.array(z.string().min(40)).min(2).max(4),
    pullQuote: z.string().min(15).max(180),
  }),

  services: z
    .array(
      z.object({
        name: z.string().min(2).max(60),
        blurb: z.string().min(30).max(300),
        /** Hint for the inline SVG icon. No emoji, no icon fonts, no external assets. */
        iconHint: z.string().min(2).max(30),
      }),
    )
    .min(3)
    .max(8),

  gallery: z.object({
    // Off when fewer than 3 usable photos were supplied. The brief is explicit: no stock photos.
    enabled: z.boolean(),
    heading: z.string().min(3).max(60),
    items: z
      .array(z.object({ assetId: z.string(), alt: z.string().min(5).max(125) }))
      .max(20),
  }),

  whyUs: z
    .array(z.object({ title: z.string().min(3).max(60), body: z.string().min(30).max(260) }))
    .min(3)
    .max(6),

  // Animated counters. Every value has to be derived from the intake, never invented.
  // `source` names the intake field it came from so verification and review can check it.
  stats: z
    .array(
      z.object({
        value: z.number(),
        suffix: z.string().max(6),
        label: z.string().min(3).max(40),
        source: z.string().min(2).max(60),
      }),
    )
    .min(3)
    .max(4),

  process: z
    .array(z.object({ title: z.string().min(3).max(40), body: z.string().min(20).max(220) }))
    .length(4),

  serviceAreas: z.object({
    heading: z.string().min(5).max(80),
    blurb: z.string().min(30).max(400),
    suburbs: z.array(z.string().min(2)).min(3),
  }),

  testimonials: z.object({
    // Off unless real reviews were supplied. Never fabricate. This is checked again server side
    // against the intake before the build call runs.
    enabled: z.boolean(),
    heading: z.string().min(3).max(60),
    items: z
      .array(
        z.object({
          quote: z.string().min(15),
          name: z.string().min(2),
          suburb: z.string().min(2),
        }),
      )
      .max(6),
  }),

  // FAQ copy must match the FAQPage JSON-LD word for word. The build call is told to emit the
  // same strings in both places, and verification compares them.
  faq: z
    .array(z.object({ q: z.string().min(10).max(160), a: z.string().min(40).max(700) }))
    .min(5)
    .max(8),

  ctaBand: z.object({
    heading: z.string().min(10).max(90),
    body: z.string().min(20).max(220),
    ctaLabel: z.string().min(2).max(30),
  }),

  contact: z.object({
    heading: z.string().min(5).max(80),
    blurb: z.string().min(20).max(300),
    formHeading: z.string().min(3).max(60),
    formButtonLabel: z.string().min(2).max(30),
  }),

  schema: z.object({
    businessType: z.string().min(3),
    areaServed: z.discriminatedUnion('mode', [
      z.object({
        mode: z.literal('city'),
        cities: z.array(z.string().min(2)).min(1),
      }),
      z.object({
        mode: z.literal('geocircle'),
        lat: z.number(),
        lng: z.number(),
        radiusMetres: z.number().int().positive(),
      }),
    ]),
    sameAs: z.array(z.string().url()),
    priceRange: z.string().max(10).optional(),
  }),

  /**
   * Anything the model had to assume. Each one becomes a
   * <!-- CONFIRM WITH CLIENT BEFORE LAUNCH: ... --> comment in the HTML, and each one is
   * surfaced to the customer in the preview. Empty array is a valid and good answer.
   */
  assumptions: z.array(z.string().min(5)).default([]),

  /**
   * Placeholders the client still owes us, e.g. photos for a section built with CSS gradients.
   * Each becomes a <!-- CLIENT TO SUPPLY: ... --> comment.
   */
  clientToSupply: z.array(z.string().min(5)).default([]),
})

export type ContentPlan = z.infer<typeof planSchema>

/**
 * One photo as it will ship: a web-sized and a thumbnail variant, each with a WebP and a JPEG,
 * so the generated site can use <picture> and every browser takes the smaller file it supports.
 * See server/lib/images.ts and DECISIONS.md D25 for why originals are never referenced.
 */
export interface PhotoRef {
  assetId: string
  webWebp: string
  webJpeg: string
  thumbWebp: string
  thumbJpeg: string
  width: number
  height: number
  /** Bytes of the web WebP, which is what most visitors actually download. */
  bytes: number
}

export interface LogoRef {
  /** Preferred file, WebP or SVG. */
  path: string
  /** PNG fallback for the <picture>, absent when the logo is an SVG. */
  fallback: string | null
  width: number
  height: number
}

/**
 * Facts the build call is not allowed to change. Passed alongside the plan so the model cannot
 * quietly reformat a phone number or drop a suburb.
 */
export interface BuildFacts {
  businessName: string
  phoneE164: string
  phoneDisplay: string
  email: string
  abn: string | null
  address: { line1: string; suburb: string; state: string; postcode: string } | null
  hoursLines: string[]
  openingHoursSpec: Array<{ days: string[]; opens: string; closes: string }>
  byAppointment: boolean
  emergency: boolean
  freeQuotes: boolean
  web3formsKey: string
  heroFormSubject: string
  contactFormSubject: string
  logo: LogoRef | null
  photos: PhotoRef[]
  /**
   * Every file that will ship alongside index.html, by the exact path the HTML must use, with
   * its byte size. Drives the "referenced assets exist" check and the page weight check.
   */
  assetManifest: Record<string, { key: string; bytes: number; contentType: string }>
  canonicalUrl: string
  googleReviewLink: string | null
}
