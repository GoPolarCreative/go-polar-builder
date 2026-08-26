import { Hono } from 'hono'
import { AuSuburbProvider } from '../lib/suburbs.js'
import { formatAbn, isValidAbn, normaliseAbn } from '../../shared/abn.js'
import { normaliseAuPhone, phoneKind } from '../../shared/phone.js'

const app = new Hono()

// Suburb lookup backs the only way suburbs can enter the system. See shared/suburbs.ts for the
// note about swapping the seed dataset for the authoritative one before launch.
const suburbs = new AuSuburbProvider()

app.get('/lookup/suburbs', async (c) => {
  const q = c.req.query('q') ?? ''
  const limit = Math.min(Number(c.req.query('limit') ?? 8) || 8, 20)
  const results = await suburbs.search(q, limit)
  return c.json({ results })
})

/**
 * ABN check. Checksum only at this stage, which is enough to catch a typo.
 * A live ABR lookup happens at .au domain purchase (Phase 5), where auDA needs the registered
 * entity name to match the ABN, not just a well-formed number.
 */
app.get('/lookup/abn', (c) => {
  const value = c.req.query('value') ?? ''
  const digits = normaliseAbn(value)
  const valid = isValidAbn(digits)
  return c.json({
    valid,
    normalised: valid ? digits : null,
    formatted: valid ? formatAbn(digits) : null,
    detail: valid
      ? 'Checksum passes. We confirm it against the ABR when you buy a .au domain.'
      : digits.length !== 11
        ? `An ABN is 11 digits. You entered ${digits.length}.`
        : 'Those 11 digits do not check out. Worth checking for a transposed pair.',
  })
})

app.get('/lookup/phone', (c) => {
  const value = c.req.query('value') ?? ''
  const e164 = normaliseAuPhone(value)
  return c.json({ valid: Boolean(e164), e164, kind: phoneKind(value) })
})

export default app
