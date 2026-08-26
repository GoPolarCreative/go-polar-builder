import sharp, { type Sharp } from 'sharp'

/**
 * Image processing at upload. This is a bandwidth control, not a nicety.
 *
 * THE MATHS (DECISIONS.md D25). Around 50 client sites, up to 20 photos each, originals up to
 * 10MB. These are static single-file sites with plain img tags: there is no framework image
 * pipeline downstream, so whatever byte size is stored is the byte size every visitor downloads,
 * on every site, forever. Serving originals would be up to 200MB of images per site. One
 * thousand visits to one such site is 200GB, which on Vercel Pro is 1TB of included bandwidth
 * gone in five site-months and $0.15/GB after that.
 *
 * So: originals are kept for rebuilds and never served. What ships is a web-sized derivative
 * capped at 1920px on the longest edge and a 800px thumbnail, each as WebP with a JPEG fallback,
 * and the generated site uses <picture> so the browser takes the smaller one.
 *
 * Typical result: a 9MB phone photo becomes about 250KB of WebP. A finished site with a hero and
 * a six-photo gallery lands near 1MB rather than 60MB.
 */

/** Longest edge for the hero and full-width gallery use. */
export const WEB_MAX_EDGE = 1920
/** Longest edge for gallery thumbnails. */
export const THUMB_MAX_EDGE = 800
/** Logos are never displayed large. */
export const LOGO_MAX_EDGE = 600

export const WEBP_QUALITY = 78
export const JPEG_QUALITY = 80
export const THUMB_WEBP_QUALITY = 72
export const THUMB_JPEG_QUALITY = 74

export type VariantRole = 'web' | 'thumb'
export type VariantFormat = 'webp' | 'jpeg' | 'png' | 'svg'

export interface ProcessedVariant {
  role: VariantRole
  format: VariantFormat
  data: Uint8Array
  bytes: number
  width: number
  height: number
  contentType: string
}

export interface ProcessedImage {
  width: number
  height: number
  /** Left untouched, stored separately, never served to a visitor. */
  originalBytes: number
  variants: ProcessedVariant[]
  /** True when the file was passed through rather than re-encoded (SVG). */
  passthrough: boolean
}

const CONTENT_TYPE: Record<VariantFormat, string> = {
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
}

export function contentTypeFor(format: VariantFormat): string {
  return CONTENT_TYPE[format]
}

/**
 * Process one upload into the derivatives that will ship.
 *
 * SVG is passed through untouched: it is already small, it scales, and rasterising a logo to
 * chase a byte count would make it worse.
 */
export async function processImage(
  input: Uint8Array,
  kind: 'logo' | 'photo',
  contentType: string,
): Promise<ProcessedImage> {
  if (contentType.includes('svg')) {
    return {
      width: 0,
      height: 0,
      originalBytes: input.byteLength,
      passthrough: true,
      variants: [
        {
          role: 'web',
          format: 'svg',
          data: input,
          bytes: input.byteLength,
          width: 0,
          height: 0,
          contentType: CONTENT_TYPE.svg,
        },
      ],
    }
  }

  const image = sharp(Buffer.from(input), { failOn: 'none' })
  const meta = await image.metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0

  const variants: ProcessedVariant[] = []

  if (kind === 'logo') {
    // Logos keep their alpha channel, so WebP and PNG rather than WebP and JPEG. A JPEG logo
    // would gain a white box on any coloured header.
    //
    // .rotate() IS NOT OPTIONAL HERE, AND ITS ABSENCE SHIPPED MIRRORED LOGOS. This branch used to
    // omit it while the photo branch below called it. Re-encoding strips the EXIF orientation tag
    // either way, so without .rotate() the tag is dropped WITHOUT being applied: a logo saved with
    // orientation 2, 4, 5 or 7 (the mirrored values, which is what you get from some phone
    // screenshots and a few editors' "flip" tools) ships horizontally flipped, and the browser has
    // no tag left to correct it with.
    //
    // Measured on a red-left/blue-right test image stamped orientation 2: without .rotate() the
    // output kept red on the left, with .rotate() it correctly moved to the right. A wrong logo is
    // worse than a sideways photo, because it is the one image on the page a customer recognises
    // instantly and it appears in the header of every page.
    const resized = sharp(Buffer.from(input), { failOn: 'none' })
      .rotate()
      .resize({
        width: LOGO_MAX_EDGE,
        height: LOGO_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })

    variants.push(await encode(resized.clone().webp({ quality: 90 }), 'web', 'webp'))
    variants.push(await encode(resized.clone().png({ compressionLevel: 9, palette: true }), 'web', 'png'))
    return { width, height, originalBytes: input.byteLength, variants, passthrough: false }
  }

  const web = sharp(Buffer.from(input), { failOn: 'none' })
    .rotate() // honour EXIF orientation, or half the phone photos land sideways
    .resize({ width: WEB_MAX_EDGE, height: WEB_MAX_EDGE, fit: 'inside', withoutEnlargement: true })

  const thumb = sharp(Buffer.from(input), { failOn: 'none' })
    .rotate()
    .resize({ width: THUMB_MAX_EDGE, height: THUMB_MAX_EDGE, fit: 'inside', withoutEnlargement: true })

  variants.push(await encode(web.clone().webp({ quality: WEBP_QUALITY }), 'web', 'webp'))
  variants.push(await encode(web.clone().jpeg({ quality: JPEG_QUALITY, mozjpeg: true }), 'web', 'jpeg'))
  variants.push(await encode(thumb.clone().webp({ quality: THUMB_WEBP_QUALITY }), 'thumb', 'webp'))
  variants.push(await encode(thumb.clone().jpeg({ quality: THUMB_JPEG_QUALITY, mozjpeg: true }), 'thumb', 'jpeg'))

  return { width, height, originalBytes: input.byteLength, variants, passthrough: false }
}

async function encode(
  pipeline: Sharp,
  role: VariantRole,
  format: VariantFormat,
): Promise<ProcessedVariant> {
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true })
  return {
    role,
    format,
    data: new Uint8Array(data),
    bytes: data.byteLength,
    width: info.width,
    height: info.height,
    contentType: CONTENT_TYPE[format],
  }
}

/** How much smaller the shipped image is than the original. Reported to the customer. */
export function savingSummary(processed: ProcessedImage): string {
  const shipped = processed.variants.find((v) => v.role === 'web' && v.format === 'webp')
  if (!shipped || processed.originalBytes === 0) return ''
  const percent = Math.round((1 - shipped.bytes / processed.originalBytes) * 100)
  return `${formatBytes(processed.originalBytes)} to ${formatBytes(shipped.bytes)}, ${percent}% smaller`
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes} bytes`
}
