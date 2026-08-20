import { parse, type HTMLElement } from 'node-html-parser'
import type { CheckResult } from '../../../shared/types.js'
import type { BuildFacts } from '../../../shared/plan.js'
import { pageWeight } from '../assets.js'
import { formatBytes } from '../images.js'

/**
 * Static verification. Brief s6 checks 1 to 12, plus check 17, page weight.
 *
 * Runs on every generation and every edit, before the customer sees anything. No browser
 * required, which is the point: these run everywhere, including in CI and on a laptop with no
 * headless Chromium, and they are the checks that catch most real faults.
 *
 * Structure comes from a real HTML parser. Text-level rules run over the raw source, because a
 * banned character inside a comment or an attribute still counts.
 *
 * Every failure carries evidence, and the evidence is fed into the repair prompt verbatim, so
 * "found 3 em dashes" is useless and "line 412: ...text..." is not.
 */

export const FOOTER_CREDIT_TEXT = 'Website by Go Polar Creative'
export const FOOTER_CREDIT_HREF = 'https://www.itscold.com.au'
export const FORM_ACTION = 'https://api.web3forms.com/submit'

/** Brief-derived budget. Warn above the first, fail above the second. */
export const PAGE_WEIGHT_TARGET = 2 * 1024 * 1024
export const PAGE_WEIGHT_WARN = 2.5 * 1024 * 1024
export const PAGE_WEIGHT_FAIL = 5 * 1024 * 1024

interface Structure {
  headings: Array<{ level: number; text: string }>
  imgs: Array<{ src: string; alt: string | null }>
  sources: string[]
  forms: Array<{ action: string | null }>
  jsonLd: string[]
  htmlLang: string | null
  footerCredit: { text: string; target: string | null } | null
  linkHrefs: string[]
  scriptSrcs: string[]
  styleAttrs: string[]
  svgColourAttrs: string[]
}

function readStructure(html: string): Structure {
  const root = parse(html, {
    lowerCaseTagName: true,
    comment: false,
    blockTextElements: { script: true, style: true, pre: true },
  })

  const headings = root
    .querySelectorAll('h1, h2, h3, h4, h5, h6')
    .map((el) => ({ level: Number(el.rawTagName.slice(1)), text: el.text.trim().slice(0, 80) }))

  const imgs = root.querySelectorAll('img').map((el) => ({
    src: el.getAttribute('src') ?? '',
    alt: el.getAttribute('alt') ?? null,
  }))

  const sources = root
    .querySelectorAll('source')
    .map((el) => el.getAttribute('srcset') ?? '')
    .filter(Boolean)

  const forms = root.querySelectorAll('form').map((el) => ({ action: el.getAttribute('action') ?? null }))

  const jsonLd = root
    .querySelectorAll('script')
    .filter((el) => (el.getAttribute('type') ?? '').includes('ld+json'))
    .map((el) => el.text)

  const htmlEl: HTMLElement | null = root.querySelector('html')
  const htmlLang = htmlEl?.getAttribute('lang') ?? null

  let footerCredit: Structure['footerCredit'] = null
  for (const el of root.querySelectorAll('a')) {
    const href = el.getAttribute('href')
    if (href === FOOTER_CREDIT_HREF || href === `${FOOTER_CREDIT_HREF}/`) {
      footerCredit = { text: el.text.trim(), target: el.getAttribute('target') ?? null }
      break
    }
  }

  const linkHrefs = root
    .querySelectorAll('link')
    .map((el) => el.getAttribute('href') ?? '')
    .filter(Boolean)

  const scriptSrcs = root
    .querySelectorAll('script')
    .map((el) => el.getAttribute('src') ?? '')
    .filter(Boolean)

  const styleAttrs = root
    .querySelectorAll('[style]')
    .map((el) => el.getAttribute('style') ?? '')
    .filter(Boolean)

  const svgColourAttrs: string[] = []
  for (const attr of ['fill', 'stroke', 'stop-color']) {
    for (const el of root.querySelectorAll(`[${attr}]`)) {
      const value = el.getAttribute(attr)
      if (value) svgColourAttrs.push(`${attr}="${value}"`)
    }
  }

  return {
    headings,
    imgs,
    sources,
    forms,
    jsonLd,
    htmlLang,
    footerCredit,
    linkHrefs,
    scriptSrcs,
    styleAttrs,
    svgColourAttrs,
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const pass = (id: CheckResult['id'], label: string): CheckResult => ({ id, label, status: 'pass' })
const fail = (
  id: CheckResult['id'],
  label: string,
  detail: string,
  evidence: string[] = [],
): CheckResult => ({ id, label, status: 'fail', detail, evidence: evidence.slice(0, 8) })

function lineOf(html: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < html.length; i++) if (html[i] === '\n') line++
  return line
}

function context(html: string, index: number, width = 70): string {
  const start = Math.max(0, index - width / 2)
  return html
    .slice(start, start + width)
    .replace(/\s+/g, ' ')
    .trim()
}

/** Byte ranges of every :root { ... } block, so colours inside them are allowed. */
function rootRanges(html: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const re = /:root\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    let depth = 1
    let i = m.index + m[0].length
    while (i < html.length && depth > 0) {
      if (html[i] === '{') depth++
      else if (html[i] === '}') depth--
      i++
    }
    ranges.push([m.index, i])
  }
  return ranges
}

