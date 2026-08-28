/**
 * Turn a vector PDF logo into a PNG the pipeline can actually use.
 *
 *   node scripts/rasterise-pdf.mjs <input.pdf> <output.png> [widthPx]
 *
 * WHY THIS EXISTS. Driftwood Building Co supplied their logo as a PDF. Nothing downstream can use
 * it: sharp is built without PDF input (verified, libvips 8.18.3 lists jpeg, png, webp, tiff, gif,
 * svg, heif, vips and no pdf), the header emits an <img>, and the palette is sampled from raster
 * pixels. A PDF in that slot is a broken header and a missing colour palette.
 *
 * It uses the Chrome that is already on the machine, through the playwright-core this project
 * already depends on for its render checks. No new dependency, no system install. Chrome renders
 * PDFs natively, so the PDF is opened in its viewer and the page area is captured.
 *
 * ImageMagick is deliberately NOT used even though `convert` resolves on PATH: on Windows that is
 * C:\Windows\System32\convert.exe, the filesystem conversion utility, which has nothing to do with
 * images and should never be handed a file path.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [, , inPath, outPath, widthArg] = process.argv
if (!inPath || !outPath) {
  console.error('usage: node scripts/rasterise-pdf.mjs <input.pdf> <output.png> [widthPx]')
  process.exit(1)
}
const targetWidth = Number(widthArg ?? 1200)

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)

const exe = CANDIDATES.find((p) => existsSync(p))
if (!exe) {
  console.error('No Chrome or Edge found. Set CHROME_PATH.')
  process.exit(1)
}
console.error('browser: ' + exe)

/*
 * THE FIRST PAGE ONLY, SIZED FROM THE REAL MediaBox.
 *
 * Driftwood's logo PDF has THREE pages, all 502.522 x 539.435, which is the usual set of colour,
 * mono and reversed variants. Chrome's viewer stacks them with a grey gap between, and scanning
 * for "the white region" spanned page one, the gap and part of page two, so the first output had
 * a grey band across the bottom and a logo squashed into the top of it.
 *
 * The page aspect ratio is read straight out of the PDF, so once the page width is known in the
 * capture the height follows exactly, and the crop stops at the bottom of page one whatever the
 * viewer decides to draw underneath it.
 */
const pdfText = readFileSync(resolve(inPath)).toString('latin1')
const boxes = [...pdfText.matchAll(/\/MediaBox\s*\[([^\]]+)\]/g)].map((m) =>
  m[1].trim().split(/\s+/).map(Number),
)
const first = boxes[0]
const pageAspect = first && first.length === 4 ? (first[2] - first[0]) / (first[3] - first[1]) : null
console.error('pdf pages: ' + boxes.length + '   page aspect: ' + (pageAspect ? pageAspect.toFixed(4) : 'unknown'))

