import { Hono } from 'hono'
import { intakeSchema, maxServices, unallocatedPages, type IntakePayload } from '../../shared/intake.js'
import { suburbKey } from '../../shared/suburbs.js'
import { AuSuburbProvider } from '../lib/suburbs.js'
import { normaliseAuPhone } from '../../shared/phone.js'
import { getJob, listAssets, recordEvent, saveIntakeDraft, submitIntake } from '../lib/db.js'
import { runGapAudit } from '../lib/audit.js'

const app = new Hono()
const suburbs = new AuSuburbProvider()

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

  /*
   * The services ceiling is twenty in the schema so that somebody who bought twenty pages can
   * name twenty services. Everyone else is still held to ten, and only this side of the wire can
   * tell the two apart, because the allowance is on the job row rather than in the answers.
   */
  const serviceCap = maxServices(job.pagesAllowed ?? 1)
  if (payload.services.length > serviceCap) {
    return c.json(
      {
        error: 'validation_failed',
        detail: 'Too many services for this build',
        issues: [
          {
            path: 'services',
            message:
              'Pick no more than ' + serviceCap + '. Buy more service pages if you need to list ' +
              'more than that.',
          },
        ],
      },
      422,
    )
  }

  /*
   * EVERY PAGE THEY PAID FOR MUST BE POINTED AT A SERVICE BEFORE THE BUILD RUNS.
   *
   * This sits beside the suburb check for the same reason that one exists: the browser already
   * prevents it, and the browser is not the gate. The entitlement is on the job row rather than
   * in the payload, so no amount of schema work can catch it and it has to be checked here.
   *
   * REFUSING IS THE KIND ANSWER. The alternative, taken until now, was to accept the submission
   * and build whatever was chosen, which quietly delivered less than the customer bought and
   * reported that everything passed. A 422 sends them back to a picker they can complete in a
   * few seconds. A silent short build is found weeks later, by them.
   */
  const unallocated = unallocatedPages(job.pagesAllowed ?? 1, payload.ownPageServices, payload.services)
  if (unallocated > 0) {
    return c.json(
      {
        error: 'validation_failed',
        detail:
          unallocated === 1
            ? 'One page you have paid for has not been given a service yet'
            : unallocated + ' pages you have paid for have not been given a service yet',
        issues: [
          {
            path: 'ownPageServices',
            message:
              'You paid for ' + Math.max(0, (job.pagesAllowed ?? 1) - 1) + ' extra page(s). ' +
              'Choose which service goes on each one. They are already paid for.',
          },
        ],
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
