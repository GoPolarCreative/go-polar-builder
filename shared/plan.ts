// Content plan. Output of generation call 1, input to call 2, and the editable source of truth
// for the edit loop in Phase 4.
//
// This schema is strict on purpose. If the model returns something that does not parse, that is
// a generation failure worth retrying, not something to paper over: a malformed plan produces a
// malformed site, and the customer is watching.

import { z } from 'zod'
import { DESIGN_STYLES, NAMED_STYLES } from './styles.js'

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

/*
 * MARKUP IS STRIPPED FROM EVERY STRING BEFORE THE PLAN IS VALIDATED.
 *
 * Every text field in this schema is plain text. The renderers escape all of it, which is correct
 * and is not negotiable: plan content is model output, and model output must never be able to
 * inject HTML into a customer's page.
 *
 * The consequence, before this existed, was that markup the model wrote did not disappear, it
 * became VISIBLE. Driftwood Building Co's service page heading was written by the model as
 * "Timber decks built for <em>Bass Coast living</em>", the renderer escaped it exactly as designed,
 * and the page showed a reader the angle brackets. Four pages across two customers shipped that
 * way, and every one of the checks passed, because the document was valid HTML that said something
 * silly rather than invalid HTML.
 *
 * Escaping at the point of render was never the wrong call. The gap was that nothing removed the
 * markup on the way IN, so a field declared plain text could still be handed something that was
 * not. Stripping here closes it for every field at once, including fields added later, which is
 * why this is a preprocess over the whole object rather than a wrapper repeated on fifty fields
 * that someone will forget to apply to the fifty-first.
 *
 * Stripping happens BEFORE the length constraints, so a heading is measured as the reader will see
 * it. If removing the markup takes a field under its minimum the plan is rejected and regenerated,
 * which is the right outcome: a heading that is only long enough because of tags is not long
 * enough.
 */

/** A tag, or a tag that has already been escaped into text. Both are markup the model invented. */
const TAG = /<\/?[a-zA-Z][^>]*>/g
const ESCAPED_TAG = /&lt;\/?[a-zA-Z][^&]*?&gt;/g

/*
 * Only tag-SHAPED sequences go. A bare "<" is left alone, because "jobs < 2 hours" is prose a
 * tradie might legitimately write and is not markup.
 */
export function stripMarkup(value: string): string {
  const out = value
    .replace(ESCAPED_TAG, '')
    .replace(TAG, '')
    // Entities the model reaches for when it is thinking in HTML. Decoding is safe because every
    // renderer escapes on the way out, so "&" here becomes "&amp;" there exactly once.
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
  return out
}

/** Depth-first over whatever the model returned, leaving non-strings untouched. */
function stripDeep(value: unknown): unknown {
  if (typeof value === 'string') return stripMarkup(value)
  if (Array.isArray(value)) return value.map(stripDeep)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = stripDeep(v)
    return out
  }
  return value
}

/**
 * An entry that arrived as a sentence instead of an object.
 *
 * Callum's landscaping build died after three attempts on "servicePages.0.steps.0: Expected
 * object, received string". The model had been told in prose that steps were stages of the job
 * and never shown that a stage is an object, so it wrote a list of sentences, which is a
 * perfectly reasonable reading. The skeleton now shows the shape and that is the real fix.
 *
 * This is the seatbelt. These three fields are optional by design, so the worst honest outcome
 * is a page without them, which falls back to the home page sections and is caught by check 24
 * as a warning. That is a plainer page. A plan that will not validate is no website at all, on
 * a build somebody has paid for, and the difference between those two is not close.
 *
 * NOTHING IS INVENTED. A title is only ever taken from the model's own sentence: the part
 * before a colon, or the first sentence, or failing both the opening few words. An entry that
 * cannot be salvaged inside the real bounds is dropped rather than padded, and if fewer than
 * three survive the whole field goes, because half a section is worse than none.
 */
function coercePairs(
  keyA: string,
  keyB: string,
  bounds: { aMin: number; aMax: number; bMin: number; bMax: number },
) {
  const fits = (a: string, b: string) =>
    a.length >= bounds.aMin && a.length <= bounds.aMax && b.length >= bounds.bMin && b.length <= bounds.bMax

  const one = (value: unknown): Record<string, string> | null => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const o = value as Record<string, unknown>
      const a = typeof o[keyA] === 'string' ? (o[keyA] as string).trim() : ''
      const b = typeof o[keyB] === 'string' ? (o[keyB] as string).trim() : ''
      return fits(a, b) ? { [keyA]: a, [keyB]: b } : null
    }
    if (typeof value !== 'string') return null

    const text = value.trim()
    // "Mark it out: we set the line and check levels before anything is dug."
    for (const sep of [': ', '. ']) {
      const at = text.indexOf(sep)
      if (at <= 0) continue
      const a = text.slice(0, at).trim()
      const b = text.slice(at + sep.length).trim()
      if (fits(a, b)) return { [keyA]: a, [keyB]: b }
    }
    // No split to be had. The opening words become the heading and every word is kept.
    const head = text.split(/\s+/).slice(0, 5).join(' ').slice(0, bounds.aMax)
    return fits(head, text) ? { [keyA]: head, [keyB]: text } : null
  }

  return (value: unknown) => {
    // Anything that is not a list at all is dropped, not handed on to fail against the array
    // rule underneath. The field is optional, so absent is a legal answer and a dead build is not.
    if (!Array.isArray(value)) return undefined
    const kept = value.map(one).filter((x): x is Record<string, string> => x !== null)
    return kept.length >= 3 ? kept.slice(0, 5) : undefined
  }
}

