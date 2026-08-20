import type { AssetRecord } from '../../shared/types.js'
import type { BuildFacts, ContentPlan } from '../../shared/plan.js'
import { planSchema } from '../../shared/plan.js'
import type { IntakePayload } from '../../shared/intake.js'
import {
  MAX_TOKENS_BUILD,
  MAX_TOKENS_PLAN,
  callMessage,
  extractJson,
  isTruncated,
  streamMessage,
  stripCodeFence,
} from './anthropic.js'
import { HOUSE_RULES, PLAN_SYSTEM } from '../prompts/houseRules.js'
import {
  EDIT_BUILD_SYSTEM,
  EDIT_PLAN_SYSTEM,
  editBuildUserMessage,
  editPlanUserMessage,
} from '../prompts/edit.js'
import { enforcePlanInvariants } from './generate.js'
import { isUsablePhoto } from './audit.js'
import type { Emit } from './generate.js'

/**
 * The edit loop. One submitted request is one edit, however many changes it contains, so the
 * customer is encouraged to batch (brief s7) and never punished for it.
 */

/**
 * A readable summary of what actually changed between two plans.
 *
 * Stored with the version so the history reads like "changed the hero headline, swapped the
 * primary colour" rather than "version 3". Computed from the plans rather than asked of the
 * model, because a model summarising its own diff will describe what it meant to do.
 */
export function diffPlans(before: ContentPlan, after: ContentPlan): string[] {
  const changes: string[] = []

  const walk = (a: unknown, b: unknown, path: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return

    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) changes.push(`${path}: ${a.length} items became ${b.length}`)
      else changes.push(`${path}: contents changed`)
      return
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)])
      for (const key of keys) {
        walk(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
          path ? `${path}.${key}` : key,
        )
      }
      return
    }
    changes.push(`${path}: ${describe(a)} became ${describe(b)}`)
  }

  walk(before, after, '')
  return changes
}

function describe(value: unknown): string {
  if (value === undefined) return 'nothing'
  if (typeof value === 'string') {
    return value.length > 60 ? `"${value.slice(0, 57)}..."` : `"${value}"`
  }
  return JSON.stringify(value)
}

/** One line for the version history list. */
export function summariseDiff(changes: string[]): string {
  if (changes.length === 0) return 'No change to the content plan'
  const shown = changes.slice(0, 4).join('; ')
  return changes.length > 4 ? `${shown}; and ${changes.length - 4} more` : shown
}

export interface EditResult {
  plan: ContentPlan
  html: string
  changes: string[]
}

/**
 * Step 1 of an edit: revise the plan.
 *
 * The revised plan goes through the same zod schema and the same server-authoritative overrides
 * as a first build, so an edit cannot be used to talk the model into a fabricated testimonial or
 * a made-up statistic.
 */
export async function generateEditedPlan(args: {
    plan: ContentPlan
    facts: BuildFacts
    intake: IntakePayload
    assets: AssetRecord[]
    request: string
    previousRequests: string[]
  },
): Promise<ContentPlan> {
  const usablePhotos = args.assets.filter(isUsablePhoto)
  const userMessage = editPlanUserMessage({
    plan: args.plan,
    facts: args.facts,
    request: args.request,
    previousRequests: args.previousRequests,
  })

  let lastError = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await callMessage({
      system: [
        // Same cached prefix as a first build, then the edit-specific rules as a second block.
        { type: 'text', text: PLAN_SYSTEM, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: EDIT_PLAN_SYSTEM },
      ],
      messages: [
        {
          role: 'user',
          content:
            attempt === 1
              ? userMessage
              : `${userMessage}\n\n# YOUR PREVIOUS ATTEMPT WAS REJECTED\n\n${lastError}\n\nReturn corrected JSON only.`,
        },
      ],
      maxTokens: MAX_TOKENS_PLAN,
      // Low: an edit is a targeted change, not a fresh creative act.
      effort: 'high',
    })

    let candidate: unknown
    try {
      candidate = JSON.parse(extractJson(result.text))
    } catch (err) {
      lastError = `The response was not valid JSON: ${(err as Error).message}`
      continue
    }

    const parsed = planSchema.safeParse(candidate)
    if (!parsed.success) {
      lastError = parsed.error.issues
        .slice(0, 12)
        .map((i) => `- ${i.path.join('.')}: ${i.message}`)
        .join('\n')
      continue
    }

    // An edit may deliberately change the look, so the style is allowed through here.
    return enforcePlanInvariants(parsed.data, args.intake, args.facts, usablePhotos, {
      allowStyleChange: true,
    })
  }

  throw new Error(`The revised plan did not validate after 2 attempts.\n${lastError}`)
}

/** Step 2 of an edit: rebuild the document from the revised plan. */
export async function rebuildFromPlan(args: {
    plan: ContentPlan
    facts: BuildFacts
    previousHtml: string
    changes: string[]
    emit: Emit
  },
): Promise<string> {
  await args.emit({ type: 'status', stage: 'building', message: 'Applying your changes' })

  let html = ''
  let stopReason: string | null = null

  for await (const chunk of streamMessage({
    system: [
      { type: 'text', text: HOUSE_RULES, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: EDIT_BUILD_SYSTEM },
    ],
    messages: [
      {
        role: 'user',
        content: editBuildUserMessage({
          plan: args.plan,
          facts: args.facts,
          previousHtml: args.previousHtml,
          changeSummary: summariseDiff(args.changes),
        }),
      },
    ],
    maxTokens: MAX_TOKENS_BUILD,
    // Lower than a first build. Unrelated drift between versions is the risk being managed here.
    effort: 'high',
  })) {
    if (chunk.type === 'text') {
      html += chunk.text
      await args.emit({ type: 'html_chunk', text: chunk.text })
    } else {
      stopReason = chunk.stopReason
    }
  }

  html = stripCodeFence(html)

  if (isTruncated(html, stopReason)) {
    // Do not hand back half a document. The caller keeps the previous version and reports it.
    throw new Error(
      'The rebuild came back incomplete. Your previous version is untouched. Try asking for fewer changes at once.',
    )
  }

  return html
}

/**
 * Offline stand-in for an edit, used when DEV_OFFLINE_GENERATION is on so the whole edit loop,
 * version history and rollback can be exercised without an API key.
 *
 * It cannot understand the request, so it does not pretend to. It records the request against
 * the plan's assumptions array and rebuilds deterministically from the same plan, which
 * exercises every code path around the edit without inventing a change.
 */
export function offlineEdit(plan: ContentPlan, request: string): ContentPlan {
  const out = structuredClone(plan)
  out.assumptions = [
    ...out.assumptions,
    `Offline fixture mode: the change request "${request.slice(0, 120)}" was recorded but not applied, because there is no model to apply it. Set ANTHROPIC_API_KEY to run real edits.`,
  ]
  return out
}
