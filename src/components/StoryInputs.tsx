import { DAYS, DAY_LABELS, type Hours, type Review } from '../../shared/intake'
import type { AuditFlag } from '../../shared/types'
import { Banner, Field, TextArea, TextInput, YesNo } from './ui'

/**
 * Day-by-day hours. Defaults to Mon-Fri 7-5 (brief s4 step 4) and tracks whether the customer
 * actually touched it, because "default hours" and "chosen hours that happen to match" are
 * different facts and only one of them gets flagged for confirmation before launch.
 */
export function HoursEditor({ value, onChange }: { value: Hours; onChange: (h: Hours) => void }) {
  const set = (patch: Partial<Hours>) => onChange({ ...value, ...patch, isDefault: false })

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="field-label mb-0">Open by appointment only?</span>
        <YesNo value={value.byAppointment} onChange={(v) => set({ byAppointment: v })} />
      </div>

      {value.byAppointment ? (
        <Banner tone="info">
          The site will say &ldquo;by appointment&rdquo; instead of listing hours, and no opening hours will be
          published to Google.
        </Banner>
      ) : (
        <div className="overflow-hidden rounded-lg border border-ice-200 bg-white">
          {DAYS.map((day) => {
            const d = value[day]
            return (
              <div
                key={day}
                className="flex flex-wrap items-center gap-3 border-b border-ice-100 px-4 py-2.5 last:border-b-0"
              >
                <span className="w-24 text-sm font-medium">{DAY_LABELS[day]}</span>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!d.closed}
                    onChange={(e) => set({ [day]: { ...d, closed: !e.target.checked } } as Partial<Hours>)}
                  />
                  Open
                </label>
                {!d.closed ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="time"
                      className="input w-32 py-1.5"
                      value={d.open}
                      onChange={(e) => set({ [day]: { ...d, open: e.target.value } } as Partial<Hours>)}
                    />
                    <span className="text-sm text-ice-500">to</span>
                    <input
                      type="time"
                      className="input w-32 py-1.5"
                      value={d.close}
                      onChange={(e) => set({ [day]: { ...d, close: e.target.value } } as Partial<Hours>)}
                    />
                  </div>
                ) : (
                  <span className="text-sm text-ice-500">Closed</span>
                )}
              </div>
            )
          })}
        </div>
      )}

      {value.isDefault ? (
        <p className="field-hint mt-2">
          These are our standard trade hours. Have a look before you go live, they show on Google.
        </p>
      ) : null}
    </div>
  )
}

/**
 * Reviews. Optional, maximum 6. If none are supplied no testimonial section is built and nothing
 * is invented, which is stated here so the customer understands the trade.
 */
export function ReviewsEditor({
  value,
  onChange,
}: {
  value: Review[]
  onChange: (r: Review[]) => void
}) {
  const update = (index: number, patch: Partial<Review>) => {
    onChange(value.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  return (
    <div className="space-y-4">
      {value.length === 0 ? (
        <Banner tone="info">
          <p>
            No reviews yet is fine. We will leave the testimonials section out rather than write fake ones, and you
            can send real ones through any time.
          </p>
        </Banner>
      ) : null}

      {value.map((review, i) => (
        <div key={i} className="rounded-lg border border-ice-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-semibold">Review {i + 1}</span>
            <button
              type="button"
              className="text-xs font-medium text-red-600 hover:underline"
              onClick={() => onChange(value.filter((_, x) => x !== i))}
            >
              Remove
            </button>
          </div>
          <div className="space-y-3">
            <Field label="What they said">
              <TextArea
                value={review.quote}
                onChange={(v) => update(i, { quote: v })}
                placeholder="Paste the review word for word"
                rows={3}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="First name">
                <TextInput value={review.firstName} onChange={(v) => update(i, { firstName: v })} />
              </Field>
              <Field label="Their suburb">
                <TextInput value={review.suburb} onChange={(v) => update(i, { suburb: v })} />
              </Field>
            </div>
          </div>
        </div>
      ))}

      {value.length < 6 ? (
        <button
          type="button"
          className="btn-ghost"
          onClick={() => onChange([...value, { quote: '', firstName: '', suburb: '' }])}
        >
          Add a review
        </button>
      ) : (
        <p className="field-hint">That is the maximum of 6.</p>
      )}
    </div>
  )
}

/**
 * Gap audit findings. Brief s4: surfaced as a friendly inline prompt, NEVER a blocking error.
 * Each one also states what the build will do about it, so the customer is never left guessing.
 */
export function AuditFlagList({ flags }: { flags: AuditFlag[] }) {
  if (flags.length === 0) return null
  const attention = flags.filter((f) => f.severity === 'attention')
  const info = flags.filter((f) => f.severity === 'info')

  return (
    <div className="space-y-3">
      {attention.map((f) => (
        <Banner key={f.code} tone="warn" title="Worth a look">
          <p>{f.message}</p>
          <p className="mt-1 text-xs opacity-80">What we will do: {f.customerNote}</p>
        </Banner>
      ))}
      {info.map((f) => (
        <Banner key={f.code} tone="info">
          <p>{f.message}</p>
          <p className="mt-1 text-xs opacity-80">What we will do: {f.customerNote}</p>
        </Banner>
      ))}
    </div>
  )
}
