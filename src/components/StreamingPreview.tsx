import { useEffect, useRef, useState } from 'react'

/**
 * The customer's website appearing as it is written.
 *
 * THE BRIEF SAYS THE SITE ASSEMBLING IN FRONT OF THEM IS THE PRODUCT, and until now it was the
 * one thing they never saw. The server has always streamed the document; the build screen threw
 * the bytes away and showed a progress bar, and the edit screen printed them as raw markup in a
 * code block. A tradesperson watched either one for eleven minutes.
 *
 * HOW IT WORKS, AND WHY NOT srcdoc. Reassigning srcdoc restarts the parse on every chunk: the
 * page flickers, images re-request, and anything below the fold jumps. Instead this opens the
 * iframe's document once and calls write() with each new slice, which is exactly what a browser
 * does when it loads a page over a slow connection. The stylesheet applies the moment it arrives
 * and each section paints as it lands.
 *
 * WHY A DIFFERENT SANDBOX FROM THE FINISHED PREVIEW. Writing into a document requires reaching
 * contentDocument, which the finished preview deliberately forbids: it runs with allow-scripts
 * and no allow-same-origin, so a generated site can never reach back into the builder. This one
 * inverts that. It takes allow-same-origin so we can write to it, and it does NOT take
 * allow-scripts, so nothing in the streamed document can run at all. Neither iframe ever holds
 * both, which is the pair that would let generated markup touch the parent.
 *
 * IT IS NEVER THE FINISHED ARTICLE. No check has run against a half-written document, so it is
 * labelled while it streams and handed over to the real preview only once the build reports done.
 */

/** Nothing is revealed until the page has something to show, so the reveal is never a white box. */
const FIRST_PAINT = /<\/section>|<\/header>|<h1[\s>]/i

/** A write per chunk is wasted work; a write per frame looks continuous and costs almost nothing. */
const FRAME_MS = 120

/** No bytes for this long while still building means something is wrong, and saying so beats a lie. */
const STALL_MS = 45_000

export type StreamState = 'idle' | 'streaming' | 'done' | 'failed'

/**
 * What fills the wait before there is anything to draw.
 *
 * MEASURED: the model thinks for 231 seconds before it emits a single byte of the document. No
 * amount of progressive rendering helps with that, because there is nothing to render. A spinner
 * for four minutes and a blank page for four minutes are the same experience.
 *
 * The content plan arrives at about 40 seconds, long before the HTML, and it is the customer's
 * own words: their headline, their services, their suburbs. Showing it turns most of the wait into
 * something worth reading, and it is real rather than a progress animation pretending to know.
 */
