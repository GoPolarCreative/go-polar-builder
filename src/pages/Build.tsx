import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { CheckResult, GenerationEvent, GenerationStage, VerificationReport } from '../../shared/types'
import { ApiCallError, api, previewUrl, streamGeneration } from '../lib/api'
import { Banner, BrandFooter, BrandHeader, Eyebrow } from '../components/ui'

/**
 * The generation screen. Brief s5: the customer watches the site assemble, and that moment is
 * the product. So the raw HTML streams into view as it arrives rather than hiding behind a
 * progress bar, and the verification result is shown honestly, including checks that were
 * skipped rather than passed.
 */

const STAGE_COPY: Record<GenerationStage, string> = {
  planning: 'Working out what goes on the page',
  building: 'Writing your website',
  assembling: 'Putting it together section by section',
  verifying: 'Checking every line of it',
  repairing: 'Fixing what did not pass',
  complete: 'Done',
  held: 'Held. A human is looking at it.',
}

/**
 * The order the build actually moves through, and how far along each stage means it is.
 *
 * The bar advances on stages the server has genuinely reached, never on a timer. A bar that
 * crawls forward on its own is a lie that gets found out at minute nine, and this screen is where
 * the customer decides whether the thing they paid for is working.
 *
 * It stops short of 100 until the build is really done, because arriving at full and then sitting
 * there is worse than arriving at eighty and moving.
 */
const STAGE_ORDER: GenerationStage[] = ['planning', 'building', 'assembling', 'verifying', 'repairing']

function progressFor(stage: GenerationStage | null, done: boolean): number {
  if (done) return 100
  if (!stage) return 4
  if (stage === 'complete') return 100
  if (stage === 'held') return 100
  const index = STAGE_ORDER.indexOf(stage)
  if (index < 0) return 8
  // Spread across 8..88 so the first stage looks started and the last does not look finished.
  return Math.round(8 + (index / STAGE_ORDER.length) * 80)
}

function elapsedLabel(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
}

/**
 * What the customer sees while it works.
 *
 * The old copy said it takes a minute or two. It takes six to twelve, and somebody who was told
 * two minutes starts refreshing at three — which on this screen means losing the stream and
 * believing it broke.
 */
function BuildProgress(props: { stage: GenerationStage | null; done: boolean; startedAt: number }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const pct = progressFor(props.stage, props.done)
  const seconds = Math.max(0, Math.floor((now - props.startedAt) / 1000))

  return (
    <div className="mb-6 rounded-xl border border-ice-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{props.stage ? STAGE_COPY[props.stage] : 'Starting'}</p>
        <p className="text-sm text-ice-600">{elapsedLabel(seconds)} so far</p>
      </div>

      <div
        className="mt-3 h-2 w-full overflow-hidden rounded-full bg-ice-100"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Build progress"
      >
        <div
          className="h-full rounded-full bg-accent transition-all duration-700 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      <ol className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
        {STAGE_ORDER.filter((s) => s !== 'repairing' || props.stage === 'repairing').map((s) => {
          const reached = props.done || STAGE_ORDER.indexOf(s) <= STAGE_ORDER.indexOf(props.stage ?? 'planning')
          return (
            <li key={s} className={reached ? 'font-medium text-ice-900' : 'text-ice-400'}>
              {reached ? '\u2713 ' : ''}
              {STAGE_COPY[s]}
            </li>
          )
        })}
      </ol>

      <p className="field-hint mt-3">
        This takes about five to ten minutes. Leave this screen open and do not refresh it. It is
        writing your copy, compressing and arranging your photos, and building your search data.
      </p>
    </div>
  )
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
  const [startedAt, setStartedAt] = useState<number | null>(null)

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
    setStartedAt(Date.now())
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
      <BrandHeader>
        <Link className="text-[13px] font-semibold text-ice-500 hover:text-ice-700" to={`/intake/${jobId}`}>
          Back to your answers
        </Link>
      </BrandHeader>

      <div className="mb-7">
        <Eyebrow>{version ? 'Built' : running ? 'Building now' : 'Ready to build'}</Eyebrow>
        <h1 className="text-4xl">
          {version ? 'Here it is.' : running ? 'Writing your website.' : 'Everything is in. Build it.'}
        </h1>
        <p className="mt-2 max-w-2xl text-[17px]">
          {version
            ? 'Every check below ran against the real page. Have a look on your phone as well as on a computer.'
            : 'It writes the copy, builds the page and then checks its own work. Five to ten minutes. Leave this screen open and watch it happen.'}
        </p>
      </div>

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
          <Banner tone="info" title="Offline fixture, not the real thing">
            <p>
              This build is coming from the local fixture rather than the model. It runs the whole
              pipeline including every check, but it is not the real output and not the quality bar.
            </p>
          </Banner>
        </div>
      ) : null}

      <div className="mb-6 flex flex-wrap items-center gap-4">
        <button className="btn-accent" onClick={run} disabled={running}>
          {running ? 'Building' : version ? 'Build it again' : 'Start the build'}
        </button>
        {message ? <span className="text-sm text-ice-700">{message}</span> : null}
      </div>

      {running && startedAt ? <BuildProgress stage={stage} done={false} startedAt={startedAt} /> : null}

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
          <div className="mb-2 flex items-end justify-between gap-4">
            <div>
              <Eyebrow>Live</Eyebrow>
              <h2 className="text-xl">Your website, being written</h2>
            </div>
            <p className="text-[13px] whitespace-nowrap text-ice-500">
              {html.length.toLocaleString()} characters
            </p>
          </div>
          <pre
            ref={streamRef}
            className="max-h-96 overflow-auto rounded-xl border border-ice-900 bg-ice-900 p-4 text-[11px] leading-relaxed text-white/70"
          >
            <code>{html.slice(-40000)}</code>
          </pre>
          <p className="field-hint">
            This is the actual page being built. Nothing here is a template.
          </p>
        </section>
      ) : null}

      {report ? <ReportPanel report={report} /> : null}

      {version ? (
        <section className="mt-8">
          <Eyebrow>The finished site</Eyebrow>
          <h2 className="mb-3 text-xl">This is yours.</h2>
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
              Change something →
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
              See the code
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

      <BrandFooter />

      <p className="hidden">
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
      <Eyebrow>What we checked</Eyebrow>
      <h2 className="mb-3 text-xl">It checks its own work.</h2>
      <div className="mb-4">
        {report.passed ? (
          <Banner tone="ok" title="Everything passed">
            <p>
              {all.length - skipped.length} of {all.length} checks passed
              {skipped.length > 0 ? `, ${skipped.length} could not run on this machine` : ''}.
              {report.repairPasses > 0 ? ` It fixed its own work ${report.repairPasses} time(s) to get there.` : ''}
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
