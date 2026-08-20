import type { AssetRecord, AssetVariant } from '../../shared/types.js'
import type { LogoRef, PhotoRef } from '../../shared/plan.js'
import { isUsablePhoto } from './audit.js'

/**
 * Turning stored assets into the file paths a generated site will reference.
 *
 * The originals never appear here. Only the processed derivatives ship, because whatever is
 * referenced is what every visitor downloads on every visit (DECISIONS.md D25).
 */

export const ASSET_DIR = 'assets'

function pick(asset: AssetRecord, role: AssetVariant['role'], format: AssetVariant['format']): AssetVariant | null {
  return asset.variants.find((v) => v.role === role && v.format === format) ?? null
}

export interface AssetPlan {
  logo: LogoRef | null
  photos: PhotoRef[]
  manifest: Record<string, { key: string; bytes: number; contentType: string }>
}

export function planAssets(assets: AssetRecord[]): AssetPlan {
  const manifest: AssetPlan['manifest'] = {}
  const add = (path: string, variant: AssetVariant, contentType: string) => {
    manifest[path] = { key: variant.key, bytes: variant.bytes, contentType }
  }

  // --- logo ------------------------------------------------------------------------------------
  const logoAsset = assets.find((a) => a.kind === 'logo')
  let logo: LogoRef | null = null

  if (logoAsset) {
    const svg = pick(logoAsset, 'web', 'svg')
    if (svg) {
      const path = `${ASSET_DIR}/logo.svg`
      add(path, svg, 'image/svg+xml')
      logo = { path, fallback: null, width: svg.width || 240, height: svg.height || 60 }
    } else {
      const webp = pick(logoAsset, 'web', 'webp')
      const png = pick(logoAsset, 'web', 'png')
      if (webp) {
        const path = `${ASSET_DIR}/logo.webp`
        add(path, webp, 'image/webp')
        let fallback: string | null = null
        if (png) {
          fallback = `${ASSET_DIR}/logo.png`
          add(fallback, png, 'image/png')
        }
        logo = { path, fallback, width: webp.width, height: webp.height }
      }
    }
  }

  // --- photos ----------------------------------------------------------------------------------
  const usable = assets.filter(isUsablePhoto).sort((a, b) => a.sortOrder - b.sortOrder)
  const photos: PhotoRef[] = []

  for (const [index, asset] of usable.entries()) {
    const webWebp = pick(asset, 'web', 'webp')
    const webJpeg = pick(asset, 'web', 'jpeg')
    const thumbWebp = pick(asset, 'thumb', 'webp')
    const thumbJpeg = pick(asset, 'thumb', 'jpeg')
    // An asset without its full set of derivatives is not shippable. Skipping it is correct:
    // the gap audit already counts usable photos and will flag the shortfall.
    if (!webWebp || !webJpeg || !thumbWebp || !thumbJpeg) continue

    const stem = `${ASSET_DIR}/photo-${String(index + 1).padStart(2, '0')}`
    const ref: PhotoRef = {
      assetId: asset.id,
      webWebp: `${stem}.webp`,
      webJpeg: `${stem}.jpg`,
      thumbWebp: `${stem}-thumb.webp`,
      thumbJpeg: `${stem}-thumb.jpg`,
      width: webWebp.width,
      height: webWebp.height,
      bytes: webWebp.bytes,
    }

    add(ref.webWebp, webWebp, 'image/webp')
    add(ref.webJpeg, webJpeg, 'image/jpeg')
    add(ref.thumbWebp, thumbWebp, 'image/webp')
    add(ref.thumbJpeg, thumbJpeg, 'image/jpeg')
    photos.push(ref)
  }

  return { logo, photos, manifest }
}

/**
 * What a first-time visitor downloads: the HTML plus every asset the page references.
 *
 * Counted against the WebP variants, because that is what any browser from the last several
 * years takes. The JPEG fallbacks ship in the export but are not double counted here.
 */
export function pageWeight(html: string, referenced: string[], manifest: AssetPlan['manifest']): number {
  const seen = new Set<string>()
  let total = new TextEncoder().encode(html).byteLength

  for (const path of referenced) {
    if (seen.has(path)) continue
    seen.add(path)
    // A JPEG fallback inside a <picture> is not fetched when the WebP is taken.
    if (/\.jpe?g$/i.test(path) && manifest[path.replace(/\.jpe?g$/i, '.webp')]) continue
    total += manifest[path]?.bytes ?? 0
  }
  return total
}
