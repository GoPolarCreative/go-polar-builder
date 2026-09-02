import { useCallback, useEffect, useState } from 'react'
import { KlaviyoPanel } from '../components/KlaviyoPanel'
import { VersionsPanel } from '../components/VersionsPanel'
import { Banner, BrandFooter, BrandHeader, Eyebrow, Spinner, TextInput } from '../components/ui'

/**
 * The operator screen. Who has finished, and a button that gives you their files.
 *
 * WHY THIS EXISTS. Everything on this page was already reachable through /api/admin/*, but only
 * with a curl command carrying a header, which meant the day to day job of "see who is done and
 * take their files" needed a terminal and a copied token. That is not a workflow, it is a barrier,
 * and it is the reason this got asked for.
 *
 * THE TOKEN LIVES IN sessionStorage, NOT localStorage. It is the key to every customer's data and
 * their finished sites, so it dies with the tab rather than sitting on the disk of whatever machine
 * happened to open this once.
 *
 * THE DOWNLOAD CANNOT BE A PLAIN LINK. The files endpoint authenticates on a header, and an anchor
 * cannot send one. So the button fetches, reads the blob, and saves it. That also lets it read the
 * x-forms-key header off the response and say out loud whose inbox the enquiry forms in that
 * package point at, which is the one thing about a handover that is invisible and expensive to get
 * wrong.
 */

interface Job {
  jobId: string
  businessName: string | null
  email: string
  phone: string | null
  status: string
  version: number
  pagesAllowed: number
  editsLeft: number
  goLiveRequestedAt: string | null
  goLiveWaitingHours: number | null
  goLiveOverdue: boolean
  wants: { hosting: boolean; email: boolean; domain: boolean; domainName: string | null }
  hostingPaidAt: string | null
  formsKeyVerified: boolean
  readyForYou: boolean
  blockers: string[]
  updatedAt: string
}

interface Queue {
  summary: {
    readyToTakeLive: number
    paidButBlocked: number
    waitingGoLive: number
    goLiveOverdue: number
    total: number
  }
  waitingGoLive: Job[]
  ready: Job[]
  paidButBlocked: Job[]
  all: Job[]
}

const TOKEN_KEY = 'gp_admin_token'

