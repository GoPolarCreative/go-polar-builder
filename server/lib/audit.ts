import type { AssetRecord, AuditFlag } from '../../shared/types.js'
import type { IntakePayload } from '../../shared/intake.js'

/**
 * Server-side gap audit. Brief s4.
 *
 * Runs after submission, before generation. NOTHING HERE BLOCKS. Every finding is a friendly
 * inline prompt plus a decision the generator acts on, because a tradie who hits a hard error at
 * the end of a five step form does not come back.
 *
 * The image judgements lean on stats computed in the browser at upload time (src/lib/image.ts),
 * because that is where the pixels already are.
 */

/** Judged on the source image, before processing. A small original cannot be made big. */
const USABLE_PHOTO_MIN_EDGE = 600
const WIDE_LOCKUP_ASPECT = 3.2
const LOGO_MIN_WIDTH = 400

export function isUsablePhoto(a: AssetRecord): boolean {
  if (a.kind !== 'photo') return false
  const w = a.width ?? a.stats?.width ?? 0
  const h = a.height ?? a.stats?.height ?? 0
  if (Math.min(w, h) < USABLE_PHOTO_MIN_EDGE) return false
  if ((a.originalBytes ?? 0) < 20_000) return false
  return true
}

/**
 * A "mockup render" is a logo composited onto a photograph: a sign, a van, a business card shot.
 * It cannot be used as a header logo because it carries its own background.
 * Signals: photographic texture, no transparency, few large flat areas, many distinct colours.
 */
function looksLikeMockupRender(logo: AssetRecord): boolean {
  const s = logo.stats
  if (!s) return false
  if ((logo.contentType ?? '').includes('svg')) return false
  if (s.hasTransparency) return false
  return s.photographicScore >= 0.55 && s.flatRatio < 0.4 && s.distinctColours > 120
}

/**
 * Pull any stated tenure out of the free-text description so it can be checked against the
 * years-in-business number. Catches "over 20 years", "since 2004", "two decades".
 * Returns years, or null when the text does not claim a tenure.
 */
