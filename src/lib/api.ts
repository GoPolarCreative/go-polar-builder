import type { AssetRecord, AssetStats, AuditFlag, GenerationEvent, Job } from '../../shared/types'
import type { IntakePayload } from '../../shared/intake'
import type { Suburb } from '../../shared/suburbs'

/**
 * API client.
 *
 * Brief s14: every external call is wrapped and surfaces a real error to the UI, never a silent
 * fail. ApiCallError carries the server's own detail string so the wizard can show the actual
 * reason instead of "something went wrong".
 */

export class ApiCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
    readonly issues?: Array<{ path: string; message: string }>,
  ) {
    super(message)
    this.name = 'ApiCallError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, init)
  } catch (err) {
    throw new ApiCallError(
      'Could not reach the server. Check your connection and try again.',
      0,
      err instanceof Error ? err.message : String(err),
    )
  }

  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = { error: 'bad_response', detail: text.slice(0, 300) }
    }
  }

  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; detail?: string; issues?: Array<{ path: string; message: string }> }
    throw new ApiCallError(b.error ?? `Request failed (${res.status})`, res.status, b.detail, b.issues)
  }
  return body as T
}

export interface JobResponse {
  job: Job
  intake: Partial<IntakePayload> | null
  intakeSubmittedAt: string | null
  auditFlags: AuditFlag[]
  assets: AssetRecord[]
  builds: Array<{ version: number; passed: number; bytes: number; created_at: string }>
}

