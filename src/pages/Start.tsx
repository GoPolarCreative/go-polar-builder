import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ApiCallError, api } from '../lib/api'
import { Banner, BrandFooter, BrandHeader, Eyebrow, Field, Spinner, Stat, TextInput } from '../components/ui'

/**
 * The front door. Brief s3a.
 *
 * A paying customer arrives here from the emailed build link at /start?t={token}. The token is
 * exchanged for a session cookie tied to their job, and then they are sent to whichever screen
 * matches where they are up to. The link is good for 90 days: people buy on a Thursday night and
 * start on a Sunday.
 *
 * "Send my link again" is on the same screen, keyed on email, so a lost email is self-service and
 * never becomes a support ticket.
 */
export default function Start() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const token = params.get('t')

  const [exchanging, setExchanging] = useState(Boolean(token))
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [health, setHealth] = useState<Awaited<ReturnType<typeof api.health>> | null>(null)

  useEffect(() => {
    void api.health().then(setHealth).catch(() => setHealth(null))
  }, [])

  useEffect(() => {
    if (!token) {
      // Already signed in from a previous visit? Go where they left off.
      void api
        .me()
        .then((me) => {
          if (me.signedIn) navigate(routeFor(me), { replace: true })
        })
        .catch(() => undefined)
      return
    }

    void (async () => {
      try {
        const res = await api.startWithToken(token)
        navigate(routeFor({ ...res, signedIn: true }), { replace: true })
      } catch (err) {
        setTokenError(
          err instanceof ApiCallError ? (err.detail ?? err.message) : 'That link could not be opened.',
        )
      } finally {
        setExchanging(false)
      }
    })()
  }, [token, navigate])

  if (exchanging) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner label="Opening your build" />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-xl px-5 py-12">
      <BrandHeader />

      <Eyebrow>Start here</Eyebrow>
      <h1 className="mb-3 text-4xl">Your website, built while you watch.</h1>
      <p className="mb-6 text-[17px]">
        Answer the questions. Upload your logo and some job photos. The site gets written and built
        in front of you, and you get ten rounds of changes to get it right.
      </p>

      <div className="mb-8 grid grid-cols-3 gap-4 border-y border-ice-200 py-5">
        <Stat figure="10" label="Rounds of changes" tone="accent" />
        <Stat figure="1" label="Page, done properly" />
        <Stat figure="0" label="Lock-in contracts" />
      </div>

      {tokenError ? (
        <div className="mb-6">
          <Banner tone="error" title="That link did not work">
            {tokenError}
          </Banner>
        </div>
      ) : null}

      <ClaimBuild />
      <ResendLink />

      {health && !health.shopifyConfigured ? <DevStart health={health} /> : null}

      <BrandFooter />
    </div>
  )
}

function routeFor(me: { signedIn: boolean; jobId?: string; status?: string; currentVersion?: number }): string {
  if (!me.jobId) return '/start'
  if ((me.currentVersion ?? 0) > 0) {
    if (me.status === 'go_live_pending' || me.status === 'live') return `/golive/${me.jobId}`
    if (me.status === 'discharged') return `/discharge/${me.jobId}`
    return `/preview/${me.jobId}`
  }
  if (me.status === 'intake' || me.status === 'generating') return `/build/${me.jobId}`
  return `/intake/${me.jobId}`
}

/**
 * The front door for somebody who has just paid.
 *
 * They land here straight from the Shopify confirmation, with the order number still on screen and
 * the email they typed at checkout fresh in their head. Nothing has to be delivered for this to
 * work, which is the entire point: the build used to be reachable only through an email, and when
 * that email stopped arriving the product stopped existing.
 *
 * The emailed link still works and is still the nicer route. This is the one that works anyway.
 */
