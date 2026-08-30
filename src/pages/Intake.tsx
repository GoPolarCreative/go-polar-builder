import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  DEFAULT_PALETTE,
  STEP_SCHEMAS,
  STEP_TITLES,
  TRAVEL_RADII,
  emptyIntake,
  maxServices,
  unallocatedPages,
  type IntakePayload,
  type Palette,
} from '../../shared/intake'
import { SERVICE_PRESETS, TRADES, TRADE_LABELS, type Trade } from '../../shared/trades'
import type { AssetRecord, AuditFlag } from '../../shared/types'
import { suburbKey } from '../../shared/suburbs'
import { ApiCallError, api } from '../lib/api'
import {
  Banner,
  BrandFooter,
  BrandHeader,
  CharCounter,
  Eyebrow,
  Field,
  Select,
  Spinner,
  TextArea,
  TextInput,
  YesNo,
} from '../components/ui'
import { SuburbChips, SuburbSearch } from '../components/SuburbPicker'
import { LogoUploader, PhotoUploader } from '../components/Uploader'
import { StylePicker } from '../components/StylePicker'
import {
  PAGE_INCLUDES,
  PAGE_MECHANISM,
} from '../../shared/pages-copy'
import { AuditFlagList, HoursEditor, ReviewsEditor } from '../components/StoryInputs'

type Draft = Partial<IntakePayload>
type Errors = Record<string, string>

