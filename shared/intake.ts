// Intake schema. Brief s4. One zod schema shared by the wizard and the Worker, so the client
// and the server cannot drift. The Worker re-validates on submit and does not trust the client.
//
// Every field here exists to prevent a specific failure seen in the 59 real Google Form
// submissions. Where that is the reason for a rule, the comment says which failure.

import { z } from 'zod'
import { TRADES } from './trades.js'
import { isValidAbn } from './abn.js'
import { normaliseAuPhone } from './phone.js'
import { DESIGN_STYLES } from './styles.js'

// ---------------------------------------------------------------------------------------------
// Shared leaf types
// ---------------------------------------------------------------------------------------------

export const AU_STATES = ['QLD', 'NSW', 'VIC', 'SA', 'WA', 'TAS', 'NT', 'ACT'] as const

export const suburbRefSchema = z.object({
  name: z.string().min(1),
  state: z.enum(AU_STATES),
  postcode: z.string().regex(/^\d{4}$/),
  lat: z.number(),
  lng: z.number(),
})
export type SuburbRef = z.infer<typeof suburbRefSchema>

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type Day = (typeof DAYS)[number]

export const DAY_LABELS: Record<Day, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
}

// schema.org openingHoursSpecification wants 24h HH:MM, so that is what is stored.
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24 hour time, e.g. 07:00')

export const dayHoursSchema = z.object({
  closed: z.boolean(),
  open: timeSchema,
  close: timeSchema,
})
export type DayHours = z.infer<typeof dayHoursSchema>

export const hoursSchema = z.object({
  mon: dayHoursSchema,
  tue: dayHoursSchema,
  wed: dayHoursSchema,
  thu: dayHoursSchema,
  fri: dayHoursSchema,
  sat: dayHoursSchema,
  sun: dayHoursSchema,
  // "by appointment" is a separate flag rather than a fake set of hours, so the generated site
  // can say "by appointment" instead of inventing a window the tradie never agreed to.
  byAppointment: z.boolean(),
  // True when the customer never touched this step. Drives the gap-audit flag and the
  // CONFIRM WITH CLIENT BEFORE LAUNCH comment in the HTML.
  isDefault: z.boolean().default(true),
})
export type Hours = z.infer<typeof hoursSchema>

export const reviewSchema = z.object({
  quote: z.string().trim().min(15, 'Too short to be a real review').max(400),
  firstName: z.string().trim().min(2).max(40),
  suburb: z.string().trim().min(2).max(60),
})
export type Review = z.infer<typeof reviewSchema>

export const paletteSchema = z.object({
  // Sampled from the logo, adjustable with a colour picker. Never asked as a text question:
  // that is how a question ended up typed into the colours field.
  primary: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  secondary: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  dark: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  light: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  source: z.enum(['logo', 'manual', 'default']),
})
export type Palette = z.infer<typeof paletteSchema>

export const addressSchema = z.object({
  line1: z.string().trim().max(120).optional().or(z.literal('')),
  suburb: z.string().trim().max(80).optional().or(z.literal('')),
  state: z.enum(AU_STATES).optional(),
  postcode: z
    .string()
    .regex(/^\d{4}$/)
    .optional()
    .or(z.literal('')),
  // Set when the address came from autocomplete. A hand-typed address is not used for NAP
  // because a wrong NAP is worse than no NAP for local SEO.
  verified: z.boolean().default(false),
})
export type BusinessAddress = z.infer<typeof addressSchema>

export const TRAVEL_RADII = ['10', '20', '40', '60', 'statewide'] as const
export type TravelRadius = (typeof TRAVEL_RADII)[number]

// ---------------------------------------------------------------------------------------------
// Step 1 - Business basics
// ---------------------------------------------------------------------------------------------

export const step1Schema = z.object({
  businessName: z.string().trim().min(2, 'Required').max(80),
  trade: z.enum(TRADES),
  tradingEntityName: z.string().trim().max(120).optional().or(z.literal('')),
  abn: z
    .string()
    .trim()
    .optional()
    .or(z.literal(''))
    .refine((v) => !v || isValidAbn(v), { message: 'That ABN does not check out. 11 digits.' }),
  // FAILURE THIS PREVENTS: free text here is how business names ended up in this field.
  // Integer only, hard bounds, no text input type.
  yearsInBusiness: z
    .number({ invalid_type_error: 'Enter a number of years' })
    .int('Whole years only')
    .min(1, 'At least 1')
    .max(100, 'At most 100'),
  phone: z
    .string()
    .trim()
    .min(1, 'Required')
    .refine((v) => normaliseAuPhone(v) !== null, {
      message: 'Enter an Australian mobile or landline',
    }),
  email: z.string().trim().email('Enter a valid email'),
  address: addressSchema.optional(),
})
export type Step1 = z.infer<typeof step1Schema>

