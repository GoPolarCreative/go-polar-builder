// Types shared by the Worker and the client. No runtime imports from here in the client
// except plain types, so nothing server side can leak into the browser bundle.

import type { Trade } from './trades'
import type { IntakePayload } from './intake'

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
  user_id: string
  status: JobStatus
  trade: Trade | null
  business_name: string | null
  edits_used: number
  edits_allowed: number
  current_version: number
  held: 0 | 1
  held_reason: string | null
  created_at: string
  updated_at: string
}

export type AssetKind = 'logo' | 'photo'

/**
 * Image signals computed in the browser at upload time (canvas), stored with the asset.
 * They exist because the Worker has no image decoder, and the gap audit needs to know things
 * like "is this logo actually a mockup render sitting on a photo".
 */
export interface AssetStats {
  width: number
  height: number
  aspect: number
  /** Share of pixels that sit in large flat colour areas. Real logos are high, photos are low. */
  flatRatio: number
  /** Distinct quantised colours. Logos are low, photographs are high. */
  distinctColours: number
  /** Any pixel with alpha < 250. Transparent PNG or SVG is a good sign for a logo. */
  hasTransparency: boolean
  /** 0-1. Higher means it looks like a photograph. Drives the mockup-render flag. */
  photographicScore: number
  /** Dominant colours, most frequent first, as #rrggbb. Feeds palette sampling. */
  dominant: string[]
}

export interface AssetRecord {
  id: string
  job_id: string
  r2_key: string
  kind: AssetKind
  filename: string | null
  content_type: string | null
  bytes: number | null
  width: number | null
  height: number | null
  sort_order: number
  stats: AssetStats | null
  created_at: string
}

// ---------------------------------------------------------------------------------------------
// Gap audit (brief s4, server side, runs after submission and before generation)
// Never blocking. Surfaced as a friendly inline prompt, and carried into generation so the
// build can compensate (CSS logotype, skipped gallery, flagged defaults).
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
  /** What the generator will do about it. Also becomes an HTML comment in the build. */
  buildEffect: string
  /** Optional field to jump the customer back to. */
  field?: string
}

// ---------------------------------------------------------------------------------------------
// Verification (brief s6)
// ---------------------------------------------------------------------------------------------

export type CheckId =
  | 'hex_outside_root'
  | 'no_em_dash'
  | 'no_emoji'
  | 'single_h1'
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

export type CheckStatus = 'pass' | 'fail' | 'skipped'

export interface CheckResult {
  id: CheckId
  label: string
  status: CheckStatus
  /** Human readable failure detail, fed back into the repair prompt verbatim. */
  detail?: string
  /** Up to a handful of offending snippets, to make the repair prompt concrete. */
  evidence?: string[]
}

export interface VerificationReport {
  passed: boolean
  ranAt: string
  static: CheckResult[]
  render: CheckResult[]
  /** True when render checks could not run (no Browser Rendering binding, e.g. local dev). */
  renderSkipped: boolean
  repairPasses: number
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
  | { type: 'done'; version: number; bytes: number; passed: boolean }
  | { type: 'error'; message: string; detail?: string }

export type GenerationStage =
  | 'planning'
  | 'building'
  | 'assembling'
  | 'verifying'
  | 'repairing'
  | 'complete'
  | 'held'
