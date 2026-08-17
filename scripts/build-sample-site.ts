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
  console.log(`\n  Open ${join(OUT, 'index.html')} in a browser.`)

  if (failed.length > 0) {
    for (const f of failed) console.error(`    FAIL ${f.id}: ${f.detail}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Sample build failed:', err)
  process.exit(1)
})