// ---------------------------------------------------------------------------------------------
// Step 2 - Services
// ---------------------------------------------------------------------------------------------

export const step2Schema = z
  .object({
    /*
     * TEN, NOT EIGHT.
     *
     * Eight was an arbitrary number carrying no comment explaining it, and a real customer broke
     * it immediately: Pest-Aside Sydney's approved copy lists ten pest types, which for that trade
     * is an ordinary service list rather than an overreach. Cockroaches, rodents, spiders, ants,
     * wasps, bees, fleas, silverfish, mosquitoes and bed bugs are ten distinct jobs a customer
     * searches for by name.
     *
     * Ten cards still lay out cleanly: the services grid is three across on desktop, so ten is
     * four rows rather than three. The cap exists to stop a keyword dump becoming the page, which
     * is a real risk, and the same customer's ORIGINAL spreadsheet answer listed eighty-eight.
     * Ten holds that line while fitting a genuine list.
     */
    services: z
      .array(z.string().trim().min(2).max(60))
      .min(3, 'Pick at least 3')
      /*
       * TWENTY IS THE OUTER BOUND, NOT THE LIMIT MOST PEOPLE MEET.
       *
       * The ten above is still the right answer for the ordinary buyer and is still enforced,
       * just not here: see maxServices below. This number only has to be high enough that a
       * customer who has PAID for twenty service pages can name twenty services to put on them.
       * The schema cannot tell those two customers apart because the allowance lives on the job
       * row, so it holds the ceiling and the entitlement-aware rule holds the line.
       */
      .max(20, 'Pick no more than 20'),
    primaryService: z.string().trim().min(2, 'Required'),
    /**
   * Services the customer has chosen to give a dedicated page. Each one costs an additional page
   * from their allowance. Empty is the normal case: the build token buys one page.
   */
  /*
   * TEN, matching the services cap. A customer who buys a page for every service they offer must
   * be able to allocate every one of them: Pest-Aside Sydney bought eleven pages, home plus ten
   * pest types, and an eight cap here would have silently stranded two paid-for pages with no
   * service to put on them.
   */
  ownPageServices: z.array(z.string()).max(20).default([]),
  freeQuotes: z.boolean(),
    emergency: z.boolean(),
  })
  .refine((v) => v.services.includes(v.primaryService), {
    message: 'Primary service must be one of the services you selected',
    path: ['primaryService'],
  })
export type Step2 = z.infer<typeof step2Schema>

/**
 * Additional pages the customer has PAID FOR but has not assigned to a service.
 *
 * WHY THIS IS A SHARED FUNCTION AND NOT A ZOD REFINEMENT. The entitlement lives on the job row,
 * not in the intake payload, so the schema cannot see it. Both the browser and the submit route
 * need the same answer, and the failure this guards against is precisely the two of them
 * disagreeing, so there is exactly one implementation and both import it.
 *
 * FAILURE THIS PREVENTS, observed in production on 2026-08-26 (job_03b9657cf7f24757828ab158).
 * A customer bought four additional pages, scrolled past the picker without choosing any,
 * and submitted. Nothing objected. `ownPageServices` was empty, so the plan built one page,
 * and `pagesDeliveredCheck` compared the delivered pages against the empty choice and passed.
 * He was charged for five pages and received one, and every gate in the chain reported success.
 *
 * A service that is no longer in `services` does not count as allocated. Deselecting a service
 * on a later pass must give its page back rather than stranding it.
 */
/**
 * The most services this particular customer may list.
 *
 * TEN FOR ALMOST EVERYONE, AND THE REASON IS UNCHANGED. A home page covering a keyword dump is
 * the failure this guards against, and the same customer whose real answer was ten had first
 * listed eighty-eight. Ten holds that line while fitting a genuine list.
 *
 * BUT TEN CANNOT BE THE ANSWER FOR SOMEBODY WHO BOUGHT TWENTY PAGES. Every additional page has
 * to be pointed at a service before the build will run, and ownPageServices is a subset of
 * services, so a customer with twenty paid pages and a ten service cap could never allocate more
 * than ten of them. The submit route refuses on unallocated pages, so that customer would have
 * paid for twenty pages and then been unable to submit the intake at all, permanently, with no
 * message telling them why. Raising the storefront stepper without raising this is how that
 * happens.
 *
 * It is a shared function for the reason unallocatedPages is: the browser and the submit route
 * have to give the same answer, and the failure being guarded against is the two disagreeing.
 */
