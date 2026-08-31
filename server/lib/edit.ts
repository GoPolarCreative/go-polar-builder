import type { AssetRecord } from '../../shared/types.js'
import type { BuildFacts, ContentPlan } from '../../shared/plan.js'
import { PLAN_KEYS, planSchema } from '../../shared/plan.js'
import type { IntakePayload } from '../../shared/intake.js'
import { MAX_TOKENS_PLAN, callMessage, extractJson } from './anthropic.js'
import { PLAN_SYSTEM } from '../prompts/houseRules.js'
import { EDIT_PLAN_SYSTEM, editPlanUserMessage } from '../prompts/edit.js'
import { enforcePlanInvariants } from './generate.js'
import { isUsablePhoto } from './audit.js'


/**
 * Which sections a plan key is drawn in.
 *
 * The last thing left of sections.ts, which existed to work out how to patch a document the
 * model had written. renderSite redraws the whole page from the plan now, so none of that
 * machinery survives; this map does, because the edit step still has to reject a key the model
 * reached for without declaring it.
 */
const PLAN_KEY_SECTIONS: Record<string, string[]> = {
  hero: ['hero'],
  trustStrip: ['trust_strip'],
  about: ['about'],
  services: ['services'],
  gallery: ['gallery'],
  whyUs: ['why_us'],
  // The figures moved into the about section, so that is the block an edit to them belongs to.
  stats: ['about'],
  process: ['process'],
  serviceAreas: ['service_areas'],
  testimonials: ['testimonials'],
  ctaBand: ['cta_band'],
  faq: ['faq'],
  contact: ['contact'],
  /*
   * sectionCopy is keyed by section itself, so it belongs to whichever sections the edit
   * declared. Listing every id here means a declaration of any one of them lets it through,
   * which is right: a request to change the label above the services heading declares
   * 'services', and the change lands in sectionCopy.services.
   */
  sectionCopy: [
    'hero',
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
  ],
}

/**
 * Is this plan key allowed to change, given what the edit step declared it would touch?
 *
 * A key with no section of its own (meta, schema, style, tokens, brand) lives in the head or the
 * stylesheet, so it only travels under a "global" declaration. Everything else needs at least one
 * of its sections named.
 */
/**
 * Keys that are not sections, and never needed a section named to justify them.
 *
 * MEASURED, NOT GUESSED. Driving fourteen ordinary requests through the real chain, six failed
 * and four of those failed here: "put the photo gallery in 3 columns" declared nothing at all,
 * "remove the image behind ready to get started" declared cta_band while layout was mapped to
 * gallery, and two wording changes declared footer, which was not in the list labels was
 * mapped to. Every one of them was thrown away after the model had done the work correctly.
 *
 * The declaration exists to stop the model rewriting sections nobody asked about. None of
 * these IS a section: labels and layout and tokens apply across the page, so asking which
 * section they belong to has no answer, and making the customer lose because the model picked
 * the wrong one is a rule protecting nothing.
 */
const NOT_SECTIONS = new Set([
  'labels',
  'layout',
  'sectionCopy',
  'tokens',
  'meta',
  'schema',
  'style',
  'brand',
])

export function keyIsDeclared(key: string, declared: Set<string>): boolean {
  if (NOT_SECTIONS.has(key)) return true
  if (declared.has('global')) return true
  /*
   * THE MODEL SOMETIMES NAMES THE PLAN KEY RATHER THAN THE SECTION.
   *
   * The vocabulary here is section ids, and an edit that meant to change the figures declared
   * ['services', 'stats']. stats is a plan key, not a section, so it mapped to ['about'],
   * nothing matched, and the change was dropped without the customer being told. Refusing a
   * change because it was announced in the wrong vocabulary is pedantry with a cost: the model
   * said which key it was touching, which is more specific than a section, not less.
   */
  if (declared.has(key)) return true
  const sections = PLAN_KEY_SECTIONS[key]
  if (!sections) return false
  return sections.some((s) => declared.has(s))
}

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

    /*
     * CHANGES WITH NOTHING DECLARED IS A RETRY, NOT A SILENT NO-OP.
     *
     * The model sometimes returns the right change and an empty sections array. Every key then
     * fails the declaration test and the edit becomes a no-op that reports success, which is the
     * worst outcome available: the work was done correctly and thrown away. Three of fourteen
     * ordinary requests did this, including "change the main headline".
     *
     * Asking again costs one call and usually fixes it, and the alternative is charging somebody
     * a round for nothing.
     */
    /*
     * AN EMPTY CHANGE SET IS NOT AN ANSWER.
     *
     * Two of fourteen ordinary requests came back with changes: {} and sections: []. "Put the
     * photo gallery in 3 columns" and "change the main headline to ..." are about as concrete as
     * a request gets, and the model simply returned nothing. Downstream that is a no-op: the
     * customer is told nothing changed and has to type it again, which is better than being
     * charged for it and far worse than asking the model once more.
     */
    /*
     * ...BUT A REFUSAL IS AN ANSWER, AND ON THE LAST ATTEMPT IT HAS TO BE ALLOWED THROUGH.
     *
     * Asking a Chermside plumber's site to say it does fencing on the Sunshine Coast is a
     * request the house rules require the model to decline, and it declines by changing nothing.
     * Retrying that forever turned a correct refusal into "the revised plan did not validate",
     * which tells the customer their editor is broken when it has just protected them from a
     * claim about their business that is not true.
     *
     * Nudge once, in case it was simply lazy. Then accept it: downstream an empty diff is the
     * no-op path, which tells them nothing changed and costs them nothing.
     */
    if (Object.keys(proposed).length === 0 && attempt < 2) {
      lastError =
        'You returned no changes at all. The request names something on the page: work out which ' +
        'part of the plan holds it and change that. If it genuinely cannot be done, change nothing ' +
        'and say so in assumptions.'
      continue
    }

    const sectionKeys = Object.keys(proposed).filter((k) => !NOT_SECTIONS.has(k))
    if (declared.size === 0 && sectionKeys.length > 0) {
      lastError =
        'You changed ' + sectionKeys.join(', ') + ' but "sections" was empty. ' +
        'List the section ids you touched, or the edit cannot be applied.'
      continue
    }

    /*
     * AGAINST THE SCHEMA, NOT AGAINST THIS ONE PLAN.
     *
     * This read `!(k in args.plan)`, so a key the schema allows but this customer does not yet
     * have was rejected as unknown. Every plan is written by the version that built it, which
     * made each new optional field permanently unreachable for anybody who already had a site.
     * It killed an edit outright on "These are not top-level keys of the plan: layout".
     */
    const unknownKeys = Object.keys(proposed).filter((k) => !PLAN_KEYS.has(k))
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

export function offlineEdit(plan: ContentPlan, request: string): ContentPlan {
  const out = structuredClone(plan)
  out.assumptions = [
    ...out.assumptions,
    `Offline fixture mode: the change request "${request.slice(0, 120)}" was recorded but not applied, because there is no model to apply it. Set ANTHROPIC_API_KEY to run real edits.`,
  ]
  return out
}

