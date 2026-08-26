// Types shared by the server and the client. Plain types only, so nothing server side can leak
// into the browser bundle.

import type { Trade } from './trades.js'
import type { IntakePayload } from './intake.js'

export type JobStatus =
  | 'paid'
  | 'intake'
  | 'generating'
  | 'preview'
  | 'editing'
  | 'go_live_pending'
  | 'live'
  | 'discharged'
  | 'abandoned'

export interface Job {
  id: string
  userId: string
  status: JobStatus
  trade: Trade | null
  businessName: string | null
  editsUsed: number
  editsAllowed: number
  currentVersion: number
  held: boolean
  heldReason: string | null
  /**
   * The customer's own Web3Forms key, masked. Set only once a real test submission through
   * Web3Forms succeeded, so a value here means the enquiry forms are known to reach them. The
   * full key is never put on this object: server code that needs it reads the row. D29.
   */
  /** How many pages this job may build. The build token grants one. See DECISIONS.md D42. */
  pagesAllowed: number
  web3formsKeyMasked: string | null
  web3formsVerifiedAt: string | null
  createdAt: string
  updatedAt: string
}

export type AssetKind = 'logo' | 'photo'

/**
 * Image signals computed in the browser at upload time (canvas), stored with the asset.
 * They exist because the gap audit needs pixel-level judgements, like "is this logo actually a
 * mockup render sitting on a photo", and the answer is cheapest where the pixels already are.
 */
export interface AssetStats {
  width: number
  height: number
  aspect: number
  /** Share of pixels sitting in large flat colour areas. Real logos are high, photos are low. */
  flatRatio: number
  /** Distinct quantised colours. Logos are low, photographs are high. */
  distinctColours: number
  hasTransparency: boolean
  /** 0 to 1. Higher means it looks like a photograph. Drives the mockup-render flag. */
  photographicScore: number
  /** Dominant colours, most frequent first, as #rrggbb. Feeds palette sampling. */
  dominant: string[]
}

export type VariantRole = 'web' | 'thumb'
export type VariantFormat = 'webp' | 'jpeg' | 'png' | 'svg'

/**
 * A processed derivative that actually ships to visitors. The original is kept separately and
 * never served: see server/lib/images.ts and DECISIONS.md D25 for the bandwidth reasoning.
 */
export interface AssetVariant {
  role: VariantRole
  format: VariantFormat
  key: string
  bytes: number
  width: number
  height: number
}

export interface AssetRecord {
  id: string
  jobId: string
  kind: AssetKind
  filename: string | null
  contentType: string | null
  /** Untouched upload, kept for rebuilds. Never referenced by a generated site. */
  originalKey: string
  originalBytes: number | null
  width: number | null
  height: number | null
  sortOrder: number
  stats: AssetStats | null
  variants: AssetVariant[]
  createdAt: string
}

// ---------------------------------------------------------------------------------------------
// Gap audit (brief s4, server side, runs after submission and before generation)
// ---------------------------------------------------------------------------------------------

export type AuditCode =
  | 'logo_missing'
  | 'logo_mockup_render'
  | 'logo_wide_lockup'
  | 'logo_low_resolution'
  | 'photos_insufficient'
  | 'photos_low_quality'
  | 'years_contradicts_story'
  | 'hours_defaulted'
  | 'no_reviews'
  | 'no_address'
  | 'palette_defaulted'
  | 'service_area_thin'

export type AuditSeverity = 'info' | 'attention'

export interface AuditFlag {
  code: AuditCode
  severity: AuditSeverity
  /** Shown to the customer. Plain English, no jargon, never blaming. */
  message: string
  /**
   * INTERNAL. Feeds the generation prompt as a build directive ("logoTreatment=css-logotype"),
   * becomes an HTML comment in the build, and is asserted on by tests. Never shown to a customer.
   */
  buildEffect: string
  /**
   * CUSTOMER-FACING. The same consequence in plain words, shown under "What we will do" on
   * the intake screens. A customer saw "flagged CONFIRM WITH CLIENT BEFORE LAUNCH in the
   * HTML" and reasonably called it tacky: one string cannot serve a prompt and a person.
   */
  customerNote: string
  field?: string
}

// ---------------------------------------------------------------------------------------------
// Verification (brief s6, plus check 17)
// ---------------------------------------------------------------------------------------------

export type CheckId =
  | 'hex_outside_root'
  | 'no_em_dash'
  | 'no_emoji'
  | 'single_h1'
  | 'single_mobile_bar'
  | 'heading_hierarchy'
  | 'footer_credit'
  | 'jsonld_valid'
  | 'form_action'
  | 'img_alt'
  | 'lang_attr'
  | 'free_quote_absent'
  | 'assets_exist'
  | 'renders_clean'
  | 'no_horizontal_overflow'
  | 'images_load'
  | 'interactions_work'
  | 'page_weight'
  | 'pages_delivered'

export type CheckStatus = 'pass' | 'fail' | 'skipped' | 'warn'

export interface CheckResult {
  id: CheckId
  label: string
  status: CheckStatus
  /** Human readable detail, fed back into the repair prompt verbatim on failure. */
  detail?: string
  evidence?: string[]
}

export interface VerificationReport {
  passed: boolean
  ranAt: string
  static: CheckResult[]
  render: CheckResult[]
  /** True when render checks could not run (no browser driver available). */
  renderSkipped: boolean
  repairPasses: number
  /** HTML plus every referenced asset, in bytes. What a first-time visitor downloads. */
  pageWeightBytes: number
}

// ---------------------------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------------------------

export interface ApiError {
  error: string
  detail?: string
}

export interface JobSummary {
  job: Job
  intake: IntakePayload | null
  auditFlags: AuditFlag[]
  assets: AssetRecord[]
}

/** Server-sent event payloads streamed during generation. */
export type GenerationEvent =
  | { type: 'status'; stage: GenerationStage; message: string }
  | { type: 'plan'; plan: unknown }
  | { type: 'html_chunk'; text: string }
  | { type: 'section_done'; section: string; index: number; total: number }
  | { type: 'verification'; report: VerificationReport }
  | { type: 'repair'; attempt: number; failing: string[] }
  | { type: 'done'; version: number; bytes: number; passed: boolean; pageWeightBytes?: number }
  | { type: 'error'; message: string; detail?: string }

export type GenerationStage =
  | 'planning'
  | 'building'
  | 'assembling'
  | 'verifying'
  | 'repairing'
  | 'complete'
  | 'held'
