import { useEffect, useState } from 'react'
import { testWeb3FormsKey, ApiCallError, api, type FormsKeyState } from '../lib/api'
import { Banner, Eyebrow, Field, TextInput } from './ui'

/**
 * Where the customer's enquiries actually go.
 *
 * THIS IS COLLECTED BEFORE THE BUILD RUNS. It has now moved three times and every reason is kept
 * here, because the next person to look at it will be tempted to move it again.
 *
 * It started in the intake, before there was a website. 59 submissions produced almost nothing
 * usable: at that point there is no site, no forms and no reason to care what an access key is
 * (D29). So it went to the go-live page, where there is something concrete to protect.
 *
 * That was still wrong, and go-live is why. Go live is a paying sequence - domain, hosting,
 * checkout - and the customer arrives at it having already decided to spend money. Dropping a
 * third-party sign-up in front of that turns a payment into an errand: they leave the page to
 * make a Web3Forms account, and the checkout is still sitting there when they come back, if they
 * come back. So it moved to the editing page, where they are sitting with their website open and
 * edits left, which reads as part of the build rather than an obstacle in front of a cart.
 *
 * THAT WAS ALSO WRONG, AND A REAL PERSON PROVED IT. In a dress rehearsal on 2026-08-26 a tester
 * finished his build, was asked for a Web3Forms key on the editing page, and stopped there. The
 * task arrived after the exciting part was over, sitting in a sidebar beside a website he was
 * already happy with, and it read as an interruption rather than a step.
 *
 * It now runs BEFORE the build, where the customer is still in setup mode and expects to be asked
 * for things. The waiting is free too: there are five to ten minutes of generation to sit through
 * anyway, and making a Web3Forms account is a good use of them.
 *
 * IT NEVER BLOCKS THE BUILD. Being trapped is the exact failure being fixed, so the build button
 * stays live whether this is done or not, and InboxTask still carries the reminder on the editing
 * page for anybody who skipped it. Go live is, as ever, the place that actually refuses.
 *
 * THE INVARIANT IS UNCHANGED WHEREVER IT SITS. Until this is verified, the live site would carry
 * Go Polar's own Web3Forms key, so every enquiry from the website the customer just paid for
 * would arrive in Go Polar's inbox and they would never see one. That is the worst failure this
 * product has available to it. Go live still refuses without it - it just sends them back here
 * to do it, rather than making them do it standing at the till.
 */
