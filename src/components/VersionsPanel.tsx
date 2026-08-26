import { useState } from 'react'

type Build = { version: number; createdAt: string; passed: boolean; prompt: string | null }
type Versions = {
  jobId: string
  businessName: string | null
  currentVersion: number
  publishedVersion: number | null
  hostname: string | null
  previousPublishedVersion: number | null
  builds: Build[]
}

/**
 * Put a customer's live site back, from a screen rather than from curl.
 *
 * THIS IS THE PHONE CALL PATH. A customer publishes something wrong and rings Chris instead of
 * pressing undo themselves, which is exactly what a worried person does. Until now the only way
 * to help them was a curl command with a job id and a version number in it, typed correctly,
 * probably on a phone, while somebody waited on the line.
 *
 * IT IS A TWO STEP ACTION AND THAT IS DELIBERATE. Look up the job, read what the versions are,
 * then choose one. Taking a live business website back a version on a single click, from a field
 * somebody has just pasted into, is the kind of convenience that eventually restores the wrong
 * customer.
 *
 * The restore itself runs through the same publishJob gate as everything else, so a version that
 * cannot pass its checks is refused here too. The operator's escape hatch is `force` on
 * /admin/publish, which is a separate and deliberate second decision.
 */
export function VersionsPanel({ token }: { token: string }) {
  const [open, setOpen] = useState(false)
  const [jobId, setJobId] = useState('')
  const [data, setData] = useState<Versions | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const look = async () => {
    setBusy(true)
    setProblem(null)
    setDone(null)
    setData(null)
    try {
      const res = await fetch(`/api/admin/jobs/${encodeURIComponent(jobId.trim())}/versions`, {
        headers: { 'x-admin-token': token },
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.detail ?? body.error ?? 'Could not look that up')
      setData(body as Versions)
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Could not look that up')
    } finally {
      setBusy(false)
    }
  }

  const restore = async (version: number) => {
    if (!data) return
    // A live website. Worth one deliberate confirmation, with the numbers in it.
    const ok = window.confirm(
      `Put ${data.hostname} back to version ${version}?\n\nThe public is currently seeing version ${data.publishedVersion}. This publishes immediately.`,
    )
    if (!ok) return

    setBusy(true)
    setProblem(null)
    setDone(null)
    try {
      const res = await fetch('/api/admin/restore', {
        method: 'POST',
        headers: { 'x-admin-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: data.jobId, version }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.detail ?? body.error ?? 'The restore was refused')
      setDone(`${data.hostname} is back on version ${version}.`)
      await look()
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'The restore was refused')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-xl border border-ice-200">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="min-w-0">
          <span className="block font-bold">Put a site back</span>
          <span className="field-hint block">
            For the call where a customer published something wrong.
          </span>
        </span>
        <span aria-hidden="true" className="shrink-0 text-base leading-none text-ice-500">
          {open ? '−' : '+'}
        </span>
      </button>

      {open ? (
        <div className="space-y-3 border-t border-ice-100 px-4 pb-4 pt-3">
          <div className="flex flex-wrap gap-2">
            <input
              className="input flex-1"
              value={jobId}
              onChange={(e) => setJobId(e.target.value)}
              placeholder="job_..."
              spellCheck={false}
            />
            <button className="btn-ghost" onClick={look} disabled={busy || jobId.trim().length < 4}>
              {busy ? 'Looking' : 'Look up'}
            </button>
          </div>
          <p className="field-hint">
            The job id is in the operator alert, and on every card below.
          </p>

          {problem ? (
            <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
              {problem}
            </div>
          ) : null}
          {done ? (
            <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
              {done}
            </div>
          ) : null}

          {data ? (
            <div className="rounded-lg border border-ice-200 p-3">
              <p className="text-sm font-bold">{data.businessName ?? 'Unnamed business'}</p>
              <p className="field-hint">
                {data.hostname ? (
                  <>
                    {data.hostname} is showing <strong>version {data.publishedVersion}</strong>.
                    {data.previousPublishedVersion !== null ? (
                      <> Before that it was version {data.previousPublishedVersion}.</>
                    ) : (
                      <> This is the first version that has ever been published.</>
                    )}
                  </>
                ) : (
                  <>This job has no live site, so there is nothing to put back.</>
                )}
              </p>

              {data.hostname ? (
                <ul className="mt-3 space-y-1.5">
                  {data.builds.map((b) => (
                    <li
                      key={b.version}
                      className="flex flex-wrap items-baseline justify-between gap-2 border-t border-ice-100 pt-1.5 text-sm"
                    >
                      <span className="min-w-0">
                        <span className="font-semibold">v{b.version}</span>
                        {b.version === data.publishedVersion ? (
                          <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-800">
                            LIVE
                          </span>
                        ) : null}
                        {!b.passed ? (
                          <span className="ml-2 text-xs font-bold text-red-700">did not pass checks</span>
                        ) : null}
                        {/* Their own words for the change, so the list reads as a story. */}
                        {b.prompt ? (
                          <span className="field-hint block truncate">&ldquo;{b.prompt}&rdquo;</span>
                        ) : null}
                      </span>
                      {b.version !== data.publishedVersion ? (
                        <button
                          className="btn-ghost shrink-0 text-xs"
                          onClick={() => restore(b.version)}
                          disabled={busy}
                        >
                          Put this back live
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
