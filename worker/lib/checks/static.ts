import type { CheckResult } from '../../../shared/types'
import type { BuildFacts } from '../../../shared/plan'

/**
 * Static verification. Brief s6, checks 1 to 12. Runs on the Worker after every generation and
 * every edit, before the customer sees anything.
 *
 * Structural checks use HTMLRewriter, which is a real HTML parser and does not fall over on the
 * things regex does. Text-level checks (em dashes, emoji, hex) run over the raw source, because
 * a banned character inside a comment or an attribute still counts.
 *
 * Every failure carries evidence. The evidence is fed back into the repair prompt verbatim, so
 * "found 3 em dashes" is useless and "line 412: ...text..." is not.
 */

export const FOOTER_CREDIT_TEXT = 'Website by Go Polar Creative'
export const FOOTER_CREDIT_HREF = 'https://www.itscold.com.au'
export const FORM_ACTION = 'https://api.web3forms.com/submit'

interface Structure {
  headings: Array<{ level: number; text: string }>
  imgs: Array<{ src: string; alt: string | null }>
  forms: Array<{ action: string | null }>
  jsonLd: string[]
  htmlLang: string | null
  footerCredit: { text: string; href: string | null; target: string | null } | null
  anchorHrefs: string[]
  linkHrefs: string[]
  scriptSrcs: string[]
  styleAttrs: string[]
  svgColourAttrs: string[]
}

