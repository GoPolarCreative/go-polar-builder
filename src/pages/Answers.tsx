import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { GenerationEvent } from '../../shared/types'
import { STEP_TITLES, type IntakePayload } from '../../shared/intake'

import { ApiCallError, api, streamEdit } from '../lib/api'
import { Banner, Spinner } from '../components/ui'
import { JobNav } from '../components/JobNav'

/**
 * The answers the customer gave, on their own page.
 *
 * READING IS FREE AND UNLIMITED. Nothing on this screen costs anything until the customer presses
 * the confirm button at the bottom, and the button says what it will cost before it is pressed.
 *
 * WHY ALMOST EVERYTHING COSTS A CHANGE. Their answers are what the site was written from, so a
 * different answer means a different site. Checked field by field against the generation path
 * rather than assumed: every field in the five steps is read by facts.ts, the prompts, the
 * renderer or the page-set builder, with exactly one exception. The web address is used at go
 * live to point DNS and appears nowhere in the HTML, so it is free to change and says so.
 *
 * CHANGES ARE STAGED, NOT APPLIED FIELD BY FIELD. Charging a round per field would punish someone
 * fixing three typos, and the chat already works the other way: one submission is one round
 * however much it contains. So edits pile up here and go together as a single round. The bar at
 * the bottom shows the count and the cost the whole time it is not empty.
 *
 * STRUCTURED ANSWERS ARE READ-ONLY HERE ON PURPOSE. Suburbs, hours, reviews, photos, the logo and
 * the palette all have real editors in the wizard with their own validation. A second, worse
 * editor for them on this page is how a suburb list ends up holding a service name. They are
 * shown in full, and the customer is pointed at Changes, where asking for it in words works.
 */

type Draft = Record<string, unknown>

/** A field the customer can change here. */
interface FieldSpec {
  key: string
  label: string
  kind: 'text' | 'textarea' | 'number' | 'email' | 'tel' | 'url' | 'bool'
  /** False only for answers that appear nowhere in the built site. */
  rebuilds: boolean
  hint?: string
}

const STEP_FIELDS: FieldSpec[][] = [
  [
    { key: 'businessName', label: 'Business name', kind: 'text', rebuilds: true },
    { key: 'tradingEntityName', label: 'Trading entity name', kind: 'text', rebuilds: true },
    { key: 'abn', label: 'ABN', kind: 'text', rebuilds: true },
    { key: 'yearsInBusiness', label: 'Years in business', kind: 'number', rebuilds: true },
    { key: 'phone', label: 'Phone', kind: 'tel', rebuilds: true },
    { key: 'email', label: 'Email', kind: 'email', rebuilds: true },
  ],
  [{ key: 'freeQuotes', label: 'We give free quotes', kind: 'bool', rebuilds: true }],
  [],
  [
    {
      key: 'about',
      label: 'About the business',
      kind: 'textarea',
      rebuilds: true,
      hint: 'This is what the words on your page were written from.',
    },
    { key: 'different', label: 'What makes you different', kind: 'textarea', rebuilds: true },
    { key: 'googleReviewLink', label: 'Google review link', kind: 'url', rebuilds: true },
    { key: 'googleRating', label: 'Your Google rating', kind: 'number', rebuilds: true },
    { key: 'googleReviewCount', label: 'How many Google reviews', kind: 'number', rebuilds: true },
  ],
  [
    {
      key: 'existingDomain',
      label: 'Web address you already own',
      kind: 'text',
      rebuilds: false,
      hint: 'Used when your site goes live. It does not appear on the page, so changing it is free.',
    },
  ],
]

/** Answers shown but not edited here, with where to go instead. */
const STEP_READONLY: Array<Array<{ label: string; render: (i: Partial<IntakePayload>) => string }>> = [
  [
    { label: 'Trade', render: (i) => String(i.trade ?? '') },
    {
      label: 'Address',
      render: (i) =>
        i.address?.line1
          ? [i.address.line1, i.address.suburb, i.address.state, i.address.postcode]
              .filter(Boolean)
              .join(', ')
          : 'None given',
    },
  ],
  [
    { label: 'Services', render: (i) => (i.services ?? []).join(', ') || 'None' },
    {
      label: 'Services with their own page',
      render: (i) => (i.ownPageServices ?? []).join(', ') || 'None',
    },
  ],
  [
    { label: 'Base suburb', render: (i) => i.baseSuburb?.name ?? '' },
    {
      label: 'Suburbs serviced',
      render: (i) => (i.suburbsServiced ?? []).map((s) => s.name).join(', '),
    },
    { label: 'Travel radius', render: (i) => (i.travelRadius ? `${i.travelRadius} km` : '') },
  ],
  [
    {
      label: 'Opening hours',
      render: (i) => (i.hours?.byAppointment ? 'By appointment' : 'Set in the wizard'),
    },
    { label: 'Reviews', render: (i) => `${(i.reviews ?? []).length} added` },
  ],
  [
    { label: 'Look', render: (i) => String(i.designStyle ?? 'auto') },
    { label: 'Photos', render: (i) => `${(i.photoAssetIds ?? []).length} uploaded` },
    { label: 'Logo', render: (i) => (i.logoAssetId ? 'Uploaded' : 'None') },
  ],
]