const { chromium } = await import('playwright-core')
const browser = await chromium.launch({ executablePath: exe, args: ['--headless=new'] })

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1600 }, deviceScaleFactor: 2 })
  await page.goto(pathToFileURL(resolve(inPath)).href + '#toolbar=0&navpanes=0&scrollbar=0&view=Fit', { waitUntil: 'load', timeout: 60_000 })
  // The viewer paints asynchronously after load; there is no event for "the page is drawn".
  await page.waitForTimeout(4000)

  const shot = await page.screenshot({ type: 'png' })
  console.error('raw capture: ' + Math.round(shot.length / 1024) + 'KB')

  /*
   * FIND THE WHITE PAGE, THEN THE ARTWORK ON IT.
   *
   * sharp's trim removes a UNIFORM border sampled from one corner, and Chrome's PDF viewer does
   * not give it one: the ground is #3c3c3c at the top and #282828 at the bottom with a toolbar in
   * between. Trimming did nothing at all, and the first attempt wrote out a logo with the viewer
   * still around it. So the white page rectangle is located explicitly, cropped to, and only then
   * is the white margin trimmed to reach the artwork.
   */
  const sharp = (await import('sharp')).default
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true })
  const { width: W, height: H, channels: C } = info
  const isPage = (x, y) => {
    const i = (y * W + x) * C
    return data[i] > 245 && data[i + 1] > 245 && data[i + 2] > 245
  }

  // Scan the middle row and column, which cross the page but miss the toolbar.
  const midY = H >> 1
  let x0 = -1
  let x1 = -1
  for (let x = 0; x < W; x++) if (isPage(x, midY)) { x0 = x; break }
  for (let x = W - 1; x >= 0; x--) if (isPage(x, midY)) { x1 = x; break }
  const midX = x0 >= 0 ? (x0 + x1) >> 1 : W >> 1
  let y0 = -1
  let y1 = -1
  for (let y = 0; y < H; y++) if (isPage(midX, y)) { y0 = y; break }
  for (let y = H - 1; y >= 0; y--) if (isPage(midX, y)) { y1 = y; break }

  if (x0 < 0 || y0 < 0 || x1 - x0 < 40) {
    console.error('REFUSING: no white page found in the capture, so the PDF did not render.')
    process.exit(2)
  }

  // Height comes from the page's own aspect ratio, not from where the white happens to stop.
  const pageW = x1 - x0 + 1
  let pageH = y1 - y0 + 1
  if (pageAspect) {
    const exact = Math.round(pageW / pageAspect)
    if (exact > 40 && y0 + exact <= H) {
      console.error('page one height from MediaBox: ' + exact + ' (white ran to ' + pageH + ')')
      pageH = exact
    }
  }
  console.error('capture ' + W + 'x' + H + ' C=' + C + '  x0=' + x0 + ' x1=' + x1 + ' y0=' + y0 + ' y1=' + y1)
  console.error('page rectangle in the capture: ' + (x1 - x0 + 1) + 'x' + (y1 - y0 + 1) + ' at ' + x0 + ',' + y0)

  const pageOnly = await sharp(shot).extract({ left: x0, top: y0, width: pageW, height: pageH }).toBuffer()

  /*
   * IS THERE ANYTHING ON THE PAGE?
   *
   * sharp's trim throws "extract_area: bad extract area" on a completely uniform image rather
   * than returning it unchanged, which is how the blank case first showed up: as a crash three
   * lines later. Checking for ink first turns that into a clear answer about whether the browser
   * actually drew the PDF, which is the thing worth knowing.
   */
  const probe = await sharp(pageOnly).raw().toBuffer({ resolveWithObject: true })
  let ink = 0
  for (let i = 0; i < probe.data.length; i += probe.info.channels) {
    if ((probe.data[i] + probe.data[i + 1] + probe.data[i + 2]) / 3 < 200) ink++
  }
  const inkPct = (ink / (probe.info.width * probe.info.height)) * 100
  console.error('ink on the page: ' + inkPct.toFixed(2) + '%')

  if (ink === 0) {
    console.error('REFUSING: the page rendered blank. This browser did not draw the PDF.')
    process.exit(2)
  }

  let meta = await sharp(pageOnly).trim({ threshold: 10 }).toBuffer({ resolveWithObject: true })
  console.error('after trimming the page margin: ' + meta.info.width + 'x' + meta.info.height)

  if (meta.info.width < 40 || meta.info.height < 40) {
    console.error('REFUSING: the page trimmed down to nothing.')
    process.exit(2)
  }

  mkdirSync(dirname(resolve(outPath)), { recursive: true })
  const out = await sharp(meta.data)
    .resize({ width: targetWidth, withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer()
  writeFileSync(resolve(outPath), out)

  const final = await sharp(out).metadata()
  console.log(
    JSON.stringify({
      written: outPath,
      width: final.width,
      height: final.height,
      aspect: +(final.width / final.height).toFixed(2),
      kb: Math.round(out.length / 1024),
      hasAlpha: final.hasAlpha,
    }),
  )
} finally {
  await browser.close()
}
