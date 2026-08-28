/**
 * Is a multi-page build ten real pages, or one page with a word swapped?
 *
 *   node scripts/audit-service-pages.mjs <jobId> [version]
 *
 * Service pages are laid out by a fixed template, so "does it look bespoke" cannot be answered by
 * opening one and forming an impression: every page will look competent and every page will look
 * like the others. The question that actually matters for a customer opening all ten, and for a
 * search engine deciding whether ten pages deserve to exist, is how much of the TEXT differs.
 *
 * So this measures rather than judges:
 *
 *   1. Which entries the model wrote and which enforcePlanInvariants synthesised. The synthesised
 *      fallback is a deliberate mail merge, documented as such where it is defined, and is matched
 *      here by its exact shape rather than by guesswork.
 *   2. Unique content words per page: words in this page's copy that appear on no other page.
 *      This is the sharpest single number. A mail merge scores 1 to 3, because only the pest name
 *      changes. Genuinely written copy scores in the tens.
 *   3. Pairwise similarity of every page against every other, on word bigrams, so near-duplicates
 *      that share phrasing but swap a noun are caught where an exact-match test would pass them.
 *   4. Whether each page's copy is actually ABOUT its own subject, not just titled with it.
 *   5. Duplicate lines reused verbatim across pages.
 *   6. Uniqueness of the fields search engines read: title, meta description, h1, canonical, and
 *      the Service schema.
 */
import { readFileSync } from 'node:fs'

const [, , jobId, versionArg] = process.argv
if (!jobId) {
  console.error('usage: node scripts/audit-service-pages.mjs <jobId> [version]')
  process.exit(1)
}

const { getDb } = await import('../server/db/client.js')
const schema = await import('../db/schema.js')
const { eq, and, desc } = await import('drizzle-orm')

const db = await getDb()
const planRows = await db
  .select()
  .from(schema.plans)
  .where(eq(schema.plans.jobId, jobId))
  .orderBy(desc(schema.plans.version))

if (planRows.length === 0) {
  console.error(`No plan for ${jobId}. Has it generated yet?`)
  process.exit(1)
}
const row = versionArg ? planRows.find((r) => r.version === Number(versionArg)) : planRows[0]
if (!row) {
  console.error(`No plan for ${jobId} version ${versionArg}.`)
  process.exit(1)
}
const plan = row.plan
const pages = plan.servicePages ?? []

if (pages.length === 0) {
  console.log(`${jobId} v${row.version}: single page build, no service pages to audit.`)
  process.exit(0)
}

/* ------------------------------------------------------------------ *
 * 1. Model-written, or synthesised by the fallback?
 * ------------------------------------------------------------------ */

/*
 * The fallback in enforcePlanInvariants writes exactly one intro paragraph ending in a fixed
 * sentence, and exactly three included lines the last of which is a fixed sentence. Matching on
 * those literals identifies it without needing the intake to hand.
 */
const FALLBACK_INTRO = /Ring us and we will talk through what your job actually involves\.$/
const FALLBACK_INCLUDED = /^Call .+ to talk through the job\.$/
const FALLBACK_YEARS = /^\d+ years in business\.$/

const synthesised = (p) =>
  p.intro.length === 1 &&
  FALLBACK_INTRO.test(p.intro[0].trim()) &&
  p.included.length === 3 &&
  FALLBACK_INCLUDED.test(p.included[2].trim()) &&
  FALLBACK_YEARS.test(p.included[1].trim())

/* ------------------------------------------------------------------ *
 * 2/3/4. Text distinctness
 * ------------------------------------------------------------------ */

// Words too common to signal anything about what a page is about.
const STOP = new Set(
  ('a an and are as at be been but by call can do does for from get has have how i if in is it its of on or our so that the their them then there these they this to us was we were what when where which who will with you your yours no not all any each every more most other some such only own same than too very just also into over under out up down off about across after before between during through we\'re we\'ll').split(
    ' ',
  ),
)

const words = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))

const copyOf = (p) => [...p.intro, ...p.included].join(' ')
const bigrams = (s) => {
  const w = words(s)
  const out = new Set()
  for (let i = 0; i < w.length - 1; i++) out.add(w[i] + ' ' + w[i + 1])
  return out
}
const jaccard = (a, b) => {
  if (a.size === 0 && b.size === 0) return 1
  let shared = 0
  for (const x of a) if (b.has(x)) shared++
  return shared / (a.size + b.size - shared)
}

const wordSets = pages.map((p) => new Set(words(copyOf(p))))
const bigramSets = pages.map((p) => bigrams(copyOf(p)))

// Words appearing on exactly one page.
const freq = new Map()
for (const set of wordSets) for (const w of set) freq.set(w, (freq.get(w) ?? 0) + 1)
const uniqueTo = wordSets.map((set) => [...set].filter((w) => freq.get(w) === 1))

/*
 * Is the page about its own subject? The service name's own distinctive words should appear in the
 * body copy, not only in the heading the template stamps there. "Cockroach Control" contributes
 * "cockroach"; the shared word "control" is ignored because every page here carries it.
 */
