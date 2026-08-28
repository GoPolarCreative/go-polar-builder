/**
 * Build a website for one of the three businesses from the old Google Form sheet.
 *
 *   node scripts/build-from-sheet.mjs lsv|driftwood|pestaside
 *
 * WHAT THIS IS AND IS NOT. It is not a shortcut around the product: every step goes through the
 * same HTTP routes a customer's browser uses, including the intake submit that re-validates
 * everything server side. It exists because the source data is a spreadsheet rather than a person
 * at a keyboard, and somebody has to make the judgement calls the old form never captured.
 *
 * EVERY VALUE THAT IS NOT VERBATIM FROM THE SHEET IS MARKED. Look for DECISION. The old form is
 * the thing the intake redesign was built to replace, and it shows: no ABN column, no hours, no
 * postcode, no travel radius, no primary service, regions typed into the suburbs field, and free
 * text where numbers belong. Each of those is a decision made here, not a fact recovered.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE = process.env.BASE ?? 'http://localhost:8787'
const which = process.argv[2]

// ------------------------------------------------------------------------------------------
// Shared
// ------------------------------------------------------------------------------------------
const HOURS = {
  mon: { closed: false, open: '07:00', close: '17:00' },
  tue: { closed: false, open: '07:00', close: '17:00' },
  wed: { closed: false, open: '07:00', close: '17:00' },
  thu: { closed: false, open: '07:00', close: '17:00' },
  fri: { closed: false, open: '07:00', close: '17:00' },
  sat: { closed: true, open: '08:00', close: '12:00' },
  sun: { closed: true, open: '08:00', close: '12:00' },
  byAppointment: false,
  isDefault: true,
}
const NO_SOCIALS = { facebook: '', instagram: '', linkedin: '', tiktok: '', youtube: '' }
/*
 * A suburb is name, state, postcode AND coordinates. The coordinates are not in the spreadsheet
 * and must not be invented: they drive the geo meta tags and the LocalBusiness schema, so a made
 * up pair puts the business somewhere it is not. Each one is resolved through the same
 * /api/lookup/suburbs endpoint the wizard's picker calls, and a name that does not resolve to
 * exactly the state and postcode asked for stops the run rather than being guessed at.
 */
const sub = (name, state, postcode) => ({ name, state, postcode, lat: null, lng: null })

async function resolveSuburb(ref) {
  const res = await fetch(BASE + '/api/lookup/suburbs?q=' + encodeURIComponent(ref.name))
  if (!res.ok) throw new Error('suburb lookup failed for ' + ref.name + ': HTTP ' + res.status)
  const body = await res.json()
  const list = Array.isArray(body) ? body : (body.suburbs ?? body.results ?? [])
  const hit = list.find(
    (s) =>
      String(s.name).toLowerCase() === ref.name.toLowerCase() &&
      s.state === ref.state &&
      String(s.postcode) === ref.postcode,
  )
  if (!hit) {
    throw new Error(
      'no exact match for ' + ref.name + ' ' + ref.state + ' ' + ref.postcode +
        '. Candidates: ' + list.map((s) => s.name + ' ' + s.state + ' ' + s.postcode).join(', '),
    )
  }
  return { name: hit.name, state: hit.state, postcode: String(hit.postcode), lat: hit.lat, lng: hit.lng }
}

