import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiCallError, api, type FormsKeyState } from '../lib/api'
import { Banner, BrandFooter, BrandHeader, Eyebrow, Field, Spinner, TextInput, YesNo } from '../components/ui'
import { InboxOutstanding } from '../components/InboxSetup'

/**
 * Phase 5, brief s8. Going live, in three screens.
 *
 * Wording rule, enforced throughout: we promise contact within one business day. We never
 * promise the domain will be connected in 24 hours. Transfers, registrar locks and
 * uncooperative third parties are outside Go Polar's control.
 */

/*
 * THE ORDER IS THE DOMAIN, THEN THE MONEY. It used to be the other way round and that was a real
 * problem, not a matter of taste: the plan screen asked them to tick "I need a domain, +$5.50"
 * BEFORE anybody had checked whether the name they wanted was free. Someone could pay for a
 * domain that was taken, or pay for one they already owned. Ask, check, then charge.
 *
 * blocked is not a step. It is the dead end for somebody who reached this page without setting
 * up their enquiry inbox back on the build page, and its only job is to send them there.
 */
type Screen = 'blocked' | 'domain' | 'plan' | 'confirmation'
type Branch = 'own' | 'new' | 'locked'

/*
 * The five that cover almost every Australian tradie, plus two honest escape hatches. Ordered by
 * how often they actually come up rather than alphabetically. "I am not sure" is a real answer
 * and gets a real button: it tells us to look it up ourselves, which is different from the
 * question being skipped.
 */
const REGISTRARS = [
  'GoDaddy',
  'Crazy Domains',
  'VentraIP',
  'Netregistry',
  'Squarespace or Wix',
  'Somewhere else',
  'I am not sure',
] as const

interface GoLiveState {
  jobStatus: string
  currentVersion: number
  selection: {
    hosting: boolean
    emailAddon: boolean
    domainAddon: boolean
    status: string
    checkoutUrl: string | null
    paidAt: string | null
  } | null
  domain: { name: string; branch: string; status: string; registrar: string | null; report: unknown } | null
  pricing: Record<string, { label: string; price: string | null; required: boolean }>
  formsKey: FormsKeyState
  promise: string
}

interface DomainReport {
  domain: string
  registered: boolean | null
  registrar: string | null
  nameservers: string[]
  mx: Array<{ value: string; priority?: number }>
  summary: string[]
  problems: string[]
}

export default function GoLive() {
  const { jobId = '' } = useParams()
  const [state, setState] = useState<GoLiveState | null>(null)
  const [screen, setScreen] = useState<Screen>('domain')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [emailAddon, setEmailAddon] = useState(false)
  const [needsDomain, setNeedsDomain] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const s = await api.goLive(jobId)
        setState(s)
        setEmailAddon(s.selection?.emailAddon ?? false)
        /*
         * THE RECORDED BRANCH WINS ON RESUME. selection.domainAddon is only written when the
         * plan POST runs, so on a reload between answering the domain question and paying it is
         * still false. Reading it alone would show someone who asked us to register a domain a
         * summary saying they already have one, and a total that leaves it out.
         */
        setNeedsDomain(s.domain?.branch === 'new' || (s.selection?.domainAddon ?? false))
        /*
         * PAYMENT IS WHAT FINISHES THIS, NOT THE DOMAIN. Worth stating because it was the other
         * way round when the domain came last: a recorded domain used to mean done, and now it
         * only means they are half way.
         */
        if (s.selection?.paidAt) setScreen('confirmation')
        else if (s.domain) setScreen('plan')
        // The enquiry inbox comes first and cannot be skipped. Anyone already past it goes
        // straight to the plan, so it is a step rather than a wall.
        else if (!s.formsKey.verified) setScreen('blocked')
      } catch (err) {
        setError(err instanceof ApiCallError ? (err.detail ?? err.message) : 'Could not load this page')
      } finally {
        setLoading(false)
      }
    })()
  }, [jobId])

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner label="Loading" />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl px-5 py-10">
      <BrandHeader />
      <div className="mb-7">
        <Eyebrow>Nearly there</Eyebrow>
        <h1 className="text-4xl">Let's get it online.</h1>
      </div>

      {error ? (
        <div className="mb-6">
          <Banner tone="error">{error}</Banner>
        </div>
      ) : null}

      {screen === 'blocked' ? <InboxOutstanding jobId={jobId} /> : null}

      {screen === 'domain' ? (
        <DomainScreen
          jobId={jobId}
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          onDone={(branch) => {
            // Carried straight into the plan screen so the cart it builds already reflects the
            // answer they just gave. The server enforces the same thing independently.
            setNeedsDomain(branch === 'new')
            setScreen('plan')
          }}
        />
      ) : null}

      {screen === 'plan' ? (
        <PlanScreen
          jobId={jobId}
          state={state}
          emailAddon={emailAddon}
          setEmailAddon={setEmailAddon}
          needsDomain={needsDomain}
          setNeedsDomain={setNeedsDomain}
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          onPaid={() => setScreen('confirmation')}
        />
      ) : null}

      {screen === 'confirmation' ? <ConfirmationScreen jobId={jobId} /> : null}

      <p className="mt-8 text-sm">
        <Link className="link-arrow" to={`/preview/${jobId}`}>
          Back to my website
        </Link>
      </p>

      <BrandFooter />
    </div>
  )
}

