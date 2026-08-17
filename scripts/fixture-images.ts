import sharp from 'sharp'

/**
 * Fixture images for seeding and for the sample site.
 *
 * These are generated, not stock photography, and they never reach a customer build: they exist
 * so the upload pipeline, the gallery path and the page weight check can be exercised without
 * asking anyone for real job photos. They are deliberately large and noisy, like a phone photo,
 * so the compression step has something real to do.
 */

export interface FixtureImage {
  filename: string
  contentType: string
  bytes: Buffer
}

/** A 4032x3024 textured image, roughly the size and messiness of a photo off a phone. */
export async function makePhoto(seed: number): Promise<FixtureImage> {
  const width = 4032
  const height = 3024

  // Noise gives the encoder something to work with, so the resulting file size is realistic
  // rather than the few kilobytes a flat gradient would compress to.
  const noise = await sharp({
    create: {
      width: 504,
      height: 378,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
      noise: { type: 'gaussian', mean: 128, sigma: 42 },
    },
  })
    .png()
    .toBuffer()

  const base = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 20 + seed * 30, g: 70 + seed * 18, b: 120 - seed * 14 },
    },
  })
    .composite([{ input: await sharp(noise).resize(width, height).toBuffer(), blend: 'overlay' }])
    .jpeg({ quality: 92 })
    .toBuffer()

  return { filename: `job-photo-${seed + 1}.jpg`, contentType: 'image/jpeg', bytes: base }
}

/** A flat two-colour mark on transparency, which is what a real logo looks like to the audit. */
export async function makeLogo(): Promise<FixtureImage> {
  const size = 512
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <circle cx="256" cy="256" r="236" fill="none" stroke="#0d3b66" stroke-width="60"/>
    <rect x="226" y="120" width="60" height="272" fill="#0d3b66"/>
    <rect x="120" y="226" width="272" height="60" fill="#f4a261"/>
  </svg>`

  return {
    filename: 'cold-front-logo.png',
    contentType: 'image/png',
    bytes: await sharp(Buffer.from(svg)).png().toBuffer(),
  }
}

/** Stats of the shape the browser computes at upload time. Honest about what was drawn. */
export const LOGO_STATS = {
  width: 512,
  height: 512,
  aspect: 1,
  flatRatio: 0.94,
  distinctColours: 4,
  hasTransparency: true,
  photographicScore: 0.06,
  dominant: ['#0d3b66', '#f4a261'],
}

export const PHOTO_STATS = {
  width: 4032,
  height: 3024,
  aspect: 1.333,
  flatRatio: 0.12,
  distinctColours: 190,
  hasTransparency: false,
  photographicScore: 0.72,
  dominant: ['#336699', '#6699cc'],
}
