import { config as loadEnvFiles } from 'dotenv'
import type { IntakePayload } from '../shared/intake'

/**
 * Seed the local database with a realistic test business, ready to click through.
 *
 *   npm run seed
 *
 * Runs against the API on http://localhost:8787 so it exercises real validation, real image
 * processing and the real gap audit, exactly as a customer would. It leaves behind:
 *
 *   1. a job sitting at the start of the intake wizard, so the wizard can be opened cold
 *   2. a job with intake already submitted, ready to generate
 *
 * The business below is invented for testing. It is not a real Go Polar customer.
 */

loadEnvFiles({ path: '.env.local', quiet: true })
loadEnvFiles({ path: '.env', quiet: true })

const BASE = process.env.SEED_BASE ?? 'http://localhost:8787'

const INTAKE: IntakePayload = {
  businessName: 'Cold Front Plumbing',
  trade: 'plumber',
  tradingEntityName: 'Cold Front Plumbing Pty Ltd',
  // Valid ABN checksum. Belongs to nobody: generated to satisfy the ATO algorithm for testing.
  abn: '51824753556',
  yearsInBusiness: 14,
  phone: '0412 345 678',
  email: 'jobs@coldfrontplumbing.com.au',
  address: { line1: '', suburb: 'Chermside', state: 'QLD', postcode: '4032', verified: true },

  services: [
    'Blocked drains',
    'Hot water systems',
    'Burst pipes',
    'Leak detection',
    'Tap and toilet repairs',
    'Gas fitting',
  ],
  primaryService: 'Blocked drains',
  ownPageServices: [],
  freeQuotes: true,
  emergency: true,

  baseSuburb: { name: 'Chermside', state: 'QLD', postcode: '4032', lat: -27.385, lng: 153.033 },
  suburbsServiced: [
    { name: 'Chermside', state: 'QLD', postcode: '4032', lat: -27.385, lng: 153.033 },
    { name: 'Aspley', state: 'QLD', postcode: '4034', lat: -27.363, lng: 153.02 },
    { name: 'Nundah', state: 'QLD', postcode: '4012', lat: -27.403, lng: 153.06 },
    { name: 'Clayfield', state: 'QLD', postcode: '4011', lat: -27.418, lng: 153.057 },
    { name: 'Stafford', state: 'QLD', postcode: '4053', lat: -27.409, lng: 153.01 },
    { name: 'Everton Park', state: 'QLD', postcode: '4053', lat: -27.402, lng: 152.993 },
    { name: 'Albany Creek', state: 'QLD', postcode: '4035', lat: -27.348, lng: 152.967 },
    { name: 'Strathpine', state: 'QLD', postcode: '4500', lat: -27.302, lng: 152.986 },
  ],
  travelRadius: '20',

  about:
    'Dad started Cold Front out of a ute in 1998 and I took it over in 2011. We are a two van outfit working the Brisbane northside, mostly drains and hot water. We answer the phone ourselves, we turn up when we say we will, and if we cannot get to you the same day we will tell you straight rather than leave you waiting.',
  different:
    'We do not subcontract. The bloke who quotes the job is the bloke who does the job, so nothing gets lost between the two.',
  hours: {
    mon: { closed: false, open: '06:30', close: '17:00' },
    tue: { closed: false, open: '06:30', close: '17:00' },
    wed: { closed: false, open: '06:30', close: '17:00' },
    thu: { closed: false, open: '06:30', close: '17:00' },
    fri: { closed: false, open: '06:30', close: '17:00' },
    sat: { closed: false, open: '07:00', close: '12:00' },
    sun: { closed: true, open: '08:00', close: '12:00' },
    byAppointment: false,
    isDefault: false,
  },
  reviews: [
    {
      quote:
        'Rang at 7am with a blocked main and they were here by 9. Cleared it, showed me the camera footage, and the price was what they said on the phone.',
      firstName: 'Marion',
      suburb: 'Aspley',
    },
    {
      quote:
        'Hot water went on a Sunday night. Got a new one in Monday morning and they took the old unit away. No mess, no fuss.',
      firstName: 'Dave',
      suburb: 'Nundah',
    },
    {
      quote: 'Second time we have used them. Straight answer on the phone and a fair price. Hard to find.',
      firstName: 'Priya',
      suburb: 'Clayfield',
    },
  ],
  googleReviewLink: '',
  socials: {
    facebook: 'https://www.facebook.com/coldfrontplumbing',
    instagram: '',
    linkedin: '',
    tiktok: '',
    youtube: '',
  },

  designStyle: 'auto',
  logoAssetId: null,
  photoAssetIds: [],
  palette: {
    primary: '#0d3b66',
    secondary: '#5a86ad',
    accent: '#f4a261',
    dark: '#14171a',
    light: '#f4f6f8',
    source: 'logo',
  },
  existingDomain: '',
}

