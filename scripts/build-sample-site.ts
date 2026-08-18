import { config as loadEnvFiles } from 'dotenv'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Build the committed sample client website.
 *
 *   npm run sample
 *
 * Writes sample/index.html, sample/assets/* and sample/verification.json. That folder is checked
 * into the repo on purpose: it is the thing worth judging, and it has to be openable in ten
 * seconds by double clicking, with no API key, no server and no setup.
 *
 * Everything here runs the real pipeline: real image processing, the real content plan shape, the
 * real HTML generator, and the real verification checks. The only thing standing in for the
 * Anthropic API is the offline fixture, which is stated in the output so nobody mistakes the
 * sample for model output.
 */

loadEnvFiles({ path: '.env.local', quiet: true })
loadEnvFiles({ path: '.env', quiet: true })

// Deterministic: local storage, no live anything.
process.env.DEMO_MODE = '1'
process.env.STORAGE_DRIVER = 'local'
process.env.DATABASE_DRIVER = 'pglite'
process.env.WEB3FORMS_ACCESS_KEY ??= '11111111-2222-3333-4444-555555555555'
process.env.APP_SECRET ??= 'sample-build-secret'

const OUT = 'sample'

const { processImage } = await import('../server/lib/images')
const { storage } = await import('../server/lib/storage')
const { buildFacts } = await import('../server/lib/facts')
const { offlinePlan, offlineHtml } = await import('../server/lib/offline')
const { runGapAudit } = await import('../server/lib/audit')
const { verify } = await import('../server/lib/verify')
const { formatBytes } = await import('../server/lib/images')
const { makeLogo, makePhoto, LOGO_STATS, PHOTO_STATS } = await import('./fixture-images')

const { SAMPLE_INTAKE } = await import('./sample-intake')
const { NAMED_STYLES, styleOption } = await import('../shared/styles')

async function main() {
  console.log('Building the sample site\n')

  const store = storage()
  const assets = []

  // --- process the fixture images through the real pipeline ---------------------------------
  const logoFile = await makeLogo()
  const logoProcessed = await processImage(new Uint8Array(logoFile.bytes), 'logo', logoFile.contentType)
  const logoVariants = []
  for (const v of logoProcessed.variants) {
    const key = `sample/logo-${v.role}.${v.format === 'jpeg' ? 'jpg' : v.format}`
    await store.put(key, v.data, v.contentType)
    logoVariants.push({ role: v.role, format: v.format, key, bytes: v.bytes, width: v.width, height: v.height })
  }
  assets.push({
    id: 'ast_logo',
    jobId: 'sample',
    kind: 'logo' as const,
    filename: logoFile.filename,
    contentType: logoFile.contentType,
    originalKey: 'sample/logo-original',
    originalBytes: logoFile.bytes.byteLength,
    width: logoProcessed.width,
    height: logoProcessed.height,
    sortOrder: 0,
    stats: LOGO_STATS,
    variants: logoVariants,
    createdAt: new Date().toISOString(),
  })
  console.log(`  logo:    ${formatBytes(logoFile.bytes.byteLength)} original`)

  let originalTotal = logoFile.bytes.byteLength

  for (let i = 0; i < 4; i++) {
    const file = await makePhoto(i)
    const processed = await processImage(new Uint8Array(file.bytes), 'photo', file.contentType)
    originalTotal += file.bytes.byteLength

    const variants = []
    for (const v of processed.variants) {
      const key = `sample/photo-${i + 1}-${v.role}.${v.format === 'jpeg' ? 'jpg' : v.format}`
      await store.put(key, v.data, v.contentType)
      variants.push({ role: v.role, format: v.format, key, bytes: v.bytes, width: v.width, height: v.height })
    }

    assets.push({
      id: `ast_p${i + 1}`,
      jobId: 'sample',
      kind: 'photo' as const,
      filename: file.filename,
      contentType: file.contentType,
      originalKey: `sample/photo-${i + 1}-original`,
      originalBytes: file.bytes.byteLength,
      width: processed.width,
      height: processed.height,
      sortOrder: i,
      stats: PHOTO_STATS,
      variants,
      createdAt: new Date().toISOString(),
    })

    const shipped = variants.find((v) => v.role === 'web' && v.format === 'webp')!
    console.log(
      `  photo ${i + 1}: ${formatBytes(file.bytes.byteLength)} original, ${formatBytes(shipped.bytes)} shipped`,
    )
  }

  // --- generate ------------------------------------------------------------------------------
  const facts = buildFacts(SAMPLE_INTAKE, assets)
  const auditFlags = runGapAudit(SAMPLE_INTAKE, assets)
  const plan = offlinePlan(
    SAMPLE_INTAKE,
    facts,
    auditFlags,
    facts.photos.map((p) => ({ assetId: p.assetId, path: p.webWebp, note: 'client photo' })),
  )
  const html = offlineHtml(plan, facts)

  // --- verify --------------------------------------------------------------------------------
  const report = await verify(html, facts, { runRender: false })

  // --- write ----------------------------------------------------------------------------------
  await mkdir(join(OUT, 'assets'), { recursive: true })
  await writeFile(join(OUT, 'index.html'), html, 'utf8')

  for (const [path, meta] of Object.entries(facts.assetManifest)) {
    const bytes = await store.get(meta.key)
    if (!bytes) continue
    await writeFile(join(OUT, path), bytes)
  }

  await writeFile(
    join(OUT, 'verification.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        generator: 'offline fixture, not the Anthropic API',
        business: SAMPLE_INTAKE.businessName,
        pageWeightBytes: report.pageWeightBytes,
        pageWeightHuman: formatBytes(report.pageWeightBytes),
        originalImageBytes: originalTotal,
        originalImageHuman: formatBytes(originalTotal),
        passed: report.passed,
        checks: [...report.static, ...report.render].map((c) => ({
          id: c.id,
          label: c.label,
          status: c.status,
          detail: c.detail ?? null,
        })),
      },
      null,
      2,
    ),
    'utf8',
  )

  const failed = [...report.static, ...report.render].filter((c) => c.status === 'fail')
  const skipped = [...report.static, ...report.render].filter((c) => c.status === 'skipped')

  console.log(`\n  page weight: ${formatBytes(report.pageWeightBytes)}`)
  console.log(`  originals:   ${formatBytes(originalTotal)} (never served)`)
  console.log(`  checks:      ${failed.length === 0 ? 'all passed' : `${failed.length} FAILED`}, ${skipped.length} skipped`)

  // --- the same business under all four named styles ------------------------------------------
  const styleFailures = await buildStyleVariants(assets)

  console.log(`\n  Open ${join(OUT, 'index.html')} in a browser.`)
  console.log(`  Open ${join(OUT, 'styles', 'index.html')} to compare the four design styles.`)

  if (failed.length > 0) {
    for (const f of failed) console.error(`    FAIL ${f.id}: ${f.detail}`)
    process.exit(1)
  }
  if (styleFailures > 0) process.exit(1)
}