export function InboxSetup(props: {
  jobId: string
  formsKey: FormsKeyState
  onVerified: (next: FormsKeyState) => void
  /**
   * Open on arrival. True before the build, where this is the thing being asked for and hiding
   * it behind a plus sign is how it gets skipped. False on the editing page, where it is one
   * task among several and an expanded panel would push the website off the screen.
   */
  defaultOpen?: boolean
}) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [open, setOpen] = useState(props.defaultOpen ?? false)

  const verified = props.formsKey.verified

  const submit = async () => {
    setBusy(true)
    setProblem(null)
    setDone(null)
    try {
      /*
       * The test goes from the browser, not the server: Web3Forms blocks server-side calls at the
       * TLS layer. It is the same call the finished website's forms will make, so if it reaches
       * their inbox the forms do too.
       *
       * IT IS ALSO ALLOWED TO FAIL WITHOUT FAILING THE STEP. A blocked request, an offline moment
       * or an ad blocker is not the customer doing anything wrong, and it used to surface as "That
       * key was not accepted" on a key nobody had found fault with. Whatever comes back is passed
       * to the server as evidence; the server saves the key either way and only marks it verified
       * when the test genuinely succeeded.
       */
      const proof = await testWeb3FormsKey(key.trim()).catch(() => null)
      const res = await api.goLiveFormsKey(props.jobId, key, proof)
      setDone(res.detail)
      setTimeout(
        () =>
          props.onVerified({
            ...props.formsKey,
            saved: true,
            verified: res.tested === true,
            keyMasked: res.keyMasked,
            blocksGoLive: res.tested !== true,
          }),
        2500,
      )
    } catch (err) {
      /*
       * Only the shape can be rejected now, and that is genuinely the customer's to fix: they
       * pasted an email address, a phone number or a URL, and the message names which. Anything
       * else is ours and says so.
       */
      setProblem(
        err instanceof ApiCallError
          ? (err.detail ?? err.message)
          : 'Something went wrong saving that key. Nothing has been saved, so please try again.',
      )
    } finally {
      setBusy(false)
    }
  }

  /*
   * DONE COLLAPSES TO ONE LINE. This sits on the editing page, which the customer comes back to
   * repeatedly across ten rounds of changes. A finished task that keeps taking up half a screen
   * reads as an outstanding one.
   */
  if (verified) {
    return (
      <section className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
        <p className="text-sm font-semibold text-emerald-900">Your enquiries come to you</p>
        <p className="field-hint">
          The forms on your website send to your own inbox
          {props.formsKey.keyMasked ? ` (key ${props.formsKey.keyMasked})` : ''}. Nothing more to do.
        </p>
      </section>
    )
  }

  return (
    <section className="rounded-lg border border-amber-300 bg-amber-50">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        aria-expanded={open}
        aria-controls="inbox-setup"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-amber-900">
            Where should your enquiries go?
          </span>
          <span className="field-hint block">
            One thing to set up while you are here. Your website cannot go live without it.
          </span>
        </span>
        <span aria-hidden="true" className="shrink-0 text-base leading-none text-amber-700">
          {open ? '−' : '+'}
        </span>
      </button>

      {open ? (
        <div id="inbox-setup" className="space-y-4 border-t border-amber-200 px-4 pb-4 pt-3">
          <p className="text-sm text-ice-700">{props.formsKey.why}</p>

          <div className="rounded-lg border border-amber-200 bg-white p-4">
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
              className="btn-accent mt-3 inline-flex"
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
              disabled={busy || Boolean(done)}
              placeholder="Paste your access key here"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          {/* Titled for what actually went wrong. The only rejection left is the shape. */}
          {problem ? (
            <Banner tone="error" title="That does not look like an access key">
              {problem}
            </Banner>
          ) : null}
          {done ? (
            <Banner tone="ok" title="Your forms are working">
              {done}
            </Banner>
          ) : null}

          <button
            className="btn-accent"
            onClick={submit}
            disabled={busy || !key.trim() || Boolean(done)}
          >
            {busy ? 'Sending a test enquiry' : 'Check my key and switch my forms over'}
          </button>
          <p className="field-hint">
            We send one test enquiry through your account to be certain it reaches you. It arrives
            in the inbox you gave Web3Forms, and you do not need to reply to it.
          </p>
        </div>
      ) : null}
    </section>
  )
}

/**
 * The go-live page's version of the same rule, for somebody who got there without doing it.
 *
 * Deliberately not a copy of the form. Two places to complete the same task means two places to
 * keep working; this one only points back.
 */
export function InboxOutstanding({ jobId }: { jobId: string }) {
  return (
    <div className="card space-y-3">
      <div>
        <Eyebrow>One thing first</Eyebrow>
        <h2 className="text-xl">Your enquiry inbox is not set up yet.</h2>
      </div>
      <p className="text-sm text-ice-700">
        Right now the contact form on your website still sends to us rather than to you. We cannot
        put it online like that, because every enquiry you got would land in our inbox and you
        would never see it.
      </p>
      <p className="text-sm text-ice-700">
        It is one short job on your website page, and it takes a couple of minutes.
      </p>
      <a className="btn-accent inline-flex" href={`/preview/${jobId}`}>
        Take me back to set it up
      </a>
    </div>
  )
}