export default function Ops() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? '')
  const [entered, setEntered] = useState('')
  const [queue, setQueue] = useState<Queue | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyJob, setBusyJob] = useState<string | null>(null)
  const [note, setNote] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  const [makingJob, setMakingJob] = useState(false)
  const [testJobError, setTestJobError] = useState<string | null>(null)

  /**
   * Mint a job to test with and go straight into it.
   *
   * Same window rather than a new tab: this is a thing to go and do, not a reference to keep open
   * beside the queue. The link is the real build link, so the wizard is entered exactly the way a
   * customer enters it and the session is established the same way.
   */
  const startTestBuild = async () => {
    setMakingJob(true)
    setTestJobError(null)
    try {
      const res = await fetch('/api/admin/test-job', {
        method: 'POST',
        headers: { 'x-admin-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) {
        const detail = await res.text()
        setTestJobError(
          res.status === 403
            ? 'That admin token was not accepted.'
            : `The job was not created (${res.status}). ${detail.slice(0, 200)}`,
        )
        return
      }
      const body = (await res.json()) as { startLink: string }
      window.location.href = body.startLink
    } catch (err) {
      setTestJobError(err instanceof Error ? err.message : 'Could not reach the server.')
    } finally {
      setMakingJob(false)
    }
  }

  const load = useCallback(async (tok: string) => {
    setLoading(true)
    setProblem(null)
    try {
      const res = await fetch('/api/admin/queue', { headers: { 'x-admin-token': tok } })
      if (res.status === 403) {
        sessionStorage.removeItem(TOKEN_KEY)
        setToken('')
        setProblem('That admin token was not accepted.')
        return
      }
      if (!res.ok) {
        setProblem(`The queue could not be read (${res.status}).`)
        return
      }
      setQueue((await res.json()) as Queue)
      sessionStorage.setItem(TOKEN_KEY, tok)
    } catch {
      setProblem('Could not reach the server.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (token) void load(token)
  }, [token, load])

  /*
   * Download, then say whose key went in. `allowPlaceholder` is the deliberate override for the
   * case where a customer has not set their own key up: it ships a commented placeholder rather
   * than the Go Polar key, and the result is labelled so a package that cannot receive enquiries
   * can never be mistaken for one that can.
   */
  const download = async (job: Job, allowPlaceholder: boolean) => {
    setBusyJob(job.jobId)
    setNote(null)
    try {
      const url =
        `/api/admin/jobs/${job.jobId}/files` + (allowPlaceholder ? '?allowGoPolarKey=yes' : '')
      const res = await fetch(url, { headers: { 'x-admin-token': token } })

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { detail?: string } | null
        setNote({
          tone: 'warn',
          text: body?.detail ?? `The files could not be built (${res.status}).`,
        })
        return
      }

      const whoseKey = res.headers.get('x-forms-key')
      const pages = res.headers.get('x-pages')
      const blob = await res.blob()
      const name =
        /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
        `${job.jobId}.zip`

      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href
      a.download = name
      a.click()
      URL.revokeObjectURL(href)

      setNote(
        whoseKey === 'customer'
          ? {
              tone: 'ok',
              text: `${name} downloaded. ${pages} page(s). The enquiry forms carry the customer's own Web3Forms key, so this is safe to put live.`,
            }
          : {
              tone: 'warn',
              text: `${name} downloaded, but the enquiry forms contain a PLACEHOLDER, not a working key. Do not put this live: anyone filling in the form would think they had contacted the business and nobody would receive it. Get them to finish the go-live screen, then download again.`,
            },
      )
    } catch {
      setNote({ tone: 'warn', text: 'The download did not complete.' })
    } finally {
      setBusyJob(null)
    }
  }

  if (!token) {
    return (
      <div className="mx-auto max-w-md px-6 py-16">
        <BrandHeader />
        <Eyebrow>Go Polar only</Eyebrow>
        <h1 className="mt-2 text-3xl font-black">Operator</h1>
        <p className="mt-2 text-sm text-ice-600">
          Paste the admin token. It is the <code>ADMIN_TOKEN</code> line in <code>.env.local</code>,
          and it is kept for this browser tab only.
        </p>
        <form
          className="mt-6 space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (entered.trim()) setToken(entered.trim())
          }}
        >
          <TextInput
            value={entered}
            onChange={setEntered}
            type="password"
            placeholder="Admin token"
            autoFocus
          />
          <button className="btn btn-primary w-full" type="submit">
            Open the queue
          </button>
        </form>
        {problem ? (
          <div className="mt-4">
            <Banner tone="error" title="Not accepted">
              <p>{problem}</p>
            </Banner>
          </div>
        ) : null}
        <BrandFooter />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <BrandHeader>
        <button
          className="text-sm text-ice-600 underline"
          onClick={() => {
            sessionStorage.removeItem(TOKEN_KEY)
            setToken('')
            setQueue(null)
          }}
        >
          Sign out
        </button>
      </BrandHeader>

      <div className="flex items-baseline justify-between">
        <div>
          <Eyebrow>The queue</Eyebrow>
          <h1 className="mt-2 text-3xl font-black">Who is finished.</h1>
        </div>
        <div className="flex gap-2">
          {/*
            Testing the wizard used to mean buying the product or finding an old build link. This
            mints a job behind the admin token and drops straight into the same /start?t= exchange
            a paying customer goes through, so what gets tested is the real path.
          */}
          <button className="btn" onClick={() => void startTestBuild()} disabled={makingJob}>
            {makingJob ? 'Creating…' : 'Start a test build'}
          </button>
          <button className="btn" onClick={() => void load(token)} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {testJobError ? (
        <div className="mt-6">
          <Banner tone="error" title="Could not create a test build">
            <p>{testJobError}</p>
          </Banner>
        </div>
      ) : null}

      {problem ? (
        <div className="mt-6">
          <Banner tone="error" title="Could not load">
            <p>{problem}</p>
          </Banner>
        </div>
      ) : null}

      {note ? (
        <div className="mt-6">
          <Banner tone={note.tone} title={note.tone === 'ok' ? 'Downloaded' : 'Read this'}>
            <p>{note.text}</p>
          </Banner>
        </div>
      ) : null}

      {loading && !queue ? <div className="mt-8"><Spinner label="Reading the queue" /></div> : null}

      {queue ? (
        <>
          <p className="mt-6 text-sm text-ice-600">
            <strong>{queue.summary.waitingGoLive}</strong> waiting to go live
            {queue.summary.goLiveOverdue > 0 ? (
              <span className="font-bold text-red-700"> ({queue.summary.goLiveOverdue} over 24h, ring them)</span>
            ) : null}{' '}
            · <strong>{queue.summary.readyToTakeLive}</strong> ready to take live ·{' '}
            <strong>{queue.summary.paidButBlocked}</strong> paid but blocked ·{' '}
            {queue.summary.total} total
          </p>

          {/*
            ABOVE THE JOB LISTS ON PURPOSE. Both of these answer questions about the SYSTEM rather
            than about one customer, and a system that cannot send email or cannot roll a site back
            is worth knowing about before working through anybody's job.
          */}
          <div className="space-y-3">
            <KlaviyoPanel token={token} />
            <VersionsPanel token={token} />
          </div>

          {/*
            The manual go-live flow (D53). Everyone here has pressed the button and their site is
            not live yet, longest wait first. Over 24 hours gets a red flag: that is the call list.
          */}
          <Section
            title="Waiting to go live"
            blurb="They pressed the button and got the setup email. Anyone over 24 hours, ring them."
            jobs={queue.waitingGoLive}
            busyJob={busyJob}
            onDownload={download}
            empty="Nobody is waiting."
          />

          <Section
            title="Ready to take live"
            blurb="Nothing is stopping these. Download and upload to the server."
            jobs={queue.ready}
            busyJob={busyJob}
            onDownload={download}
            empty="Nobody is ready yet."
          />

          <Section
            title="Paid, but blocked"
            blurb="These people have paid. Each one says what is stopping it."
            jobs={queue.paidButBlocked}
            busyJob={busyJob}
            onDownload={download}
            empty="Nothing paid is blocked."
          />

          <Section
            title="Everything else"
            blurb="Still building, or not paid yet."
            jobs={queue.all.filter(
              (j) =>
                !queue.ready.some((r) => r.jobId === j.jobId) &&
                !queue.waitingGoLive.some((w) => w.jobId === j.jobId) &&
                !j.hostingPaidAt,
            )}
            busyJob={busyJob}
            onDownload={download}
            empty="Nothing else."
          />
        </>
      ) : null}

      <BrandFooter />
    </div>
  )
}

function Section({
  title,
  blurb,
  jobs,
  busyJob,
  onDownload,
  empty,
}: {
  title: string
  blurb: string
  jobs: Job[]
  busyJob: string | null
  onDownload: (job: Job, allowPlaceholder: boolean) => void
  empty: string
}) {
  return (
    <section className="mt-10">
      <h2 className="text-xl font-bold">{title}</h2>
      <p className="mt-1 text-sm text-ice-600">{blurb}</p>
      {jobs.length === 0 ? (
        <p className="mt-4 text-sm text-ice-500">{empty}</p>
      ) : (
        <div className="mt-4 space-y-3">
          {jobs.map((job) => (
            <JobCard key={job.jobId} job={job} busy={busyJob === job.jobId} onDownload={onDownload} />
          ))}
        </div>
      )}
    </section>
  )
}

interface DnsAnswer {
  ok?: boolean
  error?: string
  detail?: string
  hostname?: string
  attachedToProject?: boolean
  dnsPointsHereYet?: boolean
  records?: Array<{ purpose: string; type: string; name: string; value: string }>
  servingNow?: { reachable: boolean; server: string | null }
  instructions?: string[]
  warning?: string
}

/**
 * The two records to type into the registrar, on the card of the job they belong to.
 *
 * This is the step of going live that a person does by hand while on the phone. The values
 * were only readable by logging into Vercel, finding the project, finding the domain and
 * reading a panel, three screens away from the customer they are for. Asked of Vercel rather
 * than written down here, because the right answer is a property of the project and not a
 * constant to paste into a component and let rot.
 */
function DnsPanel({ hostname }: { hostname: string }) {
  const [answer, setAnswer] = useState<DnsAnswer | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/admin/dns?hostname=' + encodeURIComponent(hostname), {
        // sessionStorage, and the same key the rest of this page uses. The header comment
        // above says why it is never localStorage: it opens every customer's data.
        headers: { 'x-admin-token': sessionStorage.getItem(TOKEN_KEY) ?? '' },
      })
      setAnswer((await res.json()) as DnsAnswer)
    } catch {
      setAnswer({ error: 'network', detail: 'Could not reach the server. Try again.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 border-t border-ice-100 pt-3">
      <button className="btn" disabled={busy} onClick={() => void load()}>
        {busy ? 'Asking Vercel…' : 'Connect DNS: show the records'}
      </button>

      {answer?.error ? (
        <p className="mt-2 text-sm text-amber-800">{answer.detail ?? answer.error}</p>
      ) : null}

      {answer?.ok ? (
        <div className="mt-3 space-y-3 text-sm">
          {answer.dnsPointsHereYet ? (
            <p className="font-bold text-emerald-800">
              Already pointing here. Nothing to change.
            </p>
          ) : null}

          <table className="w-full border-collapse text-left font-mono text-xs">
            <thead>
              <tr className="text-ice-500">
                <th className="py-1 pr-3 font-sans font-semibold">Type</th>
                <th className="py-1 pr-3 font-sans font-semibold">Name</th>
                <th className="py-1 font-sans font-semibold">Value</th>
              </tr>
            </thead>
            <tbody>
              {(answer.records ?? []).map((r) => (
                <tr key={r.type + r.name} className="border-t border-ice-100">
                  <td className="py-1.5 pr-3">{r.type}</td>
                  <td className="py-1.5 pr-3">{r.name}</td>
                  <td className="py-1.5 select-all">{r.value}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {answer.warning ? (
            <p
              className={
                answer.servingNow?.reachable
                  ? 'rounded-lg bg-amber-50 p-2 text-amber-900'
                  : 'text-ice-600'
              }
            >
              {answer.warning}
              {answer.servingNow?.server ? ` (served by ${answer.servingNow.server})` : ''}
            </p>
          ) : null}

          <ul className="space-y-1 text-ice-700">
            {(answer.instructions ?? []).map((line, i) => (
              <li key={i}>· {line}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function JobCard({
  job,
  busy,
  onDownload,
}: {
  job: Job
  busy: boolean
  onDownload: (job: Job, allowPlaceholder: boolean) => void
}) {
  const wants = [
    job.wants.hosting ? 'hosting' : null,
    job.wants.email ? 'email' : null,
    job.wants.domain ? `domain${job.wants.domainName ? ` (${job.wants.domainName})` : ''}` : null,
  ].filter(Boolean)

  return (
    // id + scroll-mt so an operator-alert email can link straight to one customer. scroll-mt
    // keeps the card clear of the sticky header when the browser jumps to it.
    <div id={`job-${job.jobId}`} className="scroll-mt-24 rounded-xl border border-ice-200 p-4 target:ring-2 target:ring-polar-accent">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-bold">{job.businessName ?? 'Unnamed business'}</p>
          <p className="text-sm text-ice-600">
            {job.email}
            {job.phone ? ` · ${job.phone}` : ''}
          </p>
          <p className="mt-1 text-xs text-ice-500">
            {job.status} · v{job.version} · {job.pagesAllowed} page(s) · {job.editsLeft} edits left
            {wants.length > 0 ? ` · wants ${wants.join(', ')}` : ''}
          </p>
          {job.goLiveWaitingHours !== null ? (
            <p className={`mt-1 text-xs font-bold ${job.goLiveOverdue ? 'text-red-700' : 'text-ice-600'}`}>
              Asked to go live {job.goLiveWaitingHours < 1 ? 'under an hour' : `${job.goLiveWaitingHours}h`} ago
              {job.goLiveOverdue ? ' · over 24 hours, ring them' : ''}
            </p>
          ) : null}
          <p className="mt-1 font-mono text-xs text-ice-400">{job.jobId}</p>
        </div>

        <div className="flex flex-col items-end gap-2">
          <span
            className={`rounded-full px-3 py-1 text-xs font-bold ${
              job.formsKeyVerified
                ? 'bg-emerald-100 text-emerald-800'
                : 'bg-amber-100 text-amber-800'
            }`}
          >
            {job.formsKeyVerified ? 'Their own forms key' : 'No forms key yet'}
          </span>

          <button
            className="btn btn-primary"
            disabled={busy || job.version < 1}
            onClick={() => onDownload(job, false)}
          >
            {busy ? 'Packaging…' : 'Download files'}
          </button>

          {/* Only offered where it is the actual blocker, so it never becomes the habit. */}
          {!job.formsKeyVerified && job.version >= 1 ? (
            <button
              className="text-xs text-ice-500 underline"
              disabled={busy}
              onClick={() => onDownload(job, true)}
            >
              Download anyway, with a placeholder
            </button>
          ) : null}
        </div>
      </div>

      {/*
        Only where a domain is actually named. A card with no domain has nothing to connect,
        and an empty panel on every job is how a screen stops being read.
      */}
      {job.wants.domainName ? <DnsPanel hostname={job.wants.domainName} /> : null}

      {job.blockers.length > 0 ? (
        <ul className="mt-3 space-y-1 border-t border-ice-100 pt-3 text-sm text-amber-800">
          {job.blockers.map((b, i) => (
            <li key={i}>· {b}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