// ------------------------------------------------------------------------------------------
const BUSINESSES = {
  lsv: {
    label: 'LSV Services',
    pagesAllowed: 3,
    assets: null,
    intake: {
      businessName: 'LSV Services',
      // DECISION: no listed trade fits. They do grounds maintenance, gutters, solar cleaning and
      // facilities management, which spans landscaper and several others. 'other' is the honest
      // answer rather than forcing them into 'landscaper' and having the copy talk about gardens.
      trade: 'other',
      tradingEntityName: '',
      abn: '', // The sheet has no ABN column at all.
      yearsInBusiness: 4, // Verbatim: "4".
      phone: '0401697323',
      email: 'lachlan@lsvservices.com.au',
      address: { line1: '', suburb: '', postcode: '', verified: false },
      services: [
        'Grounds Maintenance',
        'Gutter Cleaning',
        'Solar Panel Cleaning',
        'Pressure Washing',
        'Licensed Weed Spraying',
        'Facilities Management',
      ],
      primaryService: 'Grounds Maintenance', // DECISION: first listed, and the About leads with it.
      freeQuotes: true,
      emergency: true,
      /*
       * DECISION, AND THE BIGGEST ONE FOR THIS BUSINESS. The sheet's "Areas You Service" reads
       * "Snowy Valleys, Snowy Monaro, Riverina, ACT, Northern Victoria". Those are REGIONS. All
       * five were checked against the suburb dataset and not one resolves. These are real towns
       * inside those regions, chosen to span them, and they are a guess at intent.
       */
      baseSuburb: sub('Tumut', 'NSW', '2720'),
      suburbsServiced: [
        sub('Tumut', 'NSW', '2720'),
        sub('Tumbarumba', 'NSW', '2653'),
        sub('Batlow', 'NSW', '2730'),
        sub('Adelong', 'NSW', '2729'),
        sub('Gundagai', 'NSW', '2722'),
        sub('Cooma', 'NSW', '2630'),
        sub('Wagga Wagga', 'NSW', '2650'),
        sub('Albury', 'NSW', '2640'),
      ],
      travelRadius: 'statewide', // DECISION: they claim four regions across NSW, ACT and Victoria.
      /*
       * TRIMMED. The sheet's About is 694 characters and the schema caps it at 600. This is their
       * own wording with the closing sentence about compliance standards removed, because that
       * point is already made at length in the "what makes you better" answer.
       */
      about:
        'LSV Services is a facilities maintenance provider supporting residential, commercial and government clients across the Snowy Valleys, Riverina, ACT and Northern Victoria. We deliver a broad range of site services: grounds maintenance, gutter cleaning, solar panel cleaning, pressure washing, and general property upkeep. Our capability is not limited to a fixed list. Whatever the property needs, we find and deliver the solution. We handle work with our own crews and coordinate a vetted network of licensed trades where needed.',
      different:
        'We are punctual, reliable and committed to getting the job done right. We turn up when we say we will, communicate transparently at every step, and deliver quickly without cutting corners. As a local operator we know the region and the conditions, and we are responsive when something needs sorting quickly. We work to the compliance, safety and reporting standards that commercial and government clients expect, with the insurances and accreditations to back it up. We hold AQF3 Chemical Spraying accreditation, which a lot of operators do not have.',
      hours: HOURS, // The sheet has no hours column. Default Mon-Fri 7-5.
      reviews: [], // The sheet gave a Google review LINK, not review text. Nothing to quote.
      googleReviewLink: 'https://g.page/r/CSCafEnf1Wc0EBM/review',
      socials: NO_SOCIALS,
      logoAssetId: null, // No logo supplied.
      designStyle: 'modern', // Sheet: "Clean & modern".
      photoAssetIds: [],
      /*
       * DECISION: built from the sheet's prose, "Mainly black, with white and/or yellow #FFD100
       * accents". #FFD100 is the only hex value any of the three supplied. source is 'manual'
       * because it came from a person's sentence, not from sampling artwork.
       */
      palette: {
        primary: '#1A1A1A',
        secondary: '#3D3D3D',
        accent: '#FFD100',
        dark: '#0D0D0D',
        light: '#F7F7F5',
        source: 'manual',
      },
      existingDomain: 'lsvservices.com.au',
    },
    ownPageServices: ['Grounds Maintenance', 'Gutter Cleaning'],
  },

  driftwood: {
    label: 'Driftwood Building Co',
    pagesAllowed: 3,
    assets: 'intake-assets/driftwood-building-co',
    intake: {
      businessName: 'Driftwood Building Co',
      trade: 'builder',
      tradingEntityName: '',
      abn: '',
      /*
       * DECISION. The sheet says "New business" in a field the schema requires to be a whole
       * number of years, minimum 1. Their About confirms it: the builder's licence is still in
       * approval. 1 is the smallest truthful number the form will take.
       */
      yearsInBusiness: 1,
      /*
       * DECISION, AND THE ONE MOST WORTH CHECKING. This row carries THREE different numbers:
       * 0431626282 as "Best Phone Number for Customers", and "0432526382 & 0400522162" as "What
       * phone number should appear on the website". The first two differ by a digit transposition,
       * which suggests one is a typo of the other, and there is no way to tell which from here.
       * The "best number for customers" field is used because its meaning is unambiguous.
       */
      phone: '0431626282',
      // DECISION: the sheet's enquiry field holds two addresses joined by "&". Damian's is used
      // because he is the primary contact on the row; Dean's is dropped rather than mangled.
      email: 'Damian.s@driftwoodbc.com.au',
      address: { line1: '', suburb: '', postcode: '', verified: false },
      // Verbatim from the sheet, with the trailing full stop removed and capitalisation tidied.
      services: [
        'Commercial Carpentry',
        'Domestic Carpentry',
        'Decks',
        'Pergolas',
        'Internal Fitout',
        'Cladding',
      ],
      primaryService: 'Commercial Carpentry', // DECISION: first listed; the About leads with commercial.
      freeQuotes: true,
      emergency: true,
      /*
       * DECISION. The sheet says "Bass coast, Phillip island," which is two regions and a trailing
       * comma, and the schema needs at least three real suburbs. Neither region resolves. These
       * are the towns inside them.
       */
      baseSuburb: sub('Wonthaggi', 'VIC', '3995'),
      suburbsServiced: [
        sub('Wonthaggi', 'VIC', '3995'),
        sub('Cowes', 'VIC', '3922'),
        sub('Inverloch', 'VIC', '3996'),
        sub('San Remo', 'VIC', '3925'),
        sub('Cape Woolamai', 'VIC', '3925'),
        sub('Newhaven', 'VIC', '3925'),
      ],
      travelRadius: '40',
      about:
        'Newly established carpentry company servicing the Bass Coast and Phillip Island. We plan to offer emergency callout for commercial and residential maintenance and make safes, along with picking up our own jobs. Our builders licence is currently waiting on approvals, which can take a few months. In the meantime we are taking on small commercial packages, our own domestic jobs, and owner builder supervision.',
      different:
        'Honest, reliable and efficient trades business to deal with, with quality a priority. We both have 15+ years experience as carpenters, with extensive experience in management.',
      hours: HOURS,
      reviews: [],
      googleReviewLink: '',
      socials: NO_SOCIALS,
      logoAssetId: null, // filled in after upload
      designStyle: 'established', // Sheet: "Premium/high-end".
      photoAssetIds: [], // filled in after upload
      // Replaced after the logo is sampled. Sheet said "Match logo, black and light brown".
      palette: {
        primary: '#2B2B2B',
        secondary: '#6B5644',
        accent: '#A8815A',
        dark: '#1A1A1A',
        light: '#F5F1EC',
        source: 'logo',
      },
      existingDomain: 'driftwoodbc.com.au', // Sheet had "Www.driftwoodbc.com.au".
    },
    ownPageServices: ['Commercial Carpentry', 'Decks'],
  },

  pestaside: {
    label: 'Pest-Aside Sydney',
    /*
     * ELEVEN PAGES: the home page plus one for each of the ten pest types. Chris changed this
     * from a single page so the services become real destinations rather than a list, which also
     * gives the "view our services" button somewhere genuine to point.
     */
    pagesAllowed: 11,
    assets: null,
    intake: {
      businessName: 'Pest-Aside Sydney',
      trade: 'pest',
      tradingEntityName: '',
      abn: '',
      yearsInBusiness: 2,
      phone: '0424111201',
      email: 'Info@pestasidesydney.com.au',
      address: { line1: '', suburb: '', postcode: '', verified: false },
      /*
       * TEN SERVICES, VERBATIM FROM THE APPROVED COPY'S OWN LIST, in his order. This is what moved
       * the schema cap from eight to ten. The original spreadsheet answer listed eighty-eight,
       * which is the thing the cap is for; this list is the customer's considered version.
       */
      services: [
        'Cockroach Control',
        'Rodent Control',
        'Spider Control',
        'Ant Control',
        'Wasp Control',
        'Bee Control',
        'Flea Control',
        'Silverfish Control',
        'Mosquito Control',
        'Bed Bug Control',
      ],
      // DECISION: first in his own list. He did not nominate one.
      primaryService: 'Cockroach Control',
      freeQuotes: true,
      emergency: true,
      baseSuburb: sub('Sydney', 'NSW', '2000'),
      suburbsServiced: [
        sub('Sydney', 'NSW', '2000'),
        sub('Parramatta', 'NSW', '2150'),
        sub('Bondi Junction', 'NSW', '2022'),
        sub('Chatswood', 'NSW', '2067'),
        sub('Hurstville', 'NSW', '2220'),
        sub('Liverpool', 'NSW', '2170'),
        sub('Blacktown', 'NSW', '2148'),
        sub('Penrith', 'NSW', '2750'),
        sub('Manly', 'NSW', '2095'),
        sub('Randwick', 'NSW', '2031'),
        sub('Bankstown', 'NSW', '2200'),
        sub('Ryde', 'NSW', '2112'),
      ],
      travelRadius: 'statewide',
      /*
       * APPROVED COPY, WORD FOR WORD. This is his "HELPING SYDNEY FAMILIES & BUSINESSES LIVE
       * PEST-FREE" section, which is what the About section is. Not rewritten, not tightened, not
       * put into anybody else's voice. The only change is the ampersand, because it is in a
       * heading rather than in this paragraph.
       */
      about:
        "At Pest-Aside Sydney, we have a genuine passion for helping Sydney families and businesses live and operate pest-free. We're committed to delivering reliable, professional pest control with safe, effective treatments and long-lasting results that protect your home or workplace all year round. Our goal is simple: to keep Sydney homes and businesses pest-free with professional service and long-lasting protection.",
      /*
       * APPROVED COPY, WORD FOR WORD. His "WHY CHOOSE PEST-ASIDE SYDNEY?" paragraph followed by
       * his seven bullet points. The bullets are kept as sentences rather than as a list because
       * this is a text field; the renderer turns them into the why-us cards with the inline SVG
       * ticks the house rules already specify.
       *
       * This is the copy that needed the field's cap raised from 600 to 1200.
       */
      different:
        "Choosing Pest-Aside Sydney means choosing trusted local pest control backed by genuine care, professional service and a proven track record of protecting Sydney homes and businesses. We're passionate about helping families and businesses live and operate pest-free, with every treatment tailored to deliver safe, effective and long-lasting protection. Trusted local Sydney pest control specialists. Fully licensed and insured technicians. Proven track record of reliable results. Tailored treatments for every home and business. Same-day service available for urgent pest problems. Safe, effective and long-lasting pest control solutions. Residential, commercial and industrial pest management.",
      hours: HOURS,
      // Still nothing quotable. The spreadsheet gave seven names and no review text.
      reviews: [],
      googleReviewLink: '',
      socials: NO_SOCIALS,
      logoAssetId: null,
      designStyle: 'established',
      photoAssetIds: [],
      palette: {
        primary: '#1d3557',
        secondary: '#457b9d',
        accent: '#e63946',
        dark: '#14171a',
        light: '#f4f6f8',
        source: 'default',
      },
      existingDomain: 'pestasidesydney.com.au',
    },
    /*
     * A PAGE FOR EVERY PEST TYPE, in his order. Eleven pages: the home page plus ten.
     *
     * This is the largest page set this pipeline has been asked for. The previous maximum
     * exercised was three.
     */
    ownPageServices: [
      'Cockroach Control',
      'Rodent Control',
      'Spider Control',
      'Ant Control',
      'Wasp Control',
      'Bee Control',
      'Flea Control',
      'Silverfish Control',
      'Mosquito Control',
      'Bed Bug Control',
    ],
  },
}

