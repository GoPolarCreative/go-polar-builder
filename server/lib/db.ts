import { and, desc, eq, sql } from 'drizzle-orm'
import { getDb, schema } from '../db/client.js'
import type { AssetRecord, AssetStats, AssetVariant, AuditFlag, Job, JobStatus } from '../../shared/types.js'
import type { IntakePayload } from '../../shared/intake.js'
import type { Trade } from '../../shared/trades.js'
import { id } from './ids.js'
import { maskKey } from './web3forms.js'

/**
 * Data access. Drizzle over Postgres, replacing the raw D1 prepare/bind calls.
 *
 * Row shapes come back camelCase from Drizzle and are mapped to the shared types here, so the
 * rest of the codebase never touches a column name.
 */

function iso(value: Date | string | null): string {
  if (!value) return ''
  return value instanceof Date ? value.toISOString() : value
}

function toJob(row: typeof schema.jobs.$inferSelect): Job {
  return {
    id: row.id,
    userId: row.userId,
    status: row.status,
    trade: (row.trade as Trade | null) ?? null,
    businessName: row.businessName,
    editsUsed: row.editsUsed,
    editsAllowed: row.editsAllowed,
    currentVersion: row.currentVersion,
    held: row.held,
    heldReason: row.heldReason,
    pagesAllowed: row.pagesAllowed,
    web3formsKeyMasked: row.customerWeb3formsKey ? maskKey(row.customerWeb3formsKey) : null,
    web3formsVerifiedAt: row.web3formsVerifiedAt ? iso(row.web3formsVerifiedAt) : null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }
}

/**
 * The customer's real Web3Forms key, for the two places that have to put it into a document.
 * Deliberately not on the `Job` object, which travels to the browser: this is read at the point
 * of use and nowhere else.
 */
export async function getVerifiedFormsKey(jobId: string): Promise<string | null> {
  const db = await getDb()
  const rows = await db
    .select({ key: schema.jobs.customerWeb3formsKey, at: schema.jobs.web3formsVerifiedAt })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId))
    .limit(1)
  const row = rows[0]
  return row?.key && row.at ? row.key : null
}

function toAsset(row: typeof schema.assets.$inferSelect): AssetRecord {
  return {
    id: row.id,
    jobId: row.jobId,
    kind: row.kind,
    filename: row.filename,
    contentType: row.contentType,
    originalKey: row.originalKey,
    originalBytes: row.originalBytes,
    width: row.width,
    height: row.height,
    sortOrder: row.sortOrder,
    stats: (row.stats as AssetStats | null) ?? null,
    variants: (row.variants as AssetVariant[] | null) ?? [],
    createdAt: iso(row.createdAt),
  }
}

// ---------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------

export async function getJob(jobId: string): Promise<Job | null> {
  const db = await getDb()
  const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1)
  return rows[0] ? toJob(rows[0]) : null
}

export async function setJobStatus(jobId: string, status: JobStatus): Promise<void> {
  const db = await getDb()
  await db.update(schema.jobs).set({ status, updatedAt: new Date() }).where(eq(schema.jobs.id, jobId))
}

export async function holdJob(jobId: string, reason: string): Promise<void> {
  const db = await getDb()
  await db
    .update(schema.jobs)
    .set({ held: true, heldReason: reason, updatedAt: new Date() })
    .where(eq(schema.jobs.id, jobId))
}

export async function createUserAndJob(args: {
  email: string
  name?: string | null
  phone?: string | null
  shopifyCustomerId?: string | null
}): Promise<{ userId: string; jobId: string }> {
  const db = await getDb()
  const email = args.email.trim().toLowerCase()

  const existing = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1)
  let userId = existing[0]?.id

  if (!userId) {
    userId = id('usr')
    await db.insert(schema.users).values({
      id: userId,
      email,
      name: args.name ?? null,
      phone: args.phone ?? null,
      shopifyCustomerId: args.shopifyCustomerId ?? null,
    })
  } else if (args.shopifyCustomerId && !existing[0]?.shopifyCustomerId) {
    await db
      .update(schema.users)
      .set({ shopifyCustomerId: args.shopifyCustomerId })
      .where(eq(schema.users.id, userId))
  }

  const jobId = id('job')
  await db.insert(schema.jobs).values({ id: jobId, userId, status: 'paid' })
  return { userId, jobId }
}

export async function getUserForJob(jobId: string): Promise<{ id: string; email: string; name: string | null } | null> {
  const db = await getDb()
  const rows = await db
    .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name })
    .from(schema.users)
    .innerJoin(schema.jobs, eq(schema.jobs.userId, schema.users.id))
    .where(eq(schema.jobs.id, jobId))
    .limit(1)
  return rows[0] ?? null
}