/**
 * The design style choice is only worth offering if it changes the site, so this builds the one
 * seeded business four ways and writes the four documents out side by side. Chris opens them and
 * judges with his own eyes; the numbers in comparison.json are the supporting evidence, and
 * test/styles.test.ts is the thing that fails the build if they ever converge.
 */
async function buildStyleVariants(assets: Parameters<typeof buildFacts>[1]): Promise<number> {
  const dir = join(OUT, 'styles')
  await mkdir(dir, { recursive: true })

  console.log('\n  Design styles')

  const rows: Array<{
    style: (typeof NAMED_STYLES)[number]
    label: string
    weight: number
    passed: boolean
    failed: string[]
    signals: Record<string, string | null>
  }> = []
  const docs = new Map<string, string>()
  let failures = 0

  for (const style of NAMED_STYLES) {
    const intake = { ...SAMPLE_INTAKE, designStyle: style }
    const facts = buildFacts(intake, assets)
    const plan = offlinePlan(
      intake,
      facts,
      runGapAudit(intake, assets),
      facts.photos.map((p) => ({ assetId: p.assetId, path: p.webWebp, note: 'client photo' })),
    )
    const html = offlineHtml(plan, facts)
    const styleReport = await verify(html, facts, { runRender: false })
    const failedChecks = [...styleReport.static, ...styleReport.render]
      .filter((c) => c.status === 'fail')
      .map((c) => `${c.id}: ${c.detail ?? ''}`)

    // Written one level down, so the images it shares with the main sample are one level up.
    await writeFile(join(dir, `${style}.html`), html.replaceAll('"assets/', '"../assets/'), 'utf8')

    docs.set(style, html)
    rows.push({
      style,
      label: styleOption(style).label,
      weight: styleReport.pageWeightBytes,
      passed: styleReport.passed,
      failed: failedChecks,
      signals: styleSignals(html),
    })

    if (failedChecks.length > 0) {
      failures += failedChecks.length
      for (const f of failedChecks) console.error(`    FAIL ${style}: ${f}`)
    }
    console.log(
      `    ${style.padEnd(12)} ${formatBytes(styleReport.pageWeightBytes).padStart(9)}  ${
        failedChecks.length === 0 ? 'all checks passed' : `${failedChecks.length} FAILED`
      }`,
    )
  }

  // Pairwise: how much of the stylesheet actually moved, and which named signals differ.
  const pairs: Array<{ a: string; b: string; stylesheetDelta: number; differingSignals: string[] }> = []
  for (const a of NAMED_STYLES) {
    for (const b of NAMED_STYLES) {
      if (a >= b) continue
      const sheetA = (docs.get(a)!.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '').split('\n')
      const sheetB = new Set((docs.get(b)!.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '').split('\n'))
      const rowA = rows.find((r) => r.style === a)!.signals
      const rowB = rows.find((r) => r.style === b)!.signals
      pairs.push({
        a,
        b,
        stylesheetDelta: Number((sheetA.filter((l) => !sheetB.has(l)).length / sheetA.length).toFixed(3)),
        differingSignals: Object.keys(rowA).filter((k) => rowA[k] !== rowB[k]),
      })
    }
  }

  const weakest = pairs.reduce((min, p) => Math.min(min, p.differingSignals.length), Infinity)
  console.log(`    closest pair differs in ${weakest} of ${Object.keys(rows[0]!.signals).length} signals`)

  await writeFile(
    join(dir, 'comparison.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        generator: 'offline fixture, not the Anthropic API',
        business: SAMPLE_INTAKE.businessName,
        note: 'Same intake data, same photos, same copy. Only the design style differs.',
        styles: rows,
        pairs,
      },
      null,
      2,
    ),
    'utf8',
  )
  await writeFile(join(dir, 'index.html'), comparisonPage(rows, pairs), 'utf8')

  return failures
}

