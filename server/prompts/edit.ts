import type { BuildFacts, ContentPlan } from '../../shared/plan.js'
import { factsBlock } from './messages.js'
import { DEFAULT_LABELS } from '../lib/render/site.js'

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
- THE REQUEST ITSELF IS THE CUSTOMER TELLING YOU SOMETHING, AND IT COUNTS AS SUPPLIED.
  THIS OVERRIDES HOUSE RULE 1 FOR FACTS THE OWNER STATES ABOUT THEIR OWN BUSINESS. Rule 1 says
  that if the intake does not contain it, it does not exist. The intake is what they told us on
  the day; this request is what they are telling us now, and it is the same person. The facts
  block above lists what was supplied at intake. It is not a limit on what is true.

  DELEGATION COUNTS TOO. "Add six suburbs near the ones I already service" is the owner saying
  they cover that area and asking you to name the places. Name real neighbouring suburbs of the
  ones already listed. Declining that as an invented fact is the wrong reading: they are not
  asking you to guess whether they work there, they have just told you that they do.
  The rule against inventing exists to stop you making things up about a business you know
  nothing about. It is not a reason to refuse what the owner has just told you. When they name
  suburbs they work in, services they offer, hours they open, years they have been going or a
  licence they hold, that is the business stating a fact about itself, and it goes on the site.

  "Add fifteen suburbs near the four I already have" is the owner saying they work in those
  suburbs. It was declined as an invented fact and the customer was told the change had been
  made, which is the worst of both: nothing happened and nobody said so.

  When you add suburbs, put them in BOTH serviceAreas.suburbs and schema.areaServed.cities, or
  the page and the structured data disagree about where the business works.

- STILL REFUSED, EVEN WHEN ASKED DIRECTLY. A testimonial, a star rating, a review count or a
  number of jobs done. Those are claims about other people and about results, not facts the
  owner can simply state, and a made up review is a lie told to somebody about to spend money.
  Refuse the same way as below: do the rest, and say what you did not do.

- If the request cannot be satisfied without inventing a fact, do not invent it. Apply whatever
  part of the request you can, and add a plain English line to the assumptions array saying what
  you could not do and what you would need.
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
# WHERE THE THING THEY CAN SEE ACTUALLY LIVES

A customer describes what they are looking at, not the key that holds it. "The footer says
Chermside" was answered by rewriting the brand tagline, because nothing said which field puts a
town in the footer. This is that map. When a request names something on this list, change the
key beside it and nothing else.

  the town named in the footer line and in headings   meta.geoPlacename
  the wording around it, "X and surrounding suburbs"  labels["contact.area"]
  the list of suburbs in the service areas section    serviceAreas.suburbs AND
                                                      schema.areaServed.cities, both together
  the small label above a section heading             sectionCopy[section].eyebrow
  the colour of one of those labels                   sectionCopy[section].eyebrowColor
  the colour of all of them                           tokens.eyebrow
  the colour of the filled buttons                    tokens.button
  the words on the main buttons                       hero.ctaPrimary.label, hero.ctaSecondary.label
  how many photos sit in a row                        layout.galleryColumns
  the photo behind the closing call to action         layout.ctaBandPhoto
  how big the logo is                                 layout.logoHeight
  anything on ONE service page                        the matching entry in servicePages:
                                                      title, metaDescription, h1, intro,
                                                      included, steps, scopeFactors, faqs
  whether the photo gallery is shown at all           gallery.enabled
  whether the reviews section is shown at all         testimonials.enabled

# FIELDS THAT MAY BE MISSING FROM THE PLAN ABOVE

The plan you have been given may have been written before a field existed, so a field being
ABSENT does not mean it is unavailable. Add it when the request calls for it.

sectionCopy
  The small label above a section heading, and the heading and blurb where the template
  supplies one rather than the plan. Keyed by section id: hero, hero_form, about, services,
  gallery, why_us, process, service_areas, testimonials, faq, cta_band, contact. Each holds
  { "eyebrow": string, "heading": string, "blurb": string }, all optional.

  THIS IS WHERE A CHANGE TO A SECTION LABEL GOES, and it is the only place it can go. If
  somebody asks about the small text above a heading, the wording of a section heading, or
  the line underneath it, put it here. Changing something else instead means their website
  comes back looking identical and they have spent a round for nothing.

tokens.eyebrow
  A hex colour for those small labels on their own, separate from the accent. Use it when the
  request is about the colour of the text above a heading, so their buttons and links do not
  move with it.

tokens.button
  A hex colour for the filled buttons on their own, separate from the accent. Use it when the
  request is about the colour of a button, for example "make the call now button green", so the
  small labels and links do not change with it.

layout.galleryColumns
  How many photos sit across a row on a desktop screen, 2 to 4. Left out, it is worked out from
  how many photos there are. Use it when somebody asks for a particular arrangement, for example
  three rows of three.


labels
  Every other word the template supplies and the plan does not: form field labels, footer column
  headings, button and link text, the note under the enquiry form. A flat map of key to wording.
  The keys are:
${Object.keys(DEFAULT_LABELS).map((k) => "    " + k).join("\n")}

  Use it when the request is about a word on the page that is not a heading and not their own
  copy, for example "change Request a quote to Get a price".

sectionCopy[section].eyebrowColor
  A hex colour for the label above ONE section heading. tokens.eyebrow moves all of them at once;
  this moves one. Use it when the request names particular sections.

layout.logoHeight
  How tall the logo is allowed to be, 32 to 140 pixels. The footer follows. Use it for "make the
  logo bigger".

tokens.heroTick
  A hex colour for the tick icons beside the hero trust points, separate from the accent.

layout.ctaBandPhoto
  false removes the photograph behind the closing call to action band. On by default.

  A NOTE ON labels: services.cardPageCta is the WHOLE text of the link on a service card, and
  {service} in it is replaced by the service name. "More on {service}" reads per card; "LEARN
  MORE" is the same three words on every card. Do not leave the placeholder in when the customer
  asked for fixed wording.

# WHAT THE CUSTOMER HAS ASKED FOR NOW

"""
${args.request}
"""

Return the complete revised plan as JSON. Nothing else.`
}

