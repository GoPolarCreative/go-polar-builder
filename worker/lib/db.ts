import type { Env } from '../env'
import type { AssetRecord, AuditFlag, Job, JobStatus } from '../../shared/types'
import type { IntakePayload } from '../../shared/intake'
import { id, nowIso } from './ids'

/**
 * Thin D1 helpers. Deliberately not an ORM: the queries are few and being able to read the SQL
 * next to the call site is worth more here than abstraction.
 */

export async function getJob(env: Env, jobId: string): Promise<Job | null> {
  const row = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first<Job>()
  return row ?? null
}

export async function setJobStatus(env: Env, jobId: string, status: JobStatus): Promise<void> {
  await env.DB.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?')
    .bind(status, nowIso(), jobId)
    .run()
}

export async function holdJob(env: Env, jobId: string, reason: string): Promise<void> {
  await env.DB.prepare('UPDATE jobs SET held = 1, held_reason = ?, updated_at = ? WHERE id = ?')
    .bind(reason, nowIso(), jobId)
    .run()
}

export async function getIntake(
  env: Env,
  jobId: string,
): Promise<{ payload: Partial<IntakePayload>; auditFlags: AuditFlag[]; submittedAt: string | null } | null> {
  const row = await env.DB.prepare(
    'SELECT payload_json, audit_flags_json, submitted_at FROM intake WHERE job_id = ?',
  )
    .bind(jobId)
    .first<{ payload_json: string; audit_flags_json: string | null; submitted_at: string | null }>()
  if (!row) return null
  return {
    payload: JSON.parse(row.payload_json) as Partial<IntakePayload>,
    auditFlags: row.audit_flags_json ? (JSON.parse(row.audit_flags_json) as AuditFlag[]) : [],
    submittedAt: row.submitted_at,
  }
}

export async function saveIntakeDraft(
  env: Env,
  jobId: string,
  payload: unknown,
): Promise<void> {
  const now = nowIso()
  await env.DB.prepare(
    `INSERT INTO intake (job_id, payload_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
  )
    .bind(jobId, JSON.stringify(payload), now)
    .run()
}

export async function submitIntake(
  env: Env,
  jobId: string,
  payload: IntakePayload,
  flags: AuditFlag[],
): Promise<void> {
  const now = nowIso()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO intake (job_id, payload_json, audit_flags_json, submitted_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         payload_json = excluded.payload_json,
         audit_flags_json = excluded.audit_flags_json,
         submitted_at = COALESCE(intake.submitted_at, excluded.submitted_at),
         updated_at = excluded.updated_at`,
    ).bind(jobId, JSON.stringify(payload), JSON.stringify(flags), now, now),
    env.DB.prepare(
      `UPDATE jobs SET status = 'intake', trade = ?, business_name = ?, updated_at = ? WHERE id = ?`,
    ).bind(payload.trade, payload.businessName, now, jobId),
  ])
}

export async function listAssets(env: Env, jobId: string): Promise<AssetRecord[]> {
  const res = await env.DB.prepare(
    'SELECT * FROM assets WHERE job_id = ? ORDER BY kind, sort_order, created_at',
  )
    .bind(jobId)
    .all<Record<string, unknown>>()
  return (res.results ?? []).map(rowToAsset)
}

export async function getAsset(env: Env, assetId: string): Promise<AssetRecord | null> {
  const row = await env.DB.prepare('SELECT * FROM assets WHERE id = ?')
    .bind(assetId)
    .first<Record<string, unknown>>()
  return row ? rowToAsset(row) : null
}

function rowToAsset(row: Record<string, unknown>): AssetRecord {
  return {
    id: String(row.id),
    job_id: String(row.job_id),
    r2_key: String(row.r2_key),
    kind: row.kind as AssetRecord['kind'],
    filename: (row.filename as string) ?? null,
    content_type: (row.content_type as string) ?? null,
    bytes: (row.bytes as number) ?? null,
    width: (row.width as number) ?? null,
    height: (row.height as number) ?? null,
    sort_order: Number(row.sort_order ?? 0),
    stats: row.stats_json ? JSON.parse(String(row.stats_json)) : null,
    created_at: String(row.created_at),
  }
}

export async function recordEvent(
  env: Env,
  jobId: string | null,
  type: string,
  payload?: unknown,
): Promise<void> {
  // Events are the audit trail and, from Phase 6, the GHL webhook feed. Never let a logging
  // failure take down the request that produced it.
  try {
    await env.DB.prepare(
      'INSERT INTO events (id, job_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(id('evt'), jobId, type, payload ? JSON.stringify(payload) : null, nowIso())
      .run()
  } catch (err) {
    console.error('event write failed', type, err)
  }
}

export async function nextVersion(env: Env, jobId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COALESCE(MAX(version), 0) AS v FROM builds WHERE job_id = ?',
  )
    .bind(jobId)
    .first<{ v: number }>()
  return (row?.v ?? 0) + 1
}
