import type { BuildFacts, ContentPlan } from '../../shared/plan'
import { factsBlock } from './messages'

/**
 * Edit prompts. See DECISIONS.md D3: an edit revises the plan first, then the HTML is rebuilt
 * from the revised plan with the previous document supplied as reference. The plan stays the
 * source of truth, which is what rollback and the discharge export both read.
 */

/** Appended to the cached PLAN_SYSTEM block as a second, smaller system block. */
export const EDIT_PLAN_SYSTEM = `You are now revising an existing content plan rather than writing a new one.

The customer has asked for a change. Apply it, and change nothing else.

Rules:
- Return the COMPLETE revised plan as JSON, in the same shape, not a patch and not a diff.
- Every field the request does not touch comes back byte for byte identical. Do not re-word a
  heading because you think you can do better. The customer did not ask for that and they are
  watching their site change.
- If the request cannot be satisfied without inventing a fact, do not invent it. Apply whatever
  part of the request you can, and add a plain English line to the assumptions array saying what
  you could not do and what you would need. Never write a testimonial, a rating, a licence
  number, a job count or a response time that you were not given.
- If the request asks to remove something that must stay (the Go Polar footer credit, a form,
  the single h1), leave it in place and say so in the assumptions array.
- If the request is about wording, change wording. If it is about colour, change the tokens. If
  it is about a section being present, change that section's enabled flag or its contents. Match
  the scope of the request exactly.
- One request can contain several changes. Apply all of them.`

export function editPlanUserMessage(args: {
  plan: ContentPlan
  facts: BuildFacts
  request: string
  previousRequests: string[]
}): string {
  return `${factsBlock(args.facts, args.plan)}

# THE CURRENT PLAN

${JSON.stringify(args.plan, null, 2)}
${
  args.previousRequests.length > 0
    ? `\n# CHANGES THEY HAVE ALREADY ASKED FOR\n\nContext only. These are already applied. Do not apply them again.\n${args.previousRequests
        .map((r, i) => `${i + 1}. ${r}`)
        .join('\n')}\n`
    : ''
}
# WHAT THE CUSTOMER HAS ASKED FOR NOW

"""
${args.request}
"""

Return the complete revised plan as JSON. Nothing else.`
}

/** Appended to the cached HOUSE_RULES block for an edit rebuild. */
export const EDIT_BUILD_SYSTEM = `You are rebuilding a site you have already built, because the content plan changed.

You will be given the previous document and the revised plan. Produce the new document.

Everything the plan did not change must come out byte for byte identical to the previous
document. Same classes, same structure, same copy, same order, same whitespace. The customer is
comparing the two versions side by side, and anything that moves without being asked to move
reads as the tool breaking their website.

Change only what the plan changed. Then check the house rules still hold, because they still do
apply: one h1, colour tokens only in :root, no em dashes, no emoji, the exact Go Polar footer
credit, valid JSON-LD, Web3Forms form actions, alt text on every image.`

export function editBuildUserMessage(args: {
  plan: ContentPlan
  facts: BuildFacts
  previousHtml: string
  changeSummary: string
}): string {
  return `${factsBlock(args.facts, args.plan)}

# WHAT CHANGED IN THE PLAN

${args.changeSummary}

# THE REVISED PLAN

${JSON.stringify(args.plan, null, 2)}

# THE PREVIOUS DOCUMENT

${args.previousHtml}

Output the complete revised document only, starting with "<!DOCTYPE html>" and ending with
"</html>". No code fence, no commentary.`
}
