import type { AssetRecord } from '../../shared/types'
import type { BuildFacts } from '../../shared/plan'
import { DAYS, DAY_LABELS, type Day, type IntakePayload } from '../../shared/intake'
import { formatAuPhone, normaliseAuPhone } from '../../shared/phone'
import { isUsablePhoto } from './audit'
import type { Env } from '../env'
import { web3formsKey } from '../env'

/**
 * BuildFacts are the things the model is not allowed to reword: phone numbers, the Web3Forms
 * key, form subjects, asset paths, opening hours. They are computed here, handed to the build
 * call as literals, and checked afterwards. Letting the model retype a phone number is how you
 * end up with a site that rings nobody.
 */

const ASSET_DIR = 'assets'

export function logoPath(logo: AssetRecord | undefined): string | null {
  if (!logo) return null
  const ext = extFor(logo)
  return `${ASSET_DIR}/logo.${ext}`
}

export function photoPath(index: number, asset: AssetRecord): string {
  return `${ASSET_DIR}/photo-${String(index + 1).padStart(2, '0')}.${extFor(asset)}`
}

function extFor(a: AssetRecord): string {
  const t = a.content_type ?? ''
  if (t.includes('svg')) return 'svg'
  if (t.includes('png')) return 'png'
  if (t.includes('webp')) return 'webp'
  return 'jpg'
}

/** Display lines for the contact block: "Monday to Friday: 7:00am to 5:00pm". */
export function hoursLines(intake: IntakePayload): string[] {
  const h = intake.hours
  if (h.byAppointment) return ['By appointment']

  const lines: string[] = []
  let runStart: Day | null = null
  let runEnd: Day | null = null
  let runKey = ''

  const keyFor = (d: Day) => {
    const day = h[d]
    return day.closed ? 'closed' : `${day.open}-${day.close}`
  }

  const flush = () => {
    if (!runStart || !runEnd) return
    const label =
      runStart === runEnd
        ? DAY_LABELS[runStart]
        : `${DAY_LABELS[runStart]} to ${DAY_LABELS[runEnd]}`
    if (runKey === 'closed') lines.push(`${label}: Closed`)
    else {
      const [open, close] = runKey.split('-') as [string, string]
      lines.push(`${label}: ${to12h(open)} to ${to12h(close)}`)
    }
  }

  for (const d of DAYS) {
    const key = keyFor(d)
    if (key === runKey && runEnd) {
      runEnd = d
    } else {
      flush()
      runStart = d
      runEnd = d
      runKey = key
    }
  }
  flush()
  return lines
}

function to12h(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(':') as [string, string]
  const h = Number(hStr)
  const suffix = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return mStr === '00' ? `${h12}${suffix}` : `${h12}:${mStr}${suffix}`
}

const SCHEMA_DAY: Record<Day, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
}

/** schema.org openingHoursSpecification, grouped so identical days share one entry. */
export function openingHoursSpec(
  intake: IntakePayload,
): Array<{ days: string[]; opens: string; closes: string }> {
  const h = intake.hours
  if (h.byAppointment) return []

  const groups = new Map<string, string[]>()
  for (const d of DAYS) {
    const day = h[d]
    if (day.closed) continue
    const key = `${day.open}-${day.close}`
    const list = groups.get(key) ?? []
    list.push(SCHEMA_DAY[d])
    groups.set(key, list)
  }
  return [...groups.entries()].map(([key, days]) => {
    const [opens, closes] = key.split('-') as [string, string]
    return { days, opens, closes }
  })
}

export function buildFacts(
  env: Env,
  intake: IntakePayload,
  assets: AssetRecord[],
  opts: { canonicalUrl?: string } = {},
): BuildFacts {
  const logo = assets.find((a) => a.kind === 'logo')
  const usablePhotos = assets
    .filter(isUsablePhoto)
    .sort((a, b) => a.sort_order - b.sort_order)

  const e164 = normaliseAuPhone(intake.phone) ?? intake.phone
  const business = intake.businessName

  const address =
    intake.address?.line1 && intake.address?.suburb && intake.address?.postcode
      ? {
          line1: intake.address.line1,
          suburb: intake.address.suburb,
          state: intake.address.state ?? intake.baseSuburb.state,
          postcode: intake.address.postcode,
        }
      : null

  return {
    businessName: business,
    phoneE164: e164,
    phoneDisplay: formatAuPhone(e164),
    email: intake.email,
    abn: intake.abn ? intake.abn.replace(/\D/g, '') : null,
    address,
    hoursLines: hoursLines(intake),
    openingHoursSpec: openingHoursSpec(intake),
    byAppointment: intake.hours.byAppointment,
    emergency: intake.emergency,
    freeQuotes: intake.freeQuotes,
    // Injected server side. The customer is never asked for this (brief s4, removed on purpose).
    web3formsKey: web3formsKey(env),
    // Exact subject lines from the brief. Verification checks these strings.
    heroFormSubject: `${business} - Hero Form Enquiry`,
    contactFormSubject: `${business} - Contact Page Enquiry`,
    logoPath: logoPath(logo),
    photoPaths: usablePhotos.map((a, i) => ({ assetId: a.id, path: photoPath(i, a) })),
    canonicalUrl: opts.canonicalUrl ?? `https://www.${slugDomain(business)}.com.au/`,
    googleReviewLink: intake.googleReviewLink || null,
  }
}

function slugDomain(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 40) || 'example'
}