function PlanSummary({ plan }: { plan: unknown }) {
  const p = (plan ?? {}) as {
    hero?: { h1?: string; sub?: string }
    services?: Array<{ name?: string }>
    serviceAreas?: { suburbs?: unknown[] }
    faq?: unknown[]
    brand?: { businessName?: string }
  }
  const h1 = p.hero?.h1
  if (!h1) return null

  const services = (p.services ?? []).map((s) => s?.name).filter(Boolean) as string[]
  const suburbs = p.serviceAreas?.suburbs?.length ?? 0
  const faqs = p.faq?.length ?? 0

  return (
    <div className="max-h-full w-full max-w-md overflow-auto px-6 py-4 text-left">
      <p className="field-hint mb-2">It has decided what your website will say. Writing it now.</p>

      <p className="text-lg leading-snug font-bold text-ice-700" style={{ textWrap: 'balance' }}>
        {h1.replace(/<[^>]+>/g, '')}
      </p>
      {p.hero?.sub ? <p className="field-hint mt-1">{p.hero.sub.replace(/<[^>]+>/g, '')}</p> : null}

      {services.length > 0 ? (
        <div className="mt-4">
          <span className="field-label">Your services, each with its own section</span>
          <div className="flex flex-wrap gap-1.5">
            {services.map((s) => (
              <span key={s} className="chip-off cursor-default text-[13px]">
                {s}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <ul className="mt-4 space-y-1 text-[13px] text-ice-500">
        {suburbs > 0 ? <li>{suburbs} suburbs listed on your service area map</li> : null}
        {faqs > 0 ? <li>{faqs} questions answered in your FAQ</li> : null}
        <li>Photos being sized and arranged</li>
      </ul>
    </div>
  )
}

export function StreamingPreview({
  html,
  state,
  label,
  plan,
  startedAt,
}: {
  html: string
  state: StreamState
  /** What is being watched, e.g. "Writing your website" or "Applying your changes". */
  label: string
  /** The content plan, once it has arrived. It is what fills the wait before the first byte. */
  plan?: unknown
  /** When this run began, so the wait can be honest about how long it has been. */
  startedAt?: number | null
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const writtenRef = useRef(0)
  const openedRef = useRef(false)
  const [visible, setVisible] = useState(false)
  const [stalled, setStalled] = useState(false)
  const [, forceTick] = useState(0)
  const lastChunkAt = useRef<number>(Date.now())

  // One re-render a second while waiting, so the elapsed counter is not frozen at 0s.
  useEffect(() => {
    if (state !== 'streaming') return
    const t = window.setInterval(() => forceTick((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [state])

  // Reset when a new stream starts, so a second build does not append to the first.
  useEffect(() => {
    if (state === 'idle' || state === 'streaming') {
      if (html.length === 0) {
        writtenRef.current = 0
        openedRef.current = false
        setVisible(false)
        setStalled(false)
      }
    }
  }, [state, html.length])

  useEffect(() => {
    if (!html) return
    const id = window.setTimeout(() => {
      const doc = frameRef.current?.contentDocument
      // A null document means the browser refused same-origin access. Nothing to do but leave the
      // placeholder up: the finished preview still works, so this degrades to what we had before.
      if (!doc) return

      try {
        if (!openedRef.current) {
          doc.open()
          openedRef.current = true
          writtenRef.current = 0
        }
        if (html.length > writtenRef.current) {
          doc.write(html.slice(writtenRef.current))
          writtenRef.current = html.length
          lastChunkAt.current = Date.now()
        }
        if (!visible && FIRST_PAINT.test(html)) setVisible(true)
      } catch {
        // Writing can throw if the document was closed by a previous run. Stop rather than loop.
        openedRef.current = true
      }
    }, FRAME_MS)
    return () => window.clearTimeout(id)
  }, [html, visible])

  // Close the document once, when the stream really is finished.
  useEffect(() => {
    if (state !== 'done' && state !== 'failed') return
    const doc = frameRef.current?.contentDocument
    if (doc && openedRef.current) {
      try {
        doc.close()
      } catch {
        /* already closed */
      }
    }
  }, [state])

  useEffect(() => {
    if (state !== 'streaming') {
      setStalled(false)
      return
    }
    const t = window.setInterval(() => {
      setStalled(Date.now() - lastChunkAt.current > STALL_MS)
    }, 5_000)
    return () => window.clearInterval(t)
  }, [state])

  const building = state === 'streaming'

  return (
    <div className="relative overflow-hidden rounded-xl border border-ice-200 bg-white">
      {/*
        THE LABEL IS NOT DECORATION. A half-written page with no caption is indistinguishable from
        a finished one, and a customer who thinks the build is done will judge it on a document
        that has not been checked and may not even have a footer yet.
      */}
      <div
        className={`flex items-center justify-between gap-3 border-b px-4 py-2 text-[13px] font-semibold ${
          state === 'failed'
            ? 'border-red-200 bg-red-50 text-red-900'
            : building
              ? 'border-ice-200 bg-ice-900 text-white'
              : 'border-emerald-200 bg-emerald-50 text-emerald-900'
        }`}
      >
        <span>
          {state === 'failed'
            ? 'Stopped before it finished'
            : building
              ? `${label}. Not finished yet.`
              : 'Finished and checked'}
        </span>
        {building ? (
          <span className="shrink-0 font-normal tabular-nums opacity-80">
            {(html.length / 1024).toFixed(0)}KB so far
          </span>
        ) : null}
      </div>

      <div className="relative h-[60vh]">
        <iframe
          ref={frameRef}
          title="Your website being written"
          /*
           * allow-same-origin so the parent can write into it. NO allow-scripts: nothing in a
           * streamed document executes, which is what makes same-origin safe here.
           */
          sandbox="allow-same-origin"
          className={`h-full w-full border-0 transition-opacity duration-500 ${visible ? 'opacity-100' : 'opacity-0'}`}
        />

        {/*
          What fills the first two seconds. The document opens with the head and the whole
          stylesheet, so there is genuinely nothing to paint until the first section lands, and an
          empty white iframe reads exactly like the frozen spinner this replaces.
        */}
        {!visible ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ice-50 px-6 text-center">
            {plan ? (
              <PlanSummary plan={plan} />
            ) : (
              <>
                <div className="h-2 w-40 overflow-hidden rounded-full bg-ice-200">
                  <div className="h-full w-1/3 animate-pulse rounded-full bg-polar-accent" />
                </div>
                <p className="text-sm font-semibold text-ice-700">
                  Working out what your website should say
                </p>
                <p className="field-hint max-w-sm">
                  It reads your answers first and decides the wording, then writes the page. This
                  part takes about a minute.
                </p>
              </>
            )}
            {startedAt ? (
              <p className="field-hint tabular-nums">
                {Math.floor((Date.now() - startedAt) / 1000)}s so far, of about ten minutes
              </p>
            ) : null}
          </div>
        ) : null}

        {stalled && building ? (
          <div className="absolute inset-x-0 bottom-0 border-t border-amber-300 bg-amber-50 px-4 py-2 text-[13px] text-amber-900">
            This is taking longer than usual. Leave the page open, it is still going.
          </div>
        ) : null}

        {state === 'failed' ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white/95 px-6 text-center">
            <p className="text-sm font-semibold text-ice-700">This did not finish</p>
            <p className="field-hint max-w-sm">
              What you can see above is incomplete and has not been checked, so it is not your
              website. Nothing has been saved and your previous version is untouched.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
