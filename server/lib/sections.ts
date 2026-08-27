/**
 * Addressing one part of a finished document, so an edit does not have to rewrite all of it.
 *
 * THE MEASUREMENT THAT PRODUCED THIS. A real edit on 2026-08-27, "change the headline", took 266
 * seconds. 206 of those were the rebuild call re-emitting 63KB of HTML, byte for byte almost all
 * of it identical to what went in, for the sake of one line. 35,390 output tokens to change a
 * headline.
 *
 * Re-emitting the whole document is not only slow. It is the reason an edit can regress a section
 * nobody asked about: every byte is rewritten from scratch every time, so every byte is a chance
 * for the model to make a different decision than it made last time. Patching makes the untouched
 * sections byte-identical by construction rather than by hope, and test/sections.test.ts asserts
 * exactly that.
 *
 * WHY A MARKER AND NOT AN id. The obvious approach is to find the section by its HTML id. That
 * does not work: the ids are the model's own choice and they move between builds. One real build
 * used id="hero", the next used id="top" for the same section, with gallery as id="work",
 * testimonials as id="reviews", and the trust strip and CTA band carrying no id at all. Worse,
 * testimonial cards contain their own nested <footer> elements, so even matching on tag name
 * finds the wrong node. The house rules now ask for an explicit data-gp attribute, which is ours
 * rather than the model's, and a document without one is simply not patched.
 */

/** The vocabulary. A data-gp value outside this list is not a section we know how to address. */
export const SECTION_IDS = [
  'header',
  'hero',
  'trust_strip',
  'about',
  'services',
  'gallery',
  'why_us',
  'stats',
  'process',
  'service_areas',
  'testimonials',
  'faq',
  'cta_band',
  'contact',
  'footer',
] as const

export type SectionId = (typeof SECTION_IDS)[number]

/**
 * Which part of the document each top-level plan key is rendered into.
 *
 * DELIBERATELY GENEROUS. A key that reaches more than one place lists all of them, and anything
 * whose blast radius is not confidently known is not in this map at all, which routes it to a
 * full rebuild. Over-selecting costs seconds. Under-selecting means the customer asked for
 * something, was told it was done, and did not get it.
 */
export const PLAN_KEY_SECTIONS: Record<string, SectionId[]> = {
  hero: ['hero'],
  trustStrip: ['trust_strip'],
  about: ['about'],
  services: ['services'],
  gallery: ['gallery'],
  whyUs: ['why_us'],
  stats: ['stats'],
  process: ['process'],
  serviceAreas: ['service_areas'],
  testimonials: ['testimonials'],
  ctaBand: ['cta_band'],
  faq: ['faq'],
  contact: ['contact'],
}

/**
 * Plan keys that reach the head, the stylesheet, or every section at once.
 *
 * `brand` is here rather than mapped to header and footer because the business name is also in
 * the title, the meta description, the Open Graph tags and the JSON-LD. `meta` and `schema` are
 * head-only. `style` and `tokens` are the stylesheet, which is every section by definition.
 */
const GLOBAL_PLAN_KEYS = new Set(['meta', 'style', 'tokens', 'brand', 'schema'])

/** Keys that change nothing a visitor sees on the home page. */
const INERT_PLAN_KEYS = new Set(['servicePages', 'assumptions', 'clientToSupply'])

/**
 * Requests that are about how the page LOOKS rather than what it says.
 *
 * The plan cannot express these, so a colour or spacing request often produces an empty plan diff
 * and would otherwise look like "nothing to patch". They are the stylesheet, which is global, so
 * they go to a full rebuild. Matching is deliberately loose and errs towards rebuilding.
 */
const APPEARANCE = new RegExp(
  [
    'colour|color|palette|theme|font|typeface|typography|bigger|smaller|larger|size',
    'spacing|padding|margin|gap|tighter|wider|narrow',
    'style|look|feel|design|layout|modern|classic|bold|clean|professional',
    'dark|light|background|contrast|rounded|corner|shadow|border',
    'whole site|entire site|everywhere|all the|every page|throughout',
  ].join('|'),
  'i',
)

export type PatchTarget = SectionId | 'jsonld'

export type EditPlan =
  | { mode: 'patch'; targets: PatchTarget[]; reason: string }
  | { mode: 'rebuild'; reason: string }

/**
 * Does this document carry the markers, and does it carry the ones we are about to reach for?
 *
 * A build from before the marker rule, or one where the model ignored it, is not patchable. That
 * is not an error: it falls back to the rebuild that has always happened.
 */
