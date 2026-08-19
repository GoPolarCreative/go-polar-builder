/**
 * End to end smoke test against a running dev server.
 *
 *   npm run dev          (in one terminal)
 *   npm run seed
 *   npm run e2e -- <JOB_ID> <SESSION>
 *
 * Or just: node scripts/e2e.mjs      (it seeds first)
 *
 * Walks a job through generation, verification, an edit, a rollback, the verification self-test,
 * the go live screens, and the full discharge package. Prints a pass or fail line for each and
 * exits non-zero if any fail, so it can be dropped into CI once there is one.
 *
 * It uses the real API with a real session, so it exercises the auth layer rather than
 * tunnelling under it.
 */

const BASE = process.env.BASE ?? 'http://localhost:8787'

let jobId = process.argv[2] ?? null
let session = process.argv[3] ?? null

const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`)
}

async function call(path, init = {}) {
  const headers = { ...(init.headers ?? {}) }
  if (session) headers.authorization = `Bearer ${session}`
  const res = await fetch(`${BASE}${path}`, { ...init, headers })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text.slice(0, 200) }
  }
  return { status: res.status, body, text }
}

/** Read a server-sent event stream to the end and return every event. */
async function stream(path, body) {
  const headers = { 'content-type': 'application/json' }
  if (session) headers.authorization = `Bearer ${session}`
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`)

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  const events = []
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += value
    let i
    while ((i = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, i)
      buffer = buffer.slice(i + 2)
      const line = frame.split('\n').find((l) => l.startsWith('data:'))
      if (line) {
        try {
          events.push(JSON.parse(line.slice(5).trim()))
        } catch {
          /* ignore a malformed frame */
        }
      }
    }
  }
  return events
}