// ------------------------------------------------------------------------------------------
const spec = BUSINESSES[which]
if (!spec) {
  console.error('usage: node scripts/build-from-sheet.mjs ' + Object.keys(BUSINESSES).join('|'))
  process.exit(1)
}

const adminToken = readFileSync('.env.local', 'utf8')
  .split('\n')
  .find((l) => l.startsWith('ADMIN_TOKEN='))
  ?.slice('ADMIN_TOKEN='.length)
  .trim()
  .replace(/^["']|["']$/g, '')

const j = async (path, init = {}) => {
  const res = await fetch(BASE + path, init)
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  if (!res.ok) {
    console.error('HTTP ' + res.status + ' ' + path)
    console.error(typeof body === 'string' ? body.slice(0, 800) : JSON.stringify(body, null, 2).slice(0, 1600))
    process.exit(1)
  }
  return body
}

console.log('=== ' + spec.label + ' ===')

// 1. A job, created the way the operator tool creates one.
const created = await j('/api/admin/test-job', {
  method: 'POST',
  headers: { 'x-admin-token': adminToken, 'content-type': 'application/json' },
  body: JSON.stringify({ name: spec.label }),
})
const jobId = created.jobId
console.log('job          ' + jobId)

// 2. A session, through the same /start exchange a customer's browser does.
const token = new URL(created.startLink).searchParams.get('t')
const started = await j('/api/auth/start', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token }),
})
const auth = { authorization: 'Bearer ' + started.session }
console.log('session      ok')

