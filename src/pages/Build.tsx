import { useEffect, useState } from 'react'
import { InboxBeforeBuild } from '../components/InboxSetup'
import { StreamingPreview } from '../components/StreamingPreview'
import { Link, useParams } from 'react-router-dom'
import type { CheckResult, GenerationEvent, GenerationStage, VerificationReport } from '../../shared/types'
import { ApiCallError, api, previewUrl, streamGeneration } from '../lib/api'
import { Banner, BrandFooter, BrandHeader, Eyebrow } from '../components/ui'
import { BuildProgress } from '../components/BuildProgress'

/**
 * The generation screen. Brief s5: the customer watches the site assemble, and that moment is
 * the product. So the raw HTML streams into view as it arrives rather than hiding behind a
 * progress bar, and the verification result is shown honestly, including checks that were
 * skipped rather than passed.
 */

export default function Build() {
  const { jobId = '' } = useParams()
  const [stage, setStage] = useState<GenerationStage | null>(null)
  const [message, setMessage] = useState('')
  const [report, setReport] = useState<VerificationReport | null>(null)
  const [version, setVersion] = useState<number | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null)
  const [sections, setSections] = useState<string[]>([])
  const [health, setHealth] = useState<Awaited<ReturnType<typeof api.health>> | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  /*
   * The streamed document, accumulated so it can be WRITTEN INTO THE PREVIEW as it arrives.
   *
   * This state was removed a day earlier along with the raw markup panel it used to feed, which
   * was correct: no tradesperson wants to watch HTML scroll past for ten minutes. It comes back
   * for the opposite reason. The same bytes now render as the actual page in StreamingPreview,
   * which is what the brief meant by watching the site build itself.
   */
  const [streamed, setStreamed] = useState('')
  // The content plan arrives around 40 seconds in, long before any HTML. It is the only real
  // thing there is to show during the minutes the model spends writing the document.
  const [plan, setPlan] = useState<unknown>(null)


  useEffect(() => {
    void api
      .health()
      .then((h) => setHealth(h))
      .catch(() => setHealth(null))
  }, [])

  const run = async () => {
    setRunning(true)
    setStartedAt(Date.now())
    setError(null)
    setStreamed('')
    setPlan(null)
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
            setStreamed((h) => h + event.text)
            /*
             * Swallowed on purpose. The document still streams from the server, because the
             * server streams it to prove liveness and other consumers read it, but this screen no
             * longer shows raw markup to the customer and so has nothing to do with the bytes.
             * Accumulating them into state was costing a full copy of the document in memory to
             * feed a panel that has been removed.
             */
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
            setPlan(event.plan)
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

      {/*
        BEFORE THE BUILD, NOT AFTER IT. A tester walking the flow unguided finished his website,
        was asked for a Web3Forms key on the editing page, and stopped. Asked here it is one more
        setup question among the setup questions, and the generation they are about to wait five
        minutes for gives them something to do while they make the account.

        Hidden while a build runs and after one finishes in this session, so it is never competing
        with the thing they came to watch. It is NOT hidden on a later visit to this page, because
        version is not hydrated from the server: that is fine, because the card collapses itself to
        a single green line once the key is verified, so the only person who sees it twice is the
        person who has not done it yet.
      */}
      {!version && !running ? <InboxBeforeBuild jobId={jobId} /> : null}

      <div className="mb-6 flex flex-wrap items-center gap-4">
        <button className="btn-accent" onClick={run} disabled={running}>
          {running ? 'Building' : version ? 'Build it again' : 'Start the build'}
        </button>
        {message ? <span className="text-sm text-ice-700">{message}</span> : null}
      </div>

      {running && startedAt ? <BuildProgress stage={stage} done={false} startedAt={startedAt} /> : null}

      {/*
        THE SITE, APPEARING. Shown from the moment the first bytes arrive until the build finishes
        and the checked version takes over below. It carries its own "not finished yet" banner, so
        a page that is still half written can never be mistaken for the delivered one.
      */}
      {running || (streamed && !version) ? (
        <div className="mb-6">
          <StreamingPreview
            html={streamed}
            state={error ? 'failed' : running ? 'streaming' : 'done'}
            label="Writing your website"
            plan={plan}
            startedAt={startedAt}
          />
        </div>
      ) : null}

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

      {/*
        THE RAW HTML STREAM USED TO SIT HERE AND HAS BEEN REMOVED.

        It printed the document as the model wrote it, under the heading "Your website, being
        written", with a character counter. The intent was to prove the thing was working and that
        nothing was a template. What it actually did was show a tradie forty thousand characters of
        markup scrolling past for ten minutes.

        The progress bar above does the same job honestly: it moves on stages the server has really
        reached, names each one in words, and says how long it has been going. That is the
        reassurance this screen owed the customer. The code was never the reassurance.
      */}

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