/**
 * The most photos a site uses.
 *
 * Exported because the number was written out four times: the schema, the uploader's slice,
 * its label and its disabled state. Four copies of a limit is how the services picker ended up
 * capping at eight while everything else said ten, and a customer who had paid for ten pages
 * could not finish the intake. One number, one home.
 */
export const MAX_PHOTOS = 20

export function maxServices(pagesAllowed: number): number {
  return Math.min(20, Math.max(10, (pagesAllowed || 1) - 1))
}

export function unallocatedPages(
  pagesAllowed: number,
  ownPageServices: string[] | undefined,
  services: string[],
): number {
  const entitled = Math.max(0, (pagesAllowed || 1) - 1)
  const chosen = (ownPageServices ?? []).filter((name) => services.includes(name))
  return Math.max(0, entitled - chosen.length)
}

// ---------------------------------------------------------------------------------------------
// Step 3 - Service area
// ---------------------------------------------------------------------------------------------

export const step3Schema = z.object({
  baseSuburb: suburbRefSchema,
  // FAILURE THIS PREVENTS: free text here is how service names ended up in the service-area
  // field. The UI has no free-text path; the server re-checks every entry against the suburb
  // provider on submit so a crafted request cannot get around it either.
  suburbsServiced: z.array(suburbRefSchema).min(3, 'Add at least 3 suburbs'),
  travelRadius: z.enum(TRAVEL_RADII),
})
export type Step3 = z.infer<typeof step3Schema>

// ---------------------------------------------------------------------------------------------
// Step 4 - Story and proof
// ---------------------------------------------------------------------------------------------

export const step4Schema = z.object({
  about: z
    .string()
    .trim()
    .min(40, 'A bit more detail, at least 40 characters')
    .max(600, 'Keep it under 600 characters'),
  /*
   * ROOMIER THAN about, BECAUSE THIS IS WHERE APPROVED COPY LANDS.
   *
   * 600 was fine while this field held a sentence or two a customer typed. It is too small the
   * moment somebody supplies copy they have already signed off: Pest-Aside Sydney's approved
   * "why choose us" is a paragraph plus seven bullet points, about 700 characters, and truncating
   * a customer's own approved words to fit a limit nobody chose deliberately is the wrong trade.
   *
   * It is still bounded. This is a section of a page, not a document, and the plan step is told
   * to use it rather than reproduce it wholesale.
   */
  different: z.string().trim().max(1200).optional().or(z.literal('')),
  hours: hoursSchema,
  // If empty, no testimonial section is built. Never fabricate. Enforced again in the
  // house rules and in the content-plan validation.
  reviews: z.array(reviewSchema).max(6, 'Up to 6 reviews'),
  googleReviewLink: z.string().trim().url('Enter a full URL').optional().or(z.literal('')),
  /*
   * THE RATING AND THE COUNT, WHICH TURN QUOTES INTO EVIDENCE.
   *
   * We were already collecting the review link and doing nothing with it but passing it to the
   * prompt as a line of text, and the quotes rendered as anonymous pull quotes. "4.9 from 87
   * reviews on Google", with the mark and the stars beside it, is a different thing entirely: a
   * claim anybody can go and check in one tap rather than words we typed.
   *
   * Both optional, because plenty of tradies have no profile yet and the section has to degrade to
   * quotes-without-a-rating rather than refuse to build. Both are numbers a tradie reads straight
   * off their own Google listing, which is why these two were worth adding and a "what makes you
   * different" essay box was not.
   */
  googleRating: z
    .number()
    .min(1)
    .max(5)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  googleReviewCount: z
    .number()
    .int()
    .min(1)
    .max(100000)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  socials: z.object({
    facebook: z.string().trim().url().optional().or(z.literal('')),
    instagram: z.string().trim().url().optional().or(z.literal('')),
    linkedin: z.string().trim().url().optional().or(z.literal('')),
    tiktok: z.string().trim().url().optional().or(z.literal('')),
    youtube: z.string().trim().url().optional().or(z.literal('')),
  }),
})
export type Step4 = z.infer<typeof step4Schema>

