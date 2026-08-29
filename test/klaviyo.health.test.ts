import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * "We have no record" is not "it never fired".
 *
 * THE FAILURE THIS EXISTS TO STOP, and it is one this panel actually caused. The health check
 * reads our own events table. On 29 August every production job was wiped, which deletes each
 * job's event rows with it, and the panel then reported all twelve metrics as NEVER FIRED on an
 * account whose post-purchase flow was live and verified that week. Its own copy told the operator
 * that a metric which has never fired "definitely has no flow", so the honest reading of a screen
 * full of red was that the entire email system was dead. It was not. The evidence had been
 * deleted, not the flows.
 *
 * The distinction is the whole point of the panel: "definitely broken" and "cannot see" are
 * different answers and only one of them should send somebody to rebuild their Klaviyo flows.
 */

let klaviyoHealth: typeof import('../server/lib/klaviyoHealth').klaviyoHealth
let getDb: typeof import('../server/db/client').getDb
let schema: typeof import('../server/db/client').schema

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gopolar-kh-'))
  process.env.DEMO_MODE = '1'
  process.env.PGLITE_DIR = join(dir, 'pglite')
  process.env.LOCAL_STORAGE_DIR = join(dir, 'blob')
  const { migrate } = await import('../server/db/migrate')
  await migrate()
  ;({ getDb, schema } = await import('../server/db/client'))
  ;({ klaviyoHealth } = await import('../server/lib/klaviyoHealth'))
})

describe('an empty events table', () => {
  it('reports no_record rather than never, because it cannot tell them apart', async () => {
    const health = await klaviyoHealth()
    expect(health.historyPresent).toBe(false)
    expect(health.noRecord).toBe(health.metrics.length)
    // The number that drives the alarming header count must be zero.
    expect(health.neverFired).toBe(0)
    expect(health.failing).toBe(0)
  })

  it('says so in words an operator can act on, and does not blame Klaviyo', async () => {
    const [m] = (await klaviyoHealth()).metrics
    expect(m!.detail).toMatch(/no record on our side/i)
    expect(m!.detail).toMatch(/wiped/i)
    expect(m!.detail).toMatch(/flows are unaffected/i)
  })
})

describe('once there is any history at all', () => {
  it('trusts "never fired" again for the metrics that have none', async () => {
    const db = await getDb()
    const { KLAVIYO_METRICS } = await import('../server/lib/klaviyo')
    // One real send, for one metric. That is enough to make the table trustworthy.
    await db.insert(schema.events).values({
      id: 'evt_health_1',
      jobId: null,
      type: 'klaviyo.sent',
      payload: { metric: KLAVIYO_METRICS.build_purchased },
    })

    const health = await klaviyoHealth()
    expect(health.historyPresent).toBe(true)
    expect(health.noRecord).toBe(0)
    // Every other metric is now genuinely never-fired, which IS evidence of a missing flow.
    expect(health.neverFired).toBe(health.metrics.length - 1)

    const fired = health.metrics.find((m) => m.name === KLAVIYO_METRICS.build_purchased)
    expect(fired!.state).not.toBe('no_record')
    expect(fired!.state).not.toBe('never')
  })
})
