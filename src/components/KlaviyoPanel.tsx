import { useEffect, useState } from 'react'

type Metric = {
  key: string
  name: string
  state: 'never' | 'recent' | 'quiet' | 'failing'
  lastFiredAt: string | null
  lastFailedAt: string | null
  recentSends: number
  detail: string
}

type Health = { window: string; neverFired: number; failing: number; metrics: Metric[] }

/**
 * Which emails can actually reach a customer.
 *
 * THE FAILURE THIS MAKES VISIBLE. The app fires an event, Klaviyo answers 202, the app records a
 * success. If no flow is listening, the 202 is still a 202 and nothing looks wrong anywhere. The
 * customer just never gets the email: a paid discharge with no download link, a returning
 * customer with no sign-in code, and logs that say it all worked.
 *
 * NEVER FIRED IS THE STATE THAT MATTERS and it is drawn as an alarm, not as a neutral zero.
 * A metric that has never fired definitely has no flow, because Klaviyo will not offer it in the
 * trigger picker until one event of that name arrives. That is a fact this panel can prove.
 *
 * WHAT IT DOES NOT CLAIM. A metric that fired an hour ago tells you this app's side works. It
 * does NOT tell you an email arrived, because only Klaviyo knows that. The panel says so out
 * loud, because a green tick that quietly means "sent to a void" would be worse than no panel.
 */
export function KlaviyoPanel({ token }: { token: string }) {
  const [data, setData] = useState<Health | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!token) return
    void fetch('/api/admin/klaviyo-health', { headers: { 'x-admin-token': token } })
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => setData(null))
  }, [token])

  if (!data) return null

  const bad = data.neverFired + data.failing

  return (
    <section className="rounded-xl border border-ice-200">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="min-w-0">
          <span className="block font-bold">Customer emails</span>
          <span className="field-hint block">
            {bad === 0
              ? 'Every metric has fired at least once.'
              : `${bad} of ${data.metrics.length} cannot reach a customer.`}
          </span>
        </span>
        <span
          className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold ${
            bad === 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
          }`}
        >
          {data.metrics.length - bad} of {data.metrics.length} live
        </span>
      </button>

      {open ? (
        <div className="border-t border-ice-100 px-4 pb-4 pt-3">
          <p className="field-hint mb-3">
            This shows what the app sent, not what Klaviyo delivered. A metric that has never fired
            definitely has no flow. One that fired recently only means our side worked.
          </p>

          <ul className="space-y-2">
            {data.metrics.map((m) => (
              <li
                key={m.key}
                className={`rounded-lg border px-3 py-2 ${
                  m.state === 'never' || m.state === 'failing'
                    ? 'border-red-300 bg-red-50'
                    : m.state === 'quiet'
                      ? 'border-amber-200 bg-amber-50'
                      : 'border-ice-200 bg-white'
                }`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono text-[13px] font-semibold">{m.name}</span>
                  <span
                    className={`text-xs font-bold ${
                      m.state === 'never' || m.state === 'failing'
                        ? 'text-red-800'
                        : m.state === 'quiet'
                          ? 'text-amber-800'
                          : 'text-emerald-800'
                    }`}
                  >
                    {m.state === 'never'
                      ? 'NEVER FIRED'
                      : m.state === 'failing'
                        ? 'LAST ATTEMPT FAILED'
                        : m.lastFiredAt
                          ? whenever(m.lastFiredAt)
                          : ''}
                  </span>
                </div>
                <p className="field-hint mt-1">{m.detail}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

/** "3 hours ago" beats a timestamp when the question is "is this thing alive". */
function whenever(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (mins < 60) return `${Math.max(1, mins)} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)} days ago`
}

