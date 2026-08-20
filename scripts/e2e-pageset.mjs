/**
 * End to end probe of the page set, against a running local API.
 *
 * Buys two additional pages on a real job, builds, checks every page, swaps the forms key,
 * publishes the set and asks the live site for each path. Everything goes through the real
 * routes with a real session.
 *
 *   npm run dev:api        (in one terminal)
 *   npm run e2e:pageset
 */
const BASE = 'http://localhost:8787'

let failures = 0
const check = (ok, name, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`)
}

let session = null
const call = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(session ? { authorization: `Bearer ${session}` } : {}) },
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body }
}

const email = `pageset-${Date.now()}@example.com`
const created = await call('/api/dev/jobs', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, name: 'Cold Front Plumbing' }),
})
session = created.body.session
const jobId = created.body.jobId
check(Boolean(jobId), 'a job and a session exist', jobId)

const { makeLogo, makePhoto } = await import('./fixture-images')

const upload = async (kind, file) => {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(file.bytes)], { type: file.contentType }), file.filename)
  form.append('kind', kind)
  form.append('stats', '{}')
  const res = await fetch(`${BASE}/api/jobs/${jobId}/assets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session}` },
    body: form,
  })
  return JSON.parse(await res.text())
}

const logo = await upload('logo', await makeLogo())
const photoIds = []
for (let i = 0; i < 4; i++) photoIds.push((await upload('photo', await makePhoto(i))).asset.id)
check(photoIds.length === 4, 'four photos uploaded')

const { INTAKE } = await import('./seed-intake')
const payload = {
  ...INTAKE,
  email,
  logoAssetId: logo.asset.id,
  photoAssetIds: photoIds,
  ownPageServices: ['Blocked drains', 'Hot water systems'],
}
const submitted = await call(`/api/jobs/${jobId}/intake`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
})
check(
  submitted.status === 200 || submitted.status === 201,
  'intake saved',
  JSON.stringify(submitted.body).slice(0, 200),
)

const done = await call(`/api/jobs/${jobId}/intake/submit`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
})
check(done.status === 200, 'intake submitted', JSON.stringify(done.body).slice(0, 160))

// They buy two additional pages. One order, quantity two.
const paid = await call('/api/demo/checkout/complete', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jobId, email, lines: 'additional-page:2' }),
})
check(paid.status === 200, 'the additional pages order is processed', JSON.stringify(paid.body).slice(0, 160))

const job = await call(`/api/jobs/${jobId}`)
check(
  job.body?.job?.pagesAllowed === 3,
  'quantity two grants two extra pages',
  `pagesAllowed=${job.body?.job?.pagesAllowed}`,
)

const gen = await call(`/api/jobs/${jobId}/generate`, { method: 'POST' })
check(gen.status === 200, 'generation completes', String(gen.status))

const versions = await call(`/api/jobs/${jobId}/versions`)
check(
  versions.body?.pages?.length === 3,
  'the build is a set of three pages',
  JSON.stringify(versions.body?.pages?.map((p) => p.url)),
)

const pages = await call(`/api/jobs/${jobId}/builds/1/pages`)
check(pages.body?.pages?.length === 3, 'every page is stored and listed', String(pages.body?.pages?.length))
check(pages.body?.pages?.every((p) => p.passed), 'every page passed its own checks, not just the home page')

const home = await call(`/api/jobs/${jobId}/builds/1/preview`)
const svcPath = encodeURIComponent('services/blocked-drains/index.html')
const svc = await call(`/api/jobs/${jobId}/builds/1/preview?path=${svcPath}`)
check(typeof svc.body === 'string' && svc.body.includes('<h1'), 'the preview serves a service page')
check(home.body !== svc.body, 'the service page is not the home page in disguise')

const bogusPath = encodeURIComponent('services/not-bought/index.html')
const bogus = await call(`/api/jobs/${jobId}/builds/1/preview?path=${bogusPath}`)
check(bogus.status === 404, 'a page nobody built is a 404, never a silent fallback', String(bogus.status))

const rootAbsolute = [...String(svc.body).matchAll(/href="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((h) => h.startsWith('/'))
check(rootAbsolute.length === 0, 'no root-absolute internal links, so the files work from disk', rootAbsolute.join(' '))

// Go live: the forms key gate rebuilds the whole set.
const key = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const keyed = await call(`/api/jobs/${jobId}/golive/forms-key`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ key }),
})
check(keyed.status === 200, 'the key is accepted', JSON.stringify(keyed.body).slice(0, 160))
check(
  keyed.body?.formsUpdated >= 6,
  'both forms on all three pages were switched over',
  `${keyed.body?.formsUpdated} forms`,
)

const v2 = keyed.body?.version
const afterKey = await call(`/api/jobs/${jobId}/builds/${v2}/pages`)
check(afterKey.body?.pages?.length === 3, 'the new version is still a set of three', String(afterKey.body?.pages?.length))

const hotPath = encodeURIComponent('services/hot-water-systems/index.html')
const svcAfter = await call(`/api/jobs/${jobId}/builds/${v2}/preview?path=${hotPath}`)
check(String(svcAfter.body).includes(key), 'the service page posts to the customer account now')

// Publish, then ask the live site for each path.
const adminToken = process.env.ADMIN_TOKEN ?? ''
const pub = await fetch(`${BASE}/api/admin/publish`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-admin-token': adminToken },
  body: JSON.stringify({ jobId, hostname: 'pageset-test.com.au', force: true }),
})
const pubBody = await pub.json()
check(pub.status === 200, 'the set publishes', JSON.stringify(pubBody).slice(0, 240))
check(pubBody?.pages === 3, 'all three pages went live together', String(pubBody?.pages))

for (const path of ['/', '/services/blocked-drains/', '/services/blocked-drains', '/sitemap.xml', '/robots.txt']) {
  const res = await fetch(`${BASE}/api/site?host=pageset-test.com.au&path=${encodeURIComponent(path)}`)
  check(res.status === 200, `the live site answers ${path}`, String(res.status))
}
const missingPath = encodeURIComponent('/services/never-bought/')
const missing = await fetch(`${BASE}/api/site?host=pageset-test.com.au&path=${missingPath}`)
check(missing.status === 404, 'a path nobody bought is a 404 on the live site', String(missing.status))

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
