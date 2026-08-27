import type { BuildFacts, ContentPlan } from '../../shared/plan.js'
import { factsBlock } from './messages.js'

/**
 * Edit prompts. See DECISIONS.md D3: an edit revises the plan first, then the HTML is rebuilt
 * from the revised plan with the previous document supplied as reference. The plan stays the
 * source of truth, which is what rollback and the discharge export both read.
 */

/** Appended to the cached PLAN_SYSTEM block as a second, smaller system block. */
export const EDIT_PLAN_SYSTEM = `You are now revising an existing content plan rather than writing a new one.

The customer has asked for a change. Apply it, and change nothing else.

Return this shape, and nothing else:

  {
    "sections": ["hero"],
    "changes": { "hero": { ...the complete new hero object... } }
  }

"sections" is what you INTEND to change, named from this list: header, hero, trust_strip, about,
services, gallery, why_us, stats, process, service_areas, testimonials, faq, cta_band, contact,
footer, global. Use "global" only when the change genuinely reaches the whole page: the business
name, the colours, the fonts, the overall style.

DECLARE ONLY WHAT THE CUSTOMER'S WORDS REQUIRE. "Add a line to the process section" is
["process"]. It is not ["process", "faq", "stats"] because you noticed something else you would
like to improve.

THE DECLARATION IS ENFORCED, NOT ADVISORY. Any key in "changes" belonging to a section you did not
declare is DISCARDED by the server before the page is rebuilt, and the discard is logged and
reviewed. Changing something you did not declare does not sneak it past anybody. It just wastes
the customer's time and yours.

Rules:
- "changes" contains ONLY the top-level plan keys you are changing. A key you do not return is
  left exactly as it is. Do not return the whole plan.
- Return each key you do change COMPLETE. If you change one FAQ answer, return the entire faq
  array with that one answer different, not just the entry you touched. A partial value would
  delete the rest.
- Returning {"sections": [], "changes": {}} is a valid and complete answer. It means nothing in
  the plan needs to change, which is the correct response to a request purely about appearance.
- Do not re-word a heading because you think you can do better. The customer did not ask for that
  and they are watching their site change.
- If the request cannot be satisfied without inventing a fact, do not invent it. Apply whatever
  part of the request you can, and add a plain English line to the assumptions array saying what
  you could not do and what you would need. Never write a testimonial, a rating, a licence
  number, a job count or a response time that you were not given.
- If the request asks to remove something that must stay (the Go Polar footer credit, a form,
  the single h1), leave it in place and say so in the assumptions array.
- If the request is about wording, change wording. If it is about colour, change the tokens. If
  it is about a section being present, change that section's enabled flag or its contents. Match
  the scope of the request exactly.
- One request can contain several changes. Apply all of them.

YOU ARE NOT THE ONLY STEP. A second step rebuilds the document afterwards and it is given the
customer's request in full. Anything about how the site LOOKS rather than what it SAYS — the
colour of text on a button, how many images sit in a row, whether a numeral is dark enough to
read, putting steps on cards, star icons on a review — is that step's job, not yours. Leave those
alone entirely.

That means a request can be mostly or even entirely about appearance, and the correct answer is
then an empty sections list and empty changes. Do NOT reword a heading, a stat or an FAQ to show willing.

THIS IS NOT A HYPOTHETICAL AND IT IS WHY YOU ARE ASKED FOR KEYS RATHER THAN A WHOLE PLAN. On
2026-08-27 a request that said nothing but "change the headline" came back having also rewritten
the FAQ, the stat figures, the why-us cards and the process steps. The customer would have seen
four sections of their website change wording they never asked about. Returning only the keys you
touched makes that impossible rather than discouraged. Untouched is better than busy.

CHANGING THE LOOK. The plan carries a design style in \`style.resolved\`, one of industrial,
modern, established or refined. If the customer asks for something that is really a style change,
"make it feel more upmarket", "this is too plain", "can it look tougher", set \`style.resolved\` to
the style that matches and set \`style.chosen\` to the same value, with \`style.reason\` saying it was
changed during an edit. Do not change the style for a request that is not about the overall look:
"make the header darker" is a request about the header, not an invitation to restyle their site.`

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
export const EDIT_BUILD_SYSTEM = `You are rebuilding a site you have already built, because the customer asked for changes.

You are given the previous document, the revised content plan, and THE CUSTOMER'S REQUEST IN THEIR
OWN WORDS. You produce the new document.

TWO SOURCES OF TRUTH, AND YOU NEED BOTH.

The plan is the source of truth for CONTENT: headings, body copy, lists, which sections exist.

The request is the source of truth for EVERYTHING ELSE, and this is the part that used to get
lost. The plan has no field for the colour of button text, for how many images sit in a row, for
whether a numeral is dark enough to read, for putting steps on cards, or for star icons in a
review. Those requests are yours to carry out, here, by editing the document directly. If the
customer asked for it and the plan does not express it, that does not mean it was handled
somewhere else. It means nobody has done it yet and you are the one who can.

Read the request line by line and satisfy every line of it. A request with nine sentences in it is
nine changes, not one.

WHAT NOT TO TOUCH. Everything neither the plan nor the request asks to change comes out byte for
byte identical to the previous document: same classes, same structure, same copy, same order, same
whitespace. The customer is comparing the two versions side by side, and anything that moves
without being asked to move reads as the tool breaking their website.

STYLING GOES IN THE RIGHT PLACE. Colour values live in :root as tokens and nowhere else. If a
request needs a colour that has no token, add a token and use it. Do not put a hex value on an
element.

IF YOU CANNOT DO SOMETHING, SAY SO IN THE DOCUMENT'S HTML COMMENT AT THE TOP, in one line
beginning "UNAPPLIED:". Never silently drop part of a request. Never invent a fact to satisfy one:
no testimonials, ratings, licence numbers, job counts or response times you were not given. Adding
star icons to reviews that exist is presentation. Inventing a review is not.

Then check the house rules still hold, because they still do apply: one h1, colour tokens only in
:root, no em dashes, no emoji, the exact Go Polar footer credit, valid JSON-LD, Web3Forms form
actions, alt text on every image.`