function inRanges(index: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([a, b]) => index >= a && index < b)
}

const NAMED_COLOURS = [
  'white', 'black', 'red', 'blue', 'green', 'grey', 'gray', 'silver', 'navy', 'orange',
  'yellow', 'purple', 'gold', 'teal', 'pink', 'brown', 'maroon', 'olive', 'lime', 'aqua',
  'fuchsia', 'beige', 'ivory', 'coral', 'crimson', 'indigo', 'khaki', 'salmon', 'tan',
  'violet', 'wheat', 'azure', 'lavender', 'plum', 'orchid', 'tomato', 'turquoise',
]

// ---------------------------------------------------------------------------------------------
// Checks 1 to 12
// ---------------------------------------------------------------------------------------------

function checkHexOutsideRoot(html: string, s: Structure): CheckResult {
  const id = 'hex_outside_root' as const
  const label = 'No colour values outside :root'
  const ranges = rootRanges(html)
  const evidence: string[] = []

  // Scope: CSS only. That is what the rule is about, and the only place a token could have been
  // used instead. <meta name="theme-color" content="#..."> is deliberately NOT a violation: a
  // meta attribute cannot take a var(), so a literal there is the only option.
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
  for (const block of styleBlocks) {
    const body = block[1] ?? ''
    const offset = (block.index ?? 0) + block[0].indexOf(body)

    const hexRe = /#[0-9a-fA-F]{3,8}\b/g
    let m: RegExpExecArray | null
    while ((m = hexRe.exec(body)) !== null) {
      const absolute = offset + m.index
      if (inRanges(absolute, ranges)) continue
      if (/url\(\s*['"]?$/.test(body.slice(Math.max(0, m.index - 14), m.index))) continue
      evidence.push(`line ${lineOf(html, absolute)}: ${context(html, absolute)}`)
    }

    const funcRe = /\b(rgba?|hsla?)\s*\(/g
    while ((m = funcRe.exec(body)) !== null) {
      const absolute = offset + m.index
      if (inRanges(absolute, ranges)) continue
      evidence.push(`line ${lineOf(html, absolute)}: ${context(html, absolute)}`)
    }

    const declRe = /([a-z-]+)\s*:\s*([^;{}]+)/gi
    let d: RegExpExecArray | null
    while ((d = declRe.exec(body)) !== null) {
      const absolute = offset + d.index
      if (inRanges(absolute, ranges)) continue
      const value = (d[2] ?? '').toLowerCase()
      if (value.includes('var(')) continue
      for (const name of NAMED_COLOURS) {
        if (new RegExp(`(^|[\\s,(])${name}([\\s,)]|$)`).test(value)) {
          evidence.push(`line ${lineOf(html, absolute)}: ${d[1]}: ${(d[2] ?? '').trim()}`)
          break
        }
      }
    }
  }

  for (const st of s.styleAttrs) {
    if (/#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(/.test(st)) evidence.push(`inline style: ${st}`)
  }
  for (const attr of s.svgColourAttrs) {
    if (/#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(/.test(attr)) evidence.push(`svg attribute: ${attr}`)
  }

  return evidence.length === 0
    ? pass(id, label)
    : fail(
        id,
        label,
        `Found ${evidence.length} colour value(s) outside the :root block. Every colour is declared once in :root and referenced with var().`,
        evidence,
      )
}

function checkNoEmDash(html: string): CheckResult {
  const id = 'no_em_dash' as const
  const label = 'No em dashes'
  const evidence: string[] = []
  for (let i = 0; i < html.length; i++) {
    if (html.charCodeAt(i) === 0x2014) evidence.push(`line ${lineOf(html, i)}: ${context(html, i)}`)
  }
  return evidence.length === 0
    ? pass(id, label)
    : fail(id, label, `Found ${evidence.length} em dash character(s) (U+2014).`, evidence)
}

function checkNoEmoji(html: string): CheckResult {
  const id = 'no_emoji' as const
  const label = 'No emoji'
  // Extended_Pictographic covers emoji. Exclude the typographic symbols that share the property
  // and are legitimate on a business site: copyright, registered, trademark, info.
  const allowed = new Set([0x00a9, 0x00ae, 0x2122, 0x2139])
  const re = /\p{Extended_Pictographic}/gu
  const evidence: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const cp = m[0].codePointAt(0)!
    if (allowed.has(cp)) continue
    evidence.push(`line ${lineOf(html, m.index)}: ${m[0]} in "${context(html, m.index, 50)}"`)
  }
  return evidence.length === 0
    ? pass(id, label)
    : fail(id, label, `Found ${evidence.length} emoji. Icons must be inline SVG.`, evidence)
}

function checkSingleH1(s: Structure): CheckResult {
  const id = 'single_h1' as const
  const label = 'Exactly one h1'
  const h1s = s.headings.filter((h) => h.level === 1)
  if (h1s.length === 1) return pass(id, label)
  return fail(
    id,
    label,
    `Found ${h1s.length} h1 elements. There must be exactly one, and it is the hero headline.`,
    h1s.map((h) => `h1: ${h.text}`),
  )
}

function checkHeadingHierarchy(s: Structure): CheckResult {
  const id = 'heading_hierarchy' as const
  const label = 'No skipped heading levels'
  const evidence: string[] = []
  let previous = 0
  for (const h of s.headings) {
    if (previous !== 0 && h.level > previous + 1) {
      evidence.push(`h${previous} is followed by h${h.level}: "${h.text}"`)
    }
    previous = h.level
  }
  return evidence.length === 0
    ? pass(id, label)
    : fail(id, label, 'Heading levels skip a step.', evidence)
}

function checkFooterCredit(s: Structure): CheckResult {
  const id = 'footer_credit' as const
  const label = 'Go Polar footer credit'
  const c = s.footerCredit
  if (!c) {
    return fail(
      id,
      label,
      `No link to ${FOOTER_CREDIT_HREF} found. The footer must contain: <a href="${FOOTER_CREDIT_HREF}" target="_blank" rel="noopener">${FOOTER_CREDIT_TEXT}</a>`,
    )
  }
  const problems: string[] = []
  if (c.text !== FOOTER_CREDIT_TEXT) {
    problems.push(`link text is "${c.text}", it must be exactly "${FOOTER_CREDIT_TEXT}"`)
  }
  if (c.target !== '_blank') problems.push(`target is "${c.target ?? 'missing'}", it must be _blank`)
  return problems.length === 0 ? pass(id, label) : fail(id, label, problems.join('; '), problems)
}

function checkJsonLd(s: Structure): CheckResult {
  const id = 'jsonld_valid' as const
  const label = 'JSON-LD parses'
  if (s.jsonLd.length === 0) {
    return fail(id, label, 'No JSON-LD block found. The @graph is required.')
  }
  const evidence: string[] = []
  for (const [i, block] of s.jsonLd.entries()) {
    try {
      JSON.parse(block)
    } catch (err) {
      evidence.push(`block ${i + 1}: ${(err as Error).message}`)
    }
  }
  return evidence.length === 0
    ? pass(id, label)
    : fail(id, label, 'A JSON-LD block does not parse as JSON.', evidence)
}

function checkFormAction(s: Structure): CheckResult {
  const id = 'form_action' as const
  const label = 'Forms post to Web3Forms'
  if (s.forms.length === 0) {
    return fail(id, label, 'No form found. The build needs a hero form and a contact form.')
  }
  const bad = s.forms.filter((f) => f.action !== FORM_ACTION)
  if (bad.length > 0) {
    return fail(
      id,
      label,
      `${bad.length} form(s) do not post to ${FORM_ACTION}.`,
      bad.map((f) => `action="${f.action ?? 'missing'}"`),
    )
  }
  if (s.forms.length < 2) {
    return fail(id, label, 'Only one form found. There must be a hero form and a contact form.')
  }
  return pass(id, label)
}

function checkImgAlt(s: Structure): CheckResult {
  const id = 'img_alt' as const
  const label = 'Every image has alt text'
  const bad = s.imgs.filter((i) => !i.alt || i.alt.trim().length === 0)
  return bad.length === 0
    ? pass(id, label)
    : fail(
        id,
        label,
        `${bad.length} image(s) have no alt text.`,
        bad.map((i) => `<img src="${i.src}">`),
      )
}

function checkLang(s: Structure): CheckResult {
  const id = 'lang_attr' as const
  const label = 'lang="en-AU"'
  return s.htmlLang === 'en-AU'
    ? pass(id, label)
    : fail(id, label, `<html lang> is "${s.htmlLang ?? 'missing'}", it must be "en-AU".`)
}

function checkFreeQuote(html: string, facts: BuildFacts): CheckResult {
  const id = 'free_quote_absent' as const
  const label = 'No "free quote" when free quotes is No'
  if (facts.freeQuotes) {
    return { id, label, status: 'skipped', detail: 'Business does offer free quotes.' }
  }
  const evidence: string[] = []
  const re = /free\s+quote/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    evidence.push(`line ${lineOf(html, m.index)}: ${context(html, m.index)}`)
  }
  return evidence.length === 0
    ? pass(id, label)
    : fail(
        id,
        label,
        `This business does not offer free quotes, and "free quote" appears ${evidence.length} time(s). Use "request a quote" or "get a price".`,
        evidence,
      )
}

/** Every relative path the document references. Shared by checks 12 and 17. */
export function referencedPaths(html: string, s: Structure): string[] {
  const referenced = new Set<string>()
  const add = (raw: string) => {
    const value = raw.trim().split(/\s+/)[0] ?? ''
    if (!value) return
    if (/^(https?:|data:|tel:|mailto:|#|\/\/)/i.test(value)) return
    referenced.add(value.replace(/^\.\//, ''))
  }

  for (const img of s.imgs) add(img.src)
  for (const srcset of s.sources) for (const part of srcset.split(',')) add(part)
  for (const href of s.linkHrefs) add(href)
  for (const src of s.scriptSrcs) add(src)
  for (const m of html.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) add(m[1] ?? '')
  for (const m of html.matchAll(/srcset\s*=\s*"([^"]+)"/gi)) {
    for (const part of (m[1] ?? '').split(',')) add(part)
  }

  return [...referenced]
}

/**
 * Collapse a page-relative reference to a site-relative one.
 *
 * "../../assets/photo-01.webp" on a page at services/x/index.html is the same file as
 * "assets/photo-01.webp" at the root. Without this every image on every service page reads as
 * missing, which is how a correct page set fails its own check.
 */
function resolveAgainstPage(ref: string): string {
  return ref.replace(/^(?:\.\.\/)+/, '')
}

function checkAssets(html: string, s: Structure, facts: BuildFacts): CheckResult {
  const id = 'assets_exist' as const
  const label = 'Referenced assets exist'
  const allowed = new Set(Object.keys(facts.assetManifest))
  const missing = referencedPaths(html, s)
    .map(resolveAgainstPage)
    .filter((r) => !allowed.has(r))

  return missing.length === 0
    ? pass(id, label)
    : fail(
        id,
        label,
        `${missing.length} referenced file(s) do not exist. The only files that will ship are: ${[...allowed].join(', ') || 'none'}.`,
        missing,
      )
}

// ---------------------------------------------------------------------------------------------
// Check 17: page weight
// ---------------------------------------------------------------------------------------------

/**
 * What a first-time visitor actually downloads.
 *
 * This is a cost control as much as a speed one. These are static sites with plain image tags
 * served from Vercel, where bandwidth is billed, so page weight is a recurring bill for every
 * visit to every site, forever. See DECISIONS.md D25.
 */
export function checkPageWeight(html: string, s: Structure, facts: BuildFacts): CheckResult {
  const id = 'page_weight' as const
  const label = 'Page weight within budget'
  const total = pageWeight(html, referencedPaths(html, s), facts.assetManifest)

  const heaviest = Object.entries(facts.assetManifest)
    .filter(([path]) => !/\.jpe?g$/i.test(path))
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 5)
    .map(([path, meta]) => `${path}: ${formatBytes(meta.bytes)}`)

  const summary = `${formatBytes(total)} total, HTML ${formatBytes(new TextEncoder().encode(html).byteLength)}`

  if (total > PAGE_WEIGHT_FAIL) {
    return fail(
      id,
      label,
      `${summary}. That is over the ${formatBytes(PAGE_WEIGHT_FAIL)} hard limit. Drop images or use the thumbnail variants in the gallery.`,
      heaviest,
    )
  }
  if (total > PAGE_WEIGHT_WARN) {
    return {
      id,
      label,
      status: 'warn',
      detail: `${summary}. Over the ${formatBytes(PAGE_WEIGHT_WARN)} warning line, target is ${formatBytes(PAGE_WEIGHT_TARGET)}.`,
      evidence: heaviest,
    }
  }
  return { id, label, status: 'pass', detail: summary }
}

/** Page weight on its own, for recording against the build. */
export function measurePageWeight(html: string, facts: BuildFacts): number {
  return pageWeight(html, referencedPaths(html, readStructure(html)), facts.assetManifest)
}

// ---------------------------------------------------------------------------------------------

/**
 * The FAQ copy on the page must match the FAQPage schema word for word (brief s5).
 * Folded into the JSON-LD check so the numbered list of checks stays the numbered list.
 */
function faqMismatchEvidence(html: string, s: Structure): string[] {
  const evidence: string[] = []

  // Compare against the visible copy only. Searching the whole document would find the FAQ text
  // inside the JSON-LD itself and every comparison would trivially pass, which is the bug this
  // check exists to catch.
  const pageText = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')

  for (const block of s.jsonLd) {
    let parsed: unknown
    try {
      parsed = JSON.parse(block)
    } catch {
      continue
    }
    const graph = (parsed as { '@graph'?: unknown[] })['@graph'] ?? []
    for (const node of graph as Array<Record<string, unknown>>) {
      if (node['@type'] !== 'FAQPage') continue
      const questions = (node.mainEntity ?? []) as Array<Record<string, unknown>>
      for (const q of questions) {
        const name = String(q.name ?? '').replace(/\s+/g, ' ').trim()
        const answer = String((q.acceptedAnswer as Record<string, unknown> | undefined)?.text ?? '')
          .replace(/\s+/g, ' ')
          .trim()
        if (name && !pageText.includes(name)) {
          evidence.push(`FAQ question in schema but not in page copy: "${name}"`)
        }
        if (answer && !pageText.includes(answer)) {
          evidence.push(`FAQ answer in schema does not match page copy: "${answer.slice(0, 80)}"`)
        }
      }
    }
  }
  return evidence
}

export async function runStaticChecks(html: string, facts: BuildFacts): Promise<CheckResult[]> {
  const s = readStructure(html)

  const results: CheckResult[] = [
    checkHexOutsideRoot(html, s),
    checkNoEmDash(html),
    checkNoEmoji(html),
    checkSingleH1(s),
    checkHeadingHierarchy(s),
    checkFooterCredit(s),
    checkJsonLd(s),
    checkFormAction(s),
    checkImgAlt(s),
    checkLang(s),
    checkFreeQuote(html, facts),
    checkAssets(html, s, facts),
    checkPageWeight(html, s, facts),
  ]

  const jsonLd = results.find((r) => r.id === 'jsonld_valid')!
  if (jsonLd.status === 'pass') {
    const mismatches = faqMismatchEvidence(html, s)
    if (mismatches.length > 0) {
      jsonLd.status = 'fail'
      jsonLd.detail =
        'JSON-LD parses, but the FAQ copy on the page does not match the FAQPage schema word for word.'
      jsonLd.evidence = mismatches.slice(0, 8)
    }
  }

  return results
}
