import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiCallError, api } from '../lib/api'
import { Banner, Field, TextInput } from '../components/ui'

/**
 * Development entry point.
 *
 * PHASE 1 ONLY. In production the customer arrives at /start?t={token} from the email sent after
 * the Shopify orders/paid webhook (brief s3a), and a job is never created by anything else.
 * This screen exists so the intake wizard can be worked on before payments and auth land in
 * Phase 6. The API route behind it refuses to run once Shopify is configured.
 */
export default function Start() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('test@example.com')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [health, setHealth] = useState<{
    anthropicKeyPresent: boolean
    offlineGeneration: boolean
    browserRendering: boolean
  } | null>(null)

  useEffect(() => {
    void api.health().then(setHealth).catch(() => setHealth(null))
  }, [])

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
    <div className="mx-auto max-w-xl px-5 py-16">
      <p className="text-xs font-semibold tracking-[0.18em] text-ice-500 uppercase">
        Go Polar Creative
      </p>
      <h1 className="mt-1 mb-2 text-3xl">Website builder</h1>
      <p className="mb-8 text-ice-700">
        Answer a few questions and watch your website get built in front of you.
      </p>

      <div className="card space-y-4">
        <Banner tone="warn" title="Development entry point">
          <p>
            There is no payment or login yet. In production this page is reached from the emailed build link after
            the $200 build token is paid on Shopify.
          </p>
        </Banner>

        <Field label="Email" hint="Used to find your build again.">
          <TextInput value={email} onChange={setEmail} type="email" />
        </Field>

        <button className="btn-accent" onClick={start} disabled={busy}>
          {busy ? 'Starting' : 'Start a test build'}
        </button>

        {error ? <Banner tone="error">{error}</Banner> : null}
      </div>

      {health ? (
        <dl className="mt-8 grid grid-cols-3 gap-3 text-center text-xs">
          <Status label="Anthropic key" ok={health.anthropicKeyPresent} />
          <Status label="Offline fixture" ok={health.offlineGeneration} neutral />
          <Status label="Browser Rendering" ok={health.browserRendering} />
        </dl>
      ) : null}
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
