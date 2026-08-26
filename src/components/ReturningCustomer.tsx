import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiCallError, api } from '../lib/api'
import { Banner, Field, TextInput } from './ui'

/**
 * The way back in for somebody who already has a website with us.
 *
 * A CODE, NOT A LINK. Chris's call and the right one for this audience. A tradie reading an email
 * on a phone has to leave the browser for the mail app and come back, and on an older phone
 * whatever they had open is often gone by the time they return. A code is read once, in the
 * notification if the flow puts it in the subject, and typed into the screen already in front of
 * them. Nothing is lost by switching apps because nothing depends on the browser staying put.
 *
 * IT REPLACES EMAIL PLUS ORDER NUMBER FOR A LIVE SITE. That pair is evidence of a purchase and is
 * fine for opening a draft on our servers. It is not enough to change a website the public is
 * looking at: an address is on the side of the van and an order number is on a forwarded receipt.
 * Control of the inbox is the only acceptable evidence once a site is public.
 *
 * The constraints that make six digits safe live in server/lib/loginCode.ts, not here. This is
 * two boxes and some patience.
 */
export function ReturningCustomer() {
  const navigate = useNavigate()
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)

  const requestCode = async () => {
    setBusy(true)
    setProblem(null)
    try {
      const res = await api.requestLoginCode(email)
      setSent(res.detail)
      setStep('code')
    } catch (err) {
      setProblem(
        err instanceof ApiCallError ? (err.detail ?? err.message) : 'Could not send a code just now.',
      )
    } finally {
      setBusy(false)
    }
  }

  const verify = async () => {
    setBusy(true)
    setProblem(null)
    try {
      const { jobId } = await api.verifyLoginCode(email, code)
      navigate(`/preview/${jobId}`)
    } catch (err) {
      setProblem(
        err instanceof ApiCallError ? (err.detail ?? err.message) : 'That did not work. Try again.',
      )
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-8 border-t border-ice-200 pt-6">
      <h2 className="text-xl">Already have a website with us?</h2>
      <p className="field-hint mb-4">Sign in to make changes to it.</p>

      {step === 'email' ? (
        <div className="space-y-3">
          <Field label="The email you paid with">
            <TextInput
              value={email}
              onChange={(v) => {
                setEmail(v)
                setProblem(null)
              }}
              placeholder="you@yourbusiness.com.au"
              type="email"
              autoComplete="email"
            />
          </Field>

          {problem ? <Banner tone="error">{problem}</Banner> : null}

          <button
            className="btn-primary"
            onClick={requestCode}
            disabled={busy || !email.includes('@')}
          >
            {busy ? 'Sending' : 'Email me a code'}
          </button>
          <p className="field-hint">
            We send a six digit code instead of a link, so you do not lose your place swapping
            between your email and this page.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {sent ? <Banner tone="ok">{sent}</Banner> : null}

          <Field label="The six digit code" hint={`Sent to ${email}. Check your junk folder if it is not there.`}>
            <TextInput
              value={code}
              onChange={(v) => {
                // Digits only, capped at six. Saves a round trip for a typo and stops a paste of
                // "Your code is 123456" from being submitted whole.
                setCode(v.replace(/\D/g, '').slice(0, 6))
                setProblem(null)
              }}
              placeholder="123456"
              inputMode="numeric"
              autoComplete="one-time-code"
              /* Lets a phone offer the code straight from the notification. */
              maxLength={6}
            />
          </Field>

          {problem ? <Banner tone="error">{problem}</Banner> : null}

          <button className="btn-accent" onClick={verify} disabled={busy || code.length !== 6}>
            {busy ? 'Checking' : 'Open my website'}
          </button>

          <button
            className="link-arrow block text-sm"
            onClick={() => {
              setStep('email')
              setCode('')
              setProblem(null)
              setSent(null)
            }}
            disabled={busy}
          >
            Use a different email
          </button>
        </div>
      )}
    </section>
  )
}
