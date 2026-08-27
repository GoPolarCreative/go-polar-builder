import type { AssetRecord } from '../../shared/types.js'
import type { BuildFacts, ContentPlan } from '../../shared/plan.js'
import { planSchema } from '../../shared/plan.js'
import type { IntakePayload } from '../../shared/intake.js'
import {
  MAX_TOKENS_BUILD,
  MAX_TOKENS_PLAN,
  MAX_TOKENS_SECTION,
  callMessage,
  extractJson,
  isTruncated,
  streamMessage,
  stripCodeFence,
} from './anthropic.js'
import { HOUSE_RULES, PLAN_SYSTEM } from '../prompts/houseRules.js'
import {
  extractJsonLd,
  extractSection,
  extractStylesheet,
  fragmentIsComplete,
  jsonLdIsComplete,
  keyIsDeclared,
  unwrapFragment,
  spliceInto,
  type PatchTarget,
} from './sections.js'
import {
  EDIT_BUILD_SYSTEM,
  EDIT_PLAN_SYSTEM,
  PATCH_SYSTEM,
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
): Promise<EditedPlan> {
  const usablePhotos = args.assets.filter(isUsablePhoto)
  const userMessage = editPlanUserMessage({
    plan: args.plan,
    facts: args.facts,
    request: args.request,
    previousRequests: args.previousRequests,
  })

  let lastError = ''
  let droppedKeys: string[] = []
  let declaredSections: string[] = []
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await callMessage({
      system: [
        // Same cached prefix as a first build, then the edit-specific rules as a second block.
        { type: 'text', text: PLAN_SYSTEM, cache_control: { type: 'ephemeral', ttl: '1h' } },
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

    let returned: unknown
    try {
      returned = JSON.parse(extractJson(result.text))
    } catch (err) {
      lastError = `The response was not valid JSON: ${(err as Error).message}`
      continue
    }

    /*
     * MERGE THE KEYS IT RETURNED OVER THE PLAN IT WAS GIVEN.
     *
     * The model is asked for the changed top-level keys rather than the whole plan, so anything
     * it does not mention is carried across as the same object reference. That is what makes
     * "an edit changes nothing it was not asked about" a property of the code instead of a
     * request in a prompt: the prompt already said "byte for byte identical" in capital letters
     * and a real edit still came back with the FAQ, the stats, the why-us cards and the process
     * steps rewritten.
     *
     * A model that ignores the instruction and returns a whole plan still works: every key is
     * present, so the merge is a no-op over it and we are exactly where we were before.
     */
    if (!returned || typeof returned !== 'object' || Array.isArray(returned)) {
      lastError = 'The response must be a JSON object with "sections" and "changes".'
      continue
    }
    const envelope = returned as { sections?: unknown; changes?: unknown }
    if (!Array.isArray(envelope.sections) || typeof envelope.changes !== 'object' || envelope.changes === null) {
      lastError = 'The response must have "sections" as an array and "changes" as an object.'
      continue
    }

    const declared = new Set((envelope.sections as unknown[]).map((v) => String(v)))
    const proposed = envelope.changes as Record<string, unknown>

    const unknownKeys = Object.keys(proposed).filter((k) => !(k in args.plan))
    if (unknownKeys.length > 0) {
      lastError = `These are not top-level keys of the plan: ${unknownKeys.join(', ')}`
      continue
    }

    /*
     * THE DECLARATION IS ENFORCED HERE, AND THIS IS THE POINT OF THE WHOLE SHAPE.
     *
     * Three times in this project a customer has received something other than what they asked
     * for, and every time the cause was the same: trusting the shape of what the model returned
     * instead of constraining it. A request to add one line to the process section came back
     * having also rewritten the FAQ, the stat figures, the why-us cards, the gallery captions and
     * the testimonials. Two rounds of increasingly emphatic prompting did not stop it.
     *
     * So it is no longer a request. A key whose section was not declared is DROPPED, the plan
     * keeps its original value for that key, and the drop is returned to the caller to be logged.
     * Silently filtering would trade one invisible problem for another, which is why nothing here
     * is silent.
     */
    const accepted: Record<string, unknown> = {}
    const dropped: string[] = []
    for (const [key, value] of Object.entries(proposed)) {
      if (keyIsDeclared(key, declared)) accepted[key] = value
      else dropped.push(key)
    }

    droppedKeys = dropped
    declaredSections = [...declared]
    const candidate = { ...args.plan, ...accepted }

    const parsed = planSchema.safeParse(candidate)
    if (!parsed.success) {
      lastError = parsed.error.issues
        .slice(0, 12)
        .map((i) => `- ${i.path.join('.')}: ${i.message}`)
        .join('\n')
      continue
    }

    // An edit may deliberately change the look, so the style is allowed through here.
    return {
      plan: enforcePlanInvariants(parsed.data, args.intake, args.facts, usablePhotos, {
        allowStyleChange: true,
      }),
      declaredSections,
      droppedKeys,
    }
  }

  throw new Error(`The revised plan did not validate after 2 attempts.\n${lastError}`)
}

/**
 * What the plan step produces: the revised plan, plus what it said it would touch and what was
 * taken off it for reaching further than that. The audit travels with the plan so the caller can
 * record it; a filter nobody can see is not much better than no filter.
 */
export interface EditedPlan {
  plan: ContentPlan
  declaredSections: string[]
  droppedKeys: string[]
}

/** Step 2 of an edit: rebuild the document from the revised plan. */
export async function rebuildFromPlan(args: {
    plan: ContentPlan
    facts: BuildFacts
    previousHtml: string
    changes: string[]
    /* The customer's own words. The plan cannot express a request about how something looks, so
     * without this the whole appearance half of a request is lost between the two steps. */
    request: string
    emit: Emit
  },
): Promise<string> {
  await args.emit({ type: 'status', stage: 'building', message: 'Applying your changes' })

  let html = ''
  let stopReason: string | null = null

  for await (const chunk of streamMessage({
    system: [
      { type: 'text', text: HOUSE_RULES, cache_control: { type: 'ephemeral', ttl: '1h' } },
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
          request: args.request,
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

/**
 * Rewrite only the parts of the document the change actually reaches.
 *
 * WHY THIS EXISTS. A measured edit on 2026-08-27 spent 206 of its 266 seconds re-emitting 63KB of
 * HTML to change one headline, and produced a document that was not byte-identical anywhere, so
 * every section was a fresh roll of the dice whether the customer had asked about it or not.
 *
 * Each target is a separate call and they run CONCURRENTLY, so the wall clock is the slowest
 * single section rather than their sum. Concurrency is free here in a way it is not elsewhere:
 * the sections do not depend on each other, because the stylesheet is fixed and handed to each
 * one as something to use rather than to add to.
 *
 * WHAT MAKES THIS SAFE. The model is given the existing markup for its section and the existing
 * stylesheet, and is told to return that one element. Everything outside the spliced ranges is
 * carried across untouched at the byte level. The assembled document then goes through the same
 * checks a full rebuild does, so a patch that breaks the page fails exactly as a rebuild would.
 *
 * IF A CALL COMES BACK UNUSABLE the whole patch is abandoned and the caller falls back to a full
 * rebuild. A half-applied patch is the one outcome worse than being slow.
 */
export async function patchSections(args: {
  plan: ContentPlan
  facts: BuildFacts
  previousHtml: string
  targets: PatchTarget[]
  request: string
  emit: Emit
}): Promise<string> {
  const { plan, facts, previousHtml, targets, request, emit } = args

  await emit({
    type: 'status',
    stage: 'building',
    message: targets.length === 1 ? 'Changing that part of your website' : 'Changing those parts of your website',
  })

  const stylesheet = extractStylesheet(previousHtml)

  const one = async (
    target: PatchTarget,
  ): Promise<{ target: PatchTarget; markup: string; unchanged?: boolean }> => {
    const current = target === 'jsonld' ? extractJsonLd(previousHtml) : extractSection(previousHtml, target)
    if (!current) throw new Error('could not locate ' + target + ' in the current document')

    const what =
      target === 'jsonld'
        ? 'the single <script type="application/ld+json"> block, complete with its script tags'
        : 'that one element, complete with its own opening and closing tags and its data-gp attribute'

    const result = await callMessage({
      system: [
        { type: 'text', text: HOUSE_RULES, cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: PATCH_SYSTEM },
      ],
      messages: [
        {
          role: 'user',
          content: `${factsForPatch(facts, plan)}

# WHAT THE CUSTOMER ASKED FOR

${request}

# THE UPDATED CONTENT PLAN

${JSON.stringify(plan, null, 2)}
${stylesheet ? `
# THE STYLESHEET THAT IS ALREADY ON THE PAGE

Use these class names. Do not invent new ones and do not emit any CSS: there is nowhere left to put it.

${stylesheet}
` : ''}
# THE PART YOU ARE CHANGING, EXACTLY AS IT IS NOW

${current}

# WHAT TO RETURN

Return ${what}. Nothing before it, nothing after it, no code fence and no commentary. Change only what the customer asked for and what the updated plan requires. Everything else in this part stays exactly as it is.`,
        },
      ],
      maxTokens: MAX_TOKENS_SECTION,
      // A patch is a small, well-specified job against markup that already exists.
      effort: 'low',
    })

    const raw = stripCodeFence(result.text).trim()
    if (result.stopReason === 'max_tokens') {
      throw new Error('the ' + target + ' patch ran out of room')
    }

    /*
     * A SECTION THAT DOES NOT NEED CHANGING IS A RESULT, NOT AN ERROR.
     *
     * Targets are chosen from the plan diff, and the plan step is not perfectly disciplined about
     * what it rewrites, so a section is sometimes sent for patching when the customer's request
     * has nothing to do with it. The model says so, plainly, and it is right to. Keeping the
     * original bytes is then both the correct outcome and the fastest one, and it preserves the
     * property this whole mechanism exists for: a section nobody asked about is byte-identical.
     */
    const expectTag = /^<([a-z]+)/i.exec(current)?.[1]
    const unwrapped = target === 'jsonld' ? unwrapFragment(raw, 'script') : unwrapFragment(raw, expectTag)
    if (unwrapped === null) {
      return { target, markup: current, unchanged: true }
    }
    const markup = unwrapped
    // A fragment is checked as a fragment. isTruncated wants a closing </html> and would reject
    // every patch ever written, which is precisely what it did on the first run.
    const complete = target === 'jsonld' ? jsonLdIsComplete(markup) : fragmentIsComplete(markup)
    if (!complete) {
      /*
       * SAY WHAT CAME BACK, not just that it was wrong.
       *
       * The first three runs of this failed with 'the stats patch came back incomplete' and
       * nothing else, and the same call reproduced perfectly in isolation, which left no way to
       * tell whether the model had added a preamble, returned two elements, or been cut off. The
       * ends of the string are the whole diagnosis and they cost nothing to carry.
       */
      throw new Error(
        'the ' +
          target +
          ' patch came back incomplete (' +
          markup.length +
          ' chars, stop=' +
          String(result.stopReason) +
          ', starts: ' +
          JSON.stringify(markup.slice(0, 80)) +
          ', ends: ' +
          JSON.stringify(markup.slice(-80)) +
          ')',
      )
    }
    if (markup.length < 20) throw new Error('the ' + target + ' patch came back empty')
    if (target !== 'jsonld' && !markup.includes('data-gp')) {
      // Without the marker the section could never be addressed again, so the document would
      // quietly lose its fast edit path one section at a time.
      throw new Error('the ' + target + ' patch dropped its data-gp marker')
    }
    return { target, markup }
  }

  const patches = await Promise.all(targets.map(one))

  // Splicing a section back over itself is a no-op, so untouched ones are simply dropped. This
  // keeps the byte-identical guarantee obvious rather than incidental.
  const changed = patches.filter((p) => !p.unchanged)
  if (changed.length === 0) return previousHtml
  return spliceInto(previousHtml, changed)
}

/** Facts a single section needs. The full facts block is mostly about parts it cannot see. */
function factsForPatch(facts: BuildFacts, plan: ContentPlan): string {
  return `# THE BUSINESS

Name: ${plan.brand.businessName}
Phone: ${facts.phoneDisplay}
Canonical URL: ${facts.canonicalUrl}`
}