function labelFor(key: string): string {
  for (const step of STEP_FIELDS) {
    const f = step.find((x) => x.key === key)
    if (f) return f.label
  }
  return key
}

function rebuildsFor(key: string): boolean {
  for (const step of STEP_FIELDS) {
    const f = step.find((x) => x.key === key)
    if (f) return f.rebuilds
  }
  return true
}

export default function Answers() {
  const { jobId = '' } = useParams()

  const [intake, setIntake] = useState<Partial<IntakePayload> | null>(null)
  const [remaining, setRemaining] = useState<number | null>(null)
  const [allowed, setAllowed] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [draft, setDraft] = useState<Draft>({})
  const [confirming, setConfirming] = useState(false)
  const [applying, setApplying] = useState(false)
  const [outcome, setOutcome] = useState<{ tone: 'ok' | 'warn' | 'error'; title: string; body: string } | null>(
    null,
  )

  const load = useCallback(async () => {
    const [job, versions] = await Promise.all([api.getJob(jobId), api.versions(jobId).catch(() => null)])
    setIntake(job.intake ?? {})
    if (versions) {
      setRemaining(versions.editsRemaining)
      setAllowed(versions.editsAllowed)
    }
  }, [jobId])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await load()
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiCallError ? (err.detail ?? err.message) : 'Could not load your answers')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [load])

  const changed = useMemo(
    () => Object.keys(draft).filter((k) => String(draft[k] ?? '') !== String((intake ?? {})[k as keyof IntakePayload] ?? '')),
    [draft, intake],
  )
  const rebuilding = changed.filter(rebuildsFor)
  const freeOnly = changed.filter((k) => !rebuildsFor(k))

  const set = (key: string, value: unknown) => setDraft((d) => ({ ...d, [key]: value }))

  /**
   * Save, and rebuild only if something on the page actually changed.
   *
   * ORDER MATTERS. The answers are written first, because that write is free and is the record of
   * what the customer told us. The rebuild runs second and is the only thing that spends a round.
   * If the rebuild fails, the edit endpoint does not count it, and the message below says plainly
   * that the answers are saved but the site has not caught up yet, rather than leaving the two
   * quietly out of step with nothing on screen about it.
   */
  const apply = async () => {
    if (!intake || changed.length === 0) return
    setConfirming(false)
    setApplying(true)
    setOutcome(null)

    const merged = { ...intake, ...draft }
    try {
      await api.saveDraft(jobId, merged)
    } catch (err) {
      setApplying(false)
      setOutcome({
        tone: 'error',
        title: 'Your answers were not saved',
        body: err instanceof ApiCallError ? (err.detail ?? err.message) : 'Try again in a moment.',
      })
      return
    }

    if (rebuilding.length === 0) {
      setIntake(merged)
      setDraft({})
      setApplying(false)
      setOutcome({
        tone: 'ok',
        title: 'Saved',
        body: 'That answer does not appear on your website, so nothing needed rebuilding and no change was used.',
      })
      return
    }

    const instruction = rebuilding
      .map((k) => `${labelFor(k)} is now "${String(merged[k as keyof IntakePayload] ?? '')}"`)
      .join('. ')

    let failed: string | null = null
    let done = false
    try {
      await streamEdit(
        jobId,
        `Update the website to match these corrected details. ${instruction}. Change only what these details affect and leave everything else exactly as it is.`,
        (event: GenerationEvent) => {
          if (event.type === 'error') failed = event.detail ? `${event.message} ${event.detail}` : event.message
          if (event.type === 'done') done = true
        },
      )
    } catch (err) {
      failed =
        err instanceof ApiCallError ? (err.detail ?? err.message) : 'The connection dropped before it finished.'
    }

    setApplying(false)
    await load().catch(() => undefined)

    if (failed || !done) {
      setDraft({})
      setOutcome({
        tone: 'warn',
        title: 'Answers saved, website not rebuilt yet',
        body: `${failed ?? 'The connection dropped before the rebuild finished.'} Your answers are saved and no change has been used. Ask for the same thing on the Changes screen, or try again.`,
      })
      return
    }

    setDraft({})
    setOutcome({
      tone: 'ok',
      title: 'Answers saved and your website updated',
      body: 'That used one of your included changes.',
    })
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    )
  }

  const i = intake ?? {}

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <JobNav jobId={jobId} remaining={remaining} allowed={allowed} />

      <div className="mx-auto w-full max-w-2xl flex-1 px-4 pb-40 pt-4">
        <h1 className="text-lg font-semibold">Your answers</h1>
        <p className="field-hint mt-1">
          Everything you told us, in the order you were asked. Looking is free and you can come back
          as often as you like.
        </p>

        {error ? (
          <div className="mt-4">
            <Banner tone="error">{error}</Banner>
          </div>
        ) : null}

        {outcome ? (
          <div className="mt-4">
            <Banner tone={outcome.tone} title={outcome.title}>
              <p>{outcome.body}</p>
            </Banner>
          </div>
        ) : null}

        {STEP_TITLES.map((title, step) => (
          <section key={title} className="mt-6 rounded-lg border border-ice-200">
            <h2 className="border-b border-ice-100 px-4 py-2.5 text-sm font-semibold">
              <span className="text-ice-400">{step + 1}.</span> {title}
            </h2>

            <div className="space-y-4 px-4 py-4">
              {(STEP_FIELDS[step] ?? []).map((f) => {
                const current = draft[f.key] ?? i[f.key as keyof IntakePayload] ?? ''
                const dirty = changed.includes(f.key)
                return (
                  <div key={f.key}>
                    <label className="field-label flex flex-wrap items-center gap-2" htmlFor={`f-${f.key}`}>
                      {f.label}
                      {f.rebuilds ? null : (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">
                          free to change
                        </span>
                      )}
                      {dirty ? (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
                          changed
                        </span>
                      ) : null}
                    </label>

                    {f.kind === 'bool' ? (
                      <label className="mt-1 flex items-center gap-2 text-sm">
                        <input
                          id={`f-${f.key}`}
                          type="checkbox"
                          className="h-4 w-4"
                          checked={Boolean(current)}
                          onChange={(e) => set(f.key, e.target.checked)}
                        />
                        <span>Yes</span>
                      </label>
                    ) : f.kind === 'textarea' ? (
                      <textarea
                        id={`f-${f.key}`}
                        className="input min-h-24"
                        value={String(current)}
                        onChange={(e) => set(f.key, e.target.value)}
                      />
                    ) : (
                      <input
                        id={`f-${f.key}`}
                        className="input"
                        type={f.kind === 'number' ? 'number' : f.kind}
                        value={String(current)}
                        onChange={(e) =>
                          set(f.key, f.kind === 'number' ? Number(e.target.value) : e.target.value)
                        }
                      />
                    )}
                    {f.hint ? <p className="field-hint">{f.hint}</p> : null}
                  </div>
                )
              })}

              {(STEP_READONLY[step] ?? []).map((r) => (
                <div key={r.label}>
                  <p className="field-label">{r.label}</p>
                  <p className="text-sm text-ice-700">{r.render(i) || '—'}</p>
                </div>
              ))}

              {(STEP_READONLY[step] ?? []).length > 0 ? (
                <p className="field-hint border-t border-ice-100 pt-3">
                  Ask on{' '}
                  <Link className="underline" to={`/preview/${jobId}/changes`}>
                    Changes
                  </Link>{' '}
                  to alter these.
                </p>
              ) : null}
            </div>
          </section>
        ))}
      </div>

      {/*
        THE COST IS ON THE BUTTON, NOT IN A DIALOG AFTER IT. This bar only exists once something
        has been typed, and it says what pressing it will spend before it is pressed.
      */}
      {changed.length > 0 ? (
        <div className="sticky bottom-0 border-t border-ice-200 bg-white px-4 py-3 shadow-[0_-4px_16px_rgba(0,0,0,0.06)]">
          {confirming ? (
            <div>
              <p className="text-sm font-semibold">
                {rebuilding.length > 0
                  ? `Rebuild your website with ${rebuilding.length} changed ${rebuilding.length === 1 ? 'answer' : 'answers'}?`
                  : 'Save this answer?'}
              </p>
              <p className="field-hint mt-1">
                {rebuilding.length > 0
                  ? `This uses one of your ${allowed ?? 10} included changes. You have ${remaining ?? 0} left. Changing ${rebuilding.length === 1 ? 'this answer' : 'these answers'} together costs one, not ${rebuilding.length}.`
                  : 'This answer does not appear on your website, so it costs nothing.'}
              </p>
              <div className="mt-3 flex gap-2">
                <button className="btn-accent flex-1" onClick={apply} disabled={applying}>
                  {applying ? 'Working' : rebuilding.length > 0 ? 'Yes, use one change' : 'Yes, save it'}
                </button>
                <button className="btn-ghost" onClick={() => setConfirming(false)} disabled={applying}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm">
                <span className="font-semibold">
                  {changed.length} {changed.length === 1 ? 'answer' : 'answers'} changed
                </span>
                <span className="field-hint block">
                  {rebuilding.length > 0
                    ? `Rebuilds your website. Uses 1 of your ${allowed ?? 10} changes.`
                    : 'Costs nothing, this one is not on your website.'}
                </span>
              </p>
              <div className="flex shrink-0 gap-2">
                <button className="btn-ghost" onClick={() => setDraft({})} disabled={applying}>
                  Undo
                </button>
                <button className="btn-accent" onClick={() => setConfirming(true)} disabled={applying}>
                  Save
                </button>
              </div>
            </div>
          )}
          {freeOnly.length > 0 && rebuilding.length > 0 ? (
            <p className="field-hint mt-2">
              {freeOnly.map(labelFor).join(', ')} would be free on {freeOnly.length === 1 ? 'its' : 'their'}{' '}
              own, and {freeOnly.length === 1 ? 'is' : 'are'} included at no extra cost.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