export function statedYearsFromText(text: string, nowYear: number): number | null {
  const t = text.toLowerCase()

  const since = t.match(/\b(?:since|established(?:\s+in)?|est\.?|operating since)\s+((?:19|20)\d{2})\b/)
  if (since?.[1]) {
    const year = Number(since[1])
    if (year >= 1900 && year <= nowYear) return nowYear - year
  }

  const explicit = t.match(/\b(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/)
  if (explicit?.[1]) return Number(explicit[1])

  const words: Record<string, number> = {
    ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  }
  const worded = t.match(/\b(ten|fifteen|twenty|thirty|forty|fifty)\s*(?:\+|plus)?\s*years?\b/)
  if (worded?.[1] && words[worded[1]] !== undefined) return words[worded[1]]!

  if (/\bhalf a century\b/.test(t)) return 50
  const decades = t.match(/\b(a|one|two|three|four|five)\s+decades?\b/)
  if (decades?.[1]) {
    const map: Record<string, number> = { a: 10, one: 10, two: 20, three: 30, four: 40, five: 50 }
    return map[decades[1]] ?? null
  }
  return null
}

export function runGapAudit(
  intake: IntakePayload,
  assets: AssetRecord[],
  opts: { now?: Date } = {},
): AuditFlag[] {
  const flags: AuditFlag[] = []
  const now = opts.now ?? new Date()

  const logo =
    assets.find((a) => a.kind === 'logo' && a.id === intake.logoAssetId) ??
    assets.find((a) => a.kind === 'logo')
  const photos = assets.filter((a) => a.kind === 'photo')
  const usablePhotos = photos.filter(isUsablePhoto)

  // ---- Logo ---------------------------------------------------------------------------------
  if (!logo) {
    flags.push({
      code: 'logo_missing',
      severity: 'attention',
      field: 'logoAssetId',
      message:
        'No logo uploaded. We will set your business name in type for now, which looks clean, but a real logo lifts the whole site.',
      buildEffect: 'logoTreatment=css-logotype, CLIENT TO SUPPLY comment added for logo artwork',
    })
  } else {
    if (looksLikeMockupRender(logo)) {
      flags.push({
        code: 'logo_mockup_render',
        severity: 'attention',
        field: 'logoAssetId',
        message:
          'That logo file looks like a mockup image, your logo photographed or placed on a background rather than the artwork itself. We cannot use it in the header. If you can get the original file from your designer (PNG with a transparent background, or SVG), send it through and we will swap it in.',
        buildEffect:
          'logoTreatment=css-logotype, mockup not used anywhere, CLIENT TO SUPPLY comment added',
      })
    } else {
      const aspect = logo.stats?.aspect ?? (logo.width && logo.height ? logo.width / logo.height : 1)
      if (aspect >= WIDE_LOCKUP_ASPECT) {
        flags.push({
          code: 'logo_wide_lockup',
          severity: 'info',
          message:
            'Your logo is a wide one. At header size a wide logo goes unreadable, so we will use the icon part up top with your name set beside it, and the full logo larger in the footer.',
          buildEffect: 'logoTreatment=cropped-mark, full logo used in footer at larger size',
        })
      }
      const w = logo.width ?? logo.stats?.width ?? 0
      if (w > 0 && w < LOGO_MIN_WIDTH && !(logo.contentType ?? '').includes('svg')) {
        flags.push({
          code: 'logo_low_resolution',
          severity: 'info',
          message: `Your logo is only ${w}px wide, so it may look soft on a big screen. A larger version or an SVG would sharpen it up.`,
          buildEffect: 'logo used as supplied, capped at its natural width so it is not upscaled',
        })
      }
    }
  }

  if (intake.palette.source === 'default') {
    flags.push({
      code: 'palette_defaulted',
      severity: 'info',
      message:
        'We could not pull colours from a logo, so the site uses a neutral navy and grey scheme. You can change any colour in the preview.',
      buildEffect: 'default palette tokens used',
    })
  }

  // ---- Photos -------------------------------------------------------------------------------
  if (usablePhotos.length < 3) {
    flags.push({
      code: 'photos_insufficient',
      severity: 'attention',
      field: 'photoAssetIds',
      message:
        usablePhotos.length === 0
          ? 'No usable photos yet, so we are leaving the gallery out rather than filling it with stock images of someone else. Job photos off your phone are exactly right. Add three or more and we will build it in.'
          : `Only ${usablePhotos.length} of your photos are big enough for a gallery, and we need at least 3. We are leaving the gallery out for now rather than stretching small images.`,
      buildEffect: 'gallery section skipped, CSS gradients used for section backgrounds, flagged',
    })
    if (photos.length > usablePhotos.length) {
      flags.push({
        code: 'photos_low_quality',
        severity: 'info',
        message: `${photos.length - usablePhotos.length} photo${photos.length - usablePhotos.length === 1 ? '' : 's'} came through too small to use. Photos straight off your phone, not screenshots or images saved from Facebook, work best.`,
        buildEffect: 'undersized photos excluded from the gallery',
      })
    }
  }

  // ---- Years vs story ------------------------------------------------------------------------
  const stated = statedYearsFromText(
    `${intake.about} ${intake.different ?? ''}`,
    now.getUTCFullYear(),
  )
  if (stated !== null && Math.abs(stated - intake.yearsInBusiness) >= 3) {
    flags.push({
      code: 'years_contradicts_story',
      severity: 'attention',
      field: 'yearsInBusiness',
      message: `You told us ${intake.yearsInBusiness} years in business, but your description reads like about ${stated}. Which one should go on the site?`,
      buildEffect:
        'the number from the years field is used, and the sentence is flagged CONFIRM WITH CLIENT BEFORE LAUNCH',
    })
  }

  // ---- Hours --------------------------------------------------------------------------------
  if (intake.hours.isDefault) {
    flags.push({
      code: 'hours_defaulted',
      severity: 'attention',
      field: 'hours',
      message:
        'We have used standard trade hours, Monday to Friday 7am to 5pm. Worth a look before you go live, since these show on Google.',
      buildEffect: 'default hours used, flagged CONFIRM WITH CLIENT BEFORE LAUNCH in the HTML',
    })
  }

  // ---- Proof and NAP -------------------------------------------------------------------------
  if (intake.reviews.length === 0) {
    flags.push({
      code: 'no_reviews',
      severity: 'info',
      message:
        'No reviews supplied, so we are not building a testimonials section. We will not write fake ones. Send real ones through any time and we will add them.',
      buildEffect: 'testimonials section omitted entirely',
    })
  }

  const addr = intake.address
  if (!addr?.line1 || !addr?.suburb || !addr?.postcode) {
    flags.push({
      code: 'no_address',
      severity: 'info',
      message:
        'No street address given. That is normal for a mobile trade. We will use your base suburb for the location signals instead.',
      buildEffect: 'PostalAddress limited to suburb, state and postcode, no streetAddress emitted',
    })
  }

  if (intake.suburbsServiced.length < 5) {
    flags.push({
      code: 'service_area_thin',
      severity: 'info',
      message: `You have listed ${intake.suburbsServiced.length} suburbs. More suburbs means more local searches you can turn up in, so add any you would happily drive to.`,
      buildEffect: 'service area section built with the suburbs supplied',
    })
  }

  return flags
}