// ---------------------------------------------------------------------------------------------
// Step 5 - Brand and photos
// ---------------------------------------------------------------------------------------------

export const step5Schema = z.object({
  logoAssetId: z.string().nullable(),
  /**
   * How the site should look. The wizard requires an explicit pick among the five options, one
   * of which is 'auto', so nothing is preselected on the customer's behalf. The default here is
   * for payloads written before this field existed, which must keep parsing.
   */
  designStyle: z.enum(DESIGN_STYLES).default('auto'),
  photoAssetIds: z.array(z.string()).max(MAX_PHOTOS, 'Up to ' + MAX_PHOTOS + ' photos'),
  palette: paletteSchema,
  existingDomain: z
    .string()
    .trim()
    .max(120)
    .optional()
    .or(z.literal(''))
    .refine((v) => !v || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v.replace(/^https?:\/\//, '')), {
      message: 'Enter a domain like yourbusiness.com.au',
    }),
})
export type Step5 = z.infer<typeof step5Schema>

// ---------------------------------------------------------------------------------------------
// Whole payload
// ---------------------------------------------------------------------------------------------

export const intakeSchema = step1Schema
  .merge(z.object({}))
  .and(step2Schema)
  .and(step3Schema)
  .and(step4Schema)
  .and(step5Schema)

export type IntakePayload = Step1 & Step2 & Step3 & Step4 & Step5

// Partial version used while the wizard is in progress and autosaving.
export const draftIntakeSchema = z.record(z.string(), z.unknown())

/**
 * The wizard is stricter than the payload about the design style: it will not let a customer past
 * step 5 without picking one of the five options. 'Not sure, pick for me' is one of the five, so
 * this costs them a single tap and it means a stored 'auto' is a decision they made rather than a
 * field they never saw. The payload schema keeps its default so older records still parse.
 */
const step5WizardSchema = step5Schema.extend({
  designStyle: z.enum(DESIGN_STYLES, {
    message: 'Pick a look, or choose "Not sure, pick for me" and we will choose one.',
  }),
})

export const STEP_SCHEMAS = [
  step1Schema,
  step2Schema,
  step3Schema,
  step4Schema,
  step5WizardSchema,
] as const
export const STEP_TITLES = [
  'Business basics',
  'Services',
  'Service area',
  'Story and proof',
  'Brand and photos',
] as const

export const DEFAULT_HOURS: Hours = {
  // Brief s4 step 4: default Mon-Fri 7-5.
  mon: { closed: false, open: '07:00', close: '17:00' },
  tue: { closed: false, open: '07:00', close: '17:00' },
  wed: { closed: false, open: '07:00', close: '17:00' },
  thu: { closed: false, open: '07:00', close: '17:00' },
  fri: { closed: false, open: '07:00', close: '17:00' },
  sat: { closed: true, open: '08:00', close: '12:00' },
  sun: { closed: true, open: '08:00', close: '12:00' },
  byAppointment: false,
  isDefault: true,
}

// Neutral fallback palette, used only until a logo is sampled. source: 'default' is what the
// gap audit looks for when deciding whether to flag missing brand artwork.
export const DEFAULT_PALETTE: Palette = {
  primary: '#1d3557',
  secondary: '#457b9d',
  accent: '#e63946',
  dark: '#14171a',
  light: '#f4f6f8',
  source: 'default',
}

export function emptyIntake(): Partial<IntakePayload> {
  return {
    businessName: '',
    trade: undefined,
    tradingEntityName: '',
    abn: '',
    yearsInBusiness: undefined,
    phone: '',
    email: '',
    address: { line1: '', suburb: '', postcode: '', verified: false },
    services: [],
    primaryService: '',
    freeQuotes: true,
    emergency: false,
    baseSuburb: undefined,
    suburbsServiced: [],
    travelRadius: '20',
    about: '',
    different: '',
    hours: DEFAULT_HOURS,
    reviews: [],
    googleReviewLink: '',
    socials: { facebook: '', instagram: '', linkedin: '', tiktok: '', youtube: '' },
    logoAssetId: null,
    photoAssetIds: [],
    // Deliberately undefined: the customer picks, we do not preselect.
    designStyle: undefined,
    palette: DEFAULT_PALETTE,
    existingDomain: '',
  } as Partial<IntakePayload>
}
