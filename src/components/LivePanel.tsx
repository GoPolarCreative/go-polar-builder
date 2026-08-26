import { useCallback, useEffect, useState } from 'react'
import { ApiCallError, api } from '../lib/api'
import { Banner } from './ui'

type LiveState = Awaited<ReturnType<typeof api.live>>

/**
 * The live website controls.
 *
 * Only renders once a site is actually on the internet. Before that there is nothing here worth a
 * customer's attention: the whole panel is about the gap between what they have changed and what
 * the public can see, and before go-live that gap does not exist.
 *
 * THE UNDO BUTTON IS THE POINT OF THIS COMPONENT. Restore used to be a small underlined "Go back
 * to this" inside a collapsed version history, which is a fine place for it when nothing is at
 * stake and a terrible one at the moment somebody has just put a mistake in front of their
 * customers. A person in that moment is not reading; they are scanning for the way out. So the
 * most recent published version gets a real button, on the surface, labelled as an undo rather
 * than as a version operation. The full history stays where it was for anyone who wants it.
 *
 * THE COUNTER IS SHOWN BEFORE IT MATTERS. Ten changes a month is a promise the landing page makes
 * and the number should never be a surprise when it runs out.
 */
export function LivePanel({
  jobId,
  rollback,
}: {
  jobId: string
  /*
   * The editor's own rollback, passed in rather than reimplemented.
   *
   * It already reloads the version list and the preview iframe afterwards. Calling the API
   * directly from here would put the site back and leave the customer looking at a stale preview
   * of the version they just undid, which is the most confusing possible outcome for a button
   * whose entire job is to reassure them.
   */
  rollback: (version: number) => Promise<void>
}) {
  const [state, setState] = useState<LiveState | null>(null)
  const [busy, setBusy] = useState<'publish' | 'undo' | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [failures, setFailures] = useState<Array<{ path: string; detail: string }>>([])
  const [done, setDone] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setState(await api.live(jobId))
    } catch {
      // The editor must keep working if this lookup fails. It is a status panel, not a gate.
    }
  }, [jobId])

  useEffect(() => {
    void load()
  }, [load])

  if (!state?.isLive) return null

  const publish = async () => {
    setBusy('publish')
    setProblem(null)
    setFailures([])
    setDone(null)
    try {
      const res = await api.publish(jobId)
      setDone(`Your website is updated. Everyone visiting ${res.hostname} sees the new version.`)
      await load()
    } catch (err) {
      if (err instanceof ApiCallError) {
        setProblem(err.detail ?? err.message)
        // The check list is the useful part of a refusal. Without it "checks failed" is a wall.
        const body = err.body as { failures?: Array<{ path: string; detail: string }> } | undefined
        setFailures(body?.failures ?? [])
      } else {
        setProblem('Something went wrong. Your website has not changed.')
      }
    } finally {
      setBusy(null)
    }
  }

  const undo = async () => {
    if (state.publishedVersion === null) return
    setBusy('undo')
    setProblem(null)
    setFailures([])
    setDone(null)
    try {
      await rollback(state.publishedVersion)
      setDone('Put back. Your website is showing the version that was online before.')
      await load()
    } catch (err) {
      setProblem(
        err instanceof ApiCallError
          ? (err.detail ?? err.message)
          : 'That did not work. Your website has not changed.',
      )
    } finally {
      setBusy(null)
    }
  }

  const m = state.monthly

  return (
    <section className="rounded-lg border border-ice-200">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ice-100 px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Your website is online</p>
          {state.siteUrl ? (
            <a
              className="field-hint break-all underline"
              href={state.siteUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              {state.hostname}
            </a>
          ) : null}
        </div>
        {m ? (
          <span
            className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
              m.exhausted ? 'bg-amber-100 text-amber-900' : 'bg-ice-100 text-ice-700'
            }`}
            title={`Refills on the first of ${m.resetsIntoMonth}`}
          >
            {m.remaining} of {m.allowed} changes left
          </span>
        ) : null}
      </div>

      <div className="space-y-3 px-4 py-3">
        {m?.exhausted ? (
          <Banner tone="warn" title="You have used this month's changes">
            They refill on the first of {m.resetsIntoMonth}. If something is wrong and it cannot
            wait, reply to any of our emails and we will fix it for you.
          </Banner>
        ) : null}

        {/*
          THE BANNER THAT EXPLAINS WHY NOTHING LOOKS DIFFERENT. Without it a customer makes a
          change, opens their site on their phone, sees the old version and concludes the editor
          is broken. Everything they have done is real; it is just not published yet.
        */}
        {state.hasUnpublishedChanges ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
            <p className="text-sm font-semibold text-amber-900">You have changes nobody can see yet</p>
            <p className="field-hint">
              You are looking at a draft. Your website is still showing version{' '}
              {state.publishedVersion}. Put it online when you are happy with it.
            </p>
            <button className="btn-accent mt-3 w-full justify-center" onClick={publish} disabled={busy !== null}>
              {busy === 'publish' ? 'Making it live' : 'Make my edited website live'}
            </button>
          </div>
        ) : (
          <p className="field-hint">
            Everything you have changed is online. Version {state.publishedVersion}.
          </p>
        )}

        {problem ? (
          <Banner tone="error" title="Nothing was published">
            <p>{problem}</p>
            {failures.length > 0 ? (
              <ul className="mt-2 space-y-1 text-xs">
                {failures.map((f, i) => (
                  <li key={i}>
                    <span className="font-semibold">{f.path}</span>: {f.detail}
                  </li>
                ))}
              </ul>
            ) : null}
          </Banner>
        ) : null}

        {done ? <Banner tone="ok">{done}</Banner> : null}

        {/*
          The undo. Deliberately last, deliberately full width, deliberately not called
          "rollback". It only appears when there is something to undo to.
        */}
        {state.publishedVersion !== null && state.currentVersion !== state.publishedVersion ? (
          <button className="btn-ghost w-full justify-center" onClick={undo} disabled={busy !== null}>
            {busy === 'undo' ? 'Putting it back' : 'Undo my changes and go back to what is online'}
          </button>
        ) : null}
      </div>
    </section>
  )
}