function ClaimBuild() {
  const [email, setEmail] = useState('')
  const [orderNumber, setOrderNumber] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  const claim = async () => {
    setBusy(true)
    setError(null)
    try {
      const { jobId } = await api.claimBuild(email, orderNumber)
      navigate(`/intake/${jobId}`)
    } catch (err) {
      setError(err instanceof ApiCallError ? (err.detail ?? err.message) : 'Could not find that order')
    } finally {
      setBusy(false)
    }
  }

  const ready = email.includes('@') && orderNumber.trim().length > 0

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="text-xl">Just paid? Start here.</h2>
        <p className="field-hint">
          Use the email you paid with and either number from the page shown after you paid. The
          confirmation number looks like 6M2EGNICA, the order number like #GPC1258. Both work.
        </p>
      </div>

      <Field label="Email you paid with">
        <TextInput value={email} onChange={setEmail} type="email" placeholder="you@yourbusiness.com.au" />
      </Field>

      <Field label="Order or confirmation number">
        <TextInput value={orderNumber} onChange={setOrderNumber} placeholder="6M2EGNICA" />
      </Field>

      <button className="btn-primary" onClick={claim} disabled={busy || !ready}>
        {busy ? 'Checking' : 'Start building'}
      </button>

      {error ? <Banner tone="error">{error}</Banner> : null}
    </div>
  )
}

function ResendLink() {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const resend = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.resendLink(email)
      setSent(res.detail)
    } catch (err) {
      setError(err instanceof ApiCallError ? (err.detail ?? err.message) : 'Could not send that')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="text-xl">Been here before?</h2>
        <p className="field-hint">
          If you have not got the order number to hand, put in the email you paid with and we will
          send your link again.
        </p>
      </div>

      <Field label="Email">
        <TextInput value={email} onChange={setEmail} type="email" placeholder="you@yourbusiness.com.au" />
      </Field>

      <button className="btn-primary" onClick={resend} disabled={busy || email.length < 5}>
        {busy ? 'Sending' : 'Send my link'}
      </button>

      {sent ? <Banner tone="ok">{sent}</Banner> : null}
      {error ? <Banner tone="error">{error}</Banner> : null}
    </div>
  )
}

/**
 * DEVELOPMENT ONLY. Disappears the moment a Shopify webhook secret is configured, and the API
 * route behind it refuses to run then too. In production a job is created by the orders/paid
 * webhook and nowhere else.
 */
function DevStart({ health }: { health: Awaited<ReturnType<typeof api.health>> }) {
  const [email, setEmail] = useState('test@example.com')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      const { jobId } = await api.createDevJob(email)
      navigate(`/intake/${jobId}`)
    } catch (err) {
      setError(err instanceof ApiCallError ? (err.detail ?? err.message) : 'Could not start a build')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-8">
      <div className="card space-y-4">
        <Banner tone="warn" title="Development entry point">
          <p>
            No payment is wired up on this install. In production this page is reached from the emailed build link
            after the $220 build token is paid on Shopify.
          </p>
        </Banner>

        <Field label="Email">
          <TextInput value={email} onChange={setEmail} type="email" />
        </Field>

        <button className="btn-accent" onClick={start} disabled={busy}>
          {busy ? 'Starting' : 'Start a test build'}
        </button>

        {error ? <Banner tone="error">{error}</Banner> : null}
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-4">
        <Status label="Demo mode" ok={health.demoMode} neutral />
        <Status label="Anthropic key" ok={health.anthropicKeyPresent} />
        <Status label="Offline fixture" ok={health.offlineGeneration} neutral />
        <Status label="Sessions" ok={health.sessionsConfigured} />
        <Status label="Shopify" ok={health.shopifyConfigured} />
        <Status label="Email" ok={health.emailConfigured} />
        <Status label="GoHighLevel" ok={health.ghlConfigured} />
        <Status label="Live actions" ok={Object.values(health.live).some(Boolean)} />
      </dl>
      <p className="field-hint mt-2 text-center">
        database: {health.databaseDriver} | storage: {health.storageDriver} | render checks:{' '}
        {health.renderDriver}
      </p>
    </div>
  )
}

function Status({ label, ok, neutral }: { label: string; ok: boolean; neutral?: boolean }) {
  return (
    <div className="rounded-lg border border-ice-200 bg-white px-3 py-2">
      <dt className="text-ice-500">{label}</dt>
      <dd className={`font-semibold ${ok ? (neutral ? 'text-ice-700' : 'text-emerald-600') : 'text-ice-300'}`}>
        {ok ? 'on' : 'off'}
      </dd>
    </div>
  )
}