async function main() {
  console.log(`End to end against ${BASE}\n`)

  const health = await call('/api/health')
  check('health responds', health.status === 200)
  if (health.body?.shopifyConfigured) {
    console.log('\n  Shopify is configured on this install, so the dev-only routes are off.')
    console.log('  Comment out SHOPIFY_WEBHOOK_SECRET in .dev.vars to run this script.\n')
    process.exit(1)
  }

  if (!jobId) {
    console.log('No job id given, seeding one first...\n')
    const { execFileSync } = await import('node:child_process')
    // tsx is resolved from node_modules rather than via npx, which is not an executable on
    // Windows and cannot be spawned directly.
    const out = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/seed.ts'], {
      encoding: 'utf8',
      env: { ...process.env, BASE },
    })
    jobId = out.match(/JOB_ID=(\S+)/)?.[1] ?? null
    session = out.match(/SESSION=(\S+)/)?.[1] ?? null
    check('seeded a job', Boolean(jobId && session))
  }

  // --- auth ------------------------------------------------------------------------------------
  const noAuth = await fetch(`${BASE}/api/jobs/${jobId}`)
  check('a job cannot be read without a session', noAuth.status === 401)

  const me = await call('/api/auth/me')
  check('the session identifies the job', me.body?.jobId === jobId)

  const wrongJob = await call('/api/jobs/job_someone_elses_build')
  check('a session cannot read another job', wrongJob.status === 403)

  // --- generation ------------------------------------------------------------------------------
  const gen = await stream(`/api/jobs/${jobId}/generate`)
  const genDone = gen.find((e) => e.type === 'done')
  const genReport = gen.filter((e) => e.type === 'verification').pop()
  check('generation completes', Boolean(genDone), genDone ? `v${genDone.version}, ${genDone.bytes} bytes` : '')
  check('generation passes verification', genDone?.passed === true)
  check(
    'all thirteen static checks ran',
    genReport?.report?.static?.length === 13,
    `${genReport?.report?.static?.filter((c) => c.status === 'pass').length ?? 0} passed`,
  )
  // Either a browser was available and all four ran, or none was and all four skipped. A mix,
  // or a pass with no browser, is the failure mode worth guarding: it would mean a check
  // reporting success without having looked at anything.
  const renderStatuses = new Set((genReport?.report?.render ?? []).map((c) => c.status))
  check(
    'render checks either all ran or all skipped, never a mix',
    renderStatuses.size === 1 && (renderStatuses.has('pass') || renderStatuses.has('skipped')),
    [...renderStatuses].join(','),
  )
  check('the stream carried the html as it was written', gen.some((e) => e.type === 'html_chunk'))

  const version = genDone?.version ?? 1

  // --- the built site --------------------------------------------------------------------------
  const html = await call(`/api/jobs/${jobId}/builds/${version}/html`)
  check('the built site is stored and served', html.status === 200 && html.text.startsWith('<!DOCTYPE html>'))
  check('the footer credit is exact', html.text.includes('>Website by Go Polar Creative</a>'))
  check('no em dashes anywhere', !html.text.includes('—'))
  check('exactly one h1', (html.text.match(/<h1[\s>]/g) ?? []).length === 1)
  check('both forms post to Web3Forms', (html.text.match(/action="https:\/\/api\.web3forms\.com\/submit"/g) ?? []).length === 2)

  const preview = await call(`/api/jobs/${jobId}/builds/${version}/preview`)
  check('the preview has images inlined', preview.text.includes('data:image/'))

  // --- verification self test ------------------------------------------------------------------
  const selftest = await call(`/api/dev/selftest/${jobId}/${version}`)
  check(
    'every check catches its own breakage',
    selftest.body?.ok === true,
    `${selftest.body?.caught}/${selftest.body?.total} caught`,
  )

  // --- edit loop ---------------------------------------------------------------------------------
  // With no Anthropic key an edit cannot be applied. It must be refused loudly rather than
  // quietly writing a version that looks identical and charging the customer for it.
  const before = await call(`/api/jobs/${jobId}/versions`)
  check('the panel says up front whether edits can work', typeof before.body?.capability?.available === 'boolean')

  if (before.body?.capability?.available === false) {
    check(
      'the reason names the missing variable in plain English',
      /ANTHROPIC_API_KEY/.test(before.body?.capability?.reason ?? ''),
    )

    const refused = await call(`/api/jobs/${jobId}/edits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request: 'Make the header darker and put the phone number in the hero.' }),
    })
    check('an edit that cannot be applied is refused loudly', refused.status === 503, refused.body?.error)
    check('the refusal says nothing was charged', refused.body?.editCharged === false)

    const after = await call(`/api/jobs/${jobId}/versions`)
    check(
      'a refused edit costs nothing',
      after.body.editsUsed === before.body.editsUsed,
      `${after.body.editsRemaining} of ${after.body.editsAllowed} remaining`,
    )
    check('a refused edit writes no version', after.body.currentVersion === before.body.currentVersion)
  } else {
    const edit = await stream(`/api/jobs/${jobId}/edits`, {
      request: 'Make the header darker and put the phone number in the hero.',
    })
    const editDone = edit.find((e) => e.type === 'done')
    check('an edit produces a new version', editDone?.version === version + 1)
    check('the edited version passes verification', editDone?.passed === true)

    const after = await call(`/api/jobs/${jobId}/versions`)
    check(
      'one request costs exactly one edit',
      after.body.editsUsed === before.body.editsUsed + 1,
      `${after.body.editsRemaining} of ${after.body.editsAllowed} remaining`,
    )
  }

  // --- rollback ----------------------------------------------------------------------------------
  // Read the state fresh, since the edit branch above differs depending on whether edits can run.
  const beforeRollback = await call(`/api/jobs/${jobId}/versions`)

  const rolled = await call(`/api/jobs/${jobId}/rollback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version }),
  })
  check('rollback moves the current version', rolled.body?.currentVersion === version)

  const afterRollback = await call(`/api/jobs/${jobId}/versions`)
  check('rollback costs no edit', afterRollback.body.editsUsed === beforeRollback.body.editsUsed)
  check(
    'rollback destroys nothing',
    afterRollback.body.builds.length === beforeRollback.body.builds.length,
    `${afterRollback.body.builds.length} versions kept`,
  )

  // --- go live -----------------------------------------------------------------------------------
  const golive = await call(`/api/jobs/${jobId}/golive`)
  check('go live shows the price the customer is actually charged', golive.body?.pricing?.hosting?.price === '$33/month inc GST')
  check(
    'go live never promises a connection time',
    golive.body?.promise?.includes('one business day') && !/24 hours/i.test(golive.body.promise),
  )

  // --- the enquiry inbox, which blocks everything after it ---------------------------------------
  check('go live says the enquiry inbox is still outstanding', golive.body?.formsKey?.blocksGoLive === true)

  const blocked = await call(`/api/jobs/${jobId}/golive/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ emailAddon: true }),
  })
  check('no checkout while enquiries would come to us', blocked.status === 409, blocked.body?.error)
  check('and it says nothing has been charged', /nothing has been charged/i.test(blocked.body?.detail ?? ''))

  const pastedEmail = await call(`/api/jobs/${jobId}/golive/forms-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'jobs@coldfrontplumbing.com.au' }),
  })
  check('an email address is named as an email address', pastedEmail.body?.reason === 'email')

  // Demo mode fakes the test submission and says so. A key of all zeroes is the demo failure case.
  const rejected = await call(`/api/jobs/${jobId}/golive/forms-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: '00000000-1111-2222-3333-444444444444' }),
  })
  check('a key the service refuses is not saved', rejected.status === 422 && rejected.body?.saved === false)

  const accepted = await call(`/api/jobs/${jobId}/golive/forms-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'a1b2c3d4-e5f6-7081-92a3-b4c5d6e7f809' }),
  })
  check('a working key switches both forms over', accepted.body?.formsUpdated === 2, accepted.body?.detail)

  const switched = await call(`/api/jobs/${jobId}/builds/${accepted.body?.version}/html`)
  check(
    'the live document no longer posts to Go Polar',
    switched.text.includes('a1b2c3d4-e5f6-7081-92a3-b4c5d6e7f809') &&
      !switched.text.includes('00000000-0000-0000-0000-000000000000'),
  )

  const chargedForKey = await call(`/api/jobs/${jobId}/versions`)
  check('sorting the inbox out costs no edit', chargedForKey.body.editsUsed === afterRollback.body.editsUsed)

  const plan = await call(`/api/jobs/${jobId}/golive/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ emailAddon: true }),
  })
  check('a demo checkout link is offered locally', Boolean(plan.body?.checkoutUrl))
  check(
    'the demo checkout points at this app, not at Shopify',
    String(plan.body?.checkoutUrl ?? '').includes('/demo/checkout'),
  )

  const noAbn = await call(`/api/jobs/${jobId}/golive/domain`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ branch: 'new', domain: 'coldfrontplumbingtest2026.com.au' }),
  })
  check('a .au domain cannot proceed without an ABN', noAbn.status === 422 && noAbn.body?.field === 'abn')

  // --- discharge ----------------------------------------------------------------------------------
  const badKey = await call(`/api/jobs/${jobId}/discharge/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ web3formsKey: 'jobs@coldfront.com.au' }),
  })
  check('an email is rejected as a Web3Forms key', badKey.status === 422)

  await call(`/api/jobs/${jobId}/discharge/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  const prepared = await call(`/api/jobs/${jobId}/discharge/prepare`, { method: 'POST' })
  check('the package is prepared but not released', prepared.body?.status === 'prepared')
  check(
    'it contains the files the brief lists',
    ['index.html', 'favicon.svg', 'PREVIEW.html'].every((f) => prepared.body?.files?.includes(f)),
    `${prepared.body?.files?.length} files`,
  )

  const released = await call(`/api/jobs/${jobId}/discharge/release`, { method: 'POST' })
  check('release returns a signed download link', Boolean(released.body?.downloadUrl))

  const downloadUrl = String(released.body?.downloadUrl ?? '').replace(/^https?:\/\/[^/]+/, BASE)
  const zip = await fetch(downloadUrl)
  const bytes = new Uint8Array(await zip.arrayBuffer())
  check(
    'the zip downloads and is a real zip',
    zip.status === 200 && bytes[0] === 0x50 && bytes[1] === 0x4b,
    `${(bytes.length / 1024 / 1024).toFixed(1)}MB`,
  )

  const tampered = await fetch(`${downloadUrl.slice(0, -3)}xyz`)
  check('a tampered download link is refused', tampered.status === 403)

  // ------------------------------------------------------------------------------------------------
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) {
    console.log(`\nFailed:\n${failed.map((f) => `  ${f.name}`).join('\n')}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('\nEnd to end run failed:', err.message)
  process.exit(1)
})