export const api = {
  health: () =>
    request<{
      ok: boolean
      anthropicKeyPresent: boolean
      offlineGeneration: boolean
      browserRendering: boolean
      shopifyConfigured: boolean
      emailConfigured: boolean
      ghlConfigured: boolean
      sessionsConfigured: boolean
    }>('/api/health'),

  // --- Phase 6: auth --------------------------------------------------------------------------
  /** Exchange the emailed build token for a session cookie. */
  startWithToken: (token: string) =>
    request<{ jobId: string; status: string; currentVersion: number; session: string }>('/api/auth/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    }),

  me: () =>
    request<{
      signedIn: boolean
      jobId?: string
      status?: string
      currentVersion?: number
      editsRemaining?: number
    }>('/api/auth/me'),

  resendLink: (email: string) =>
    request<{ ok: true; detail: string }>('/api/auth/resend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    }),

  createDevJob: (email: string, name?: string) =>
    request<{ jobId: string; userId: string; session: string; startLink: string }>('/api/dev/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, name }),
    }),

  getJob: (jobId: string) => request<JobResponse>(`/api/jobs/${jobId}`),

  saveDraft: (jobId: string, payload: unknown) =>
    request<{ ok: true }>(`/api/jobs/${jobId}/intake`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  submitIntake: (jobId: string, payload: unknown) =>
    request<{ ok: true; auditFlags: AuditFlag[] }>(`/api/jobs/${jobId}/intake/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  searchSuburbs: (q: string) =>
    request<{ results: Suburb[] }>(`/api/lookup/suburbs?q=${encodeURIComponent(q)}`),

  checkAbn: (value: string) =>
    request<{ valid: boolean; normalised: string | null; formatted: string | null; detail: string }>(
      `/api/lookup/abn?value=${encodeURIComponent(value)}`,
    ),

  uploadAsset: async (
    jobId: string,
    file: File,
    kind: 'logo' | 'photo',
    stats: AssetStats | null,
  ) => {
    const form = new FormData()
    form.append('file', file)
    form.append('kind', kind)
    if (stats) form.append('stats', JSON.stringify(stats))
    return request<{ asset: AssetRecord }>(`/api/jobs/${jobId}/assets`, {
      method: 'POST',
      body: form,
    })
  },

  deleteAsset: (assetId: string) =>
    request<{ ok: true }>(`/api/assets/${assetId}`, { method: 'DELETE' }),

  reorderAssets: (jobId: string, ids: string[]) =>
    request<{ ok: true }>(`/api/jobs/${jobId}/assets/order`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    }),

  buildChecks: (jobId: string, version: number) =>
    request<{ report: unknown }>(`/api/jobs/${jobId}/builds/${version}/checks`),

  // --- Phase 4: versions, rollback, edit allowance -------------------------------------------
  versions: (jobId: string) =>
    request<{
      currentVersion: number
      editsUsed: number
      editsAllowed: number
      editsRemaining: number
      overAllowance: boolean
      held: boolean
      heldReason: string | null
      builds: Array<{ version: number; bytes: number; passed: number; repair_passes: number; created_at: string }>
      edits: Array<{
        version_from: number
        version_to: number
        prompt: string | null
        diff_summary: string | null
        counted: number
        created_at: string
      }>
    }>(`/api/jobs/${jobId}/versions`),

  rollback: (jobId: string, version: number) =>
    request<{ ok: true; currentVersion: number; editsCharged: number }>(`/api/jobs/${jobId}/rollback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version }),
    }),

  // --- Phase 5: go live, domains, discharge ---------------------------------------------------
  goLive: (jobId: string) =>
    request<{
      jobStatus: string
      currentVersion: number
      selection: {
        hosting: boolean
        emailAddon: boolean
        domainAddon: boolean
        status: string
        checkoutUrl: string | null
        paidAt: string | null
      } | null
      domain: { name: string; branch: string; status: string; report: unknown } | null
      pricing: Record<string, { label: string; price: string | null; required: boolean }>
      promise: string
    }>(`/api/jobs/${jobId}/golive`),

  goLivePlan: (jobId: string, body: { emailAddon: boolean; domainAddon: boolean }) =>
    request<{ checkoutUrl: string | null; promise: string }>(`/api/jobs/${jobId}/golive/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),

  inspectDomain: (jobId: string, domain: string) =>
    request<{ report: unknown }>(
      `/api/jobs/${jobId}/golive/domain/inspect?domain=${encodeURIComponent(domain)}`,
    ),

  checkDomain: (jobId: string, domain: string) =>
    request<{ domain: string; available: boolean | null; detail: string; requiresAbn: boolean }>(
      `/api/jobs/${jobId}/golive/domain/available?domain=${encodeURIComponent(domain)}`,
    ),

  submitDomain: (
    jobId: string,
    body: { branch: string; domain: string; abn?: string; entityName?: string },
  ) =>
    request<{ ok: true; branch: string; domain: string; report: unknown; nextSteps: string[] }>(
      `/api/jobs/${jobId}/golive/domain`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),

  goLiveConfirmation: (jobId: string) =>
    request<{
      paid: boolean
      monthly: Array<{ label: string; price: string | null }>
      domain: { name: string; branch: string; status: string } | null
      promise: string
      afterLaunch: { label: string; price: string | null; detail: string }
    }>(`/api/jobs/${jobId}/golive/confirmation`),

  discharge: (jobId: string) =>
    request<{
      price: string | null
      includes: string[]
      excludes: string[]
      footerCreditStays: boolean
      web3formsNote: string
      current: {
        status: string
        checkoutUrl: string | null
        preparedAt: string | null
        releasedAt: string | null
        expiresAt: string | null
        usedPlaceholder: boolean
        fileCount: number | null
      } | null
    }>(`/api/jobs/${jobId}/discharge`),

  requestDischarge: (jobId: string, web3formsKey?: string) =>
    request<{ dischargeId: string; checkoutUrl: string | null; price: string | null }>(
      `/api/jobs/${jobId}/discharge/request`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ web3formsKey }),
      },
    ),

  extraEdits: (jobId: string) =>
    request<{ available: boolean; quantity: number; price: string | null; included: number; detail: string | null }>(
      `/api/jobs/${jobId}/edits/extra`,
    ),

  reverify: (jobId: string, version: number) =>
    request<{ report: unknown }>(`/api/jobs/${jobId}/builds/${version}/verify`, { method: 'POST' }),
}

export function assetUrl(assetId: string): string {
  return `/api/assets/${assetId}/raw`
}

export function previewUrl(jobId: string, version: number): string {
  return `/api/jobs/${jobId}/builds/${version}/preview`
}

/**
 * Open the generation stream. Uses fetch rather than EventSource because the endpoint is a POST,
 * and because a dropped connection must surface as an error rather than silently reconnecting
 * and restarting a paid generation.
 */
export async function streamGeneration(
  jobId: string,
  onEvent: (e: GenerationEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamSse(`/api/jobs/${jobId}/generate`, undefined, onEvent, signal)
}

/** Submit one change request. One request is one edit, however many changes it contains. */
export async function streamEdit(
  jobId: string,
  editRequest: string,
  onEvent: (e: GenerationEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamSse(`/api/jobs/${jobId}/edits`, { request: editRequest }, onEvent, signal)
}

async function streamSse(
  path: string,
  body: unknown,
  onEvent: (e: GenerationEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    signal,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })

  if (!res.ok) {
    const text = await res.text()
    let detail = text.slice(0, 300)
    try {
      detail = (JSON.parse(text) as { detail?: string }).detail ?? detail
    } catch {
      /* keep the raw text */
    }
    throw new ApiCallError('Generation could not start', res.status, detail)
  }
  if (!res.body) throw new ApiCallError('Generation returned no stream', 502)

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += value

    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const line = frame.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as GenerationEvent)
      } catch {
        /* a malformed frame is not worth killing the stream over */
      }
    }
  }
}
