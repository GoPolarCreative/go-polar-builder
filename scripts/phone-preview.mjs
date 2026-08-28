/**
 * One self-contained HTML file per site, for sending to a phone.
 *
 *   node scripts/phone-preview.mjs
 *
 * The discharge package already builds a standalone copy of the home page with every image turned
 * into a data URI (PREVIEW.html, via inlineAssets). This reuses that file rather than inlining
 * anything again, and does the one thing the discharge copy cannot: it deals with the links.
 *
 * THE LINK PROBLEM. A discharged PREVIEW.html still points at "services/<slug>/index.html", which
 * are real files sitting beside it in the export folder. Sent to a phone on its own, those links
 * have nothing to resolve against, so every service link in the nav, the services grid and the
 * footer is a dead tap. On a phone a dead tap reads as a broken website rather than as a preview
 * with a known limit.
 *
 * So the links are pointed at a note appended to the end of the document, which says where the
 * service pages actually are. Tapping one now explains itself instead of doing nothing. The note
 * carries its own inline styles and is appended after everything else, so it cannot disturb the
 * layout of a design this script did not write.
 *
 * SIZE. The images come from the manifest, which holds the web derivatives the image pipeline
 * makes, never the originals. Driftwood's seven originals are about 20MB between them; the same
 * seven as web files and thumbnails inline to a file of about five and a half.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'

const EXPORTS = 'C:/Users/Chris/Desktop/go-polar-sites'
const OUT =
  'C:/Users/Chris/AppData/Roaming/Claude/local-agent-mode-sessions/4aa0a511-ea50-4722-a93f-192212a5180f/3f7b39e1-61c9-4155-821b-07169a9e430d/agent/local_ditto_3f7b39e1-61c9-4155-821b-07169a9e430d/outputs'

const SITES = [
  { slug: 'lsv-services', label: 'LSV Services', pages: 3 },
  { slug: 'driftwood-building-co', label: 'Driftwood Building Co', pages: 3 },
  { slug: 'pest-aside-sydney', label: 'Pest-Aside Sydney', pages: 11 },
]

const NOTE_ID = 'gp-preview-note'

function noteFor(label, servicePages) {
  const list = servicePages.map((s) => `<li>${s}</li>`).join('')
  return `
<!-- Added for the phone preview only. Not part of the website. -->
<section id="${NOTE_ID}" style="box-sizing:border-box;margin:0;padding:28px 20px 120px;background:#0f1419;color:#e8eef4;font:400 15px/1.6 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:640px;margin:0 auto;">
    <p style="margin:0 0 10px;font:600 12px/1.4 system-ui,sans-serif;letter-spacing:.10em;text-transform:uppercase;color:#7cc4f0;">Preview note, not part of the site</p>
    <h2 style="margin:0 0 12px;font:700 21px/1.3 system-ui,sans-serif;color:#fff;">This is the ${label} home page on its own</h2>
    <p style="margin:0 0 14px;">It is a single self-contained file so it can be sent and opened anywhere. Every image is embedded in the file itself.</p>
    <p style="margin:0 0 8px;">The site has <strong>${servicePages.length} more page${servicePages.length === 1 ? '' : 's'}</strong>, which are not in this file:</p>
    <ul style="margin:0 0 14px;padding-left:20px;">${list}</ul>
    <p style="margin:0;color:#9fb3c4;">The full set, with every page and all its files, is in the export folder on the desktop under <code style="background:#1c242c;padding:2px 6px;border-radius:4px;font-size:13px;">go-polar-sites\\${''}</code>.</p>
  </div>
</section>`
}

/*
 * Titles come from the service pages themselves rather than from the slugs, so the note lists what
 * the pages are actually called instead of a guess reconstructed from a filename.
 */
function servicePageTitles(dir) {
  const out = []
  const seen = new Set()
  const html = readFileSync(`${dir}/index.html`, 'utf8')
  for (const m of html.matchAll(/href="services\/([a-z0-9-]+)\/(?:index\.html)?"/g)) {
    const slug = m[1]
    if (seen.has(slug)) continue
    seen.add(slug)
    const file = `${dir}/services/${slug}/index.html`
    let title = slug.replace(/-/g, ' ')
    if (existsSync(file)) {
      const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(readFileSync(file, 'utf8'))
      /*
       * Entities are decoded BEFORE tags are stripped, because some of these headings contain
       * escaped markup rather than markup. The model put literal <em> inside the plan's h1, which
       * is a plain text field, so the renderer escaped it as it should and the page now shows the
       * tags to the reader. Stripping tags alone would leave "&lt;em&gt;" in this list; decoding
       * first turns it back into a tag that the strip then removes.
       */
      if (h1) {
        title = h1[1]
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .replace(/&#39;|&apos;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/<[^>]+>/g, '')
          .replace(/\s+/g, ' ')
          .trim()
      }
    }
    out.push(title)
  }
  return out
}

const results = []

for (const site of SITES) {
  const dir = `${EXPORTS}/${site.slug}`
  if (!existsSync(dir)) {
    results.push({ ...site, error: 'export folder missing' })
    continue
  }

  /*
   * PREVIEW.html when the discharge flow made one, because that is the copy with the images
   * already embedded. Otherwise index.html, which is equivalent for a site that has no images at
   * all: LSV and Pest-Aside supplied neither photos nor a logo, so their pages reference no files.
   */
  const preview = `${dir}/PREVIEW.html`
  const source = existsSync(preview) ? preview : `${dir}/index.html`
  let html = readFileSync(source, 'utf8')

  const titles = servicePageTitles(dir)

  // Every internal service link, in both the directory and the file form, goes to the note.
  const before = (html.match(/href="services\/[a-z0-9-]+\/(?:index\.html)?"/g) ?? []).length
  html = html.replace(/href="services\/[a-z0-9-]+\/(?:index\.html)?"/g, `href="#${NOTE_ID}"`)

  // Any other relative reference left over would be a request the phone cannot satisfy.
  const dangling = [...html.matchAll(/(?:src|href)="(?!https?:|data:|tel:|mailto:|#)([^"]+)"/g)].map((m) => m[1])

  if (titles.length > 0) {
    const note = noteFor(site.label, titles)
    html = html.includes('</body>') ? html.replace(/<\/body>/i, `${note}\n</body>`) : html + note
  }

  const outPath = `${OUT}/${site.slug}.html`
  writeFileSync(outPath, html, 'utf8')

  results.push({
    ...site,
    source: source.endsWith('PREVIEW.html') ? 'PREVIEW.html (images embedded)' : 'index.html (no images to embed)',
    linksRewired: before,
    servicePagesListed: titles.length,
    dangling,
    bytes: statSync(outPath).size,
    outPath,
  })
}

const mb = (b) => (b / 1024 / 1024).toFixed(2) + ' MB'
console.log('')
for (const r of results) {
  if (r.error) {
    console.log(`${r.label}: ${r.error}`)
    continue
  }
  console.log(`${r.label}`)
  console.log(`  file        ${r.outPath}`)
  console.log(`  size        ${mb(r.bytes)}  (${r.bytes.toLocaleString()} bytes)`)
  console.log(`  source      ${r.source}`)
  console.log(`  links       ${r.linksRewired} service links now go to the note`)
  console.log(`  note lists  ${r.servicePagesListed} service pages`)
  console.log(
    `  dangling    ${r.dangling.length === 0 ? 'none, no relative paths remain' : 'STILL RELATIVE: ' + [...new Set(r.dangling)].slice(0, 6).join(', ')}`,
  )
  console.log('')
}
process.exit(0)