function PlanScreen(props: {
  jobId: string
  state: GoLiveState | null
  emailAddon: boolean
  setEmailAddon: (v: boolean) => void
  needsDomain: boolean
  setNeedsDomain: (v: boolean) => void
  busy: boolean
  setBusy: (v: boolean) => void
  setError: (v: string | null) => void
  onPaid: () => void
}) {
  const { state } = props
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(state?.selection?.checkoutUrl ?? null)
  const [configProblem, setConfigProblem] = useState<string | null>(null)

  const start = async () => {
    props.setBusy(true)
    props.setError(null)
    setConfigProblem(null)
    try {
      const res = await api.goLivePlan(props.jobId, {
        emailAddon: props.emailAddon,
        domainAddon: props.needsDomain,
      })
      setCheckoutUrl(res.checkoutUrl)
      if (res.checkoutUrl) window.location.href = res.checkoutUrl
    } catch (err) {
      if (err instanceof ApiCallError && err.status === 503) {
        // Real error, surfaced. Not a silent stub.
        setConfigProblem(err.detail ?? 'Checkout is not configured yet.')
      } else {
        props.setError(err instanceof ApiCallError ? (err.detail ?? err.message) : 'Could not start checkout')
      }
    } finally {
      props.setBusy(false)
    }
  }

  return (
    <div className="card space-y-5">
      <div>
        <Eyebrow>Last thing</Eyebrow>
        <h2 className="text-xl">Let's get your hosting sorted.</h2>
        <ul className="mt-3 space-y-2 text-sm">
          <li className="flex justify-between border-b border-ice-100 pb-2">
            <span>{state?.pricing.hosting?.label}</span>
            <span className="font-semibold">{state?.pricing.hosting?.price}</span>
          </li>
          {props.needsDomain ? (
            <li className="flex justify-between border-b border-ice-100 pb-2">
              <span>{state?.pricing.domain?.label}</span>
              <span className="font-semibold">{state?.pricing.domain?.price}</span>
            </li>
          ) : null}
        </ul>
        <p className="field-hint mt-2">No maintenance retainer. No lock-in contract. Cancel whenever.</p>
      </div>

      <div className="rounded-lg border border-ice-200 p-4">
        <span className="field-label">
          Custom email address, like enquiries@yourbusiness.com.au
        </span>
        <p className="field-hint mb-2">{state?.pricing.email?.price}. Optional.</p>
        <YesNo
          value={props.emailAddon}
          onChange={props.setEmailAddon}
          yesLabel="Yes please"
          noLabel="No thanks"
        />
      </div>

      {/*
        READ-ONLY. This is the answer from the previous screen, shown so the total is not a
        surprise, not asked again. A second control over the same fact is how the two copies end
        up disagreeing, and the server derives the cart from the recorded domain branch anyway,
        so a control here would be decorative at best and misleading at worst.
      */}
      <div className="rounded-lg border border-ice-200 bg-ice-50 p-4">
        <span className="field-label">Your web address</span>
        {state?.domain ? (
          <p className="mt-1 text-sm text-ice-700">
            {props.needsDomain ? (
              <>
                We are registering <span className="font-semibold">{state.domain.name}</span> for
                you, so {state.pricing.domain?.price} is included below.
              </>
            ) : (
              <>
                You already have <span className="font-semibold">{state.domain.name}</span>, so
                there is nothing extra to pay for it.
              </>
            )}
          </p>
        ) : (
          <p className="mt-1 text-sm text-ice-700">Answered on the previous screen.</p>
        )}
      </div>

      {configProblem ? (
        <Banner tone="warn" title="Checkout is not connected yet">
          <p>Your choices have been saved, so nothing is lost.</p>
          <p className="mt-1 font-mono text-xs break-words">{configProblem}</p>
        </Banner>
      ) : null}

      {checkoutUrl ? (
        <Banner tone="info">
          <p>
            <a className="underline" href={checkoutUrl}>
              Open your checkout
            </a>{' '}
            if it did not open by itself.
          </p>
        </Banner>
      ) : null}

      <button className="btn-accent" onClick={start} disabled={props.busy}>
        {props.busy ? 'Setting it up' : 'Continue to payment →'}
      </button>
      <p className="field-hint">
        Hosting starts billing now, at go live. Nothing has been charged for it up to this point.
      </p>
    </div>
  )
}