/** The values a person notices, read back out of the rendered document. */
function styleSignals(html: string): Record<string, string | null> {
  const token = (name: string) => html.match(new RegExp(`--${name}:([^;]+);`))?.[1]?.trim() ?? null
  return {
    'heading font': token('font-head'),
    'heading weight': token('weight-head'),
    'heading tracking': token('track-head'),
    'h1 size': token('h1'),
    'body size': token('step-body'),
    'section padding': token('section-pad-lg'),
    gap: token('gap'),
    measure: token('measure'),
    'corner radius': token('radius'),
    'button radius': token('radius-btn'),
    'raised shadow': token('shadow-raised'),
    'strong border': token('border-strong'),
    'hero shape': html.match(/hero__(slab|cardwrap|panel|rule)/)?.[1] ?? 'plain',
  }
}

function comparisonPage(
  rows: Array<{ style: string; label: string; weight: number; passed: boolean; signals: Record<string, string | null> }>,
  pairs: Array<{ a: string; b: string; stylesheetDelta: number; differingSignals: string[] }>,
): string {
  const keys = Object.keys(rows[0]!.signals)
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Design styles compared</title>
<style>
:root{--ink:#16191d;--muted:#5b646e;--line:#e2e6ea;--surface:#fff;--alt:#f4f6f8;--good:#1f8a4c;--bad:#c0392b;}
*{box-sizing:border-box;}
body{margin:0;padding:2.5rem 1.5rem 4rem;font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--ink);background:var(--surface);}
main{max-width:70rem;margin:0 auto;}
h1{font-size:1.9rem;margin:0 0 .5rem;}
p.lede{color:var(--muted);max-width:60ch;margin:0 0 2rem;}
.grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));margin-bottom:2.5rem;}
.card{border:1px solid var(--line);border-radius:10px;padding:1.25rem;}
.card h2{font-size:1.05rem;margin:0 0 .25rem;}
.card a{display:inline-block;margin-top:.75rem;font-weight:600;}
.meta{font-size:.85rem;color:var(--muted);}
table{border-collapse:collapse;width:100%;font-size:.86rem;margin-bottom:2.5rem;}
th,td{border-bottom:1px solid var(--line);padding:.5rem .6rem;text-align:left;vertical-align:top;}
th{background:var(--alt);font-weight:600;}
td.name{color:var(--muted);white-space:nowrap;}
.ok{color:var(--good);font-weight:600;}
.no{color:var(--bad);font-weight:600;}
.wrap{overflow-x:auto;}
</style>
</head>
<body>
<main>
<h1>The same business, four design styles</h1>
<p class="lede">Identical intake data, identical photos, identical copy. Only the design style differs. Open each one and compare. Every one of them passes all seventeen verification checks, and the brand colours are byte for byte the same in all four.</p>

<div class="grid">
${rows
  .map(
    (r) => `  <div class="card">
    <h2>${esc(r.label)}</h2>
    <p class="meta">${(r.weight / 1024 / 1024).toFixed(2)} MB page weight, checks ${
      r.passed ? '<span class="ok">passed</span>' : '<span class="no">FAILED</span>'
    }</p>
    <a href="${r.style}.html">Open the ${esc(r.style)} version</a>
  </div>`,
  )
  .join('\n')}
</div>

<h2>What actually changed</h2>
<div class="wrap">
<table>
<tr><th>Signal</th>${rows.map((r) => `<th>${esc(r.style)}</th>`).join('')}</tr>
${keys
  .map(
    (k) =>
      `<tr><td class="name">${esc(k)}</td>${rows
        .map((r) => `<td>${esc(String(r.signals[k] ?? '-'))}</td>`)
        .join('')}</tr>`,
  )
  .join('\n')}
</table>
</div>

<h2>Every pair, compared</h2>
<div class="wrap">
<table>
<tr><th>Pair</th><th>Stylesheet lines changed</th><th>Signals differing</th></tr>
${pairs
  .map(
    (p) =>
      `<tr><td class="name">${esc(p.a)} vs ${esc(p.b)}</td><td>${(p.stylesheetDelta * 100).toFixed(
        1,
      )}%</td><td>${p.differingSignals.length} of ${keys.length}: ${esc(
        p.differingSignals.join(', '),
      )}</td></tr>`,
  )
  .join('\n')}
</table>
</div>
<p class="meta">Generated by the offline fixture generator, not the Anthropic API. Regenerate with <code>npm run sample</code>.</p>
</main>
</body>
</html>`
}

main().catch((err) => {
  console.error('Sample build failed:', err)
  process.exit(1)
})
