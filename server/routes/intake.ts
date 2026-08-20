import { Hono } from 'hono'
import { intakeSchema, type IntakePayload } from '../../shared/intake.js'
import { SeedSuburbProvider, suburbKey } from '../../shared/suburbs.js'
import { normaliseAuPhone } from '../../shared/phone.js'
import { getJob, listAssets, recordEvent, saveIntakeDraft, submitIntake } from '../lib/db.js'
import { runGapAudit } from '../lib/audit.js'

const app = new Hono()
const suburbs = new SeedSuburbProvider()

/** Autosave. Deliberately unvalidated: a half-filled form is the normal state of a draft. */
app.put('/jobs/:jobId/intake', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => null)
  if (body === null || typeof body !== 'object') {
    return c.json({ error: 'bad_request', detail: 'Body must be a JSON object' }, 400)
  }
  await saveIntakeDraft(jobId, body)
  return c.json({ ok: true })
})

/**
 * Submit. Re-validates everything server side, because the client is not trusted, and then runs
 * the gap audit. The audit never blocks: its findings come back with the 200 so the wizard can
 * show them inline.
 */
app.post('/jobs/:jobId/intake/submit', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => null)
  const parsed = intakeSchema.safeParse(body)
  if (!parsed.success) {
    return c.json(
      {
        error: 'validation_failed',
        detail: 'Some answers need another look',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      422,
    )
  }

  const payload = parsed.data as IntakePayload

  // Service-area suburbs must exist in the suburb dataset. The UI has no free-text path, but a
  // crafted request must not be able to get service names into the service-area field either.
  const unknown: string[] = []
  for (const s of [payload.baseSuburb, ...payload.suburbsServiced]) {
    const hit = await suburbs.exact(s.name, s.state, s.postcode)
    if (!hit || suburbKey(hit) !== suburbKey(s)) unknown.push(`${s.name} ${s.state} ${s.postcode}`)
  }
  if (unknown.length > 0) {
    return c.json(
      {
        error: 'validation_failed',
        detail: 'Service areas must be picked from the suburb list',
        issues: unknown.map((u) => ({ path: 'suburbsServiced', message: `Unknown suburb: ${u}` })),
      },
      422,
    )
  }

  // Store the phone in E.164. Validation already proved it converts.
  payload.phone = normaliseAuPhone(payload.phone) ?? payload.phone
  payload.email = payload.email.trim().toLowerCase()

  const assets = await listAssets(jobId)
  const flags = runGapAudit(payload, assets)

  await submitIntake(jobId, payload, flags)
  await recordEvent(jobId, 'intake.submitted', {
    trade: payload.trade,
    flags: flags.map((f) => f.code),
  })

  return c.json({ ok: true, auditFlags: flags })
})

export default app
