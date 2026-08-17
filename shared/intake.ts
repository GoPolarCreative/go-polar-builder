// Intake schema. Brief s4. One zod schema shared by the wizard and the Worker, so the client
// and the server cannot drift. The Worker re-validates on submit and does not trust the client.
//
// Every field here exists to prevent a specific failure seen in the 59 real Google Form
// submissions. Where that is the reason for a rule, the comment says which failure.

import { z } from 'zod'
import { TRADES } from './trades'
import { isValidAbn } from './abn'
import { normaliseAuPhone } from './phone'

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
    services: z
      .array(z.string().trim().min(2).max(60))
      .min(3, 'Pick at least 3')
      .max(8, 'Pick no more than 8'),
    primaryService: z.string().trim().min(2, 'Required'),
    freeQuotes: z.boolean(),
    emergency: z.boolean(),
  })
  .refine((v) => v.services.includes(v.primaryService), {
    message: 'Primary service must be one of the services you selected',
    path: ['primaryService'],
  })
export type Step2 = z.infer<typeof step2Schema>

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
  different: z.string().trim().max(600).optional().or(z.literal('')),
  hours: hoursSchema,
  // If empty, no testimonial section is built. Never fabricate. Enforced again in the
  // house rules and in the content-plan validation.
  reviews: z.array(reviewSchema).max(6, 'Up to 6 reviews'),
  googleReviewLink: z.string().trim().url('Enter a full URL').optional().or(z.literal('')),
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
  photoAssetIds: z.array(z.string()).max(20, 'Up to 20 photos'),
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

export const STEP_SCHEMAS = [step1Schema, step2Schema, step3Schema, step4Schema, step5Schema] as const
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
    palette: DEFAULT_PALETTE,
    existingDomain: '',
  } as Partial<IntakePayload>
}
