/**
 * How much of a service page is actually about that service?
 *
 *   node scripts/audit-rendered-pages.mjs <jobId> [version]
 *
 * audit-service-pages.mjs measures the copy the model wrote. This measures what a visitor actually
 * reads, which is a different and harsher question: the template surrounds that copy with sections
 * built from SHARED plan fields, and those render byte-identical on every service page. The
 * process steps, the FAQ, the trust strip, the service-area blurb and the footer are the same words
 * on all of them.
 *
 * So a customer opening all ten sees more repetition than the plan-level numbers suggest, and a
 * search engine comparing the ten sees a large common block around a small distinct core. This
 * reports that split: per page, how much of its visible text is unique to it, and how much appears
 * verbatim on every other service page.
 *
 * It reads the rendered pages straight off the blob store rather than through the database. The
 * pages are what is under test and the database only points at them, so going direct also means
 * this runs while the dev server holds the pglite lock.
 */
import { readFile } from 'node:fs/promises'
import { readdirSync, statSync } from 'node:fs'

const [, , jobId, versionArg] = process.argv
if (!jobId) {
  console.error('usage: node scripts/audit-rendered-pages.mjs <jobId> [version]')
  process.exit(1)
}

const ROOT = `.local/blob/jobs/${jobId}/builds`
let versions
try {
  versions = readdirSync(ROOT)
    .filter((d) => /^v\d+$/.test(d))
    .sort((x, y) => Number(y.slice(1)) - Number(x.slice(1)))
} catch {
  console.error(`No builds on disk for ${jobId}.`)
  process.exit(1)
}
if (versions.length === 0) {
  console.error(`No builds on disk for ${jobId}.`)
  process.exit(1)
}
const version = versionArg ? Number(versionArg) : Number(versions[0].slice(1))
const base = `${ROOT}/v${version}`

const walk = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const full = `${dir}/${n}`
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.html') ? [full] : []
  })

const pages = walk(base).map((full) => {
  const rel = full.slice(base.length + 1)
  const m = rel.match(/^services\/([^/]+)\/index\.html$/)
  return { path: rel, file: full, serviceSlug: m ? m[1] : null }
})

const html = new Map()
for (const p of pages) html.set(p.path, await readFile(p.file, 'utf8'))

/** Visible text: strip head, script, style and tags, collapse whitespace. */
const visible = (h) =>
  h
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Sentence-ish units, so "shared" means a shared phrase rather than a shared word. */
const units = (t) =>
  t
    .split(/(?<=[.!?])\s+|\s{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12)

const service = pages.filter((p) => p.serviceSlug)
const home = pages.find((p) => !p.serviceSlug)

if (service.length === 0) {
  console.log('Single page build, nothing to compare.')
  process.exit(0)
}

const unitsBy = new Map()
for (const p of service) unitsBy.set(p.path, new Set(units(visible(html.get(p.path) ?? ''))))

const count = new Map()
for (const set of unitsBy.values()) for (const u of set) count.set(u, (count.get(u) ?? 0) + 1)

const n = service.length
const pad = (s, w) => String(s).padEnd(w)

console.log(`\n${'='.repeat(78)}`)
console.log(`RENDERED PAGE AUDIT   ${jobId}  v${version}   ${pages.length} pages (${n} service)`)
console.log('='.repeat(78))

console.log(`\nWhat a visitor reads on each service page:\n`)
console.log(`  ${pad('page', 24)}${pad('phrases', 9)}${pad('unique', 8)}${pad('on all ' + n, 10)}unique %`)
let totUniq = 0
let totAll = 0
for (const p of service) {
  const set = unitsBy.get(p.path)
  const uniq = [...set].filter((u) => count.get(u) === 1).length
  const shared = [...set].filter((u) => count.get(u) === n).length
  totUniq += uniq
  totAll += set.size
  console.log(
    `  ${pad(p.serviceSlug, 24)}${pad(set.size, 9)}${pad(uniq, 8)}${pad(shared, 10)}${((uniq / set.size) * 100).toFixed(0)}%`,
  )
}
console.log(
  `\n  across all service pages: ${((totUniq / totAll) * 100).toFixed(1)}% of visible phrases are unique to their page`,
)

// The block every service page shares, in full, so the size of the repetition is visible.
const everywhere = [...count.entries()].filter(([, c]) => c === n).map(([u]) => u)
const sharedChars = everywhere.join(' ').length
const meanChars = service.reduce((a, p) => a + visible(html.get(p.path) ?? '').length, 0) / n
console.log(
  `  identical block: ${everywhere.length} phrases, ${sharedChars} chars of a ${Math.round(meanChars)} char page (${((sharedChars / meanChars) * 100).toFixed(0)}%)`,
)

console.log(`\nThe text that is the same on all ${n} service pages:`)
for (const u of everywhere.slice(0, 45)) console.log(`  | ${u.slice(0, 74)}${u.length > 74 ? '...' : ''}`)
if (everywhere.length > 45) console.log(`  | ... and ${everywhere.length - 45} more`)

if (home) {
  const homeUnits = new Set(units(visible(html.get(home.path) ?? '')))
  const alsoOnHome = everywhere.filter((u) => homeUnits.has(u)).length
  console.log(
    `\n  of those, ${alsoOnHome} also appear on the home page (so they repeat across all ${pages.length} pages)`,
  )
}

/*
 * The headings, which is what a customer scanning ten tabs actually notices. The template builds
 * three of them from the service name, so they are distinct strings assembled from one sentence.
 * Printing them together makes that visible rather than leaving it as an assertion.
 */
console.log(`\nHEADINGS, page by page:`)
for (const p of service) {
  const h = html.get(p.path) ?? ''
  const hs = [...h.matchAll(/<h([12])[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) =>
    m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
  )
  console.log(`  ${p.serviceSlug}`)
  for (const t of hs) console.log(`      ${t}`)
}

console.log(`\n${'='.repeat(78)}\n`)
process.exit(0)
