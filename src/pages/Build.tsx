import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { CheckResult, GenerationEvent, GenerationStage, VerificationReport } from '../../shared/types'
import { ApiCallError, api, previewUrl, streamGeneration } from '../lib/api'
import { Banner, Spinner } from '../components/ui'

/**
 * The generation screen. Brief s5: the customer watches the site assemble, and that moment is
 * the product. So the raw HTML streams into view as it arrives rather than hiding behind a
 * progress bar, and the verification result is shown honestly, including checks that were
 * skipped rather than passed.
 */

const STAGE_COPY: Record<GenerationStage, string> = {
  planning: 'Planning your content',
  building: 'Writing your website',
  assembling: 'Assembling it section by section',
  verifying: 'Checking every line',
  repairing: 'Fixing what did not pass',
  complete: 'Done',
  held: 'Held for review',
}

export default function Build() {
  const { jobId = '' } = useParams()
  const [stage, setStage] = useState<GenerationStage | null>(null)
  const [message, setMessage] = useState('')
  const [html, setHtml] = useState('')
  const [report, setReport] = useState<VerificationReport | null>(null)
  const [version, setVersion] = useState<number | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null)
  const [sections, setSections] = useState<string[]>([])
  const [health, setHealth] = useState<Awaited<ReturnType<typeof api.health>> | null>(null)

  const streamRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    void api
      .health()
      .then((h) => setHealth(h))
      .catch(() => setHealth(null))
  }, [])

  useEffect(() => {
    if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight
  }, [html])

  const run = async () => {
    setRunning(true)
    setError(null)
    setHtml('')
    setReport(null)
    setSections([])
    setVersion(null)

    try {
      await streamGeneration(jobId, (event: GenerationEvent) => {
        switch (event.type) {
          case 'status':
            setStage(event.stage)
            setMessage(event.message)
            break
          case 'html_chunk':
            setHtml((h) => h + event.text)
            break
          case 'section_done':
            setSections((s) => [...s, `${event.index}/${event.total} ${event.section}`])
            break
          case 'verification':
            setReport(event.report)
            break
          case 'repair':
            setMessage(`Repair pass ${event.attempt}: ${event.failing.join(', ')}`)
            break
          case 'done':
            setVersion(event.version)
            setStage(event.passed ? 'complete' : 'held')
            break
          case 'error':
            setError({ message: event.message, detail: event.detail })
            break
          case 'plan':
            break
        }
      })
    } catch (err) {
      setError({
        message: 'Generation could not start',
        detail: err instanceof ApiCallError ? (err.detail ?? err.message) : String(err),
      })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-5 py-10">
      <header className="mb-6">
        <p className="text-xs font-semibold tracking-[0.18em] text-ice-500 uppercase">
          Go Polar Creative
        </p>
        <h1 className="text-3xl">Building your website</h1>
      </header>

      {health && !health.anthropicKeyPresent && !health.offlineGeneration ? (
        <div className="mb-6">
          <Banner tone="warn" title="No Anthropic key configured">
            <p>
              Generation will fail until <code>ANTHROPIC_API_KEY</code> is set in <code>.env.local</code>, or{' '}
              <code>DEV_OFFLINE_GENERATION=1</code> is set to run the deterministic offline fixture instead.
            </p>
          </Banner>
        </div>
      ) : null}

      {health?.offlineGeneration ? (
        <div className="mb-6">
          <Banner tone="info" title="Offline fixture mode">
            <p>
              Generation is running the deterministic local fixture, not the Anthropic API. It exercises the whole
              pipeline including verification, but it is not the real output and not the quality bar.
            </p>
          </Banner>
        </div>
      ) : null}

      <div className="mb-6 flex flex-wrap items-center gap-4">
        <button className="btn-accent" onClick={run} disabled={running}>
          {running ? 'Building' : version ? 'Build it again' : 'Start the build'}
        </button>
        {running ? <Spinner label={stage ? STAGE_COPY[stage] : 'Starting'} /> : null}
        {message ? <span className="text-sm text-ice-700">{message}</span> : null}
      </div>

      {error ? (
        <div className="mb-6">
          <Banner tone="error" title={error.message}>
            <p className="font-mono text-xs break-words">{error.detail}</p>
          </Banner>
        </div>
      ) : null}

      {sections.length > 0 ? (
        <div className="mb-6">
          <Banner tone="info" title="Sectioned build">
            <p>{sections.join(' | ')}</p>
          </Banner>
        </div>
      ) : null}

      {html ? (
        <section className="mb-8">
          <h2 className="mb-2 text-lg">Your site, as it is written</h2>
          <pre
            ref={streamRef}
            className="max-h-96 overflow-auto rounded-xl border border-ice-200 bg-ice-900 p-4 text-[11px] leading-relaxed text-ice-100"
          >
            <code>{html.slice(-40000)}</code>
          </pre>
          <p className="field-hint">
            {html.length.toLocaleString()} characters so far. Showing the tail of the stream.
          </p>
        </section>
      ) : null}

      {report ? <ReportPanel report={report} /> : null}

      {version ? (
        <section className="mt-8">
          <h2 className="mb-3 text-lg">The finished site</h2>
          <div className="overflow-hidden rounded-xl border border-ice-200 bg-white">
            <iframe
              title="Generated website preview"
              src={previewUrl(jobId, version)}
              className="h-[70vh] w-full"
              sandbox="allow-scripts allow-popups"
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-3">
            <Link className="btn-accent" to={`/preview/${jobId}`}>
              Looks good, let me make changes
            </Link>
            <a className="btn-ghost" href={previewUrl(jobId, version)} target="_blank" rel="noreferrer">
              Open in a new tab
            </a>
            <a
              className="btn-ghost"
              href={`/api/jobs/${jobId}/builds/${version}/html`}
              target="_blank"
              rel="noreferrer"
            >
              View the raw index.html
            </a>
            <button
              className="btn-ghost"
              onClick={async () => {
                try {
                  const res = await api.reverify(jobId, version)
                  setReport(res.report as VerificationReport)
                } catch (err) {
                  setError({ message: 'Re-check failed', detail: String(err) })
                }
              }}
            >
              Run the checks again
            </button>
          </div>
        </section>
      ) : null}

      <p className="mt-10 text-sm">
        <Link className="text-ice-700 underline" to={`/intake/${jobId}`}>
          Back to your answers
        </Link>
      </p>
    </div>
  )
}

