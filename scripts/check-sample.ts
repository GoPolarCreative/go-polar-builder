import { config as loadEnvFiles } from 'dotenv'
import { readFile } from 'node:fs/promises'

/**
 * Run the FULL verification suite against the committed sample site, including checks 13 to 16,
 * which need a real browser.
 *
 *   npm run sample:verify
 *
 * Uses whichever Chrome or Edge is installed. If there is none, the render checks report skipped
 * with a reason and the static checks still run, which is the whole point of the driver
 * interface.
 */

loadEnvFiles({ path: '.env.local', quiet: true })
loadEnvFiles({ path: '.env', quiet: true })

process.env.DEMO_MODE = '1'
process.env.STORAGE_DRIVER = 'local'
process.env.WEB3FORMS_ACCESS_KEY ??= '11111111-2222-3333-4444-555555555555'
process.env.APP_SECRET ??= 'sample-build-secret'

const { buildFacts } = await import('../server/lib/facts')
const { verify } = await import('../server/lib/verify')
const { formatBytes } = await import('../server/lib/images')
const { createRenderDriver } = await import('../server/lib/checks/render')
const { SAMPLE_INTAKE } = await import('./sample-intake')
const { sampleAssets } = await import('./sample-assets')

const driver = createRenderDriver()
const availability = driver ? await driver.available() : { ok: false as const, reason: 'RENDER_DRIVER=none' }
console.log(`Render driver: ${driver?.name ?? 'none'} (${availability.ok ? 'available' : availability.reason})\n`)

const facts = buildFacts(SAMPLE_INTAKE, await sampleAssets())
const html = await readFile('sample/index.html', 'utf8')

const report = await verify(html, facts)

for (const check of [...report.static, ...report.render]) {
  const mark = check.status === 'pass' ? 'PASS' : check.status === 'fail' ? 'FAIL' : check.status.toUpperCase()
  console.log(`  ${mark.padEnd(5)} ${check.label}`)
  if (check.status !== 'pass' && check.detail) console.log(`        ${check.detail}`)
  for (const line of check.evidence ?? []) console.log(`        - ${line}`)
}

console.log(`\n  page weight: ${formatBytes(report.pageWeightBytes)}`)
console.log(`  overall: ${report.passed ? 'passed' : 'FAILED'}`)

// The same suite, in the same browser, for every design style. A style that produced a site which
// overflowed on a phone or broke its own accordions would be a style we should not be offering.
const { NAMED_STYLES } = await import('../shared/styles')
let styleFailures = 0

console.log('\nDesign styles, full suite each')
for (const style of NAMED_STYLES) {
  const styleFacts = buildFacts({ ...SAMPLE_INTAKE, designStyle: style }, await sampleAssets())
  // The committed variants live a folder down so they open by double clicking. Put the asset
  // paths back the way the manifest describes them before verifying.
  const styleHtml = (await readFile(`sample/styles/${style}.html`, 'utf8')).replaceAll(
    '"../assets/',
    '"assets/',
  )
  const styleReport = await verify(styleHtml, styleFacts)
  const bad = [...styleReport.static, ...styleReport.render].filter((c) => c.status === 'fail')
  const skipped = [...styleReport.static, ...styleReport.render].filter((c) => c.status === 'skipped')

  styleFailures += bad.length
  console.log(
    `  ${style.padEnd(12)} ${formatBytes(styleReport.pageWeightBytes).padStart(9)}  ${
      bad.length === 0 ? 'all checks passed' : `${bad.length} FAILED`
    }${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}`,
  )
  for (const c of bad) console.log(`        FAIL ${c.id}: ${c.detail ?? ''}`)
}

process.exit(report.passed && styleFailures === 0 ? 0 : 1)
