import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { PRICING, formatPrice, type PriceKey } from '../../shared/pricing'
import { ApiCallError, api } from '../lib/api'
import { Banner, Spinner } from '../components/ui'

/**
 * The demo checkout. Local preview only.
 *
 * Stands in for the Shopify checkout so the go-live and discharge flows can be clicked all the
 * way through with no accounts. Confirming here runs the same processPaidOrder the real
 * orders/paid webhook runs, so what gets exercised is the production path, not an imitation.
 *
 * NOTHING IS CHARGED. There is no payment form, because there is no payment.
 */
export default function DemoCheckout() {
  const [params] = useSearchParams()
  const navigate = useNavigate()

  const jobId = params.get('job') ?? ''
  const email = params.get('email') ?? ''
  const lines = (params.get('lines') ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const describe = (line: string) => {
    const handle = line.split(':')[0] ?? ''
    const key = (Object.keys(PRICING) as PriceKey[]).find((k) => PRICING[k].ref === handle)
    if (!key) return { label: handle, price: null }
    return { label: PRICING[key].label, price: formatPrice(key) }
  }

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.completeDemoCheckout({ jobId, email, lines: lines.join(',') })
      setDone(result.handled.map((h) => h.action))
    } catch (err) {
      setError(err instanceof ApiCallError ? (err.detail ?? err.message) : 'Could not complete the demo checkout')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-xl px-5 py-16">
      <p className="text-xs font-semibold tracking-[0.18em] text-ice-500 uppercase">Demo checkout</p>
      <h1 className="mt-1 mb-2 text-3xl">Pretend payment</h1>

      <div className="card mt-6 space-y-5">
        <Banner tone="warn" title="Nothing is charged here">
          <p>
            This install is in demo mode, so there is no Shopify and no payment. Confirming below runs exactly the
            same code the real orders/paid webhook runs, so the flow continues as it would after a genuine
            purchase.
          </p>
        </Banner>

        <div>
          <h2 className="mb-2 text-sm font-semibold">What would be purchased</h2>
          <ul className="space-y-1 text-sm">
            {lines.map((line) => {
              const item = describe(line)
              return (
                <li key={line} className="flex justify-between border-b border-ice-100 pb-1">
                  <span>{item.label}</span>
                  <span className="font-semibold">{item.price ?? 'price not set'}</span>
                </li>
              )
            })}
          </ul>
          {email ? <p className="field-hint mt-2">Receipt would go to {email}</p> : null}
        </div>

        {done ? (
          <Banner tone="ok" title="Done">
            <ul className="list-inside list-disc">
              {done.map((action, i) => (
                <li key={i}>{action}</li>
              ))}
            </ul>
          </Banner>
        ) : null}

        {error ? <Banner tone="error">{error}</Banner> : null}

        <div className="flex flex-wrap gap-3">
          {done ? (
            <button className="btn-accent" onClick={() => navigate(jobId ? `/golive/${jobId}` : '/start')}>
              Carry on
            </button>
          ) : (
            <button className="btn-accent" onClick={confirm} disabled={busy || lines.length === 0}>
              {busy ? <Spinner label="Working" /> : 'Pretend I paid'}
            </button>
          )}
          <button className="btn-ghost" onClick={() => navigate(jobId ? `/preview/${jobId}` : '/start')}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
