import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AssetRecord, AssetVariant } from '../shared/types'
import { LOGO_STATS, PHOTO_STATS } from './fixture-images'

/**
 * Reconstruct the asset records for the committed sample site from the files on disk.
 *
 * The sample folder is the source of truth for the sample: this reads what is actually there
 * rather than assuming, so the verification run measures the files a person would open.
 */
export async function sampleAssets(root = 'sample'): Promise<AssetRecord[]> {
  const size = async (path: string): Promise<number> => (await stat(join(root, path))).size

  const logoVariants: AssetVariant[] = [
    { role: 'web', format: 'webp', key: 'sample/logo-web.webp', bytes: await size('assets/logo.webp'), width: 512, height: 512 },
    { role: 'web', format: 'png', key: 'sample/logo-web.png', bytes: await size('assets/logo.png'), width: 512, height: 512 },
  ]

  const assets: AssetRecord[] = [
    {
      id: 'ast_logo',
      jobId: 'sample',
      kind: 'logo',
      filename: 'cold-front-logo.png',
      contentType: 'image/png',
      originalKey: 'sample/logo-original',
      // Judged usable on the source dimensions and size, so this has to be real.
      originalBytes: 17_000,
      width: 512,
      height: 512,
      sortOrder: 0,
      stats: LOGO_STATS,
      variants: logoVariants,
      createdAt: '2026-08-18T00:00:00.000Z',
    },
  ]

  for (let i = 0; i < 4; i++) {
    const n = String(i + 1).padStart(2, '0')
    assets.push({
      id: `ast_p${i + 1}`,
      jobId: 'sample',
      kind: 'photo',
      filename: `job-photo-${i + 1}.jpg`,
      contentType: 'image/jpeg',
      originalKey: `sample/photo-${i + 1}-original`,
      originalBytes: 2_400_000,
      width: 4032,
      height: 3024,
      sortOrder: i,
      stats: PHOTO_STATS,
      variants: [
        { role: 'web', format: 'webp', key: `sample/photo-${i + 1}-web.webp`, bytes: await size(`assets/photo-${n}.webp`), width: 1920, height: 1440 },
        { role: 'web', format: 'jpeg', key: `sample/photo-${i + 1}-web.jpg`, bytes: await size(`assets/photo-${n}.jpg`), width: 1920, height: 1440 },
        { role: 'thumb', format: 'webp', key: `sample/photo-${i + 1}-thumb.webp`, bytes: await size(`assets/photo-${n}-thumb.webp`), width: 800, height: 600 },
        { role: 'thumb', format: 'jpeg', key: `sample/photo-${i + 1}-thumb.jpg`, bytes: await size(`assets/photo-${n}-thumb.jpg`), width: 800, height: 600 },
      ],
      createdAt: '2026-08-18T00:00:00.000Z',
    })
  }

  return assets
}