async function parse(html: string): Promise<Structure> {
  const s: Structure = {
    headings: [],
    imgs: [],
    forms: [],
    jsonLd: [],
    htmlLang: null,
    footerCredit: null,
    anchorHrefs: [],
    linkHrefs: [],
    scriptSrcs: [],
    styleAttrs: [],
    svgColourAttrs: [],
  }

  let capturingHeading: number | null = null
  let headingText = ''
  let jsonLdBuffer: string | null = null
  let creditBuffer: { text: string; href: string | null; target: string | null } | null = null

  const rewriter = new HTMLRewriter()
    .on('html', {
      element(el) {
        s.htmlLang = el.getAttribute('lang')
      },
    })
    .on('h1, h2, h3, h4, h5, h6', {
      element(el) {
        capturingHeading = Number(el.tagName.slice(1))
        headingText = ''
        el.onEndTag(() => {
          if (capturingHeading !== null) {
            s.headings.push({ level: capturingHeading, text: headingText.trim().slice(0, 80) })
          }
          capturingHeading = null
        })
      },
      text(t) {
        if (capturingHeading !== null) headingText += t.text
      },
    })
    .on('img', {
      element(el) {
        s.imgs.push({ src: el.getAttribute('src') ?? '', alt: el.getAttribute('alt') })
      },
    })
    .on('form', {
      element(el) {
        s.forms.push({ action: el.getAttribute('action') })
      },
    })
    .on('script[type="application/ld+json"]', {
      element(el) {
        jsonLdBuffer = ''
        el.onEndTag(() => {
          if (jsonLdBuffer !== null) s.jsonLd.push(jsonLdBuffer)
          jsonLdBuffer = null
        })
      },
      text(t) {
        if (jsonLdBuffer !== null) jsonLdBuffer += t.text
      },
    })
    .on('script[src]', {
      element(el) {
        const src = el.getAttribute('src')
        if (src) s.scriptSrcs.push(src)
      },
    })
    .on('a', {
      element(el) {
        const href = el.getAttribute('href')
        if (href) s.anchorHrefs.push(href)
        if (href === FOOTER_CREDIT_HREF || href === FOOTER_CREDIT_HREF + '/') {
          creditBuffer = { text: '', href, target: el.getAttribute('target') }
          el.onEndTag(() => {
            if (creditBuffer) s.footerCredit = { ...creditBuffer, text: creditBuffer.text.trim() }
            creditBuffer = null
          })
        }
      },
      text(t) {
        if (creditBuffer) creditBuffer.text += t.text
      },
    })
    .on('link[href]', {
      element(el) {
        const href = el.getAttribute('href')
        if (href) s.linkHrefs.push(href)
      },
    })
    .on('[style]', {
      element(el) {
        const st = el.getAttribute('style')
        if (st) s.styleAttrs.push(st)
      },
    })
    .on('[fill], [stroke], [stop-color]', {
      element(el) {
        for (const attr of ['fill', 'stroke', 'stop-color']) {
          const v = el.getAttribute(attr)
          if (v) s.svgColourAttrs.push(`${attr}="${v}"`)
        }
      },
    })

  await rewriter.transform(new Response(html)).text()
  return s
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

/** Byte ranges of every :root { ... } block, so hex inside them can be ignored. */
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

// ---------------------------------------------------------------------------------------------
// Checks 1 to 12
// ---------------------------------------------------------------------------------------------

const NAMED_COLOURS = [
  'white', 'black', 'red', 'blue', 'green', 'grey', 'gray', 'silver', 'navy', 'orange',
  'yellow', 'purple', 'gold', 'teal', 'pink', 'brown', 'maroon', 'olive', 'lime', 'aqua',
  'fuchsia', 'beige', 'ivory', 'coral', 'crimson', 'indigo', 'khaki', 'salmon', 'tan',
  'violet', 'wheat', 'azure', 'lavender', 'plum', 'orchid', 'tomato', 'turquoise',
]

function checkHexOutsideRoot(html: string, s: Structure): CheckResult {
  const id = 'hex_outside_root' as const
  const label = 'No colour values outside :root'
  const ranges = rootRanges(html)
  const evidence: string[] = []

  // Scope: CSS only. That is what the rule is about, and it is the only place a token could
  // have been used instead. <meta name="theme-color" content="#..."> is deliberately NOT a
  // violation: a meta attribute cannot take a var(), so a literal there is the only option.
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
  for (const block of styleBlocks) {
    const body = block[1] ?? ''
    const offset = (block.index ?? 0) + block[0].indexOf(body)

    // Literal hex, ignoring url(#gradientId) references.
    const hexRe = /#[0-9a-fA-F]{3,8}\b/g
    let m: RegExpExecArray | null
    while ((m = hexRe.exec(body)) !== null) {
      const absolute = offset + m.index
      if (inRanges(absolute, ranges)) continue
      if (/url\(\s*['"]?$/.test(body.slice(Math.max(0, m.index - 14), m.index))) continue
      evidence.push(`line ${lineOf(html, absolute)}: ${context(html, absolute)}`)
    }

    // Functional colour notations.
    const funcRe = /\b(rgba?|hsla?)\s*\(/g
    while ((m = funcRe.exec(body)) !== null) {
      const absolute = offset + m.index
      if (inRanges(absolute, ranges)) continue
      evidence.push(`line ${lineOf(html, absolute)}: ${context(html, absolute)}`)
    }

    // Named colours in declaration values.
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

  // Inline style attributes and SVG colour attributes carrying literal colours.
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

function checkAssets(html: string, s: Structure, facts: BuildFacts): CheckResult {
  const id = 'assets_exist' as const
  const label = 'Referenced assets exist'
  const allowed = new Set<string>(facts.photoPaths.map((p) => p.path))
  if (facts.logoPath) allowed.add(facts.logoPath)

  const referenced = new Set<string>()
  const add = (raw: string) => {
    const value = raw.trim().split(/\s+/)[0] ?? ''
    if (!value) return
    if (/^(https?:|data:|tel:|mailto:|#|\/\/)/i.test(value)) return
    referenced.add(value.replace(/^\.\//, ''))
  }

  for (const img of s.imgs) add(img.src)
  for (const href of s.linkHrefs) add(href)
  for (const src of s.scriptSrcs) add(src)
  for (const m of html.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) add(m[1] ?? '')
  for (const m of html.matchAll(/srcset\s*=\s*"([^"]+)"/gi)) {
    for (const part of (m[1] ?? '').split(',')) add(part)
  }

  const missing = [...referenced].filter((r) => !allowed.has(r))
  return missing.length === 0
    ? pass(id, label)
    : fail(
        id,
        label,
        `${missing.length} referenced file(s) do not exist. The only files that will ship are: ${[...allowed].join(', ') || 'none'}.`,
        missing,
      )
}

/**
 * Extra check beyond the brief's list, cheap and worth it: the FAQ copy on the page must match
 * the FAQPage schema word for word (brief s5, SEO baseline). Reported as part of jsonld_valid
 * evidence rather than as a separate check id so the numbered list of 16 stays the numbered
 * list of 16.
 */
function faqMismatchEvidence(html: string, s: Structure): string[] {
  const evidence: string[] = []
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
      const text = html.replace(/\s+/g, ' ')
      for (const q of questions) {
        const name = String(q.name ?? '')
        const answer = String(
          (q.acceptedAnswer as Record<string, unknown> | undefined)?.text ?? '',
        )
        if (name && !text.includes(name.replace(/\s+/g, ' '))) {
          evidence.push(`FAQ question in schema but not in page copy: "${name}"`)
        }
        if (answer && !text.includes(answer.replace(/\s+/g, ' ').slice(0, 60))) {
          evidence.push(`FAQ answer in schema does not match page copy: "${answer.slice(0, 60)}"`)
        }
      }
    }
  }
  return evidence
}

export async function runStaticChecks(html: string, facts: BuildFacts): Promise<CheckResult[]> {
  const s = await parse(html)

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
  ]

  // Fold the FAQ copy comparison into the JSON-LD check when the JSON itself was fine.
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