function DomainScreen(props: {
  jobId: string
  busy: boolean
  setBusy: (v: boolean) => void
  setError: (v: string | null) => void
  onDone: (branch: Branch) => void
}) {
  // 'own' is the default because most tradies calling us already bought a domain years ago and
  // forgot about it. Defaulting to 'new' would sell a second one to someone who has one.
  const [branch, setBranch] = useState<Branch>('own')
  const [registrar, setRegistrar] = useState('')
  const [domain, setDomain] = useState('')
  const [abn, setAbn] = useState('')
  const [entityName, setEntityName] = useState('')
  const [report, setReport] = useState<DomainReport | null>(null)
  const [availability, setAvailability] = useState<{ available: boolean | null; detail: string; requiresAbn: boolean } | null>(
    null,
  )
  const [fieldError, setFieldError] = useState<{ field?: string; detail: string } | null>(null)
  const [nextSteps, setNextSteps] = useState<string[] | null>(null)

  const inspect = async () => {
    props.setBusy(true)
    setFieldError(null)
    try {
      const res = await api.inspectDomain(props.jobId, domain)
      setReport(res.report as DomainReport)
    } catch (err) {
      setFieldError({ detail: err instanceof ApiCallError ? (err.detail ?? err.message) : 'Lookup failed' })
    } finally {
      props.setBusy(false)
    }
  }

  const check = async () => {
    props.setBusy(true)
    setFieldError(null)
    try {
      setAvailability(await api.checkDomain(props.jobId, domain))
    } catch (err) {
      setFieldError({ detail: err instanceof ApiCallError ? (err.detail ?? err.message) : 'Check failed' })
    } finally {
      props.setBusy(false)
    }
  }

  const submit = async () => {
    props.setBusy(true)
    setFieldError(null)
    try {
      const res = await api.submitDomain(props.jobId, { branch, domain, abn, entityName, registrar })
      setNextSteps(res.nextSteps)
    } catch (err) {
      if (err instanceof ApiCallError && (err.status === 422 || err.status === 400)) {
        setFieldError({ detail: err.detail ?? err.message })
      } else {
        props.setError(err instanceof ApiCallError ? (err.detail ?? err.message) : 'Could not save that')
      }
    } finally {
      props.setBusy(false)
    }
  }

  if (nextSteps) {
    return (
      <div className="card space-y-4">
        <h2 className="text-xl">Got it</h2>
        <ul className="space-y-2 text-sm">
          {nextSteps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
        <button className="btn-primary" onClick={() => props.onDone(branch)}>
          Next: your hosting
        </button>
      </div>
    )
  }

  return (
    <div className="card space-y-5">
      <h2 className="text-xl">Your domain name</h2>

      <div className="grid gap-2">
        {(
          [
            ['own', 'I already have a domain'],
            ['new', 'I need a domain'],
            ['locked', 'I have a domain but I cannot get into it'],
          ] as Array<[Branch, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`rounded-lg border px-4 py-3 text-left text-sm font-medium ${
              branch === value ? 'border-ice-700 bg-ice-100' : 'border-ice-200 bg-white hover:border-ice-300'
            }`}
            onClick={() => {
              setBranch(value)
              setReport(null)
              setAvailability(null)
            }}
          >
            {label}
            {value === 'locked' ? (
              <span className="mt-0.5 block text-xs font-normal text-ice-500">
                A previous web designer holds it and is not answering. This happens a lot, and we can help.
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <Field label="The domain" error={fieldError?.field ? undefined : fieldError?.detail}>
        <TextInput value={domain} onChange={setDomain} placeholder="yourbusiness.com.au" />
      </Field>

      {branch === 'own' || branch === 'locked' ? (
        <>
          {/*
            WHO THEY BOUGHT IT FROM, IN THEIR WORDS.

            The lookup below reports what the internet says, which is the reseller. That is often
            not the brand on the login page the customer will have to open, and the first question
            on the phone call is always "where do we log in". A list rather than a text box
            because the answer needs to be scannable in an alert, and because a tradie who cannot
            remember gets a real option to pick instead of guessing into an empty field.
          */}
          <Field label="Where did you buy it?" hint="A rough answer is fine. It just tells us which login screen to expect.">
            <div className="grid gap-2 sm:grid-cols-2">
              {REGISTRARS.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`rounded-lg border px-3 py-2.5 text-left text-sm ${
                    registrar === name
                      ? 'border-ice-700 bg-ice-100 font-medium'
                      : 'border-ice-200 bg-white hover:border-ice-300'
                  }`}
                  onClick={() => setRegistrar(registrar === name ? '' : name)}
                >
                  {name}
                </button>
              ))}
            </div>
          </Field>

          <button className="btn-ghost" onClick={inspect} disabled={props.busy || domain.length < 4}>
            {props.busy ? 'Looking it up' : 'Look it up'}
          </button>

          {report ? (
            <div className="rounded-lg border border-ice-200 bg-ice-50 p-4 text-sm">
              <p className="mb-2 font-semibold">Here is what we found. Does this look right?</p>
              <ul className="space-y-1">
                {report.summary.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
              {report.problems.length > 0 ? (
                <p className="field-hint mt-2">
                  Some lookups did not answer: {report.problems.join('; ')}. We will check by hand.
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {branch === 'new' ? (
        <>
          <button className="btn-ghost" onClick={check} disabled={props.busy || domain.length < 4}>
            {props.busy ? 'Checking' : 'Check if it is available'}
          </button>

          {availability ? (
            <Banner tone={availability.available === true ? 'ok' : availability.available === false ? 'warn' : 'info'}>
              {availability.detail}
            </Banner>
          ) : null}

          {availability?.requiresAbn || /\.au$/i.test(domain) ? (
            <div className="rounded-lg border border-ice-200 p-4">
              <p className="field-label">A .au domain needs these</p>
              <p className="field-hint mb-3">
                auDA will not let anyone register a .au without them, so we have to collect them before we buy it.
              </p>
              <div className="space-y-3">
                <Field label="ABN" error={fieldError?.field === 'abn' ? fieldError.detail : undefined}>
                  <TextInput value={abn} onChange={setAbn} inputMode="numeric" />
                </Field>
                <Field
                  label="Registered entity name"
                  error={fieldError?.field === 'entityName' ? fieldError.detail : undefined}
                >
                  <TextInput value={entityName} onChange={setEntityName} placeholder="As it appears on the ABN" />
                </Field>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {branch === 'locked' ? (
        <Banner tone="info" title="What happens with a domain you cannot access">
          <p>
            We look up who the domain is registered with and who is listed on it, then approach them directly. If
            that goes nowhere there is a formal complaint process with the registrar, and an auDA dispute after
            that.
          </p>
          <p className="mt-2">
            We will not put a timeframe on it, because it depends on someone else replying. We can put your site
            live on a temporary address in the meantime so it is not sitting there doing nothing.
          </p>
        </Banner>
      ) : null}

      {fieldError && !fieldError.field ? <Banner tone="error">{fieldError.detail}</Banner> : null}

      <button className="btn-accent" onClick={submit} disabled={props.busy || domain.length < 4}>
        {props.busy ? 'Saving' : 'That is the one'}
      </button>
    </div>
  )
}

function ConfirmationScreen({ jobId }: { jobId: string }) {
  const [data, setData] = useState<{
    paid: boolean
    monthly: Array<{ label: string; price: string | null }>
    domain: { name: string; branch: string; status: string } | null
    promise: string
    afterLaunch: { label: string; price: string | null; detail: string }
  } | null>(null)

  useEffect(() => {
    void api.goLiveConfirmation(jobId).then(setData).catch(() => setData(null))
  }, [jobId])

  if (!data) {
    return (
      <div className="card">
        <Spinner label="Loading" />
      </div>
    )
  }

  return (
    <div className="card space-y-5">
      <h2 className="text-xl">What happens next</h2>
      <ul className="space-y-2 text-sm">
        <li>{data.promise}</li>
        <li>Your website stays exactly as you approved it. Nothing changes when it goes live.</li>
        <li>A receipt has been emailed to you.</li>
      </ul>

      <div>
        <h3 className="mb-2 text-sm font-semibold">What you pay each month</h3>
        <ul className="space-y-1 text-sm">
          {data.monthly.map((m) => (
            <li key={m.label} className="flex justify-between border-b border-ice-100 pb-1">
              <span>{m.label}</span>
              <span className="font-semibold">{m.price}</span>
            </li>
          ))}
        </ul>
        {/*
          The price is deliberately null on the DIY tier: changes are included, so there is no
          number to show and printing "null" or "$0" would both be worse than the sentence.
        */}
        <p className="field-hint mt-2">
          <span className="font-semibold">{data.afterLaunch.label}.</span> {data.afterLaunch.detail}
          {data.afterLaunch.price ? ` ${data.afterLaunch.price}.` : ''}
        </p>
      </div>

      {data.domain ? (
        <p className="text-sm">
          Domain: <strong>{data.domain.name}</strong> ({data.domain.status.replace(/_/g, ' ')})
        </p>
      ) : null}

      <p className="text-sm">
        <Link className="text-ice-500 underline" to={`/discharge/${jobId}`}>
          Or take your files to another provider
        </Link>
      </p>
    </div>
  )
}
