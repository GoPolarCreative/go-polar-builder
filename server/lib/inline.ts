import type { BuildFacts } from '../../shared/plan.js'
import { storage } from './storage.js'

/**
 * Produce a standalone copy of a build with every image replaced by a data URI.
 *
 * Used in three places:
 *   - the render checks, so a headless browser can load the page without an asset server
 *   - the preview iframe, where srcdoc means relative paths cannot resolve
 *   - the discharge export, which ships a PREVIEW copy alongside the real files
 *
 * Only the processed derivatives are inlined, which is the same set the live site references.
 * Inlining originals would produce a preview many times heavier than the real page and would
 * misrepresent what a visitor gets.
 */

export interface InlineResult {
  html: string
  inlined: number
  missing: string[]
  bytes: number
}

export async function inlineAssets(html: string, facts: BuildFacts): Promise<InlineResult> {
  const store = storage()
  const dataUris = new Map<string, string>()
  const missing: string[] = []

  for (const [path, meta] of Object.entries(facts.assetManifest)) {
    // Only inline paths the document actually references. A manifest entry nobody used is not
    // worth several hundred kilobytes of base64.
    if (!html.includes(path)) continue
    try {
      const bytes = await store.get(meta.key)
      if (!bytes) {
        missing.push(path)
        continue
      }
      dataUris.set(path, `data:${meta.contentType};base64,${toBase64(bytes)}`)
    } catch (err) {
      console.error('inline failed for', path, err)
      missing.push(path)
    }
  }

  let out = html
  // Longest paths first: photo-01-thumb.webp must be replaced before photo-01.webp, or the
  // shorter path would match inside the longer one and corrupt it.
  for (const path of [...dataUris.keys()].sort((a, b) => b.length - a.length)) {
    out = out.split(path).join(dataUris.get(path)!)
  }

  return { html: out, inlined: dataUris.size, missing, bytes: out.length }
}

/** Chunked so a large image does not blow the argument limit on String.fromCharCode. */
function toBase64(bytes: Uint8Array): string {
  const chunk = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