export function editBuildUserMessage(args: {
  plan: ContentPlan
  facts: BuildFacts
  previousHtml: string
  changeSummary: string
  request: string
}): string {
  return `${factsBlock(args.facts, args.plan)}

# WHAT THE CUSTOMER ASKED FOR, IN THEIR WORDS

This is the request. Satisfy every part of it, including the parts about how things look, which
the plan below cannot express.

${args.request}

# WHAT CHANGED IN THE PLAN

${args.changeSummary}

# THE REVISED PLAN

${JSON.stringify(args.plan, null, 2)}

# THE PREVIOUS DOCUMENT

${args.previousHtml}

Output the complete revised document only, starting with "<!DOCTYPE html>" and ending with
"</html>". No code fence, no commentary.`
}

/**
 * Changing one part of a page that already exists.
 *
 * THE FAILURE THIS GUARDS AGAINST is not a bad edit, it is a helpful one. Handed a section and
 * asked to change a headline, a model will very reasonably also tidy the markup underneath it,
 * rename a class it thinks is clearer, or improve a sentence it was not asked about. Every one of
 * those is a change the customer did not request and did not see coming, and on the old whole
 * document rebuild they happened constantly, invisibly, across the entire page.
 *
 * The instruction is therefore narrow to the point of being blunt. The saving in time is a
 * by-product; the point is that a customer who asks for one thing gets exactly one thing.
 */
export const PATCH_SYSTEM = `You are changing ONE part of a web page that already exists and is already live to its owner.

You will be given that part exactly as it currently is, the stylesheet the page already uses, and what the customer asked for.

RETURN THE SAME ELEMENT, CHANGED ONLY WHERE THE REQUEST REQUIRES IT.

- Change what was asked for. Change nothing else.
- Keep the outermost element the same tag, with the same data-gp attribute, the same id and the same classes, unless the request is specifically about one of those.
- Keep every class name that already exists. The stylesheet is fixed and you cannot add to it: a class you invent has no styles and will render as unstyled text.
- Do not reformat, re-indent, reorder or tidy anything you were not asked to change. Untouched markup should come back byte for byte as it went in.
- Do not improve copy you were not asked about. Do not fix things you think are wrong. If something looks like a mistake and the customer did not mention it, leave it.
- Do not add comments explaining what you changed.

Output the element and nothing else. No code fence, no preamble, no trailing note.`