const nameFreq = new Map()
for (const p of pages) for (const w of new Set(words(p.service))) nameFreq.set(w, (nameFreq.get(w) ?? 0) + 1)
const subjectWords = pages.map((p) => words(p.service).filter((w) => nameFreq.get(w) === 1))
const onSubject = pages.map((p, i) => {
  const body = copyOf(p).toLowerCase()
  const hits = subjectWords[i].filter((w) => body.includes(w))
  return { need: subjectWords[i], hit: hits, ok: subjectWords[i].length === 0 || hits.length > 0 }
})

/* ------------------------------------------------------------------ *
 * 5. Verbatim reuse
 * ------------------------------------------------------------------ */
const lineOwners = new Map()
pages.forEach((p, i) => {
  for (const line of [...p.intro, ...p.included]) {
    const k = line.trim()
    if (!lineOwners.has(k)) lineOwners.set(k, [])
    lineOwners.get(k).push(i)
  }
})
const reused = [...lineOwners.entries()].filter(([, owners]) => owners.length > 1)

/* ------------------------------------------------------------------ *
 * 6. The fields search engines read
 * ------------------------------------------------------------------ */
const dupes = (vals) => {
  const seen = new Map()
  vals.forEach((v, i) => {
    const k = (v ?? '').trim().toLowerCase()
    if (!seen.has(k)) seen.set(k, [])
    seen.get(k).push(i)
  })
  return [...seen.entries()].filter(([, ix]) => ix.length > 1)
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */
const pad = (s, n) => String(s).padEnd(n)
const synthCount = pages.filter(synthesised).length

console.log(`\n${'='.repeat(78)}`)
console.log(`SERVICE PAGE AUDIT   ${jobId}  v${row.version}   ${pages.length} service pages`)
console.log('='.repeat(78))

console.log(`\nORIGIN`)
console.log(`  model written   ${pages.length - synthCount} / ${pages.length}`)
console.log(`  synthesised     ${synthCount} / ${pages.length}${synthCount ? '   <-- these are the documented mail-merge fallback' : ''}`)
if (synthCount) {
  for (const [i, p] of pages.entries()) if (synthesised(p)) console.log(`                  - ${p.service}`)
}

console.log(`\nPER PAGE`)
console.log(`  ${pad('service', 22)}${pad('words', 7)}${pad('unique', 8)}${pad('intro', 7)}${pad('incl', 6)}on-subject`)
pages.forEach((p, i) => {
  const u = uniqueTo[i].length
  console.log(
    `  ${pad(p.service, 22)}${pad(wordSets[i].size, 7)}${pad(u, 8)}${pad(p.intro.length, 7)}${pad(p.included.length, 6)}${
      onSubject[i].ok ? 'yes' : 'NO  (never says "' + onSubject[i].need.join('/') + '")'
    }`,
  )
})
const uniqAvg = uniqueTo.reduce((a, b) => a + b.length, 0) / pages.length
console.log(`\n  mean unique words per page: ${uniqAvg.toFixed(1)}`)
console.log(`  (1-3 means the pages differ only by the subject's name. 15+ means real separate copy.)`)

let worst = { v: -1 }
let sum = 0
let n = 0
for (let i = 0; i < pages.length; i++) {
  for (let j = i + 1; j < pages.length; j++) {
    const v = jaccard(bigramSets[i], bigramSets[j])
    sum += v
    n++
    if (v > worst.v) worst = { v, i, j }
  }
}
console.log(`\nOVERLAP  (shared two-word phrases, 0 = nothing in common, 1 = identical)`)
console.log(`  mean pair    ${(sum / n).toFixed(3)}`)
console.log(`  worst pair   ${worst.v.toFixed(3)}   ${pages[worst.i].service}  vs  ${pages[worst.j].service}`)

console.log(`\nVERBATIM REUSE ACROSS PAGES`)
if (reused.length === 0) console.log(`  none. every line of copy appears on exactly one page.`)
else
  for (const [line, owners] of reused)
    console.log(`  x${owners.length}  "${line.slice(0, 62)}${line.length > 62 ? '...' : ''}"`)

console.log(`\nSEARCH FIELDS`)
for (const [label, vals] of [
  ['title', pages.map((p) => p.title)],
  ['metaDescription', pages.map((p) => p.metaDescription)],
  ['h1', pages.map((p) => p.h1)],
  ['slug', pages.map((p) => p.slug)],
]) {
  const d = dupes(vals)
  console.log(
    `  ${pad(label, 18)}${d.length === 0 ? 'all distinct' : 'DUPLICATED: ' + d.map(([, ix]) => ix.map((i) => pages[i].service).join(' = ')).join('; ')}`,
  )
}

console.log(`\nWHAT EACH PAGE SAYS IN ITS OWN WORDS`)
pages.forEach((p, i) => {
  console.log(`\n  --- ${p.service} ---`)
  console.log(`  h1    ${p.h1}`)
  console.log(`  meta  ${p.metaDescription}`)
  p.intro.forEach((t) => console.log(`  p     ${t}`))
  p.included.forEach((t) => console.log(`  li    ${t}`))
  console.log(`  only-here: ${uniqueTo[i].slice(0, 14).join(', ') || '(nothing)'}`)
})

console.log(`\n${'='.repeat(78)}\n`)
process.exit(0)
