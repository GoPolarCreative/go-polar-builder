import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiCallError, api, type FormsKeyState } from '../lib/api'
import { Banner, Field, Spinner, TextInput, YesNo } from '../components/ui'

/**
 * Phase 5, brief s8. Going live, in three screens.
 *
 * Wording rule, enforced throughout: we promise contact within one business day. We never
 * promise the domain will be connected in 24 hours. Transfers, registrar locks and
 * uncooperative third parties are outside Go Polar's control.
 */

type Screen = 'inbox' | 'plan' | 'domain' | 'confirmation'
type Branch = 'own' | 'new' | 'locked'

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
  domain: { name: string; branch: string; status: string; report: unknown } | null
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
  const [screen, setScreen] = useState<Screen>('plan')
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
        setNeedsDomain(s.selection?.domainAddon ?? false)
        if (s.domain) setScreen('confirmation')
        else if (s.selection?.paidAt) setScreen('domain')
        // The enquiry inbox comes first and cannot be skipped. Anyone already past it goes
        // straight to the plan, so it is a step rather than a wall.
        else if (!s.formsKey.verified) setScreen('inbox')
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
      <header className="mb-8">
        <p className="text-xs font-semibold tracking-[0.18em] text-ice-500 uppercase">Go Polar Creative</p>
        <h1 className="text-3xl">Going live</h1>
      </header>

      {error ? (
        <div className="mb-6">
          <Banner tone="error">{error}</Banner>
        </div>
      ) : null}

      {screen === 'inbox' && state ? (
        <InboxScreen
          jobId={jobId}
          formsKey={state.formsKey}
          busy={busy}
          setBusy={setBusy}
          onVerified={(next) => {
            setState({ ...state, formsKey: next })
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
          onPaid={() => setScreen('domain')}
        />
      ) : null}

      {screen === 'domain' ? (
        <DomainScreen
          jobId={jobId}
          suggestNew={needsDomain}
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          onDone={() => setScreen('confirmation')}
        />
      ) : null}

      {screen === 'confirmation' ? <ConfirmationScreen jobId={jobId} /> : null}

      <p className="mt-10 text-sm">
        <Link className="text-ice-700 underline" to={`/preview/${jobId}`}>
          Back to my website
        </Link>
      </p>
    </div>
  )
}

/**
 * Screen 0. Where the customer's enquiries will actually go.
 *
 * This used to sit in the intake, where 59 submissions produced almost nothing usable, because at
 * that point there is no site and no reason to care. Here there is a website on the other side of
 * the button and something concrete to protect, and the step explains itself rather than asking
 * a tradie to know what an access key is. See DECISIONS.md D29.
 */
function InboxScreen(props: {
  jobId: string
  formsKey: FormsKeyState
  busy: boolean
  setBusy: (v: boolean) => void
  onVerified: (next: FormsKeyState) => void
}) {
  const [key, setKey] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const submit = async () => {
    props.setBusy(true)
    setProblem(null)
    setDone(null)
    try {
      const res = await api.goLiveFormsKey(props.jobId, key)
      setDone(res.detail)
      // Held for a moment so they can read that the test enquiry went through, then on to the
      // plan. Nothing about their site changed except where the forms send.
      setTimeout(
        () =>
          props.onVerified({
            ...props.formsKey,
            verified: true,
            keyMasked: res.keyMasked,
            blocksGoLive: false,
          }),
        2500,
      )
    } catch (err) {
      // Every rejection has a reason worth reading: the shape was wrong, or Web3Forms tested the
      // key and refused it. Both come back as plain sentences from the server.
      setProblem(
        err instanceof ApiCallError
          ? (err.detail ?? err.message)
          : 'Something went wrong checking that key. Nothing has been saved.',
      )
    } finally {
      props.setBusy(false)
    }
  }

  return (
    <div className="card space-y-5">
      <div>
        <h2 className="text-xl">Where should your enquiries go?</h2>
        <p className="mt-2 text-sm text-ice-600">{props.formsKey.why}</p>
      </div>

      <div className="rounded-lg border border-ice-200 bg-ice-50 p-4">
        <p className="text-sm font-semibold">What you need to do, once</p>
        <ol className="mt-2 space-y-1.5 text-sm text-ice-700">
          {props.formsKey.whatToExpect.map((line, i) => (
            <li key={i} className="flex gap-2">
              <span className="font-semibold text-ice-500">{i + 1}.</span>
              <span>{line}</span>
            </li>
          ))}
        </ol>
        <a
          className="btn-ghost mt-3 inline-flex"
          href={props.formsKey.signUpUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          Open web3forms.com in a new tab
        </a>
      </div>

      <Field
        label="Your Web3Forms access key"
        hint="It looks like 1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809. Paste the whole thing."
      >
        <TextInput
          value={key}
          onChange={(v) => {
            setKey(v)
            setProblem(null)
          }}
          disabled={props.busy || Boolean(done)}
          placeholder="Paste your access key here"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>

      {problem ? <Banner tone="error" title="That key was not accepted">{problem}</Banner> : null}
      {done ? <Banner tone="ok" title="Your forms are working">{done}</Banner> : null}

      <button className="btn-accent" onClick={submit} disabled={props.busy || !key.trim() || Boolean(done)}>
        {props.busy ? 'Sending a test enquiry' : 'Check my key and switch my forms over'}
      </button>
      <p className="field-hint">
        We send one test enquiry through your account to be certain it reaches you. It arrives in
        the inbox you gave Web3Forms, and you do not need to reply to it.
      </p>
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
        <h2 className="text-xl">What it costs to keep your website online</h2>
        <ul className="mt-3 space-y-2 text-sm">
          <li className="flex justify-between border-b border-ice-100 pb-2">
            <span>{state?.pricing.hosting?.label}</span>
            <span className="font-semibold">{state?.pricing.hosting?.price}</span>
          </li>
          <li className="flex justify-between border-b border-ice-100 pb-2">
            <span>{state?.pricing.domain?.label}</span>
            <span className="font-semibold">{state?.pricing.domain?.price}</span>
          </li>
        </ul>
        <p className="field-hint mt-2">No mandatory ongoing maintenance fees. No lock-in contracts.</p>
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

      <div className="rounded-lg border border-ice-200 p-4">
        <span className="field-label">Do you need us to get you a domain name?</span>
        <p className="field-hint mb-2">
          {state?.pricing.domain?.price}. Say no if you already own one, you can connect it on the next screen.
        </p>
        <YesNo
          value={props.needsDomain}
          onChange={props.setNeedsDomain}
          yesLabel="I need one"
          noLabel="I have one"
        />
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
        {props.busy ? 'Setting it up' : 'Continue to payment'}
      </button>
      <p className="field-hint">
        Hosting only starts billing now, at go live. It has not been charged up to this point.
      </p>
    </div>
  )
}

function DomainScreen(props: {
  jobId: string
  suggestNew: boolean
  busy: boolean
  setBusy: (v: boolean) => void
  setError: (v: string | null) => void
  onDone: () => void
}) {
  const [branch, setBranch] = useState<Branch>(props.suggestNew ? 'new' : 'own')
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
      const res = await api.submitDomain(props.jobId, { branch, domain, abn, entityName })
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
        <button className="btn-primary" onClick={props.onDone}>
          Continue
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
        <p className="field-hint mt-2">
          {data.afterLaunch.detail} {data.afterLaunch.label}: {data.afterLaunch.price}.
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
