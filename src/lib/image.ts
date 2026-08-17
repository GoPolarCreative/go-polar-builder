import type { AssetStats } from '../../shared/types'
import type { Palette } from '../../shared/intake'

/**
 * Client-side image analysis and logo colour sampling.
 *
 * Brief s4 step 5: brand colours are auto-sampled from the logo and shown as adjustable
 * swatches. They are never asked as a text question. That question is how a question ended up
 * typed into the colours field.
 *
 * This runs in the browser because a Worker has no image decoder, and the gap audit needs pixel
 * signals to tell a real logo from a mockup render. The stats travel with the upload.
 */

const SAMPLE_EDGE = 220

export async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file)
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error(`Could not read ${file.name}. Try re-saving it as a PNG or JPG.`))
      // SVG rasterises fine through this path, which is why it is used instead of createImageBitmap.
      img.src = url
    })
  } finally {
    // Revoke on the next tick so the decode has definitely finished.
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }
}

interface Sampled {
  data: Uint8ClampedArray
  width: number
  height: number
}

function sample(img: HTMLImageElement): Sampled | null {
  const naturalW = img.naturalWidth || SAMPLE_EDGE
  const naturalH = img.naturalHeight || SAMPLE_EDGE
  const scale = Math.min(1, SAMPLE_EDGE / Math.max(naturalW, naturalH))
  const w = Math.max(1, Math.round(naturalW * scale))
  const h = Math.max(1, Math.round(naturalH * scale))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, w, h)

  try {
    return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h }
  } catch {
    // A cross-origin image would taint the canvas. Uploads are local files, so this should not
    // happen, but returning null degrades to "no stats" rather than throwing at the user.
    return null
  }
}

function quantise(r: number, g: number, b: number): number {
  return ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
}

function keyToHex(key: number): string {
  const r = ((key >> 8) & 0xf) * 17
  const g = ((key >> 4) & 0xf) * 17
  const b = (key & 0xf) * 17
  return rgbToHex(r, g, b)
}

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
  else if (max === gn) h = ((bn - rn) / d + 2) / 6
  else h = ((rn - gn) / d + 4) / 6
  return [h, s, l]
}

/** Analyse an image for the gap audit. Returns null if the canvas could not be read. */
export function computeStats(img: HTMLImageElement): AssetStats | null {
  const s = sample(img)
  if (!s) return null

  const { data, width, height } = s
  const total = width * height
  const counts = new Map<number, number>()
  let transparent = 0
  let flat = 0
  let compared = 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const a = data[i + 3]!
      if (a < 250) transparent++
      if (a < 16) continue // fully transparent pixels tell us nothing about colour

      const key = quantise(data[i]!, data[i + 1]!, data[i + 2]!)
      counts.set(key, (counts.get(key) ?? 0) + 1)

      // Flatness: does this pixel match its right and bottom neighbour after quantisation?
      // Logos are mostly flat fills. Photographs almost never are.
      if (x + 1 < width && y + 1 < height) {
        const right = (y * width + x + 1) * 4
        const below = ((y + 1) * width + x) * 4
        const kr = quantise(data[right]!, data[right + 1]!, data[right + 2]!)
        const kb = quantise(data[below]!, data[below + 1]!, data[below + 2]!)
        compared++
        if (kr === key && kb === key) flat++
      }
    }
  }

  const significant = [...counts.entries()].filter(([, n]) => n > total * 0.001)
  const flatRatio = compared > 0 ? flat / compared : 0
  const distinctColours = significant.length

  // 0 is a clean flat logo, 1 is a photograph. Both signals point the same way, so average them.
  const photographicScore = Math.max(
    0,
    Math.min(1, 0.6 * (1 - flatRatio) + 0.4 * Math.min(distinctColours / 200, 1)),
  )

  const dominant = significant
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([key]) => keyToHex(key))

  return {
    width: img.naturalWidth || width,
    height: img.naturalHeight || height,
    aspect: Number(((img.naturalWidth || width) / (img.naturalHeight || height)).toFixed(3)),
    flatRatio: Number(flatRatio.toFixed(3)),
    distinctColours,
    hasTransparency: transparent > total * 0.02,
    photographicScore: Number(photographicScore.toFixed(3)),
    dominant,
  }
}

function shade(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex)
  return amount < 0
    ? rgbToHex(r * (1 + amount), g * (1 + amount), b * (1 + amount))
    : rgbToHex(r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount)
}

/**
 * Build a palette from the logo's dominant colours.
 *
 * Background white and near-black outlines dominate most logos by pixel count and mean nothing
 * as brand colours, so they are set aside and only used for the dark and light tokens. What is
 * left, ordered by area, is the brand. If the logo carries two meaningful colours the second one
 * becomes the accent, which is the brief's "use them structurally".
 */
export function paletteFromStats(stats: AssetStats | null): Palette | null {
  if (!stats || stats.dominant.length === 0) return null

  const scored = stats.dominant.map((hex) => {
    const [r, g, b] = hexToRgb(hex)
    const [, sat, light] = rgbToHsl(r, g, b)
    return { hex, sat, light }
  })

  const brand = scored.filter((c) => c.sat >= 0.18 && c.light > 0.1 && c.light < 0.9)
  if (brand.length === 0) {
    // A black and white logo. Use the darkest colour as primary rather than inventing one.
    const darkest = scored.reduce((a, b) => (a.light <= b.light ? a : b))
    const primary = darkest.light > 0.35 ? shade(darkest.hex, -0.4) : darkest.hex
    return {
      primary,
      secondary: shade(primary, 0.25),
      accent: shade(primary, -0.2),
      dark: '#14171a',
      light: '#f4f6f8',
      source: 'logo',
    }
  }

  let primary = brand[0]!.hex
  if (brand[0]!.light > 0.62) primary = shade(primary, -0.35) // must carry white text

  const second = brand.find((c) => colourDistance(c.hex, brand[0]!.hex) > 90)
  const accent = second ? second.hex : shade(primary, -0.25)

  return {
    primary,
    secondary: shade(primary, 0.3),
    accent,
    dark: '#14171a',
    light: '#f4f6f8',
    source: 'logo',
  }
}

function colourDistance(a: string, b: string): number {
  const [r1, g1, b1] = hexToRgb(a)
  const [r2, g2, b2] = hexToRgb(b)
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2)
}

/** Everything the uploader needs in one pass: dimensions, stats, and a palette if it is a logo. */
export async function analyseUpload(
  file: File,
  kind: 'logo' | 'photo',
): Promise<{ stats: AssetStats | null; palette: Palette | null }> {
  const img = await loadImage(file)
  const stats = computeStats(img)
  return { stats, palette: kind === 'logo' ? paletteFromStats(stats) : null }
}