function ReportPanel({ report }: { report: VerificationReport }) {
  const all = [...report.static, ...report.render]
  const failed = all.filter((c) => c.status === 'fail')
  const skipped = all.filter((c) => c.status === 'skipped')

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-lg">Verification</h2>
      <div className="mb-4">
        {report.passed ? (
          <Banner tone="ok" title="Everything passed">
            <p>
              {all.length - skipped.length} of {all.length} checks passed
              {skipped.length > 0 ? `, ${skipped.length} could not run in this environment` : ''}.
              {report.repairPasses > 0 ? ` Took ${report.repairPasses} repair pass(es).` : ''}
            </p>
          </Banner>
        ) : (
          <Banner tone="error" title={`${failed.length} check(s) failed`}>
            <p>After {report.repairPasses} repair pass(es). The customer is not shown a build in this state.</p>
          </Banner>
        )}
      </div>

      <ul className="divide-y divide-ice-100 overflow-hidden rounded-xl border border-ice-200 bg-white">
        {all.map((c) => (
          <CheckRow key={c.id} check={c} />
        ))}
      </ul>
    </section>
  )
}

function CheckRow({ check }: { check: CheckResult }) {
  const tone =
    check.status === 'pass'
      ? 'text-emerald-600'
      : check.status === 'fail'
        ? 'text-red-600'
        : 'text-ice-300'
  const glyph = check.status === 'pass' ? 'PASS' : check.status === 'fail' ? 'FAIL' : 'SKIP'

  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 w-10 shrink-0 text-xs font-bold ${tone}`}>{glyph}</span>
        <div className="min-w-0">
          <p className="text-sm font-medium">{check.label}</p>
          {check.detail ? <p className="mt-0.5 text-xs text-ice-500">{check.detail}</p> : null}
          {check.evidence?.length ? (
            <ul className="mt-1.5 space-y-0.5">
              {check.evidence.map((e, i) => (
                <li key={i} className="font-mono text-[11px] break-words text-ice-700">
                  {e}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </li>
  )
}
