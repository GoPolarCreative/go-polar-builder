import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { GenerationEvent, VerificationReport } from '../../shared/types'
import { ApiCallError, api, previewUrl, streamEdit } from '../lib/api'
import { Banner, Spinner } from '../components/ui'

/**
 * Preview and the edit loop.
 *
 * The preview is a sandboxed iframe fed by srcdoc with every image inlined as a data URI, so
 * relative asset paths cannot break (brief s7). The edit counter is visible at all times, and the
 * placeholder tells the customer to batch their changes, because one submitted request is one
 * edit however many changes it contains.
 *
 * EVERY SUBMISSION ENDS IN SOMETHING VISIBLE. A change lands and the preview refreshes, or a
 * message says what went wrong in plain words. There is no third outcome, because an editor that
 * silently does nothing costs a customer one of their ten changes and all of their confidence.
 */

type VersionsState = Awaited<ReturnType<typeof api.versions>>
type Device = 'desktop' | 'mobile'

export default function Preview() {
  const { jobId = '' } = useParams()
  const navigate = useNavigate()

  const [versions, setVersions] = useState<VersionsState | null>(null)
  const [srcDoc, setSrcDoc] = useState<string>('')
  const [device, setDevice] = useState<Device>('desktop')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [request, setRequest] = useState('')
  const [running, setRunning] = useState(false)
  const [statusMessage, setStatusMessage] = useState('')
  const [liveHtml, setLiveHtml] = useState('')
  const [report, setReport] = useState<VerificationReport | null>(null)
  const [outcome, setOutcome] = useState<{ tone: 'ok' | 'warn' | 'error'; title: string; body: string } | null>(
    null,
  )
  const [extra, setExtra] = useState<Awaited<ReturnType<typeof api.extraEdits>> | null>(null)

  const streamRef = useRef<HTMLPreElement>(null)

  const loadVersions = useCallback(async () => {
    const v = await api.versions(jobId)
    setVersions(v)
    return v
  }, [jobId])

  const loadPreview = useCallback(
    async (version: number) => {
      const res = await fetch(previewUrl(jobId, version))
      if (!res.ok) throw new ApiCallError('Could not load the preview', res.status)
      setSrcDoc(await res.text())
    },
    [jobId],
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const v = await loadVersions()
        if (cancelled) return
        if (v.currentVersion < 1) {
          navigate(`/build/${jobId}`)
          return
        }
        await loadPreview(v.currentVersion)
        const e = await api.extraEdits(jobId)
        if (!cancelled) setExtra(e)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiCallError ? (err.detail ?? err.message) : 'Could not load your website')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [jobId, loadPreview, loadVersions, navigate])

  useEffect(() => {
    if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight
  }, [liveHtml])

  const submitEdit = async () => {
    const text = request.trim()
    if (text.length < 3 || running) return

    const before = versions
    setRunning(true)
    setError(null)
    setOutcome(null)
    setLiveHtml('')
    setReport(null)
    setStatusMessage('Sending it through')

    // Every path out of here sets one of these, so the submission can never end in silence.
    let sawDone: { version: number; passed: boolean } | null = null
    let sawError: string | null = null

    try {
      await streamEdit(jobId, text, (event: GenerationEvent) => {
        switch (event.type) {
          case 'status':
            setStatusMessage(event.message)
            break
          case 'html_chunk':
            setLiveHtml((h) => h + event.text)
            break
          case 'verification':
            setReport(event.report)
            break
          case 'error':
            sawError = event.detail ? `${event.message} ${event.detail}` : event.message
            break
          case 'done':
            sawDone = { version: event.version, passed: event.passed }
            break
          default:
            break
        }
      })
    } catch (err) {
      // A refusal arrives here as a non-200 with a real reason attached. It is not an unknown
      // failure and must not be described as one.
      sawError =
        err instanceof ApiCallError
          ? (err.detail ?? err.message)
          : err instanceof Error
            ? err.message
            : 'That change did not go through.'
    }

    setRunning(false)
    setLiveHtml('')
    setStatusMessage('')

    if (sawError) {
      setOutcome({
        tone: 'error',
        title: 'That change was not made',
        body: `${sawError} Your website has not been touched, and this has not used up one of your changes.`,
      })
      // Re-read the counter rather than trusting the local copy, so what is shown is what the
      // server actually recorded.
      await loadVersions().catch(() => undefined)
      return
    }

    if (!sawDone) {
      setOutcome({
        tone: 'error',
        title: 'That change was not made',
        body: 'The connection dropped before your change finished. Your website has not been touched. Try again, and if it keeps happening give us a ring.',
      })
      await loadVersions().catch(() => undefined)
      return
    }

    // Success path. Refresh both the counter and the iframe to the version just written.
    const done = sawDone as { version: number; passed: boolean }
    try {
      const v = await loadVersions()
      await loadPreview(v.currentVersion)
      setRequest('')

      const applied = v.currentVersion > (before?.currentVersion ?? 0)
      setOutcome(
        done.passed && applied
          ? {
              tone: 'ok',
              title: 'Change made',
              body: `You are now looking at version ${v.currentVersion}. ${v.editsRemaining} of ${v.editsAllowed} changes left.`,
            }
          : {
              tone: 'warn',
              title: 'Held for a check',
              body: 'Your change was built but did not pass all our checks, so one of our team is looking at it. Your previous version is safe and you can roll back to it below.',
            },
      )
    } catch (err) {
      setOutcome({
        tone: 'warn',
        title: 'Change made, but the preview did not refresh',
        body: `${err instanceof ApiCallError ? (err.detail ?? err.message) : 'Reload the page to see it.'}`,
      })
    }
  }

  const rollback = async (version: number) => {
    setRunning(true)
    setError(null)
    setOutcome(null)
    try {
      await api.rollback(jobId, version)
      const v = await loadVersions()
      await loadPreview(v.currentVersion)
      setOutcome({
        tone: 'ok',
        title: `Back on version ${version}`,
        body: 'Going back does not use up a change.',
      })
    } catch (err) {
      setError(err instanceof ApiCallError ? (err.detail ?? err.message) : 'Could not roll back')
    } finally {
      setRunning(false)
    }
  }

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner label="Loading your website" />
      </div>
    )
  }

  const remaining = versions?.editsRemaining ?? 0
  const outOfEdits = remaining === 0
  const canEdit = versions?.capability.available !== false

  return (
    <div className="flex min-h-screen flex-col lg:h-screen lg:flex-row lg:overflow-hidden">
      {/* Preview */}
      <main className="flex min-h-[60vh] flex-1 flex-col bg-ice-100 p-4 lg:h-full">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              className={device === 'desktop' ? 'chip-on' : 'chip-off'}
              onClick={() => setDevice('desktop')}
            >
              Desktop
            </button>
            <button className={device === 'mobile' ? 'chip-on' : 'chip-off'} onClick={() => setDevice('mobile')}>
              Mobile
            </button>
          </div>
          <div className="text-xs text-ice-500">
            Version {versions?.currentVersion} of {versions?.builds.length}
          </div>
        </div>

        <div className="flex flex-1 justify-center overflow-hidden rounded-xl border border-ice-200 bg-white">
          <iframe
            title="Your website"
            srcDoc={srcDoc}
            // Scripts run so the accordion and counters work. No same-origin, so the preview
            // cannot reach back into the builder.
            sandbox="allow-scripts"
            className={
              device === 'mobile' ? 'h-full w-[390px] max-w-full border-x border-ice-200' : 'h-full w-full'
            }
          />
        </div>
      </main>

      {/* Chat and history */}
      <aside className="flex w-full flex-col border-t border-ice-200 bg-white lg:h-full lg:w-[420px] lg:border-t-0 lg:border-l">
        <header className="border-b border-ice-100 px-5 py-4">
          <p className="text-xs font-semibold tracking-[0.18em] text-ice-500 uppercase">Go Polar Creative</p>
          <h1 className="text-xl">Your website</h1>
          <p className="mt-1 text-sm font-semibold text-ice-700">
            {remaining} of {versions?.editsAllowed} changes remaining
          </p>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {/* Said on load, before anything is typed. */}
          {!canEdit ? (
            <Banner tone="warn" title="Changes are switched off on this install">
              <p>{versions?.capability.reason}</p>
              <p className="mt-2">
                Everything else works: you can look through your website, go back to an earlier version, go live,
                or take your files.
              </p>
            </Banner>
          ) : null}

          {versions?.held ? (
            <Banner tone="warn" title="This version is being looked at">
              <p>
                The last change did not pass all our checks, so one of our team has been notified. Your earlier
                versions are safe and you can roll back to any of them below.
              </p>
            </Banner>
          ) : null}

          {outcome ? (
            <Banner tone={outcome.tone} title={outcome.title}>
              <p>{outcome.body}</p>
            </Banner>
          ) : null}

          {error ? <Banner tone="error">{error}</Banner> : null}

          {running ? (
            <div className="space-y-2">
              <Spinner label={statusMessage || 'Working'} />
              {liveHtml ? (
                <pre
                  ref={streamRef}
                  className="max-h-40 overflow-auto rounded-lg bg-ice-900 p-3 text-[10px] leading-relaxed text-ice-100"
                >
                  <code>{liveHtml.slice(-6000)}</code>
                </pre>
              ) : null}
            </div>
          ) : null}

          {report && !report.passed ? (
            <Banner tone="warn" title="Some checks did not pass">
              <ul className="list-inside list-disc">
                {[...report.static, ...report.render]
                  .filter((c) => c.status === 'fail')
                  .map((c) => (
                    <li key={c.id}>{c.label}</li>
                  ))}
              </ul>
            </Banner>
          ) : null}

          {outOfEdits && canEdit ? (
            <Banner tone="info" title="You have used all your included changes">
              <p>You can still go live whenever you are ready.</p>
              {extra?.available ? (
                <p className="mt-2">
                  Another {extra.quantity} changes are {extra.price}.
                </p>
              ) : (
                <p className="mt-2">
                  {extra?.detail ??
                    'If you need more changes before you go live, get in touch and we will sort it out with you.'}
                </p>
              )}
              <p className="mt-2">
                If you send another change through anyway it will still be made, and we will be in touch about it.
              </p>
            </Banner>
          ) : null}

          <section>
            <h2 className="mb-2 text-sm font-semibold">History</h2>
            <ul className="space-y-2">
              {versions?.builds.map((b) => {
                const edit = versions.edits.find((e) => e.versionTo === b.version)
                return (
                  <li
                    key={b.version}
                    className={`rounded-lg border px-3 py-2 text-xs ${
                      b.version === versions.currentVersion ? 'border-ice-700 bg-ice-100' : 'border-ice-200'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">
                        Version {b.version}
                        {b.version === versions.currentVersion ? ' (showing)' : ''}
                      </span>
                      {b.version !== versions.currentVersion ? (
                        <button
                          className="font-medium text-ice-700 underline disabled:opacity-50"
                          disabled={running}
                          onClick={() => rollback(b.version)}
                        >
                          Go back to this
                        </button>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-ice-500">
                      {new Date(b.createdAt).toLocaleString('en-AU')} | {Math.round((b.bytes ?? 0) / 1024)}KB
                      {b.passed ? '' : ' | did not pass checks'}
                    </p>
                    {edit?.prompt ? <p className="mt-1 text-ice-700">&ldquo;{edit.prompt}&rdquo;</p> : null}
                  </li>
                )
              })}
            </ul>
            <p className="field-hint mt-2">Going back to an earlier version does not use up a change.</p>
          </section>
        </div>

        <footer className="border-t border-ice-100 px-5 py-4">
          <label className="field-label" htmlFor="editRequest">
            What would you like changed?
          </label>
          <textarea
            id="editRequest"
            className="input min-h-24 disabled:cursor-not-allowed disabled:bg-ice-50"
            value={request}
            disabled={running || !canEdit}
            onChange={(e) => setRequest(e.target.value)}
            placeholder={
              canEdit
                ? 'Send as many changes as you like in one go, it only counts as one. For example: make the header darker, change the phone number to 0400 111 222, and swap the second and third services around.'
                : 'Changes are switched off on this install. See the note above.'
            }
          />
          {canEdit ? (
            // The style chosen in the intake is on the plan, so a restyle is a normal edit. Worth
            // saying, because nobody guesses that the whole look is on the table.
            <p className="field-hint">
              You can change the overall look here too. Something like "can it feel more upmarket"
              or "this is too plain, make it tougher" counts as one change like any other.
            </p>
          ) : null}
          <div className="mt-3 flex items-center justify-between gap-3">
            <Link className="text-xs text-ice-500 underline" to={`/golive/${jobId}`}>
              I am ready to go live
            </Link>
            <button
              className="btn-accent"
              onClick={submitEdit}
              disabled={running || !canEdit || request.trim().length < 3}
            >
              {running ? 'Working' : 'Make this change'}
            </button>
          </div>
        </footer>
      </aside>
    </div>
  )
}
