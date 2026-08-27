/**
 * Time a build or an edit through the REAL HTTP route, from the SSE stream.
 *
 *   node scripts/measure-route.mjs build <jobId> <session>
 *   node scripts/measure-route.mjs edit  <jobId> <session> "your request"
 *
 * The in-process harness (measure-build.ts) opens the local database directly, which the dev
 * server already holds, so the two cannot run at once. This one goes through the server that is
 * already running, which has the side benefit of measuring exactly what a customer's browser
 * receives, streaming included, rather than the library calls underneath it.
 */

const [, , mode, jobId, session, request] = process.argv
if (!mode || !jobId || !session) {
  console.error('usage: node scripts/measure-route.mjs build|edit <jobId> <session> [request]')
  process.exit(1)
}

const BASE = process.env.BASE ?? 'http://localhost:8787'
const url =
  mode === 'edit' ? `${BASE}/api/jobs/${jobId}/edits` : `${BASE}/api/jobs/${jobId}/generate`
const body = mode === 'edit' ? JSON.stringify({ request }) : '{}'

const t0 = Date.now()
const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(7)

/*
 * node:http, NOT fetch.
 *
 * The model can go 200 seconds or more without emitting a byte while it thinks, and undici's
 * default body timeout is 300 seconds between chunks. A build that crossed that line had its
 * stream torn down with UND_ERR_BODY_TIMEOUT mid-measurement. A browser reading an EventSource
 * has no such timeout, so this is a measuring artefact rather than something a customer would
 * hit, but it does say something about the length of the silence.
 */
const http = await import('node:http')
const u = new URL(url)

const res = await new Promise((resolve, reject) => {
  const req = http.request(
    {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        authorization: `Bearer ${session}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    },
    resolve,
  )
  req.setTimeout(0)
  req.on('error', reject)
  req.write(body)
  req.end()
})

if (res.statusCode !== 200) {
  console.error('HTTP ' + res.statusCode)
  res.resume()
  process.exit(1)
}

const decoder = new TextDecoder()
let buf = ''
let bytes = 0
let firstChunkAt = null
let lastStage = null
const stageStart = {}
const stageEnd = {}
let done = null
let failed = null

const closeStage = () => {
  if (lastStage) stageEnd[lastStage] = Date.now()
}

for await (const value of res) {
  buf += decoder.decode(value, { stream: true })
  const parts = buf.split('\n\n')
  buf = parts.pop() ?? ''
  for (const p of parts) {
    const line = p.split('\n').find((l) => l.startsWith('data: '))
    if (!line) continue
    let e
    try {
      e = JSON.parse(line.slice(6))
    } catch {
      continue
    }

    if (e.type === 'status') {
      if (e.stage !== lastStage) {
        closeStage()
        stageStart[e.stage] = Date.now()
        lastStage = e.stage
        console.log(`${at()}s  >> ${e.stage.padEnd(12)} ${e.message ?? ''}`)
      }
    } else if (e.type === 'html_chunk') {
      bytes += e.text.length
      if (firstChunkAt === null) {
        firstChunkAt = Date.now()
        console.log(`${at()}s  ** FIRST BYTE OF THE DOCUMENT (this is when the customer sees something)`)
      }
    } else if (e.type === 'verification') {
      const fails = [...(e.report.static ?? []), ...(e.report.render ?? [])].filter((c) => c.status === 'fail')
      console.log(
        `${at()}s  -- verification: ${e.report.passed ? 'PASSED' : 'FAILED'}`,
      )
      for (const f of fails) {
        console.log(`           FAILED ${f.id}: ${f.detail ?? ''}`)
        if (f.evidence?.length) console.log(`             evidence: ${JSON.stringify(f.evidence).slice(0, 300)}`)
      }
    } else if (e.type === 'repair') {
      console.log(`${at()}s  !! REPAIR attempt ${e.attempt}: ${(e.failing ?? []).join(' | ')}`)
    } else if (e.type === 'done') {
      done = e
      console.log(`${at()}s  == done  version ${e.version}  ${((e.bytes ?? 0) / 1024).toFixed(0)}KB  passed=${e.passed !== false}`)
    } else if (e.type === 'error') {
      failed = e
      console.log(`${at()}s  == ERROR ${e.message} ${e.detail ?? ''}`)
    }
  }
}
closeStage()

const total = (Date.now() - t0) / 1000
console.log('')
console.log('='.repeat(70))
console.log(`${mode.toUpperCase()}  total ${total.toFixed(1)}s   streamed ${(bytes / 1024).toFixed(0)}KB`)
if (firstChunkAt) console.log(`time to first visible byte: ${((firstChunkAt - t0) / 1000).toFixed(1)}s`)
console.log('='.repeat(70))
for (const stage of Object.keys(stageStart)) {
  const end = stageEnd[stage] ?? Date.now()
  console.log(`  ${stage.padEnd(14)} ${((end - stageStart[stage]) / 1000).toFixed(1).padStart(7)}s`)
}
if (failed) process.exitCode = 1