/**
 * The pre-build version: the same guided task, asked before the website exists.
 *
 * WHAT IT DOES NOT DO IS AS IMPORTANT AS WHAT IT DOES. It does not gate the build button, it does
 * not nag, and it can be put aside in one tap. A tester stopping dead at this question is the
 * reason it moved here, and a version of it that traps people would be a worse bug than the one
 * it replaced.
 *
 * Putting it aside is remembered for the session only. A customer who skips it, builds, and comes
 * back tomorrow should be asked again, because by then the question has an obvious answer: their
 * website exists and its contact form goes to the wrong place.
 */
export function InboxBeforeBuild({ jobId }: { jobId: string }) {
  const [formsKey, setFormsKey] = useState<FormsKeyState | null>(null)
  const [setAside, setSetAside] = useState(false)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const s = await api.goLive(jobId)
        if (live) setFormsKey(s.formsKey)
      } catch {
        // The build must start even if this lookup fails. Go live still enforces the rule.
      }
    })()
    return () => {
      live = false
    }
  }, [jobId])

  if (!formsKey) return null

  if (formsKey.verified) {
    return (
      <section className="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
        <p className="text-sm font-semibold text-emerald-900">Your enquiries come to you</p>
        <p className="field-hint">
          Enquiries from your website will go straight to your own inbox
          {formsKey.keyMasked ? ` (key ${formsKey.keyMasked})` : ''}. Nothing more to do.
        </p>
      </section>
    )
  }

  if (setAside) {
    return (
      <section className="mb-6 rounded-lg border border-ice-200 bg-ice-50 px-4 py-3">
        <p className="text-sm font-semibold text-ice-700">Enquiry inbox: still to do</p>
        <p className="field-hint">
          No rush. We will ask again on your website page once it is built, and it has to be done
          before you can go live.{' '}
          <button
            type="button"
            className="font-semibold underline"
            onClick={() => setSetAside(false)}
          >
            Do it now instead
          </button>
        </p>
      </section>
    )
  }

  return (
    <div className="mb-6">
      <InboxSetup jobId={jobId} formsKey={formsKey} onVerified={setFormsKey} defaultOpen />
      <p className="field-hint mt-2">
        Rather get straight to it?{' '}
        <button type="button" className="font-semibold underline" onClick={() => setSetAside(true)}>
          Skip this for now
        </button>{' '}
        and we will remind you once your website is built. It will not hold the build up.
      </p>
    </div>
  )
}

/**
 * The build page renders this and nothing else. It loads its own state rather than being handed
 * it, because the alternative was threading formsKey through the editor outlet context, and the
 * editor already carries twenty-one values through there. Nothing renders until the answer is
 * known: a task card that appears, then vanishes because it turned out to be done, is worse than
 * one that shows up a beat late.
 */
export function InboxTask({ jobId }: { jobId: string }) {
  const [formsKey, setFormsKey] = useState<FormsKeyState | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const s = await api.goLive(jobId)
        if (live) setFormsKey(s.formsKey)
      } catch {
        // The editor must keep working if this lookup fails. Go live still enforces the rule.
      }
    })()
    return () => {
      live = false
    }
  }, [jobId])

  if (!formsKey) return null

  /*
   * ONCE IT IS DONE IT DISAPPEARS FROM HERE.
   *
   * This used to collapse to a green "your enquiries come to you" card and sit at the top of the
   * changes panel for the rest of the build. A finished task reporting that it is finished, above
   * the things the customer actually came to use. It is a setup step, not a status readout, so
   * when there is nothing left to do there is nothing to show.
   *
   * Keyed off `saved` rather than `verified` deliberately. The customer's part is pasting a
   * well-formed key; proving it with a live test happens at go live and is our job, so nagging
   * somebody who has already done what was asked would be the same mistake in reverse.
   *
   * Go live still refuses without a verified key, and says so there, which is where a person can
   * do something about it.
   */
  if (formsKey.saved) return null

  return <InboxSetup jobId={jobId} formsKey={formsKey} onVerified={setFormsKey} />
}