/** Most recent job for an email that has not been discharged. */
export async function latestJobForEmail(email: string): Promise<string | null> {
  const db = await getDb()
  const rows = await db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .innerJoin(schema.users, eq(schema.users.id, schema.jobs.userId))
    .where(and(eq(schema.users.email, email.trim().toLowerCase()), sql`${schema.jobs.status} <> 'discharged'`))
    .orderBy(desc(schema.jobs.createdAt))
    .limit(1)
  return rows[0]?.id ?? null
}

// ---------------------------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------------------------

export async function getIntake(
  jobId: string,
): Promise<{ payload: Partial<IntakePayload>; auditFlags: AuditFlag[]; submittedAt: string | null } | null> {
  const db = await getDb()
  const rows = await db.select().from(schema.intake).where(eq(schema.intake.jobId, jobId)).limit(1)
  const row = rows[0]
  if (!row) return null
  return {
    payload: row.payload as Partial<IntakePayload>,
    auditFlags: (row.auditFlags as AuditFlag[] | null) ?? [],
    submittedAt: row.submittedAt ? iso(row.submittedAt) : null,
  }
}

export async function saveIntakeDraft(jobId: string, payload: unknown): Promise<void> {
  const db = await getDb()
  await db
    .insert(schema.intake)
    .values({ jobId, payload, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.intake.jobId,
      set: { payload, updatedAt: new Date() },
    })
}

export async function submitIntake(
  jobId: string,
  payload: IntakePayload,
  flags: AuditFlag[],
): Promise<void> {
  const db = await getDb()
  const now = new Date()

  await db
    .insert(schema.intake)
    .values({ jobId, payload, auditFlags: flags, submittedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.intake.jobId,
      set: {
        payload,
        auditFlags: flags,
        // Keep the first submission time. Re-submitting is an edit, not a new intake.
        submittedAt: sql`coalesce(${schema.intake.submittedAt}, ${now.toISOString()}::timestamptz)`,
        updatedAt: now,
      },
    })

  await db
    .update(schema.jobs)
    .set({ status: 'intake', trade: payload.trade, businessName: payload.businessName, updatedAt: now })
    .where(eq(schema.jobs.id, jobId))
}

// ---------------------------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------------------------

export async function listAssets(jobId: string): Promise<AssetRecord[]> {
  const db = await getDb()
  const rows = await db
    .select()
    .from(schema.assets)
    .where(eq(schema.assets.jobId, jobId))
    .orderBy(schema.assets.kind, schema.assets.sortOrder, schema.assets.createdAt)
  return rows.map(toAsset)
}

export async function getAsset(assetId: string): Promise<AssetRecord | null> {
  const db = await getDb()
  const rows = await db.select().from(schema.assets).where(eq(schema.assets.id, assetId)).limit(1)
  return rows[0] ? toAsset(rows[0]) : null
}

export async function insertAsset(record: {
  id: string
  jobId: string
  kind: 'logo' | 'photo'
  filename: string | null
  contentType: string
  originalKey: string
  originalBytes: number
  width: number | null
  height: number | null
  sortOrder: number
  stats: AssetStats | null
  variants: AssetVariant[]
}): Promise<AssetRecord> {
  const db = await getDb()
  await db.insert(schema.assets).values(record)
  const saved = await getAsset(record.id)
  if (!saved) throw new Error('Asset vanished immediately after being written')
  return saved
}

export async function deleteAsset(assetId: string): Promise<void> {
  const db = await getDb()
  await db.delete(schema.assets).where(eq(schema.assets.id, assetId))
}

export async function reorderAssets(jobId: string, ids: string[]): Promise<void> {
  const db = await getDb()
  for (const [index, assetId] of ids.entries()) {
    await db
      .update(schema.assets)
      .set({ sortOrder: index })
      .where(and(eq(schema.assets.id, assetId), eq(schema.assets.jobId, jobId)))
  }
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

export async function recordEvent(jobId: string | null, type: string, payload?: unknown): Promise<void> {
  // Events are the audit trail and the GHL webhook feed. Never let a logging failure take down
  // the request that produced it.
  try {
    const db = await getDb()
    await db.insert(schema.events).values({ id: id('evt'), jobId, type, payload: payload ?? null })
  } catch (err) {
    console.error('event write failed', type, err)
  }
}

// ---------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------

export async function nextVersion(jobId: string): Promise<number> {
  const db = await getDb()
  const rows = await db
    .select({ max: sql<number>`coalesce(max(${schema.builds.version}), 0)` })
    .from(schema.builds)
    .where(eq(schema.builds.jobId, jobId))
  return Number(rows[0]?.max ?? 0) + 1
}
