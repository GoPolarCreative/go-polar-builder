import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { testWeb3FormsKey, ApiCallError, api } from '../lib/api'
import { Banner, Field, Spinner, TextInput, BrandFooter, BrandHeader, Eyebrow } from '../components/ui'

/**
 * Phase 5, brief s9. Discharge.
 *
 * Available from the go-live screen and at any time after launch, visible and not hidden. What
 * they get and what they do not get are both on the page, because a customer who leaves and then
 * finds out they have no hosting is a customer who tells people about it.
 */
export default function Discharge() {
  const { jobId = '' } = useParams()
  const [data, setData] = useState<{
    price: string | null
    includes: string[]
    excludes: string[]
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
  } | null>(null)

  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [keyError, setKeyError] = useState<string | null>(null)
  const [configProblem, setConfigProblem] = useState<string | null>(null)

  const load = async () => {
    try {
      setData(await api.discharge(jobId))
    } catch (err) {
      setError(err instanceof ApiCallError ? (err.detail ?? err.message) : 'Could not load this page')
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  const request = async () => {
    setBusy(true)
    setError(null)
    setKeyError(null)
    setConfigProblem(null)
    try {
      // Same reason as go-live: Web3Forms blocks server-side calls at the TLS layer, so the test
      // submission has to leave from here. Skipped entirely when they did not type a key, because
      // the one they verified at go-live is reused.
      const trimmed = key.trim()
      const proof = trimmed ? await testWeb3FormsKey(trimmed) : null
      const res = await api.requestDischarge(jobId, trimmed || undefined, proof)
      if (res.checkoutUrl) window.location.href = res.checkoutUrl
      await load()
    } catch (err) {
      if (err instanceof ApiCallError && err.status === 422) setKeyError(err.detail ?? err.message)
      else if (err instanceof ApiCallError && err.status === 503) setConfigProblem(err.detail ?? err.message)
      else setError(err instanceof ApiCallError ? (err.detail ?? err.message) : 'Could not start that')
    } finally {
      setBusy(false)
    }
  }

  if (!data) {
    return (
      <div className="grid min-h-screen place-items-center">
        {error ? <Banner tone="error">{error}</Banner> : <Spinner label="Loading" />}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl px-5 py-10">
      <header className="mb-8">
        <BrandHeader />
        <Eyebrow>Your files</Eyebrow>
        <h1 className="text-4xl">Take it with you.</h1>
        <p className="mt-1 text-ice-700">
          You are welcome to. Here is exactly what that involves, {data.price} one off.
        </p>
      </header>

      <div className="card space-y-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <h2 className="mb-2 text-sm font-semibold">What you get</h2>
            <ul className="list-inside list-disc space-y-1 text-sm">
              {data.includes.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className="mb-2 text-sm font-semibold">What it does not include</h2>
            <ul className="list-inside list-disc space-y-1 text-sm text-ice-700">
              {data.excludes.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </div>
        </div>

        <Banner tone="info" title="Your enquiry forms">
          <p>{data.web3formsNote}</p>
        </Banner>

        <Field
          label="Your own Web3Forms access key"
          hint="Optional. Leave it blank and we will put a clearly marked placeholder in instead."
          error={keyError ?? undefined}
        >
          <TextInput
            value={key}
            onChange={setKey}
            placeholder="1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809"
            invalid={Boolean(keyError)}
          />
        </Field>

        {data.current?.status === 'released' ? (
          <Banner tone="ok" title="Your files are ready">
            <p>
              {data.current.fileCount} files.{' '}
              {data.current.expiresAt
                ? `The download link is good until ${new Date(data.current.expiresAt).toLocaleDateString('en-AU')}.`
                : ''}
            </p>
            <p className="mt-1">Check your email for the download link.</p>
            {data.current.usedPlaceholder ? (
              <p className="mt-2">
                Your forms have a placeholder key in them. They will not send anywhere until you replace it, and
                READ-ME-FIRST.txt in the zip explains how.
              </p>
            ) : null}
          </Banner>
        ) : data.current?.status === 'prepared' ? (
          <Banner tone="info" title="Nearly there">
            <p>Your files are packaged and one of our team is doing a last check before releasing them.</p>
          </Banner>
        ) : data.current?.status === 'awaiting_payment' && data.current.checkoutUrl ? (
          <Banner tone="info">
            <p>
              <a className="underline" href={data.current.checkoutUrl}>
                Finish your checkout
              </a>{' '}
              and we will package everything up.
            </p>
          </Banner>
        ) : null}

        {configProblem ? (
          <Banner tone="warn" title="Checkout is not connected yet">
            <p>Your request has been saved.</p>
            <p className="mt-1 font-mono text-xs break-words">{configProblem}</p>
          </Banner>
        ) : null}

        {error ? <Banner tone="error">{error}</Banner> : null}

        {data.current?.status !== 'released' ? (
          <button className="btn-accent" onClick={request} disabled={busy}>
            {busy ? 'Setting it up' : `Discharge my website, ${data.price}`}
          </button>
        ) : null}

        <p className="field-hint">The Go Polar credit stays in the footer of the exported files.</p>
      </div>

      <p className="mt-8 text-sm">
        <Link className="link-arrow" to={`/preview/${jobId}`}>
          Actually, take me back to my website
        </Link>
      </p>

      <BrandFooter />
    </div>
  )
}
