import type { Env } from '../env'
import type { AssetRecord } from '../../shared/types'
import type { BuildFacts } from '../../shared/plan'

/**
 * Produce a standalone copy of a build with every image replaced by a data URI.
 *
 * Used in three places:
 *   - the render checks, so a headless browser can load the page without an asset server
 *   - the preview iframe (Phase 4), where srcdoc means relative paths cannot resolve
 *   - the discharge export (Phase 5), which ships a PREVIEW copy alongside the real files
 *
 * SVG is inlined as base64 too rather than as a raw data URI, because raw SVG in a src attribute
 * needs escaping that goes wrong the moment the artwork contains a quote character.
 */

export interface InlineResult {
  html: string
  inlined: number
  missing: string[]
  bytes: number
}

export async function inlineAssets(
  env: Env,
  html: string,
  facts: BuildFacts,
  assets: AssetRecord[],
): Promise<InlineResult> {
  const byPath = new Map<string, AssetRecord>()

  const logo = assets.find((a) => a.kind === 'logo')
  if (facts.logoPath && logo) byPath.set(facts.logoPath, logo)
  for (const p of facts.photoPaths) {
    const asset = assets.find((a) => a.id === p.assetId)
    if (asset) byPath.set(p.path, asset)
  }

  const dataUris = new Map<string, string>()
  const missing: string[] = []

  for (const [path, asset] of byPath) {
    try {
      const object = await env.BUCKET.get(asset.r2_key)
      if (!object) {
        missing.push(path)
        continue
      }
      const buf = await object.arrayBuffer()
      const type = asset.content_type ?? 'image/jpeg'
      dataUris.set(path, `data:${type};base64,${toBase64(buf)}`)
    } catch (err) {
      console.error('inline failed for', path, err)
      missing.push(path)
    }
  }

  let out = html
  for (const [path, uri] of dataUris) {
    // Match the path wherever it appears: src, srcset, url() and href.
    out = out.split(path).join(uri)
  }

  return { html: out, inlined: dataUris.size, missing, bytes: out.length }
}

/** Chunked so a large image does not blow the argument limit on String.fromCharCode. */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunk = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
