import { config as loadEnvFiles } from 'dotenv'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Build the four style demos the customer previews from the wizard.
 *
 *   npm run demos
 *
 * Writes public/demo/{style}.html plus one public/demo/assets folder the four of them share.
 *
 * THESE ARE THE REAL RENDERER, NOT MOCKUPS. Every demo goes through buildFacts, the offline
 * content plan and render/site.ts, which is the same code that builds a paying customer's site.
 * A hand-drawn demo would be easier and would be a lie: the customer would choose a look from a
 * picture the builder cannot actually produce, and find that out after paying. The four pass the
 * same static checks as a real build, and this script exits non-zero if any of them stops passing.
 *
 * The business is invented. See demo-intake.ts.
 */

loadEnvFiles({ path: '.env.local', quiet: true })
loadEnvFiles({ path: '.env', quiet: true })

process.env.DEMO_MODE = '1'
process.env.STORAGE_DRIVER = 'local'
process.env.DATABASE_DRIVER = 'pglite'
process.env.WEB3FORMS_ACCESS_KEY ??= '00000000-0000-0000-0000-000000000000'
process.env.APP_SECRET ??= 'demo-build-secret'

const OUT = join('public', 'demo')

const { buildFacts } = await import('../server/lib/facts')
const { offlinePlan, offlineHtml } = await import('../server/lib/offline')
const { runGapAudit } = await import('../server/lib/audit')
const { verify } = await import('../server/lib/verify')
const { sampleAssets } = await import('./sample-assets')
const { NAMED_STYLES, styleOption } = await import('../shared/styles')
const { DEMO_INTAKE } = await import('./demo-intake')

await mkdir(OUT, { recursive: true })

// The demos reuse the sample's processed photos rather than shipping a second set of images.
const assets = await sampleAssets('sample')

// One assets folder for all four, sitting where the generated markup already looks for it.
await mkdir(join(OUT, 'assets'), { recursive: true })
let copied = 0
for (const name of await readdir(join('sample', 'assets'))) {
  await copyFile(join('sample', 'assets', name), join(OUT, 'assets', name))
  copied += 1
}
console.log(`  ${copied} shared asset file(s) copied.`)

// Go Polar's own mark on the demos, over the fixture placeholder that came with the sample.
// Only the two files are swapped, not the asset record: both marks are square, and the header
// sizes the logo with max-height and width:auto, so nothing stretches.
const { processImage } = await import('../server/lib/images')
const logoSource = await readFile(join('public', 'favicon.png'))
const processedLogo = await processImage(new Uint8Array(logoSource), 'logo', 'image/png')
for (const v of processedLogo.variants) {
  if (v.format !== 'webp' && v.format !== 'png') continue
  await writeFile(join(OUT, 'assets', `logo.${v.format}`), v.data)
}
console.log(`  Go Polar mark in place, ${processedLogo.width}x${processedLogo.height}.\n`)

console.log('Building the four style demos from the real renderer.\n')

let failures = 0

/**
 * A palette per style, rather than one palette across all four.
 *
 * The first cut held Go Polar black and cyan constant so that shape was the only variable.
 * That flattened "warm and established" into cold navy, which is the opposite of what its own
 * blurb promises: cream and white under a deep header with gold detailing. A demo that
 * contradicts the label it sits under is worse than no demo.
 *
 * It is also the more honest preview. A real customer's palette is sampled from their logo, and
 * the style decides where those colours go. Holding hue constant showed something no customer
 * ever gets. The Go Polar mark stays on all four so they still read as a set.
 */
const DEMO_PALETTES: Record<(typeof NAMED_STYLES)[number], { primary: string; secondary: string; accent: string; dark: string; light: string; source: 'manual' }> = {
  // Plant and machinery: near black with the Go Polar cyan as the one cold accent.
  industrial: { primary: '#0a0a0a', secondary: '#1da7f5', accent: '#38b6ff', dark: '#070b12', light: '#f4f6f8', source: 'manual' },
  // Organised and current: a lighter blue ground, same cyan, plenty of white.
  modern: { primary: '#0f2a3d', secondary: '#4f7f9d', accent: '#38b6ff', dark: '#0c1f2e', light: '#f7fafc', source: 'manual' },
  // Settled and premium: deep navy header over cream, gold detailing. What the blurb says.
  established: { primary: '#12304f', secondary: '#5b7fa3', accent: '#c8a04a', dark: '#0d2239', light: '#f7f3ea', source: 'manual' },
  // Fast and easy to ring: navy with a hot accent and hard contrast.
  direct: { primary: '#0b2545', secondary: '#4a6fa5', accent: '#e8452c', dark: '#081a33', light: '#f5f7fa', source: 'manual' },
}

for (const style of NAMED_STYLES) {
  const intake = { ...DEMO_INTAKE, designStyle: style, palette: DEMO_PALETTES[style] }
  const facts = buildFacts(intake, assets)
  const plan = offlinePlan(
    intake,
    facts,
    runGapAudit(intake, assets),
    facts.photos.map((p) => ({ assetId: p.assetId, path: p.webWebp, note: 'demo photo' })),
  )

  const html = offlineHtml(plan, facts)

  // Same static checks a paying customer's build has to pass. A demo that would fail its own
  // verification is not a demo of this product.
  const report = await verify(html, facts, { runRender: false })
  const failed = [...report.static, ...report.render].filter((c) => c.status === 'fail')

  // NOT INLINED, AND THAT WAS A DELIBERATE REVERSAL. Inlining every image as a data URI made each
  // demo 3.9MB, so a customer flicking through all four on a phone pulled 15.7MB of mobile data to
  // look at four pictures. The four share one assets folder instead: the HTML is about 63KB, the
  // images are fetched once and then come from cache, so the second, third and fourth previews
  // cost almost nothing. images.ts already reasons about bandwidth this way for real sites and
  // there is no argument for the demos being the exception.
  const banner = demoBanner(styleOption(style).label)
  const withBanner = html.replace('<body>', `<body>${banner}`)

  await writeFile(join(OUT, `${style}.html`), withBanner, 'utf8')

  const kb = Math.round(Buffer.byteLength(withBanner) / 1024)
  console.log(
    `  ${style.padEnd(12)} ${String(kb).padStart(4)}KB  ${failed.length === 0 ? 'all checks passed' : `${failed.length} FAILED`}`,
  )
  for (const f of failed) console.error(`      ${f.id}: ${f.detail ?? ''}`)
  failures += failed.length
}

console.log(`\n  Written to ${OUT}. Open public/demo/modern.html to check one.`)

if (failures > 0) {
  console.error('\n  A demo failed its own verification. Not writing this off as cosmetic.')
  process.exit(1)
}

/**
 * A fixed strip saying this is a demo and the business is invented.
 *
 * WITHOUT THIS THE PAGE IS A FAKE BUSINESS ON A REAL DOMAIN. It has a phone number, an address, an
 * ABN and four testimonials, and none of it is true. The strip is not decoration and does not
 * scroll away: anybody who lands on it, including somebody sent the link out of context, is told
 * what they are looking at in the first line they read.
 */
function demoBanner(label: string): string {
  return `<div style="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#0a0a0a;color:#fff;font:600 13px/1.4 system-ui,sans-serif;padding:10px 14px;display:flex;gap:10px;align-items:center;justify-content:center;text-align:center;box-shadow:0 -2px 12px rgba(0,0,0,.35)">
<span style="color:#38b6ff">Example only</span>
<span style="font-weight:400;opacity:.85">&ldquo;${label}&rdquo; layout. Kirra Coast Electrical is not a real business and the reviews were written for this demo.</span>
</div>`
}