const planObject = z.object({
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
  /*
   * THE WORDS THE TEMPLATE USED TO OWN.
   *
   * renderSite hardcoded eleven eyebrows and five section headings and blurbs, because they
   * are the same on every site and writing them once seemed like the point of a template. It
   * is not: they are WORDS ON A CUSTOMER'S WEBSITE, and the customer is paying for ten rounds
   * of changes to their words.
   *
   * Chris asked four times to change the label above a heading. Every edit reported success
   * and charged a round, because the model dutifully changed something in the plan, and the
   * label never moved because the label was not in the plan. Reporting success while
   * delivering less than was asked for is the failure this codebase keeps coming back to, and
   * this is the version of it I introduced.
   *
   * Optional and keyed by section id, so an older plan renders exactly as it does today and
   * anything the model leaves out falls back to the built-in wording.
   */
  /*
   * The handful of layout choices a customer reasonably asks about by name.
   *
   * galleryColumns is derived from the photo count, which is right until somebody wants
   * something else: nine photos give four across, and a customer asking for three rows of
   * three had no way to say so. Optional, so the derived answer stands unless asked.
   */
  layout: z
    .object({
      galleryColumns: z.number().int().min(2).max(4).optional(),
      /*
       * The photograph behind the closing call to action. On by default because a flat band of
       * colour there is what made the page read as blocks stacked by a machine. Off is a real
       * request though: it is their photo on their website, and "remove the image behind READY
       * TO GET STARTED" had no way to be carried out.
       */
      ctaBandPhoto: z.boolean().optional(),
      /*
       * How tall the logo is allowed to be, in the header and in the footer.
       *
       * "Make the logo bigger" is one of the most common things anybody says about a website
       * and there was no field for it: the height was a number in the stylesheet, so the model
       * had nowhere to put the change and the customer was told it had been made. The footer
       * follows at roughly the same proportion it always had.
       */
      logoHeight: z.number().int().min(32).max(140).optional(),
      /*
       * Whether a gallery photo opens full size when it is tapped. On by default: the photos
       * are the work, and a thumbnail in a three column grid on a phone is too small to show
       * anything. Off is here because somebody will want it off.
       */
      lightbox: z.boolean().optional(),
      /*
       * The photo behind the heading at the top of a SERVICE page. On by default, because a
       * trade page with a picture of the work on it is the point.
       *
       * It exists because "remove the hero image on all service pages" had nowhere to go. The
       * model answered correctly - it wrote that the schema had no field for it - and that
       * refusal went into assumptions, which renders as an HTML comment nobody reads, while
       * the edit was recorded as a success and charged a round.
       */
      servicePageHeroPhoto: z.boolean().optional(),
      /** The same, for the photo behind the heading on the home page. */
      heroPhoto: z.boolean().optional(),
      /*
       * THERE IS DELIBERATELY NO heroPhotoAssetId HERE.
       *
       * The hero is facts.photos[0], and which photo that is comes from the order of the
       * photos, which the customer sets with the "Make hero" button on the photos panel.
       * That button has always existed and it works.
       *
       * A plan field was added here so a chat request could choose the hero too, and it was
       * wrong: the renderer preferred the field, so a customer who chose the hero by chat and
       * then pressed "Make hero" on a different photo would have watched the button do
       * nothing. Two mechanisms for one choice, with one silently beating the other, is the
       * exact failure this codebase keeps paying for.
       *
       * If the hero ever needs to be settable from chat, the answer is to make the request
       * reorder the photos, so there stays one source of truth for which one is first.
       */
    })
    .optional(),

  /*
   * EVERY OTHER WORD THE TEMPLATE SUPPLIES.
   *
   * sectionCopy covers the labels above headings. This covers the rest: form field labels,
   * footer column headings, button and link text, the note under the enquiry form. They were
   * literals in the renderer, which meant a customer could read them on their own website and
   * no edit could touch them.
   *
   * Flat and free-keyed on purpose. The renderer asks for a key and supplies the wording that
   * ships if nobody has changed it, so adding a label later is one call and not a schema
   * change, and test/sitefixes.test.ts fails if a visible string appears that no key covers.
   */
  labels: z.record(z.string(), z.string().max(120)).optional(),

  /*
   * THE ENQUIRY FORM, AS A LIST RATHER THAN FOUR LINES OF MARKUP.
   *
   * Name, phone, email and message were written into the renderer, so "add a suburb field to
   * the contact form" had nowhere to go. It is a reasonable thing for a tradie to want: which
   * suburb the job is in decides whether they take it.
   *
   * Optional, and absent means the four that always shipped. Web3Forms forwards whatever it is
   * sent, so a new field arrives in the inbox without anything else being configured.
   *
   * name is the key the enquiry arrives under and has to be a plain identifier: it goes into a
   * form post, and a stray quote or bracket there breaks the submission rather than the page.
   */
  formFields: z
    .array(
      z.object({
        name: z.string().min(1).max(40).regex(/^[a-z][a-z0-9_]*$/i),
        label: z.string().min(1).max(60),
        type: z.enum(['text', 'tel', 'email', 'textarea', 'select']).default('text'),
        required: z.boolean().default(false),
        /** Only for select. Ignored otherwise. */
        options: z.array(z.string().min(1).max(60)).max(30).optional(),
        /** Passed to the browser so it can offer what it already knows. */
        autocomplete: z.string().max(40).optional(),
      }),
    )
    .min(1)
    .max(12)
    .optional(),

  sectionCopy: z
    .record(
      z.string(),
      z.object({
        eyebrow: z.string().max(40).optional(),
        heading: z.string().max(90).optional(),
        blurb: z.string().max(220).optional(),
        /*
         * The colour of that label, for this section only. tokens.eyebrow sets them all at
         * once, which is the right answer until somebody wants two of them black and the rest
         * left alone, and then it is no answer at all.
         */
        eyebrowColor: hex.optional(),
      }),
    )
    .optional(),

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
    /*
     * The small caps label above a heading. Optional, falling back to the accent, which is
     * what it always was. It is separate because the accent is a brand colour used on buttons
     * and links where it works, and the eyebrow is the one place it lands on a photo or a dark
     * band where a customer may simply want it white.
     */
    eyebrow: hex.optional(),
    /*
     * The filled button. Optional, falling back to the accent, which is what it always was.
     * Separate for the same reason the eyebrow is: the accent paints buttons, links, icons and
     * labels at once, and "make the Call Now button green" should not repaint all of them.
     */
    button: hex.optional(),
    /*
     * The tick icons beside the hero trust points. They follow the accent, which is right until
     * somebody wants them green on a page whose accent is grey. Same shape as eyebrow and
     * button: a token of its own that falls back to the accent.
     */
    heroTick: hex.optional(),
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
    // Matches the intake ceiling. Raising one without the other means a customer can submit
    // twenty services and then have the plan rejected for containing them.
    .max(20),

  /**
   * One extra page per additional page the customer bought, each about a single service.
   *
   * Empty on a one-page build, which is what the $220 build token buys. The mechanism this sells
   * on: a home page covering eight services competes with itself, while a page about one service
   * in a named service area gives a search engine something specific to match. Never longer than
   * the job's page allowance: see server/lib/pages.ts.
   */
  servicePages: z
    .array(
      z.object({
        /** URL slug, kebab-case, derived from the service name. */
        slug: z.string().min(2).max(60).regex(/^[a-z0-9-]+$/),
        /** The service this page is about, matching one of the services above exactly. */
        service: z.string().min(2).max(60),
        title: z.string().min(10).max(70),
        metaDescription: z.string().min(70).max(165),
        h1: z.string().min(10).max(90),
        /*
         * TWO PARAGRAPHS MINIMUM, AND THE REASON IS A BUG THIS SCHEMA ALLOWED.
         *
         * The first paragraph is the hero subtitle and the rest are the body of the "what it
         * involves" section. While one was legal, both places rendered intro[0], and every
         * real page printed its opening sentence twice: once under the h1 and again a screen
         * later. Confirmed on the shipped Driftwood export. Requiring two makes the two uses
         * distinct by construction rather than by the renderer remembering to slice.
         */
        intro: z.array(z.string().min(40)).min(2).max(3),
        /** What the job actually involves. Three to six lines, from the intake, never invented. */
        included: z.array(z.string().min(10).max(160)).min(3).max(6),

        /*
         * WHY THESE THREE EXIST, MEASURED RATHER THAN GUESSED.
         *
         * Two service pages off the last real build were compared block by block: 480 words
         * of visible text, of which 350 were IDENTICAL on both pages and 130 were about the
         * service. The template was reprinting the home page's process steps and the home
         * page's FAQ on every service page, so the two biggest content sections on a page
         * about decking were about the business in general.
         *
         * A page carrying 130 words about its own subject is a container with the right label
         * on it. These give the page its own middle: how this particular job runs, what makes
         * it bigger or smaller, and the questions people actually ask about it.
         *
         * OPTIONAL ON PURPOSE. enforcePlanInvariants synthesises a page from the intake when
         * the model omits one it was paid to write, and synthesised copy cannot know how a
         * retaining wall gets built. When they are absent the renderer falls back to the home
         * page's sections, which is what it always did. Thin and true beats padded and wrong.
         */
        steps: z.preprocess(
          coercePairs('title', 'body', { aMin: 3, aMax: 60, bMin: 40, bMax: 300 }),
          z
            .array(z.object({ title: z.string().min(3).max(60), body: z.string().min(40).max(300) }))
            .min(3)
            .max(5)
            .optional(),
        ),
        /*
         * What makes this job bigger or smaller. Mechanism only: D44 forbids quoting a price
         * or promising a result, and this is the honest way to answer "what will it cost"
         * without doing either.
         */
        scopeFactors: z.preprocess(
          coercePairs('label', 'detail', { aMin: 3, aMax: 60, bMin: 40, bMax: 300 }),
          z
            .array(z.object({ label: z.string().min(3).max(60), detail: z.string().min(40).max(300) }))
            .min(3)
            .max(5)
            .optional(),
        ),
        faqs: z.preprocess(
          coercePairs('q', 'a', { aMin: 10, aMax: 120, bMin: 60, bMax: 600 }),
          z
            .array(z.object({ q: z.string().min(10).max(120), a: z.string().min(60).max(600) }))
            .min(3)
            .max(5)
            .optional(),
        ),
      }),
    )
    // Matches the intake's ownPageServices ceiling. A customer can buy a page per service, and
    // with the services ceiling at twenty this has to reach twenty as well or the plan is
    // rejected for containing exactly the pages the customer paid for.
    .max(20)
    .default([]),

  /*
   * A HEADING IS ONLY REQUIRED WHEN THE SECTION IS ON.
   *
   * heading was min(3) unconditionally, including for a gallery that is switched off. A business
   * with no photos gets gallery.enabled false, and the model then quite reasonably returns an
   * empty heading for a section that will never render. That failed validation three times and
   * the whole build died with "Content plan did not validate after 3 attempts".
   *
   * It bit LSV Services, which supplied neither photos nor reviews, so gallery and testimonials
   * were both off and both headings empty. That combination is not an edge case: it is the
   * ordinary state of a tradie who has not sent us anything yet, which is most of them.
   */
  gallery: z
    .object({
      // Off when fewer than 3 usable photos were supplied. The brief is explicit: no stock photos.
      enabled: z.boolean(),
      heading: z.string().max(60).default(''),
      items: z
        .array(z.object({ assetId: z.string(), alt: z.string().min(5).max(125) }))
        .max(20),
    })
    .superRefine((value, ctx) => {
      if (value.enabled && value.heading.trim().length < 3) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['heading'],
          message: 'A gallery that is switched on needs a heading of at least 3 characters.',
        })
      }
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

  // Same reasoning as gallery above: a heading for a section that is switched off is not a thing
  // the model can sensibly be required to invent, and demanding one killed whole builds.
  testimonials: z
    .object({
      // Off unless real reviews were supplied. Never fabricate. This is checked again server side
      // against the intake before the build call runs.
      enabled: z.boolean(),
      heading: z.string().max(60).default(''),
      items: z
        .array(
          z.object({
            quote: z.string().min(15),
            name: z.string().min(2),
            suburb: z.string().min(2),
          }),
        )
        .max(6),
    })
    .superRefine((value, ctx) => {
      if (value.enabled && value.heading.trim().length < 3) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['heading'],
          message: 'A testimonials section that is switched on needs a heading of at least 3 characters.',
        })
      }
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

export const planSchema = z.preprocess(stripDeep, planObject)

/**
 * Every top-level key a plan MAY have, including the optional ones a given plan does not.
 *
 * THE BUG THIS ENDS. The edit step checked each returned key against the customer’s CURRENT
 * plan object, so any optional field their plan did not already contain came back as "not a
 * top-level key of the plan" and the whole edit died. Every plan is written by the version of
 * the app that built it, so that rule made each new optional field permanently unreachable for
 * everybody who already had a website. sectionCopy hit it, layout hit it and killed an edit
 * outright, and anything added later would have hit it too.
 *
 * Derived from the schema rather than typed out, so a field cannot be added without also being
 * editable. A hand-written list is the same bug waiting to be put back.
 */
export const PLAN_KEYS: ReadonlySet<string> = new Set(Object.keys(planObject.shape))

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
  /** Null unless a review link was also supplied. See buildFacts for why they travel together. */
  googleRating: number | null
  googleReviewCount: number | null
}