// 3. Assets, through the real upload route so they get compressed and variant-ed as usual.
const payload = { ...spec.intake }
if (spec.assets && existsSync(spec.assets)) {
  const { readdirSync } = await import('node:fs')
  const files = readdirSync(spec.assets)
  const logoFile = files.find((f) => f === 'logo.png')
  const photos = files.filter((f) => /\.(jpe?g|png)$/i.test(f) && f !== 'logo.png').sort()

  const upload = async (file, kind) => {
    const buf = readFileSync(resolve(spec.assets, file))
    const form = new FormData()
    form.set('kind', kind)
    form.set('file', new File([buf], file, { type: file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg' }))
    const r = await fetch(BASE + '/api/jobs/' + jobId + '/assets', { method: 'POST', headers: auth, body: form })
    const b = await r.json().catch(() => ({}))
    if (!r.ok) {
      console.error('  upload FAILED ' + file + ': ' + JSON.stringify(b).slice(0, 300))
      return null
    }
    return b
  }

  if (logoFile) {
    const r = await upload(logoFile, 'logo')
    if (r?.asset?.id) {
      payload.logoAssetId = r.asset.id
      console.log('logo         ' + logoFile + ' -> ' + r.asset.id)
    }
  }
  const ids = []
  for (const p of photos) {
    const r = await upload(p, 'photo')
    if (r?.asset?.id) ids.push(r.asset.id)
  }
  payload.photoAssetIds = ids
  console.log('photos       ' + ids.length + ' uploaded')
} else {
  console.log('photos       none supplied')
}

// 3b. Coordinates for every suburb, from the same lookup the wizard uses.
payload.baseSuburb = await resolveSuburb(payload.baseSuburb)
payload.suburbsServiced = []
for (const ref of spec.intake.suburbsServiced) payload.suburbsServiced.push(await resolveSuburb(ref))
console.log('suburbs      ' + payload.suburbsServiced.length + ' resolved with coordinates')

// 4. The page allowance, then the services those pages are for. The intake now refuses to submit
//    with paid pages left unallocated, so this is the same requirement a customer would meet.
await j('/api/admin/grant-pages', {
  method: 'POST',
  headers: { 'x-admin-token': adminToken, 'content-type': 'application/json' },
  body: JSON.stringify({ jobId, pagesAllowed: spec.pagesAllowed }),
})
payload.ownPageServices = spec.ownPageServices
console.log('pages        ' + spec.pagesAllowed + ' (' + spec.ownPageServices.join(', ') + ')')

// 5. Submit, through the route that re-validates every field server side.
const submitted = await j('/api/jobs/' + jobId + '/intake/submit', {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify(payload),
})
console.log('intake       accepted' + (submitted.auditFlags?.length ? '  flags: ' + submitted.auditFlags.map((f) => f.code).join(', ') : '  no gap-audit flags'))

console.log('')
console.log('READY: ' + jobId + '   session ' + started.session)