export default function Intake() {
  const { jobId = '' } = useParams()
  const navigate = useNavigate()

  const [data, setData] = useState<Draft>(emptyIntake())
  const [assets, setAssets] = useState<AssetRecord[]>([])
  const [step, setStep] = useState(0)
  const [errors, setErrors] = useState<Errors>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [auditFlags, setAuditFlags] = useState<AuditFlag[] | null>(null)
  /*
   * How many pages this job paid for. One comes with the build; anything beyond that was bought
   * on the landing page, and until now nothing in the intake knew about it. The picker below
   * asked everybody "want any of these on their own page?" whether they had bought a page or not,
   * and told them we would confirm the charge later. Anyone who had already paid for two was
   * being asked to opt in to something they owned.
   */
  const [pagesAllowed, setPagesAllowed] = useState(1)

  const firstLoad = useRef(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await api.getJob(jobId)
        if (cancelled) return
        setData({ ...emptyIntake(), ...(res.intake ?? {}) })
        setPagesAllowed(res.job.pagesAllowed ?? 1)
        setAssets(res.assets)
        if (res.intakeSubmittedAt) setAuditFlags(res.auditFlags)
      } catch (err) {
        if (!cancelled) {
          setLoadError(
            err instanceof ApiCallError ? (err.detail ?? err.message) : 'Could not load this build',
          )
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [jobId])

  // Autosave. A tradie who loses a half-filled form does not start it again.
  useEffect(() => {
    if (loading) return
    if (firstLoad.current) {
      firstLoad.current = false
      return
    }
    const timer = setTimeout(async () => {
      setSaving(true)
      try {
        await api.saveDraft(jobId, data)
      } catch {
        // Autosave failures are not worth interrupting typing over. The submit call will
        // surface anything that actually matters.
      } finally {
        setSaving(false)
      }
    }, 900)
    return () => clearTimeout(timer)
  }, [data, jobId, loading])

  const patch = useCallback((p: Draft) => setData((d) => ({ ...d, ...p })), [])

  const logo = useMemo(() => assets.find((a) => a.kind === 'logo') ?? null, [assets])
  const photos = useMemo(
    () => assets.filter((a) => a.kind === 'photo').sort((a, b) => a.sortOrder - b.sortOrder),
    [assets],
  )

  const validateStep = (index: number): boolean => {
    const schema = STEP_SCHEMAS[index]!
    const result = schema.safeParse(data)
    const next: Errors = {}

    if (!result.success) {
      for (const issue of result.error.issues) {
        const key = issue.path.join('.') || 'form'
        if (!next[key]) next[key] = issue.message
      }
    }

    /*
     * PAGES THEY HAVE PAID FOR MUST BE ALLOCATED BEFORE THEY CAN MOVE ON.
     *
     * This cannot be a schema rule because the allowance lives on the job row rather than in the
     * answers, so it sits here, and the submit route checks it again because this copy runs in a
     * browser and is therefore a courtesy rather than a guarantee.
     *
     * The step is hard-blocked rather than warned. A warning is what we effectively had: the
     * picker already said "0 of 4 chosen" and said in as many words that the pages were paid for,
     * and a real customer scrolled past all of it and shipped a one page website he had bought
     * five pages for.
     */
    if (index === 1) {
      // Same rule as the submit route, same reason it cannot be a schema rule: the allowance is
      // on the job row, not in the answers.
      const cap = maxServices(pagesAllowed)
      const picked = data.services ?? []
      if (picked.length > cap && !next.services) {
        next.services = `Pick no more than ${cap}.`
      }

      const left = unallocatedPages(pagesAllowed, data.ownPageServices, data.services ?? [])
      if (left > 0 && !next.ownPageServices) {
        next.ownPageServices =
          left === 1
            ? 'Choose the service for the extra page you have paid for.'
            : `Choose services for the ${left} extra pages you have paid for.`
      }
    }

    setErrors(next)
    return Object.keys(next).length === 0
  }

  const goNext = () => {
    if (!validateStep(step)) return
    setStep((s) => Math.min(s + 1, STEP_SCHEMAS.length - 1))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const goBack = () => {
    setErrors({})
    setStep((s) => Math.max(s - 1, 0))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const submit = async () => {
    if (!validateStep(step)) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      await api.saveDraft(jobId, data)
      const res = await api.submitIntake(jobId, data)
      setAuditFlags(res.auditFlags)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (err) {
      if (err instanceof ApiCallError && err.issues?.length) {
        const next: Errors = {}
        for (const issue of err.issues) next[issue.path] = issue.message
        setErrors(next)
        setSubmitError(`${err.detail ?? 'Some answers need another look'}. See the highlighted fields.`)
      } else {
        setSubmitError(
          err instanceof ApiCallError ? (err.detail ?? err.message) : 'Could not submit your answers',
        )
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <Shell>
        <Spinner label="Loading your build" />
      </Shell>
    )
  }
  if (loadError) {
    return (
      <Shell>
        <Banner tone="error" title="We could not open this build">
          {loadError}
        </Banner>
      </Shell>
    )
  }

  if (auditFlags) {
    return (
      <Shell>
        <Eyebrow>All in</Eyebrow>
        <h1 className="mb-2 text-4xl">That is everything we need.</h1>
        <p className="mb-6 text-[17px]">
          Here is what we noticed reading your answers. None of it stops the build.
        </p>
        <div className="space-y-4">
          <AuditFlagList flags={auditFlags} />
          {auditFlags.length === 0 ? (
            <Banner tone="ok" title="Nothing to flag">
              Everything came through complete. Nothing needed assuming.
            </Banner>
          ) : null}
          <div className="flex flex-wrap gap-3 pt-2">
            <button className="btn-accent" onClick={() => navigate(`/build/${jobId}`)}>
              Build my website
            </button>
            <button
              className="btn-ghost"
              onClick={() => {
                setAuditFlags(null)
                setStep(0)
              }}
            >
              Change an answer first
            </button>
          </div>
        </div>
      </Shell>
    )
  }

  return (
    <Shell>
      <Progress step={step} />

      <div className="card mt-6">
        {step === 0 ? <StepBusiness data={data} patch={patch} errors={errors} /> : null}
        {step === 1 ? (
          <StepServices data={data} patch={patch} errors={errors} pagesAllowed={pagesAllowed} />
        ) : null}
        {step === 2 ? <StepArea data={data} patch={patch} errors={errors} /> : null}
        {step === 3 ? <StepStory data={data} patch={patch} errors={errors} /> : null}
        {step === 4 ? (
          <StepBrand
            data={data}
            patch={patch}
            errors={errors}
            jobId={jobId}
            logo={logo}
            photos={photos}
            setAssets={setAssets}
          />
        ) : null}
      </div>

      {Object.keys(errors).length > 0 ? (
        <div className="mt-4">
          <Banner tone="error" title="A few things need fixing">
            <ul className="list-inside list-disc">
              {Object.entries(errors).map(([path, message]) => (
                <li key={path}>{message}</li>
              ))}
            </ul>
          </Banner>
        </div>
      ) : null}

      {submitError ? (
        <div className="mt-4">
          <Banner tone="error">{submitError}</Banner>
        </div>
      ) : null}

      <div className="mt-6 flex items-center justify-between">
        <div className="text-xs text-ice-500">{saving ? 'Saving' : 'Saved'}</div>
        <div className="flex gap-3">
          {step > 0 ? (
            <button className="btn-ghost" onClick={goBack}>
              Back
            </button>
          ) : null}
          {step < STEP_SCHEMAS.length - 1 ? (
            <button className="btn-primary" onClick={goNext}>
              Next
            </button>
          ) : (
            <button className="btn-accent" onClick={submit} disabled={submitting}>
              {submitting ? 'Checking your answers' : 'Done, build my site'}
            </button>
          )}
        </div>
      </div>
    </Shell>
  )
}

// ---------------------------------------------------------------------------------------------

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl px-5 py-10">
      <BrandHeader>
        <span className="text-[13px] font-semibold text-ice-500">Website builder</span>
      </BrandHeader>
      {children}
      <BrandFooter />
    </div>
  )
}

function Progress({ step }: { step: number }) {
  return (
    <ol className="flex flex-wrap gap-2">
      {STEP_TITLES.map((title, i) => (
        <li
          key={title}
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            i === step
              ? 'bg-polar-accent text-white'
              : i < step
                ? 'bg-ice-100 text-ice-700'
                : 'border border-ice-200 bg-white text-ice-300'
          }`}
        >
          {i + 1}. {title}
        </li>
      ))}
    </ol>
  )
}

interface StepProps {
  data: Draft
  patch: (p: Draft) => void
  errors: Errors
}

// --- Step 1 ------------------------------------------------------------------------------------

function StepBusiness({ data, patch, errors }: StepProps) {
  const [abnNote, setAbnNote] = useState<string | null>(null)

  return (
    <div className="space-y-5">
      <div>
        <Eyebrow>Step one</Eyebrow>
        <h1 className="text-3xl">Who are you?</h1>
      </div>

      <Field label="Business name" required error={errors.businessName}>
        <TextInput
          value={data.businessName ?? ''}
          onChange={(v) => patch({ businessName: v })}
          invalid={Boolean(errors.businessName)}
          placeholder="Northside Plumbing"
        />
      </Field>

      <Field label="Trade" required error={errors.trade}>
        <Select<Trade>
          value={data.trade}
          onChange={(v) => {
            // Changing trade resets the service chips, since the presets no longer apply.
            patch({ trade: v, services: [], primaryService: '' })
          }}
          placeholder="Choose your trade"
          invalid={Boolean(errors.trade)}
          options={TRADES.map((t) => ({ value: t, label: TRADE_LABELS[t] }))}
        />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Trading entity name"
          hint="Only needed for a .au domain. The name on the ABN, if it differs."
          error={errors.tradingEntityName}
        >
          <TextInput
            value={data.tradingEntityName ?? ''}
            onChange={(v) => patch({ tradingEntityName: v })}
            placeholder="Optional"
          />
        </Field>

        <Field label="ABN" hint={abnNote ?? '11 digits. Needed if you want a .com.au domain.'} error={errors.abn}>
          <TextInput
            value={data.abn ?? ''}
            onChange={(v) => patch({ abn: v })}
            invalid={Boolean(errors.abn)}
            placeholder="Optional"
            inputMode="numeric"
            onBlur={async () => {
              const value = (data.abn ?? '').trim()
              if (!value) return setAbnNote(null)
              try {
                const res = await api.checkAbn(value)
                setAbnNote(res.detail)
              } catch {
                setAbnNote('We could not check that ABN just now. It will be checked again later.')
              }
            }}
          />
        </Field>
      </div>

      <Field
        label="Years in business"
        required
        // FAILURE THIS PREVENTS: free text here is how business names ended up in this field.
        hint="Whole years, 1 to 100."
        error={errors.yearsInBusiness}
      >
        <input
          type="number"
          min={1}
          max={100}
          step={1}
          className={`input w-40 ${errors.yearsInBusiness ? 'input-invalid' : ''}`}
          value={data.yearsInBusiness ?? ''}
          onChange={(e) =>
            patch({ yearsInBusiness: e.target.value === '' ? undefined : Number(e.target.value) })
          }
        />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Phone" required error={errors.phone} hint="Mobile or landline.">
          <TextInput
            value={data.phone ?? ''}
            onChange={(v) => patch({ phone: v })}
            invalid={Boolean(errors.phone)}
            placeholder="0412 345 678"
            inputMode="tel"
          />
        </Field>
        <Field label="Email" required error={errors.email}>
          <TextInput
            value={data.email ?? ''}
            onChange={(v) => patch({ email: v })}
            invalid={Boolean(errors.email)}
            placeholder="you@yourbusiness.com.au"
            type="email"
          />
        </Field>
      </div>

      {/* ASSUMPTION: the brief asks for address autocomplete. Street-level autocomplete needs a
          Places or Geoscape key, which is not configured yet. Until it is, the suburb comes from
          the verified suburb dataset and the street line is typed. The suburb is what drives the
          NAP and the geo tags, so the important half is already verified. */}
      <fieldset className="rounded-lg border border-ice-200 p-4">
        <legend className="px-1 text-sm font-semibold">Business address (optional)</legend>
        <p className="field-hint mb-3">
          Only if you work from a shop or yard customers can visit. Mobile trades can skip this.
        </p>
        <div className="space-y-3">
          <TextInput
            value={data.address?.line1 ?? ''}
            onChange={(v) => patch({ address: { ...(data.address ?? { verified: false }), line1: v } })}
            placeholder="12 Example Street"
          />
          <SuburbSearch
            placeholder="Suburb"
            onPick={(s) =>
              patch({
                address: {
                  ...(data.address ?? {}),
                  suburb: s.name,
                  state: s.state,
                  postcode: s.postcode,
                  verified: true,
                },
              })
            }
          />
          {data.address?.suburb ? (
            <p className="text-sm text-ice-700">
              {data.address.suburb} {data.address.state} {data.address.postcode}
            </p>
          ) : null}
        </div>
      </fieldset>
    </div>
  )
}

// --- Step 2 ------------------------------------------------------------------------------------

function StepServices({
  data,
  patch,
  errors,
  pagesAllowed,
}: StepProps & { pagesAllowed: number }) {
  const [custom, setCustom] = useState('')
  const trade = (data.trade ?? 'other') as Trade
  const presets = SERVICE_PRESETS[trade] ?? []
  const selected = data.services ?? []

  const toggle = (name: string) => {
    const next = selected.includes(name)
      ? selected.filter((s) => s !== name)
      : selected.length < 8
        ? [...selected, name]
        : selected
    patch({
      services: next,
      primaryService: next.includes(data.primaryService ?? '') ? data.primaryService : '',
    })
  }

  return (
    <div className="space-y-5">
      <div>
        <Eyebrow>Step two</Eyebrow>
        <h1 className="text-3xl">What do you actually do?</h1>
      </div>
      <p className="text-sm text-ice-700">
        Pick between 3 and 8. These become the services section, and the first one drives your headline.
      </p>

      <div>
        <span className="field-label">Services offered</span>
        <div className="flex flex-wrap gap-2">
          {presets.map((name) => (
            <button
              key={name}
              type="button"
              className={selected.includes(name) ? 'chip-on' : 'chip-off'}
              onClick={() => toggle(name)}
            >
              {name}
            </button>
          ))}
          {selected
            .filter((s) => !presets.includes(s))
            .map((name) => (
              <button key={name} type="button" className="chip-on" onClick={() => toggle(name)}>
                {name}
              </button>
            ))}
        </div>
        {errors.services ? <p className="field-error">{errors.services}</p> : null}
        <p className="field-hint">{selected.length} of 8 chosen.</p>

        <div className="mt-3 flex gap-2">
          <TextInput
            value={custom}
            onChange={setCustom}
            placeholder="Add something we missed"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                const name = custom.trim()
                if (name.length >= 2 && !selected.includes(name) && selected.length < 8) {
                  patch({ services: [...selected, name] })
                  setCustom('')
                }
              }
            }}
          />
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              const name = custom.trim()
              if (name.length >= 2 && !selected.includes(name) && selected.length < 8) {
                patch({ services: [...selected, name] })
                setCustom('')
              }
            }}
          >
            Add
          </button>
        </div>
      </div>

      <Field label="Your main service" required error={errors.primaryService} hint="This drives your headline.">
        <Select
          value={data.primaryService || undefined}
          onChange={(v) => patch({ primaryService: v })}
          placeholder={selected.length === 0 ? 'Pick some services first' : 'Choose one'}
          invalid={Boolean(errors.primaryService)}
          options={selected.map((s) => ({ value: s, label: s }))}
        />
      </Field>

      {selected.length > 0 && pagesAllowed > 1 ? (
        <OwnPagePicker
          data={data}
          patch={patch}
          selected={selected}
          extraPages={pagesAllowed - 1}
          error={errors.ownPageServices}
        />
      ) : null}

      <div>
        <span className="field-label">Do you offer free quotes?</span>
        <YesNo value={data.freeQuotes ?? true} onChange={(v) => patch({ freeQuotes: v })} />
        {data.freeQuotes === false ? (
          <p className="field-hint">
            Understood. The words &ldquo;free quote&rdquo; will not appear anywhere on your site.
          </p>
        ) : null}
      </div>

      <div>
        <span className="field-label">Do you take emergency or after hours calls?</span>
        <YesNo value={data.emergency ?? false} onChange={(v) => patch({ emergency: v })} />
      </div>
    </div>
  )
}

// --- Step 3 ------------------------------------------------------------------------------------

function StepArea({ data, patch, errors }: StepProps) {
  const serviced = data.suburbsServiced ?? []

  return (
    <div className="space-y-5">
      <div>
        <Eyebrow>Step three</Eyebrow>
        <h1 className="text-3xl">Where do you work?</h1>
      </div>

      <Field
        label="Your base suburb"
        required
        error={errors.baseSuburb}
        hint="Where you work out of. This anchors your local search results."
      >
        <SuburbSearch
          onPick={(s) => {
            patch({ baseSuburb: s })
            // Adding the base suburb to the serviced list is what everyone means anyway.
            if (!serviced.some((x) => suburbKey(x) === suburbKey(s))) {
              patch({ baseSuburb: s, suburbsServiced: [s, ...serviced] })
            }
          }}
        />
      </Field>
      {data.baseSuburb ? (
        <p className="-mt-3 text-sm text-ice-700">
          Base: {data.baseSuburb.name}, {data.baseSuburb.state} {data.baseSuburb.postcode}
        </p>
      ) : null}

      <Field
        label="Suburbs you service"
        required
        error={errors.suburbsServiced}
        hint="At least 3. Pick from the list, we cannot use typed suburbs."
      >
        <SuburbSearch onPick={(s) => patch({ suburbsServiced: [...serviced, s] })} exclude={serviced} />
      </Field>
      <SuburbChips
        suburbs={serviced}
        onRemove={(s) =>
          patch({ suburbsServiced: serviced.filter((x) => suburbKey(x) !== suburbKey(s)) })
        }
      />
      <p className="field-hint">{serviced.length} suburbs added.</p>

      <Field label="How far will you travel?" required error={errors.travelRadius}>
        <Select
          value={data.travelRadius}
          onChange={(v) => patch({ travelRadius: v })}
          options={TRAVEL_RADII.map((r) => ({
            value: r,
            label: r === 'statewide' ? 'Anywhere in the state' : `Up to ${r}km`,
          }))}
        />
      </Field>
    </div>
  )
}

// --- Step 4 ------------------------------------------------------------------------------------

function StepStory({ data, patch, errors }: StepProps) {
  return (
    <div className="space-y-5">
      <div>
        <Eyebrow>Step four</Eyebrow>
        <h1 className="text-3xl">Why should they call you?</h1>
      </div>

      <Field
        label="Tell us about your business"
        required
        error={errors.about}
        hint={<CharCounter value={data.about ?? ''} min={40} max={600} />}
      >
        <TextArea
          value={data.about ?? ''}
          onChange={(v) => patch({ about: v })}
          invalid={Boolean(errors.about)}
          rows={5}
          placeholder="How you started, who you work for, what a customer can expect. Write it like you would say it."
        />
      </Field>

      <Field label="What makes you different?" error={errors.different} hint="Optional, but it is usually the best bit.">
        <TextArea
          value={data.different ?? ''}
          onChange={(v) => patch({ different: v })}
          rows={3}
          placeholder="We answer the phone before 7am. We never subcontract."
        />
      </Field>

      <div>
        <span className="field-label">Business hours</span>
        {data.hours ? <HoursEditor value={data.hours} onChange={(h) => patch({ hours: h })} /> : null}
      </div>

      <div>
        <span className="field-label">Reviews</span>
        <p className="field-hint mb-3">
          Real ones only, up to 6. Copy them straight from Google or a text message.
        </p>
        <ReviewsEditor value={data.reviews ?? []} onChange={(r) => patch({ reviews: r })} />
      </div>

      <Field label="Google review link" error={errors.googleReviewLink} hint="Optional.">
        <TextInput
          value={data.googleReviewLink ?? ''}
          onChange={(v) => patch({ googleReviewLink: v })}
          placeholder="https://g.page/..."
        />
      </Field>

      {/*
       * Only asked once there is a profile to check them against, because a rating with nothing
       * behind it is the sort of unverifiable number the whole build refuses to write. Two numbers
       * read straight off their own listing, which is about ten seconds of work for the strongest
       * trust signal on the finished page.
       */}
      {(data.googleReviewLink ?? '').trim() !== '' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Your Google rating"
            error={errors.googleRating}
            hint="Optional. The number at the top of your Google listing, like 4.9."
          >
            <TextInput
              value={data.googleRating === undefined ? '' : String(data.googleRating)}
              onChange={(v) => {
                const t = v.trim()
                patch({ googleRating: t === '' ? undefined : Number(t) })
              }}
              placeholder="4.9"
              inputMode="decimal"
            />
          </Field>
          <Field
            label="How many reviews"
            error={errors.googleReviewCount}
            hint="Optional. The total count shown next to your rating."
          >
            <TextInput
              value={data.googleReviewCount === undefined ? '' : String(data.googleReviewCount)}
              onChange={(v) => {
                const t = v.trim()
                patch({ googleReviewCount: t === '' ? undefined : Number(t) })
              }}
              placeholder="87"
              inputMode="numeric"
            />
          </Field>
        </div>
      ) : null}

      <fieldset className="rounded-lg border border-ice-200 p-4">
        <legend className="px-1 text-sm font-semibold">Social links (optional)</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {(['facebook', 'instagram', 'linkedin', 'tiktok', 'youtube'] as const).map((key) => (
            <Field key={key} label={key[0]!.toUpperCase() + key.slice(1)} error={errors[`socials.${key}`]}>
              <TextInput
                value={data.socials?.[key] ?? ''}
                onChange={(v) =>
                  patch({
                    socials: {
                      facebook: '',
                      instagram: '',
                      linkedin: '',
                      tiktok: '',
                      youtube: '',
                      ...(data.socials ?? {}),
                      [key]: v,
                    },
                  })
                }
                placeholder="https://"
              />
            </Field>
          ))}
        </div>
      </fieldset>
    </div>
  )
}

// --- Step 5 ------------------------------------------------------------------------------------

function StepBrand({
  data,
  patch,
  errors,
  jobId,
  logo,
  photos,
  setAssets,
}: StepProps & {
  jobId: string
  logo: AssetRecord | null
  photos: AssetRecord[]
  setAssets: React.Dispatch<React.SetStateAction<AssetRecord[]>>
}) {
  const palette = data.palette ?? DEFAULT_PALETTE

  const setPalette = (p: Partial<Palette>) =>
    patch({ palette: { ...palette, ...p, source: p.source ?? (palette.source === 'default' ? 'manual' : palette.source) } })

  return (
    <div className="space-y-6">
      <div>
        <Eyebrow>Step five</Eyebrow>
        <h1 className="text-3xl">What does it look like?</h1>
      </div>

      <div>
        <span className="field-label">Logo</span>
        <LogoUploader
          jobId={jobId}
          logo={logo}
          onChange={(asset) => {
            setAssets((prev) => [...prev.filter((a) => a.kind !== 'logo'), ...(asset ? [asset] : [])])
            patch({ logoAssetId: asset?.id ?? null })
          }}
          onPalette={(p) => patch({ palette: p })}
        />
      </div>

      <div>
        <span className="field-label">Brand colours</span>
        <p className="field-hint mb-3">
          {palette.source === 'logo'
            ? 'Pulled straight from your logo. Adjust any of them if they are not quite right.'
            : 'Upload a logo and we will pull your colours from it. You can also set them here.'}
        </p>
        <div className="flex flex-wrap gap-4">
          {(['primary', 'secondary', 'accent'] as const).map((key) => (
            <label key={key} className="flex items-center gap-2 text-sm">
              <input
                type="color"
                className="h-10 w-14 cursor-pointer rounded border border-ice-200 bg-white p-1"
                value={palette[key]}
                onChange={(e) => setPalette({ [key]: e.target.value } as Partial<Palette>)}
              />
              <span className="capitalize">{key}</span>
              <code className="text-xs text-ice-500">{palette[key]}</code>
            </label>
          ))}
        </div>
      </div>

      <StylePicker
        value={data.designStyle}
        onChange={(designStyle) => patch({ designStyle })}
        trade={data.trade}
        // Drawn in their own colours, which is the clearest way to show that the style decides
        // the shape and the logo decides the palette.
        palette={{ primary: palette.primary, accent: palette.accent }}
        error={errors.designStyle}
      />

      <div>
        <span className="field-label">Photos of your work</span>
        <PhotoUploader
          jobId={jobId}
          photos={photos}
          onChange={(next) => {
            // sortOrder is restamped to match the new positions. Without this the arrows and
            // "Make hero" did nothing visible: the memo above sorts by sortOrder, the handed-back
            // records still carried their old values, and the array snapped straight back. The
            // server writes the same numbers via reorderAssets, so client and server agree.
            const stamped = next.map((p, i) => ({ ...p, sortOrder: i }))
            setAssets((prev) => [...prev.filter((a) => a.kind !== 'photo'), ...stamped])
            patch({ photoAssetIds: stamped.map((p) => p.id) })
          }}
        />
      </div>

      <Field
        label="Do you already have a domain?"
        error={errors.existingDomain}
        hint="Optional. We sort domains out after the site is built, this is just so we know."
      >
        <TextInput
          value={data.existingDomain ?? ''}
          onChange={(v) => patch({ existingDomain: v })}
          placeholder="yourbusiness.com.au"
        />
      </Field>
    </div>
  )
}

/**
 * The additional pages option, offered per service.
 *
 * PERSUADES WITH THE MECHANISM, NEVER WITH A PROMISE. Every word a customer reads here comes from
 * shared/pages-copy.ts, which exists so the whole claim surface can be read and signed off in one
 * place, and which has a test that greps it for ranking, traffic, timeframe and guarantee claims.
 * See DECISIONS.md D44.
 */
function OwnPagePicker({
  data,
  patch,
  selected,
  extraPages,
  error,
}: {
  data: Draft
  patch: (p: Draft) => void
  selected: string[]
  extraPages: number
  error?: string
}) {
  const chosen = (data.ownPageServices ?? []).filter((name) => selected.includes(name))
  const full = chosen.length >= extraPages

  const toggle = (name: string) => {
    const isOn = chosen.includes(name)
    // Silently ignoring a tap on a full list reads as a broken button, so the chip is disabled
    // and says why rather than doing nothing.
    if (!isOn && full) return
    patch({ ownPageServices: isOn ? chosen.filter((s) => s !== name) : [...chosen, name] })
  }

  return (
    /*
     * DELIBERATELY THE LOUDEST THING ON THE STEP.
     *
     * The previous version was a quiet grey card that read as an optional extra, and it was
     * skipped by the first real customer to see it. It is now a thick accent rail, a status line
     * that says whether the job is done, and a counter at the top instead of buried underneath
     * the chips. Being required is not enough on its own: an unmissable blocker still produces a
     * confused customer if they never understood there was something to do.
     *
     * The unfinished state is carried by TEXT as well as colour, because colour alone is not a
     * message and this project has already shipped one instruction nobody could read.
     */
    <div
      className={`rounded-lg border-2 border-l-8 p-4 ${
        error
          ? 'border-red-500 bg-red-50'
          : full
            ? 'border-polar-accent bg-white'
            : 'border-polar-accent bg-ice-50'
      }`}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <Eyebrow>
          You paid for {extraPages === 1 ? 'an extra page' : `${extraPages} extra pages`}
        </Eyebrow>
        <span
          className={`px-2 py-0.5 text-[13px] font-bold ${
            full ? 'bg-polar-accent text-white' : 'bg-ice-700 text-white'
          }`}
        >
          {chosen.length} of {extraPages} chosen
        </span>
      </div>

      <span className="field-label text-base">
        Which {extraPages === 1 ? 'service' : 'services'} did you want on your extra{' '}
        {extraPages === 1 ? 'page' : 'pages'}?
      </span>
      <p className="field-hint mb-3">{PAGE_MECHANISM}</p>

      <div className="flex flex-wrap gap-2">
        {selected.map((name) => {
          const on = chosen.includes(name)
          return (
            <button
              key={name}
              type="button"
              aria-pressed={on}
              disabled={!on && full}
              className={`${on ? 'chip-on' : 'chip-off'} disabled:cursor-not-allowed disabled:opacity-40`}
              onClick={() => toggle(name)}
            >
              {name}
            </button>
          )
        })}
      </div>

      <ul className="mt-3 space-y-1 text-[13px] text-ice-500">
        {PAGE_INCLUDES.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      <p className="mt-3 text-sm font-semibold text-ice-700">
        {full
          ? 'All done. Tap one again to swap it out.'
          : chosen.length === 0
            ? 'Nothing chosen yet. Pick the work you most want your own page about.'
            : `Still to choose: ${extraPages - chosen.length}.`}
      </p>

      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : !full ? (
        <p className="field-hint mt-1">
          These pages are paid for either way, so there is nothing to gain by leaving{' '}
          {extraPages - chosen.length === 1 ? 'one' : 'them'} unused. You cannot continue until{' '}
          {extraPages === 1 ? 'it is' : 'they are'} allocated.
        </p>
      ) : null}
    </div>
  )
}
