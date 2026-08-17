import { encodePng } from './png.mjs'

/**
 * Seed one realistic test business (brief Phase 1: "seed with one realistic test business").
 *
 * Run against a dev server:  npm run dev   then   node scripts/seed.mjs
 * Optional: BASE=http://localhost:5173 node scripts/seed.mjs
 *
 * It goes through the real API rather than writing SQL, so the seed exercises validation, the
 * suburb lookup, the R2 upload path and the gap audit exactly as a customer would.
 *
 * The business below is invented for testing. It is not a real Go Polar customer.
 */

const BASE = process.env.BASE ?? 'http://localhost:5173'

const INTAKE = {
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

// ---------------------------------------------------------------------------------------------

// Every job route is behind a session. The dev job-creation route hands one back, and it is sent
// as a bearer token from here rather than juggling a cookie jar.
let SESSION = null

async function api(path, init = {}) {
  const headers = { ...(init.headers ?? {}) }
  if (SESSION) headers.authorization = `Bearer ${SESSION}`
  const res = await fetch(`${BASE}${path}`, { ...init, headers })
  const text = await res.text()
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

function makeLogo() {
  // Flat two-colour mark on transparency. Reads as a real logo to the gap audit, which is the
  // point: it exercises the "image" logo treatment rather than the CSS logotype fallback.
  const size = 512
  return encodePng(size, size, (x, y) => {
    const cx = x - size / 2
    const cy = y - size / 2
    const r = Math.sqrt(cx * cx + cy * cy)
    if (r > size * 0.46) return [0, 0, 0, 0]
    if (r > size * 0.34) return [13, 59, 102, 255]
    if (Math.abs(cx) < size * 0.06 || Math.abs(cy) < size * 0.06) return [244, 162, 97, 255]
    return [13, 59, 102, 255]
  })
}

function makePhoto(seed) {
  // Textured gradient, large enough to count as a usable photo (min edge 600, over 20KB).
  const w = 1200
  const h = 800
  return encodePng(w, h, (x, y) => {
    const n = Math.sin((x + seed * 90) / 47) * Math.cos((y + seed * 30) / 61)
    const t = (x / w) * 0.6 + (y / h) * 0.4
    const base = [20 + seed * 25, 60 + seed * 20, 110 - seed * 12]
    return [
      Math.min(255, base[0] + t * 120 + n * 26),
      Math.min(255, base[1] + t * 90 + n * 26),
      Math.min(255, base[2] + t * 70 + n * 26),
      255,
    ]
  })
}

// Fixture stats, stated honestly rather than measured: the browser normally computes these on
// upload (src/lib/image.ts) and this script has no canvas. The values describe what was actually
// drawn above.
const LOGO_STATS = {
  width: 512,
  height: 512,
  aspect: 1,
  flatRatio: 0.94,
  distinctColours: 4,
  hasTransparency: true,
  photographicScore: 0.06,
  dominant: ['#003366', '#ff9966'],
}

const PHOTO_STATS = {
  width: 1200,
  height: 800,
  aspect: 1.5,
  flatRatio: 0.12,
  distinctColours: 190,
  hasTransparency: false,
  photographicScore: 0.72,
  dominant: ['#336699', '#6699cc'],
}

async function upload(jobId, kind, filename, bytes, stats) {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'image/png' }), filename)
  form.append('kind', kind)
  form.append('stats', JSON.stringify(stats))
  const res = await fetch(`${BASE}/api/jobs/${jobId}/assets`, {
    method: 'POST',
    body: form,
    headers: SESSION ? { authorization: `Bearer ${SESSION}` } : {},
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`upload ${filename} -> ${res.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text).asset
}

async function main() {
  console.log(`Seeding against ${BASE}`)

  const health = await api('/api/health')
  console.log(
    `  health: anthropic key ${health.anthropicKeyPresent ? 'present' : 'absent'}, offline fixture ${
      health.offlineGeneration ? 'on' : 'off'
    }, browser rendering ${health.browserRendering ? 'bound' : 'unbound'}`,
  )

  const created = await api('/api/dev/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: INTAKE.email, name: INTAKE.businessName }),
  })
  const jobId = created.jobId
  SESSION = created.session
  console.log(`  job: ${jobId}`)

  const logo = await upload(jobId, 'logo', 'cold-front-logo.png', makeLogo(), LOGO_STATS)
  console.log(`  logo: ${logo.id} (${logo.bytes} bytes)`)

  const photos = []
  for (let i = 0; i < 4; i++) {
    const asset = await upload(jobId, 'photo', `job-photo-${i + 1}.png`, makePhoto(i), PHOTO_STATS)
    photos.push(asset)
    console.log(`  photo ${i + 1}: ${asset.id} (${asset.bytes} bytes)`)
  }

  const payload = {
    ...INTAKE,
    logoAssetId: logo.id,
    photoAssetIds: photos.map((p) => p.id),
  }

  await api(`/api/jobs/${jobId}/intake`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const submitted = await api(`/api/jobs/${jobId}/intake/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

  console.log(`\n  gap audit: ${submitted.auditFlags.length} flag(s)`)
  for (const f of submitted.auditFlags) console.log(`    [${f.code}] ${f.message}`)

  console.log('\nSeeded. Sign in with the link below, the same way a paying customer would:')
  console.log(`  ${created.startLink}`)
  console.log(`\nThen: ${BASE}/build/${jobId} to generate, ${BASE}/preview/${jobId} to edit.`)
  console.log(`JOB_ID=${jobId}`)
  console.log(`SESSION=${SESSION}`)
}

main().catch((err) => {
  console.error('\nSeed failed:', err.message)
  process.exit(1)
})