let session: string | null = null

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (session) headers.set('authorization', `Bearer ${session}`)
  const res = await fetch(`${BASE}${path}`, { ...init, headers })
  const text = await res.text()
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${text.slice(0, 300)}`)
  return (text ? JSON.parse(text) : null) as T
}

async function upload(
  jobId: string,
  kind: 'logo' | 'photo',
  file: { filename: string; contentType: string; bytes: Buffer },
  stats: unknown,
) {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(file.bytes)], { type: file.contentType }), file.filename)
  form.append('kind', kind)
  form.append('stats', JSON.stringify(stats))

  const res = await fetch(`${BASE}/api/jobs/${jobId}/assets`, {
    method: 'POST',
    body: form,
    headers: session ? { authorization: `Bearer ${session}` } : {},
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`upload ${file.filename} -> ${res.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text) as { asset: { id: string }; saving: string }
}

async function createJob(email: string, label: string) {
  const created = await api<{ jobId: string; session: string; startLink: string }>('/api/dev/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, name: INTAKE.businessName }),
  })
  session = created.session
  console.log(`\n  ${label}`)
  console.log(`    job:  ${created.jobId}`)
  return created
}

async function main() {
  console.log(`Seeding against ${BASE}`)

  const health = await api<{ demoMode: boolean; offlineGeneration: boolean; anthropicKeyPresent: boolean }>(
    '/api/health',
  )
  console.log(
    `  mode: ${health.demoMode ? 'demo' : 'live'}, generation: ${
      health.offlineGeneration ? 'offline fixture' : health.anthropicKeyPresent ? 'Anthropic' : 'not configured'
    }`,
  )

  const { makeLogo, makePhoto, LOGO_STATS, PHOTO_STATS } = await import('./fixture-images')

  // --- job 1: empty, so the wizard can be opened from the first question --------------------
  const empty = await createJob('empty@coldfrontplumbing.com.au', 'Empty job, starts at the wizard')
  const emptyStart = empty.startLink

  // --- job 2: intake submitted, ready to generate -------------------------------------------
  const ready = await createJob('jobs@coldfrontplumbing.com.au', 'Submitted job, ready to generate')

  const logo = await makeLogo()
  const savedLogo = await upload(ready.jobId, 'logo', logo, LOGO_STATS)
  console.log(`    logo: ${savedLogo.saving}`)

  const photoIds: string[] = []
  for (let i = 0; i < 4; i++) {
    const photo = await makePhoto(i)
    const saved = await upload(ready.jobId, 'photo', photo, PHOTO_STATS)
    photoIds.push(saved.asset.id)
    console.log(`    photo ${i + 1}: ${saved.saving}`)
  }

  const payload = { ...INTAKE, logoAssetId: savedLogo.asset.id, photoAssetIds: photoIds }

  await api(`/api/jobs/${ready.jobId}/intake`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const submitted = await api<{ auditFlags: Array<{ code: string; message: string }> }>(
    `/api/jobs/${ready.jobId}/intake/submit`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
  )

  console.log(`\n  gap audit: ${submitted.auditFlags.length} flag(s)`)
  for (const f of submitted.auditFlags) console.log(`    [${f.code}] ${f.message}`)

  console.log('\nSeeded. Sign in with either link, the same way a paying customer would:')
  console.log(`\n  Start the wizard from scratch:\n    ${emptyStart}`)
  console.log(`\n  Straight to generating a site:\n    ${ready.startLink}`)
  console.log(`\nJOB_ID=${ready.jobId}`)
  console.log(`SESSION=${session}`)
}

main().catch((err) => {
  console.error('\nSeed failed:', err.message)
  process.exit(1)
})