export function markedSections(html: string): Set<SectionId> {
  const counts = new Map<SectionId, number>()
  for (const m of html.matchAll(/data-gp=["']([a-z_]+)["']/g)) {
    const id = m[1] as SectionId
    if ((SECTION_IDS as readonly string[]).includes(id)) {
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
  }

  /*
   * EXACTLY ONCE, OR IT IS NOT ADDRESSABLE.
   *
   * A marker that appears twice cannot identify a section: sectionRange takes the first match, so
   * a patch would rewrite whichever element happened to come first and leave the real one alone,
   * or splice a header into the middle of the page. Silently doing the wrong thing to a
   * customer's website is the failure this whole module exists to prevent.
   *
   * Not hypothetical. A build at BUILD_EFFORT=medium on 2026-08-27 emitted data-gp="header" three
   * times. Dropping the id costs that one section its fast path and nothing else: planEdit sees
   * no marker for it and rebuilds the page, which is the behaviour every document had before any
   * of this existed.
   */
  const found = new Set<SectionId>()
  for (const [id, n] of counts) if (n === 1) found.add(id)
  return found
}

/**
 * The byte range of one marked section, including its own opening and closing tags.
 *
 * Walks the tag stack rather than regex-matching a closing tag, because sections contain nested
 * elements of the same name: a testimonial card is a <footer> inside a <section>, and the naive
 * match for the site footer swallows half the page.
 */
export function sectionRange(html: string, id: SectionId): { start: number; end: number } | null {
  const open = new RegExp('<([a-z]+)([^>]*\\sdata-gp=["\']' + id + '["\'][^>]*)>', 'i')
  const m = open.exec(html)
  if (!m) return null
  const tag = m[1]!.toLowerCase()
  const start = m.index

  // Self-closing is not valid for a landmark, but refuse rather than mis-splice if it happens.
  if (m[0].endsWith('/>')) return { start, end: start + m[0].length }

  const scan = new RegExp('<' + tag + '\\b[^>]*>|</' + tag + '\\s*>', 'gi')
  scan.lastIndex = start
  let depth = 0
  for (let hit = scan.exec(html); hit; hit = scan.exec(html)) {
    if (hit[0].startsWith('</')) {
      depth--
      if (depth === 0) return { start, end: hit.index + hit[0].length }
    } else if (!hit[0].endsWith('/>')) {
      depth++
    }
  }
  return null
}

export function extractSection(html: string, id: SectionId): string | null {
  const r = sectionRange(html, id)
  return r ? html.slice(r.start, r.end) : null
}

/** The JSON-LD block, which the FAQ copy is checked against word for word. */
export function jsonLdRange(html: string): { start: number; end: number } | null {
  const m = /<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/i.exec(html)
  return m ? { start: m.index, end: m.index + m[0].length } : null
}

export function extractJsonLd(html: string): string | null {
  const r = jsonLdRange(html)
  return r ? html.slice(r.start, r.end) : null
}

/**
 * Put the replacements back.
 *
 * Applied back to front so that an earlier splice cannot invalidate a later offset, and every
 * target is located against the ORIGINAL document exactly once.
 */
export function spliceInto(
  html: string,
  patches: Array<{ target: PatchTarget; markup: string }>,
): string {
  const ranges = patches
    .map((p) => {
      const r = p.target === 'jsonld' ? jsonLdRange(html) : sectionRange(html, p.target)
      return r ? { ...r, markup: p.markup, target: p.target } : null
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => b.start - a.start)

  let out = html
  for (const r of ranges) out = out.slice(0, r.start) + r.markup.trim() + out.slice(r.end)
  return out
}

/**
 * Did this fragment come back whole?
 *
 * WHY NOT isTruncated. That one asks whether the text ends with a closing html tag, which is
 * exactly right for a document and exactly wrong for a piece of one. Used on a section it
 * reported EVERY patch as truncated, so the first working patch run threw "the stats patch came
 * back incomplete", abandoned six perfectly good sections and fell back to the rebuild it was
 * meant to replace, after spending 144 seconds not doing so.
 *
 * A fragment is whole when its outermost tag closes: the same number of opening and closing tags,
 * and the last thing in it is that closing tag.
 */
export function fragmentIsComplete(markup: string): boolean {
  const text = markup.trim()
  const open = /^<([a-z]+)[\s>]/i.exec(text)
  if (!open) return false
  const tag = open[1]!.toLowerCase()

  if (!new RegExp('</' + tag + '\\s*>$', 'i').test(text)) return false

  const opens = (text.match(new RegExp('<' + tag + '\\b[^>]*>', 'gi')) ?? []).filter(
    (t) => !t.endsWith('/>'),
  ).length
  const closes = (text.match(new RegExp('</' + tag + '\\s*>', 'gi')) ?? []).length
  return opens > 0 && opens === closes
}

/**
 * Pull the element out of a reply that may have a sentence in front of it.
 *
 * WHY THIS IS NEEDED, from a real run. Asked to patch the testimonials section for a request
 * about the process section, the model replied:
 *
 *   "The requested change belongs to the process section, not testimonials. This part
 *    <section data-gp="testimonials">...</section>"
 *
 * Which is a completely correct thing to say. The strict parser saw a character that was not "<"
 * and failed the entire patch, so six good sections were thrown away and the whole edit fell back
 * to the rebuild it was there to avoid. Being right about the markup is not worth being brittle
 * about the packaging.
 */
export function unwrapFragment(text: string, expectTag?: string): string | null {
  const trimmed = text.trim()
  const at = expectTag
    ? trimmed.search(new RegExp('<' + expectTag + '\\b', 'i'))
    : trimmed.search(/<[a-z]+[\s>]/i)
  if (at < 0) return null
  return trimmed.slice(at).trim()
}

/** The JSON-LD block is complete when it closes and the JSON inside it parses. */
export function jsonLdIsComplete(markup: string): boolean {
  const text = markup.trim()
  if (!/^<script\b/i.test(text) || !/<\/script>$/i.test(text)) return false
  const inner = text.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '')
  try {
    JSON.parse(inner)
    return true
  } catch {
    return false
  }
}

/**
 * Decide whether this edit can be patched, and what it touches.
 *
 * `changes` are the lines from diffPlans. The first segment is the top-level plan key, which is
 * what decides the blast radius.
 */
export function planEdit(args: { changes: string[]; request: string; html: string }): EditPlan {
  const { changes, request, html } = args

  if (markedSections(html).size === 0) {
    return {
      mode: 'rebuild',
      reason: 'This document predates section markers, so it cannot be patched.',
    }
  }

  if (APPEARANCE.test(request)) {
    return {
      mode: 'rebuild',
      reason:
        'The request is about how the site looks, which lives in the stylesheet and reaches every section.',
    }
  }

  /*
   * diffPlans emits "<dotted.path>: <what changed>", for example
   *   hero.h1: "Trusted specialists..." became "Emergency plumbing"
   *   faq: contents changed
   * so the key is everything before the first colon OR the first dot, whichever comes first.
   * Splitting on the dot alone yields "faq: contents changed" as a key name, which matches
   * nothing, and every edit silently fell back to a full rebuild. It did exactly that on the
   * first real measurement.
   */
  const keys = new Set(
    changes
      .map((c) => c.split(':')[0]!.trim().split('.')[0]!.trim())
      .filter((k) => k.length > 0 && !INERT_PLAN_KEYS.has(k)),
  )

  if (keys.size === 0) {
    return {
      mode: 'rebuild',
      reason: 'The plan did not move, so there is nothing to localise the change to.',
    }
  }

  const global = [...keys].filter((k) => GLOBAL_PLAN_KEYS.has(k))
  if (global.length > 0) {
    return { mode: 'rebuild', reason: global.join(', ') + ' reaches the head and the stylesheet.' }
  }

  const unknown = [...keys].filter((k) => !PLAN_KEY_SECTIONS[k])
  if (unknown.length > 0) {
    return {
      mode: 'rebuild',
      reason: 'No section mapping for ' + unknown.join(', ') + ', so the whole page is rebuilt.',
    }
  }

  const targets = new Set<PatchTarget>()
  for (const k of keys) for (const s of PLAN_KEY_SECTIONS[k]!) targets.add(s)

  // The FAQ copy is checked against the FAQPage schema word for word, so the two move together
  // or the build fails jsonld_valid and buys a repair pass, which is the cost being avoided.
  if (targets.has('faq')) targets.add('jsonld')

  const present = markedSections(html)
  const missing = [...targets].filter((t) => t !== 'jsonld' && !present.has(t as SectionId))
  if (missing.length > 0) {
    return { mode: 'rebuild', reason: 'This build has no marker for ' + missing.join(', ') + '.' }
  }
  if (targets.has('jsonld') && !jsonLdRange(html)) {
    return { mode: 'rebuild', reason: 'The JSON-LD block could not be located.' }
  }

  /*
   * WHERE PATCHING STOPS PAYING.
   *
   * The calls run concurrently, so eight sections cost about the same wall clock as one and the
   * limit is not really about speed. It is about coherence: past roughly two thirds of the page,
   * a single pass that can see the whole document is more likely to keep it consistent than a
   * dozen independent rewrites stitched together, and at that point the customer has effectively
   * asked for a new page anyway.
   */
  const sectionCount = [...targets].filter((t) => t !== 'jsonld').length
  if (sectionCount > 9) {
    return { mode: 'rebuild', reason: sectionCount + ' sections change, which is most of the page.' }
  }

  return {
    mode: 'patch',
    targets: [...targets],
    reason: 'Localised to ' + [...targets].join(', ') + '.',
  }
}

/**
 * Is this plan key allowed to change, given what the edit step declared it would touch?
 *
 * A key with no section of its own (meta, schema, style, tokens, brand) lives in the head or the
 * stylesheet, so it only travels under a "global" declaration. Everything else needs at least one
 * of its sections named.
 */
export function keyIsDeclared(key: string, declared: Set<string>): boolean {
  if (declared.has('global')) return true
  const sections = PLAN_KEY_SECTIONS[key]
  if (!sections) return false
  return sections.some((s) => declared.has(s))
}

/** The stylesheet already in the document, handed to a patch so it reuses classes and adds none. */
export function extractStylesheet(html: string): string | null {
  const blocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!)
  if (blocks.length === 0) return null
  return blocks.join('\n')
}
