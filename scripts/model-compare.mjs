/**
 * Compare two model runs of the same job, side by side.
 *
 *   node scripts/model-compare.mjs <jobId> <versionA> <versionB>
 *
 * The two versions must have been built from the same intake and the same photos, differing only
 * in ANTHROPIC_MODEL, or the comparison is measuring the wrong thing.
 *
 * Writes both documents to compare/ so they can be opened side by side, and prints what each one
 * cost and how long it took from the event log — the numbers the meter recorded rather than an
 * estimate made afterwards.
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'https://go-polar-builder.vercel.app'
const [jobId, versionA, versionB] = process.argv.slice(2)
const SESSION = process.env.SESSION ?? ''
const ADMIN = process.env.ADMIN_TOKEN ?? ''

if (!jobId || !versionA || !versionB) {
  console.error('usage: node scripts/model-compare.mjs <jobId> <versionA> <versionB>')
  process.exit(1)
}

const money = (n) => (n === undefined || n === null ? '—' : `$${Number(n).toFixed(4)}`)
const thousands = (n) => (n === undefined || n === null ? '—' : Number(n).toLocaleString('en-AU'))

async function html(version) {
  const res = await fetch(`${BASE}/api/jobs/${jobId}/builds/${version}/html`, {
    headers: { authorization: `Bearer ${SESSION}` },
  })
  if (!res.ok) throw new Error(`version ${version}: HTTP ${res.status}`)
  return res.text()
}

/** The generation.completed event for a version, which is where the meter wrote its numbers. */
async function spend(version) {
  const res = await fetch(`${BASE}/api/admin/events?limit=200`, {
    headers: { 'x-admin-token': ADMIN },
  })
  if (!res.ok) return null
  const body = await res.json()
  const events = body.events ?? body ?? []
  for (const event of events) {
    if (event.type !== 'generation.completed') continue
    const payload = event.payload ?? {}
    if (Number(payload.version) === Number(version) && event.jobId === jobId) return payload
  }
  return null
}

mkdirSync('compare', { recursive: true })

const rows = []
for (const version of [versionA, versionB]) {
  const doc = await html(version)
  const usage = await spend(version)
  const file = `compare/v${version}-${usage?.model ?? 'unknown'}.html`
  writeFileSync(file, doc)
  rows.push({ version, file, bytes: doc.length, usage })
}

console.log('')
for (const row of rows) {
  const u = row.usage ?? {}
  console.log(`version ${row.version}  ${u.model ?? '(model not recorded)'}`)
  console.log(`  file            ${row.file}`)
  console.log(`  html            ${thousands(row.bytes)} bytes`)
  console.log(`  input tokens    ${thousands(u.inputTokens)}`)
  console.log(`  output tokens   ${thousands(u.outputTokens)}`)
  console.log(`  cache read      ${thousands(u.cacheReadTokens)}`)
  console.log(`  api calls       ${u.calls ?? '—'}`)
  console.log(`  repair passes   ${u.repairPasses ?? '—'}`)
  console.log(`  passed checks   ${u.passed ?? '—'}`)
  console.log(`  estimated cost  ${money(u.estimatedCostUsd)}`)
  console.log('')
}

const [a, b] = rows
if (a?.usage?.estimatedCostUsd && b?.usage?.estimatedCostUsd) {
  const ratio = b.usage.estimatedCostUsd / a.usage.estimatedCostUsd
  console.log(`${b.usage.model} costs ${ratio.toFixed(2)}x ${a.usage.model} on this job.`)
}
console.log('Open both files in a browser and judge them side by side. Cost is not the only axis.')
