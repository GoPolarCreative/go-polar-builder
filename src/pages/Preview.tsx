import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, Outlet, useNavigate, useOutlet, useOutletContext, useParams } from 'react-router-dom'
import type { GenerationEvent, GenerationStage, VerificationReport } from '../../shared/types'
import { ApiCallError, api, previewUrl, streamEdit } from '../lib/api'
import { Banner, Spinner } from '../components/ui'
import { StreamingPreview } from '../components/StreamingPreview'
import { BuildProgress } from '../components/BuildProgress'
import { JobNav } from '../components/JobNav'
import { InboxTask } from '../components/InboxSetup'
import { LivePanel } from '../components/LivePanel'
import { PhotoUploader } from '../components/Uploader'
import type { AssetRecord } from '../../shared/types'

/**
 * Preview and the edit loop.
 *
 * The preview is a sandboxed iframe fed by srcdoc with every image inlined as a data URI, so
 * relative asset paths cannot break (brief s7). The edit counter is visible at all times, and the
 * placeholder tells the customer to batch their changes, because one submitted request is one
 * edit however many changes it contains.
 *
 * EVERY SUBMISSION ENDS IN SOMETHING VISIBLE. A change lands and the preview refreshes, or a
 * message says what went wrong in plain words. There is no third outcome, because an editor that
 * silently does nothing costs a customer one of their ten changes and all of their confidence.
 */

type VersionsState = Awaited<ReturnType<typeof api.versions>>
type Device = 'desktop' | 'mobile'

export default function Preview() {
  const { jobId = '' } = useParams()
  const navigate = useNavigate()

  const [versions, setVersions] = useState<VersionsState | null>(null)
  const [srcDoc, setSrcDoc] = useState<string>('')
  // Most of these customers open this on a phone, so that is what the preview opens as. Desktop
  // is one tap away and now renders a true desktop layout scaled down. Flip the initial value if
  // you would rather it always opened on desktop.
  const [device, setDevice] = useState<Device>(() =>
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches
      ? 'desktop'
      : 'mobile',
  )
  const requestRef = useRef<HTMLTextAreaElement>(null)
  // Set when a common-change chip is tapped, consumed once the new text has been committed.
  const setCaretToEnd = useRef(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [request, setRequest] = useState('')
  const [running, setRunning] = useState(false)
  const [stage, setStage] = useState<GenerationStage | null>(null)
  const [editStartedAt, setEditStartedAt] = useState<number | null>(null)
  const [liveHtml, setLiveHtml] = useState('')
  const [report, setReport] = useState<VerificationReport | null>(null)
  const [outcome, setOutcome] = useState<{ tone: 'ok' | 'warn' | 'error'; title: string; body: string } | null>(
    null,
  )
  const [extra, setExtra] = useState<Awaited<ReturnType<typeof api.extraEdits>> | null>(null)
  const [activePage, setActivePage] = useState('/')

  const pages = versions?.pages ?? [{ url: '/', path: 'index.html', service: null }]
  // null on /preview/:jobId, non-null once /changes is open. Drives the go-live bar below.
  const outlet = useOutlet()


  const loadVersions = useCallback(async () => {
    const v = await api.versions(jobId)
    setVersions(v)
    return v
  }, [jobId])

  const loadPreview = useCallback(
    async (version: number, path?: string) => {
      const res = await fetch(previewUrl(jobId, version, path))
      if (!res.ok) throw new ApiCallError('Could not load the preview', res.status)
      setSrcDoc(await res.text())
    },
    [jobId],
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const v = await loadVersions()
        if (cancelled) return
        if (v.currentVersion < 1) {
          navigate(`/build/${jobId}`)
          return
        }
        await loadPreview(v.currentVersion, pages.find((p) => p.url === activePage)?.path)
        const e = await api.extraEdits(jobId)
        if (!cancelled) setExtra(e)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiCallError ? (err.detail ?? err.message) : 'Could not load your website')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [jobId, loadPreview, loadVersions, navigate])

  // Runs after the chip's text has been committed to the box, so the caret can be put after it.
  useLayoutEffect(() => {
    if (!setCaretToEnd.current) return
    setCaretToEnd.current = false
    const el = requestRef.current
    if (!el) return
    // The chips are at the top of the column and the box is in the footer, so bring it into view
    // before focusing. Without this a tap adds text somewhere the customer cannot see.
    el.scrollIntoView({ block: 'nearest' })
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    el.scrollTop = el.scrollHeight
  }, [request])

  // Show whichever page the customer picked. Looking at a page is not an edit and costs nothing.
  const showPage = async (url: string) => {
    const page = pages.find((p) => p.url === url)
    if (!page || !versions) return
    setActivePage(url)
    try {
      await loadPreview(versions.currentVersion, page.path)
    } catch (err) {
      setError(
        err instanceof ApiCallError ? (err.detail ?? err.message) : 'Could not load that page',
      )
    }
  }

  const submitEdit = async () => {
    const text = request.trim()
    if (text.length < 3 || running) return

    const before = versions
    setRunning(true)
    setError(null)
    setOutcome(null)
    setLiveHtml('')
    setReport(null)
    setStage(null)
    setEditStartedAt(Date.now())

    // Every path out of here sets one of these, so the submission can never end in silence.
    let sawDone: { version: number; passed: boolean } | null = null
    let sawError: string | null = null

    try {
      await streamEdit(jobId, text, (event: GenerationEvent) => {
        switch (event.type) {
          case 'status':
            setStage(event.stage)
            break
          case 'html_chunk':
            setLiveHtml((h) => h + event.text)
            break
          case 'verification':
            setReport(event.report)
            break
          case 'error':
            sawError = event.detail ? `${event.message} ${event.detail}` : event.message
            break
          case 'done':
            sawDone = { version: event.version, passed: event.passed }
            break
          default:
            break
        }
      })
    } catch (err) {
      // A refusal arrives here as a non-200 with a real reason attached. It is not an unknown
      // failure and must not be described as one.
      sawError =
        err instanceof ApiCallError
          ? (err.detail ?? err.message)
          : err instanceof Error
            ? err.message
            : 'That change did not go through.'
    }

    setRunning(false)
    setLiveHtml('')

    if (sawError) {
      setOutcome({
        tone: 'error',
        title: 'That change was not made',
        body: `${sawError} Your website has not been touched, and this has not used up one of your changes.`,
      })
      // Re-read the counter rather than trusting the local copy, so what is shown is what the
      // server actually recorded.
      await loadVersions().catch(() => undefined)
      return
    }

    if (!sawDone) {
      setOutcome({
        tone: 'error',
        title: 'That change was not made',
        body: 'The connection dropped before your change finished. Your website has not been touched. Try again, and if it keeps happening give us a ring.',
      })
      await loadVersions().catch(() => undefined)
      return
    }

    // Success path. Refresh both the counter and the iframe to the version just written.
    const done = sawDone as { version: number; passed: boolean }
    try {
      const v = await loadVersions()
      await loadPreview(v.currentVersion, pages.find((p) => p.url === activePage)?.path)
      setRequest('')

      const applied = v.currentVersion > (before?.currentVersion ?? 0)
      setOutcome(
        done.passed && applied
          ? {
              tone: 'ok',
              title: 'Change made',
              body: `You are now looking at version ${v.currentVersion}. ${v.editsRemaining} of ${v.editsAllowed} changes left.`,
            }
          : {
              tone: 'warn',
              title: 'Held for a check',
              body: 'Your change was built but did not pass all our checks, so one of our team is looking at it. Your previous version is safe and you can roll back to it below.',
            },
      )
    } catch (err) {
      setOutcome({
        tone: 'warn',
        title: 'Change made, but the preview did not refresh',
        body: `${err instanceof ApiCallError ? (err.detail ?? err.message) : 'Reload the page to see it.'}`,
      })
    }
  }

  const rollback = async (version: number) => {
    setRunning(true)
    setError(null)
    setOutcome(null)
    try {
      await api.rollback(jobId, version)
      const v = await loadVersions()
      await loadPreview(v.currentVersion, pages.find((p) => p.url === activePage)?.path)
      setOutcome({
        tone: 'ok',
        title: `Back on version ${version}`,
        body: 'Going back does not use up a change.',
      })
    } catch (err) {
      setError(err instanceof ApiCallError ? (err.detail ?? err.message) : 'Could not roll back')
    } finally {
      setRunning(false)
    }
  }

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner label="Loading your website" />
      </div>
    )
  }

  const remaining = versions?.editsRemaining ?? 0
  const outOfEdits = remaining === 0
  const canEdit = versions?.capability.available !== false

  const outletContext: ChangesContext = {
    jobId,
    versions,
    canEdit,
    remaining,
    outOfEdits,
    extra,
    outcome,
    error,
    running,
    editStartedAt,
    stage,
    liveHtml,
    report,
    request,
    setRequest,
    submitEdit,
    requestRef,
    setCaretToEnd,
    rollback,
    setDevice,
  }
  return (
    <div className="flex min-h-screen flex-col lg:h-screen lg:overflow-hidden">
      <JobNav
        jobId={jobId}
        remaining={versions?.editsRemaining ?? null}
        allowed={versions?.editsAllowed ?? null}
      />

      <div className="relative flex flex-1 flex-col lg:min-h-0 lg:flex-row lg:overflow-hidden">
        {/* Preview */}
        <main className="flex flex-1 flex-col bg-ice-100 p-4 lg:h-full">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                className={device === 'desktop' ? 'chip-on' : 'chip-off'}
                onClick={() => setDevice('desktop')}
              >
                Desktop
              </button>
              <button className={device === 'mobile' ? 'chip-on' : 'chip-off'} onClick={() => setDevice('mobile')}>
                Mobile
              </button>
            </div>
            {pages.length > 1 ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-ice-500">Page</span>
                {pages.map((pg) => (
                  <button
                    key={pg.url}
                    className={pg.url === activePage ? 'chip-on' : 'chip-off'}
                    onClick={() => void showPage(pg.url)}
                  >
                    {pg.url === '/' ? 'Home' : (pg.service ?? pg.url)}
                  </button>
                ))}
              </div>
            ) : null}

            {/*
              THE WHOLE PAGE, IN A REAL TAB.
              
              The preview is an iframe inside a column beside a chat box, so it is never the
              width the site will actually be looked at, and a phone preview inside a phone is
              a 356px window pretending to be a 390px one. Opening it properly is the only way
              to see what a customer sees, and every person who has looked at one of these has
              asked for it.
              
              The path follows whichever page is being previewed, so opening it from a service
              page opens that service page rather than the home page.
            */}
            {versions?.currentVersion ? (
              <a
                className="chip-off"
                href={previewUrl(
                  jobId,
                  versions.currentVersion,
                  // activePage is a site path like "/services/decks/"; the preview wants the file.
                  activePage === '/' ? undefined : activePage.slice(1) + 'index.html',
                )}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open in a new tab
              </a>
            ) : null}

            <div className="text-xs text-ice-500">
              Version {versions?.currentVersion} of {versions?.builds.length}
            </div>
          </div>

          {/*
            WHILE A REBUILD STREAMS, THE MAIN STAGE SHOWS IT HAPPENING.

            Only when there are bytes to show. A patched edit does not stream, because it changes
            one section through a single small call rather than re-emitting the document, so
            liveHtml stays empty and the customer keeps looking at their real site while the
            change lands. That is the right behaviour for both: a rebuild is long enough to be
            worth watching, and a patch is short enough not to need to be.
          */}
          {running && liveHtml ? (
            <div className="p-4">
              <StreamingPreview html={liveHtml} state="streaming" label="Applying your changes" />
            </div>
          ) : (
            <DevicePreview srcDoc={srcDoc} device={device} />
          )}
        </main>

        {/* Chat and history */}

        {/*
          The chat is a child route, so /preview/:jobId/changes is a real address that can be
          bookmarked and that the back button understands. Rendering it through an Outlet rather
          than swapping this component keeps Preview mounted, which is the whole point: the
          iframe is never torn down, so the customer comes back to the same place on their page
          rather than to the top of it. An edit still running survives the trip for the same
          reason, because the state driving it lives up here and is handed down.
        */}
        <Outlet context={outletContext} />

        {/*
          THE WAY OUT, ON THE SCREEN WHERE THE DECISION IS ACTUALLY MADE.

          Going live was reachable from the changes panel and nowhere else: a "Happy with it?" card
          and a full width button, both sitting below the chat box on /preview/:jobId/changes. A
          tester walking the flow unguided never took that path, and this is why. He was on the
          Website tab, looking at his finished website, which is exactly where a person decides
          they are happy with it, and that screen offered him no way forward at all. The button was
          not too quiet. It was on a different page.

          Rendered only when no child route is showing, so it never appears underneath the changes
          panel, which has its own copy of it. useOutlet returns null on the index route, which is
          precisely "the customer is looking at their website and nothing else".

          Not conditional on the checklist, for the reason given on the card below: the checklist
          is advice, and nothing in it is allowed to gate the door.
        */}
        {outlet === null ? (
          <div className="border-t border-ice-200 bg-white p-4">
            <p className="text-sm font-semibold">Happy with it?</p>
            <p className="field-hint mb-3">
              Nothing goes live until you have paid for hosting and we have connected your address.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Link className="btn-accent flex-1 justify-center" to={`/golive/${jobId}`}>
                I'm ready to go live →
              </Link>
              <Link className="btn-ghost flex-1 justify-center" to={`/preview/${jobId}/changes`}>
                Change something first
              </Link>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The website, at a real viewport width, scaled to fit whatever space we have.
 *
 * WHAT WAS WRONG, MEASURED AT 390px. The iframe was `h-full w-full` inside a flex column whose
 * height was auto. A percentage height against an auto-height parent does not resolve, so the
 * iframe fell back to the HTML default of 150px inside a 428px card: 278px of empty white, about
 * two thirds of the card. And `w-full` on a phone is a 356px-wide iframe, so the site inside hit
 * its own mobile breakpoint and rendered the hamburger and the stacked bar while the toggle above
 * it said "Desktop". Both came from the same root cause: the iframe had no dimensions of its own
 * and took whatever the container gave it, which was phone width and no height.
 *
 * SO THE IFRAME IS SIZED IN CSS PIXELS AND SCALED, NEVER STRETCHED. It is laid out at a real
 * viewport (1280x800 for desktop, 390x844 for mobile) so the site inside chooses its layout the
 * way a real browser at that width would, and a transform shrinks the result to fit. A desktop
 * layout at 28% is small, but it is true. A mobile layout under a Desktop label is a lie, and a
 * customer who approves on the strength of it finds out after go-live.
 *
 * TWO FITS. Side by side on a large screen the card has a real height from the flex row, so the
 * scale is whichever of width and height binds first. Stacked on a phone there is no height to
 * fit inside, so width sets the scale and the card takes the resulting height. That is what
 * closes the empty white: the card is exactly as tall as the thing inside it.
 */
/**
 * Can this browser re-render at a scale rather than stretching a picture of the page?
 *
 * THE BUG THIS FIXES. The preview laid the site out at 1280px and then applied
 * transform: scale(0.89) to fit the pane. A transform does not re-run layout: the browser
 * rasterises the frame at 1280 and then resamples that bitmap, so every letterform is resampled
 * at a fractional ratio and the whole preview looks soft. A customer looking at it reasonably
 * concluded their website was pixellated. It was not; the picture of it was.
 *
 * zoom re-runs layout and rasterises at the final size, so text is drawn crisply at whatever
 * scale it ends up. The iframe still gets a 1280px viewport, so the site inside still lays out
 * as a desktop page and its media queries are unaffected: only the drawing changes.
 *
 * Detected rather than assumed, with the transform kept as the fallback. zoom is very widely
 * supported now but it was non-standard for years, and a browser without it should get the
 * slightly soft preview rather than an unscaled 1280px page overflowing its card.
 */
const CAN_ZOOM =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('zoom', '0.5')

const VIEWPORTS: Record<Device, { w: number; h: number }> = {
  desktop: { w: 1280, h: 800 },
  mobile: { w: 390, h: 844 },
}

function DevicePreview({ srcDoc, device }: { srcDoc: string; device: Device }) {
  const holder = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [height, setHeight] = useState(0)
  const [sideBySide, setSideBySide] = useState(false)

  // lg: in Tailwind. The layout changes from stacked to side by side here, and so does which
  // dimension is allowed to set the scale.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const sync = () => setSideBySide(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  // MEASURED SYNCHRONOUSLY BEFORE PAINT, NOT ONLY ON A ResizeObserver CALLBACK. A ResizeObserver
  // is delivered from the rendering lifecycle, so it does not fire until the page produces a
  // frame. That is fine in front of a customer and useless anywhere the tab is not compositing,
  // where the first measurement never arrives and the card renders empty forever. Reading the box
  // in a layout effect forces the measurement to happen there and then, so the first paint is
  // already the right size; the observer is kept on top of it purely to catch later resizes.
  useLayoutEffect(() => {
    const el = holder.current
    if (!el) return

    const measure = () => {
      const box = el.getBoundingClientRect()
      setWidth(Math.round(box.width))
      setHeight(Math.round(box.height))
    }
    measure()

    window.addEventListener('resize', measure)
    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure)
      ro.observe(el)
    }
    return () => {
      window.removeEventListener('resize', measure)
      ro?.disconnect()
    }
  }, [device])

  const view = VIEWPORTS[device]
  const byWidth = width > 0 ? width / view.w : 0
  const byHeight = sideBySide && height > 0 ? height / view.h : Infinity
  const scale = Math.min(byWidth, byHeight)

  const shownW = view.w * scale
  const shownH = view.h * scale

  return (
    <div
      ref={holder}
      className="relative w-full overflow-hidden rounded-xl border border-ice-200 bg-white lg:min-h-0 lg:flex-1"
      // Stacked: the card is exactly as tall as the scaled page, so there is no dead white under
      // it. Side by side: the flex row owns the height and we fit inside it.
      style={sideBySide ? undefined : { height: shownH > 0 ? Math.round(shownH) : undefined }}
    >
      {scale > 0 ? (
        /*
         * The positioned box is the SCALED size and is not itself zoomed, so its offsets stay in
         * ordinary pixels. The iframe inside it is zoomed and fills it exactly. Putting the
         * position on the zoomed element instead would scale its own top and left along with it,
         * which is the kind of arithmetic that works until somebody resizes the window.
         */
        <div
          style={{
            position: 'absolute',
            top: sideBySide ? Math.max(0, (height - shownH) / 2) : 0,
            left: Math.max(0, (width - shownW) / 2),
            width: Math.round(shownW),
            height: Math.round(shownH),
            overflow: 'hidden',
          }}
        >
          <iframe
            title="Your website"
            srcDoc={srcDoc}
            // Scripts run so the accordion and counters work. No same-origin, so the preview
            // cannot reach back into the builder.
            sandbox="allow-scripts"
            style={{
              width: view.w,
              height: view.h,
              border: 0,
              display: 'block',
              ...(CAN_ZOOM
                ? { zoom: scale }
                : { transform: `scale(${scale})`, transformOrigin: 'top left' }),
            }}
          />
        </div>
      ) : null}
    </div>
  )
}

/**
 * The last look before going live.
 *
 * A customer with ten changes left and a site they have only skimmed will approve it, and then
 * notice the phone number three weeks later. This is the list of things worth looking at, and
 * every item is something an edit can fix while they still have edits.
 *
 * MOBILE IS ON THE LIST BECAUSE MOST OF THEIR CUSTOMERS ARE ON A PHONE, and the preview opens on
 * desktop. Ticking it flips the preview across rather than trusting them to find the toggle.
 *
 * The ticks are kept per job in localStorage. They are a memory aid for one person on one machine,
 * not a record of anything, so they never reach the server: a half-ticked list is not a state the
 * build needs to know about.
 */
const CHECKS: Array<{ id: string; label: string; hint: string; mobile?: boolean }> = [
  { id: 'words', label: 'The words sound like you', hint: 'Read the top of the page out loud. If it sounds like an ad rather than you, say so.' },
  { id: 'contact', label: 'Phone number and email are right', hint: 'Ring the number on the page from your phone. This is the one mistake that costs jobs.' },
  { id: 'photos', label: 'The photos are the ones you want, in the right order', hint: 'Your best job should be first.' },
  { id: 'colours', label: 'Happy with the colours', hint: 'Ask for a different look if not. Changing the whole style counts as one change.' },
  { id: 'fonts', label: 'Happy with the fonts', hint: 'Too fussy, too plain, too small: any of those is a change.' },
  { id: 'spacing', label: 'Happy with the spacing and sizing', hint: 'Things too cramped, too spread out, headings too big or too small.' },
  { id: 'areas', label: 'Your services and suburbs are all there', hint: 'Anything missing is worth adding before you go live.' },
  { id: 'mobile', label: 'Checked it on mobile', hint: 'Most people will see it on a phone. Tick this to switch the preview over.', mobile: true },
]

function ReadyChecklist({ jobId, onWantMobile }: { jobId: string; onWantMobile: () => void }) {
  const key = `gp_checks_${jobId}`
  const [done, setDone] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, boolean>
    } catch {
      return {}
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(done))
    } catch {
      /* a full or blocked localStorage must not break the editor */
    }
  }, [key, done])

  const [open, setOpen] = useState(false)
  const ticked = CHECKS.filter((chk) => done[chk.id]).length
  const all = ticked === CHECKS.length

  return (
    <section className="rounded-lg border border-ice-200">
      {/*
        CLOSED BY DEFAULT. Expanded, eight items with a hint each ran 693px on a 390px screen,
        which is more than the phone is tall: it buried the history, the chat box and the go-live
        link under a list nobody had asked for yet. The count stays on the closed header so it
        still nags. "0 of 8" is a prompt to open it; a bare chevron is not.
      */}
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        aria-expanded={open}
        aria-controls="ready-checklist"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold">Before you go live</span>
          <span className="field-hint block">Worth a look while you still have changes left.</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
              all ? 'bg-emerald-100 text-emerald-800' : 'bg-ice-100 text-ice-700'
            }`}
          >
            {ticked} of {CHECKS.length}
          </span>
          <span aria-hidden="true" className="text-base leading-none text-ice-500">
            {open ? '−' : '+'}
          </span>
        </span>
      </button>

      {open ? (
        <div id="ready-checklist" className="border-t border-ice-100 px-4 pb-4 pt-3">
          <p className="field-hint mb-3">Nothing here is sent to us.</p>
          <ul className="space-y-3">
            {CHECKS.map((chk) => (
              <li key={chk.id}>
                <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    // Bigger than the default on a phone, where this is the thing being tapped.
                    className="mt-0.5 h-4 w-4 shrink-0"
                    checked={Boolean(done[chk.id])}
                    onChange={(e) => {
                      setDone((d) => ({ ...d, [chk.id]: e.target.checked }))
                      if (chk.mobile && e.target.checked) onWantMobile()
                    }}
                  />
                  <span>
                    <span className={done[chk.id] ? 'text-ice-400 line-through' : 'font-medium'}>
                      {chk.label}
                    </span>
                    <span className="field-hint block">{chk.hint}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>

          {all ? (
            <p className="mt-3 text-sm font-medium text-emerald-700">
              That is the lot. Whenever you are ready, go live.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

/**
 * The changes people actually ask for.
 *
 * Not a shortcut so much as a prompt: a customer looking at a finished website often cannot think
 * what to say, and "what needs changing?" over an empty box is a hard question. These are phrased
 * exactly as somebody would say them out loud, which is also the way the editor works best.
 *
 * THEY APPEND RATHER THAN REPLACE. One submitted request is one edit however many changes it
 * contains, so stacking four of these into one box is the cheapest way to use the allowance, and
 * the placeholder already tells them to batch.
 */
/*
 * WHAT PEOPLE ACTUALLY WANT TO ASK FOR.
 *
 * The first version of this list was timid: correct a phone number, make the text bigger, take a
 * service off. All real, all things a customer can already see are wrong, and none of them the
 * reason somebody opens the changes panel on a website they have just been handed. The reaction to
 * a new site is rarely "the email address is wrong", it is "can it look better than this".
 *
 * So the list now leads with the look, and says out loud that restyling the whole thing costs one
 * change like anything else, because nobody guesses that the entire design is on the table.
 *
 * EVERY LINE HERE HAS TO BE A REQUEST THE BUILDER CAN ACTUALLY CARRY OUT. A chip is a promise, and
 * a promise the edit cannot keep is worse than an empty list: the customer spends an attempt, gets
 * a shrug, and stops trusting the box. That rules out scroll animations and a before-and-after
 * slider until the JAVASCRIPT house rule allows more than its current five things, and it rules
 * out parallax until it works on more than two of the four styles and on a phone.
 */
const COMMON_EDITS: Array<{ group: string; items: string[] }> = [
  {
    // First, because it is the reason most people open this panel.
    group: 'The overall look',
    items: [
      'make the whole thing feel more premium',
      'make it look more modern',
      'make it feel tougher and more industrial',
      'it feels cramped, give it more room to breathe',
      'make the sections fade in as I scroll down',
      'add a parallax effect to the main photo',
      'change the colours',
      'change the fonts',
    ],
  },
  {
    group: 'The top of the page',
    items: [
      'make the hero image bigger and bolder',
      'reword the headline at the top',
      'the headline is too long, cut it down',
      'use a different photo as the main background image',
    ],
  },
  {
    group: 'Moving things around',
    items: [
      'move the gallery further up the page',
      'move the reviews higher up',
      'move the about section further down',
      'put the services above the about section',
    ],
  },
  {
    group: 'Photos',
    items: [
      'put my best photo first',
      'swap the order of the photos',
      'make the photos bigger',
      'show the photos in a bigger grid',
    ],
  },
  {
    group: 'Words',
    items: [
      'make the writing sound less salesy',
      'this reads too corporate, make it sound like a person',
      'add a service we do',
      'take a service off',
      'add a suburb we cover',
      'my phone number is wrong, it should be ',
      'my email address is wrong, it should be ',
    ],
  },
]

function CommonEdits({ onPick }: { onPick: (line: string) => void }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <div className="mb-2 rounded-lg border border-ice-200">
      {/* Closed by default, like the checklist. On a phone this sits directly above the chat box,
          so anything it renders open is height taken from the thing it is meant to help with. */}
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
        aria-expanded={open}
        aria-controls="common-changes"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-sm font-medium text-ice-700">Common changes people ask for</span>
        <span aria-hidden="true" className="shrink-0 text-base leading-none text-ice-500">
          {open ? '−' : '+'}
        </span>
      </button>

      {open ? (
        <div id="common-changes" className="space-y-3 border-t border-ice-100 bg-ice-50 p-3">
          <p className="field-hint">
            Tap to add one to the box, then edit the wording. <strong>Tap as many as you like</strong>{' '}
            — everything you send in one go counts as a single change, so it costs no more to ask
            for six things than for one.
          </p>
          {COMMON_EDITS.map((section) => (
            <div key={section.group}>
              <p className="text-xs font-semibold text-ice-700">{section.group}</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {section.items.map((item) => (
                  <button
                    key={item}
                    type="button"
                    // py-1.5 rather than py-1: these are the tap targets on a phone.
                    className="rounded-full border border-ice-300 bg-white px-3 py-1.5 text-xs text-ice-700 hover:border-ice-500"
                    onClick={() => onPick(item)}
                  >
                    {item.trimEnd()}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      </div>

      {/*
        * NOT AN ACCORDION, AND NOT BURIED.
        *
        * The point of this is to be read BEFORE somebody spends a change asking for something
        * that cannot be done. Hidden behind a tap it would be found by the people who already
        * know, which is nobody. It is five lines and it sits above the box they type into.
        *
        * Everything listed here is genuinely fixed, and the list is short because it is the
        * whole of it: every word, every colour, the photos and the services are all editable.
        */}
      <div className="mb-2 rounded-lg border border-ice-200 bg-white px-3 py-2.5">
        <p className="text-sm font-medium text-ice-700">What you cannot change</p>
        <ul className="mt-1.5 space-y-1">
          <li className="field-hint">Which sections are on the page, and the order they come in</li>
          <li className="field-hint">The fonts, and the layout of the big photo at the top</li>
          <li className="field-hint">The spacing between sections</li>
          <li className="field-hint">
            The <span className="whitespace-nowrap">&ldquo;Website by Go Polar Creative&rdquo;</span> line in the footer
          </li>
        </ul>
        <p className="field-hint mt-2">
          The fonts and that top layout come as a set with the design style your website was
          built in, so you cannot change one on its own. You <strong>can</strong> ask to switch
          to a different style, which changes them together. Everything else is yours: every
          word, every colour, your photos and your services.
        </p>
        <p className="field-hint mt-2">
          You can add photos at any time under <strong>Your photos</strong> above, and then ask
          for one by name, for example &ldquo;put the new decking photo in the gallery&rdquo;. The
          big photo at the top is whichever one you mark <strong>Make hero</strong>.
        </p>
      </div>
    </>
  )
}


/** Everything the changes screen needs, handed down rather than fetched again. */
export interface ChangesContext {
  jobId: string
  versions: VersionsState | null
  canEdit: boolean
  remaining: number
  outOfEdits: boolean
  extra: Awaited<ReturnType<typeof api.extraEdits>> | null
  outcome: { tone: 'ok' | 'warn' | 'error'; title: string; body: string } | null
  error: string | null
  running: boolean
  editStartedAt: number | null
  stage: GenerationStage | null
  liveHtml: string
  report: VerificationReport | null
  request: string
  setRequest: React.Dispatch<React.SetStateAction<string>>
  submitEdit: () => Promise<void>
  requestRef: React.RefObject<HTMLTextAreaElement>
  setCaretToEnd: React.MutableRefObject<boolean>
  rollback: (version: number) => Promise<void>
  setDevice: React.Dispatch<React.SetStateAction<Device>>
}

/**
 * Add a photo without going back to the start.
 *
 * The upload route never had a status gate, and an edit rebuilds the photo list from the
 * database every time, so a photo added here is described to the model on the very next
 * request, by assetId, alongside the ones from intake. The only thing missing was a way to
 * put the file there.
 *
 * Sits above the wording help rather than inside it: somebody who has just taken a photo on a
 * job is looking for somewhere to put it, not reading an accordion.
 */
function PhotosTask({ jobId }: { jobId: string }) {
  const [photos, setPhotos] = useState<AssetRecord[] | null>(null)
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await api.getJob(jobId)
        if (cancelled) return
        setPhotos(res.assets.filter((a) => a.kind === 'photo').sort((a, b) => a.sortOrder - b.sortOrder))
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [jobId])

  const count = photos?.length ?? 0

  return (
    <div className="rounded-lg border border-ice-200">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
        aria-expanded={open}
        aria-controls="editor-photos"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-sm font-medium text-ice-700">
          Your photos{photos ? ` (${count})` : ''}
        </span>
        <span aria-hidden="true" className="shrink-0 text-base leading-none text-ice-500">
          {open ? '−' : '+'}
        </span>
      </button>
      {open ? (
        <div id="editor-photos" className="space-y-3 border-t border-ice-200 px-3 py-3">
          {failed ? (
            <Banner tone="error">
              Your photos could not be loaded just now. Reload the page and try again.
            </Banner>
          ) : photos === null ? (
            <p className="field-hint">Loading your photos…</p>
          ) : (
            <>
              <PhotoUploader jobId={jobId} photos={photos} onChange={setPhotos} />
              <p className="field-hint">
                Add a photo here, then ask for it below by what it shows or what the file is
                called, for example &ldquo;put the new decking photo in the gallery&rdquo;. To change
                the big photo at the top, press <strong>Make hero</strong> on the one you want.
              </p>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The chat, the checklist and the history, as their own route.
 *
 * Everything comes down through the outlet rather than being fetched again, so opening and
 * closing it costs no requests and the counter here cannot disagree with the one in the nav.
 *
 * On a phone it is a sheet over the preview, below the nav so the counter and the way back stay
 * on screen. From lg up it is the right hand column it always was.
 */
export function ChangesPanel() {
  const {
    jobId,
    versions,
    canEdit,
    outOfEdits,
    extra,
    outcome,
    error,
    running,
    editStartedAt,
    stage,
    liveHtml,
    report,
    request,
    setRequest,
    submitEdit,
    requestRef,
    setCaretToEnd,
    rollback,
    setDevice,
  } = useOutletContext<ChangesContext>()

  // Closed by default. It is the tallest thing in the column and the rarest thing wanted.
  const [historyOpen, setHistoryOpen] = useState(false)

  /*
   * The chips now sit at the top of the column and the box they fill is in the footer, so this is
   * shared rather than defined inline where the chips are rendered.
   */
  const appendToRequest = (line: string) => {
    setRequest((r) => {
      // Was /s+$/, which matches a trailing letter "s", not trailing whitespace: it quietly ate
      // the last character of anything ending in one ("change the colours" became "change the
      // colour"). [\s,]+ is what was meant, and it also swallows a comma the customer typed
      // themselves so we never produce ", ,".
      const base = r.replace(/[\s,]+$/, '')
      // line keeps its own trailing space where it has one, so "...it should be " puts the cursor
      // exactly where the number goes.
      return base ? `${base}, ${line}` : line
    })
    /*
     * Straight into the box with the cursor at the end. A flag rather than requestAnimationFrame:
     * rAF is tied to frame production, so it never runs in a tab that is not compositing and the
     * caret silently stays put. The layout effect runs on commit, which is when the text exists.
     *
     * It also scrolls the box into view now that it is a column away rather than directly below
     * the chips, so tapping a chip still shows you where the words went.
     */
    setCaretToEnd.current = true
  }

  // absolute inset-0 against the row, not fixed with a top offset. A magic number for the nav
  // height was wrong the moment a nav label wrapped to two lines, and it covered the very tabs it
  // was measured from. The row already starts below the nav, so filling it needs no number.
  return (
    <aside className="absolute inset-0 z-20 flex flex-col border-t border-ice-200 bg-white lg:static lg:z-auto lg:h-full lg:w-[420px] lg:border-t-0 lg:border-l">
      {/*
        No wordmark and no second counter. The nav above carries both the name of this screen and
        the count, and repeating the count in two places is how they end up disagreeing.
      */}
      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {/* Said on load, before anything is typed. */}
        {!canEdit ? (
          <Banner tone="warn" title="Changes are switched off on this install">
            <p>{versions?.capability.reason}</p>
            <p className="mt-2">
              Everything else works: you can look through your website, go back to an earlier version, go live,
              or take your files.
            </p>
          </Banner>
        ) : null}

        {versions?.held ? (
          <Banner tone="warn" title="This version is being looked at">
            <p>
              The last change did not pass all our checks, so one of our team has been notified. Your earlier
              versions are safe and you can roll back to any of them below.
            </p>
          </Banner>
        ) : null}

        {outcome ? (
          <Banner tone={outcome.tone} title={outcome.title}>
            <p>{outcome.body}</p>
          </Banner>
        ) : null}

        {error ? <Banner tone="error">{error}</Banner> : null}

        {running ? (
          <div className="space-y-2">
            {editStartedAt ? <BuildProgress stage={stage} done={false} startedAt={editStartedAt} /> : null}
            {/*
              The raw markup panel that used to sit here is gone. It showed a tradesperson the
              document scrolling past as text, which told them nothing and looked like an error
              log. The same bytes now render as their actual page on the main stage.
            */}
            {liveHtml ? (
              <p className="field-hint">Your website is being redrawn on the left as it is written.</p>
            ) : null}
          </div>
        ) : null}

        {report && !report.passed ? (
          <Banner tone="warn" title="Some checks did not pass">
            <ul className="list-inside list-disc">
              {[...report.static, ...report.render]
                .filter((c) => c.status === 'fail')
                .map((c) => (
                  <li key={c.id}>{c.label}</li>
                ))}
            </ul>
          </Banner>
        ) : null}

        {outOfEdits && canEdit ? (
          <Banner tone="info" title="You have used all your included changes">
            <p>You can still go live whenever you are ready.</p>
            {/*
              RUNNING OUT IS A PROMPT TO FINISH, NOT A TILL. There is no longer anything to sell
              here: the extra-edits product was removed (D66) and the answer to "I have used my
              ten" is that going live starts a fresh ten a month.
            */}
            <p className="mt-2">
              {extra?.detail ??
                'You have used the changes that come with the build. Going live starts a fresh ten a month.'}
            </p>
            <p className="mt-2">
              {extra?.ifStuck ??
                'If you send another change through anyway it will still be made, and we will be in touch about it.'}
            </p>
          </Banner>
        ) : null}

        {/*
          ABOVE THE CHECKLIST ON PURPOSE. The checklist is advice and ticking none of it still
          lets them go live. This is the one task on this page that actually blocks it, so it
          sits above the optional list rather than inside it.
        */}
        {/*
          FIRST IN THE COLUMN once the site is live. Everything else on this page is about the
          draft they are working on; this is the only thing that is about the website the public
          can actually see, which makes it the thing a worried customer is looking for.
          Renders nothing at all before go-live.
        */}
        <LivePanel jobId={jobId} rollback={rollback} />

        {/*
          THE TWO THINGS THEY CAME HERE TO USE, AT THE TOP.

          This column had grown into a stack of five cards, and the two at the top were both status
          rather than action: a green tick saying the enquiry inbox was sorted, and a second go-live
          button duplicating the one in the footer six inches below. A customer opening the changes
          panel is there to change something or to check what is left before going live, so those
          are what the top of the column is now for.

          The go-live card is gone rather than moved. There were two buttons to the same screen on
          one panel; the footer keeps its one, beside the change button, where the two decisions
          sit together.
        */}
        <ReadyChecklist jobId={jobId} onWantMobile={() => setDevice('mobile')} />

        {/*
          Above the wording help, because somebody who has just taken a photo on a job is
          looking for somewhere to put it rather than reading an accordion.
        */}
        <PhotosTask jobId={jobId} />

        <CommonEdits onPick={appendToRequest} />

        <InboxTask jobId={jobId} />

        {/*
          BEHIND A DISCLOSURE, AND LAST. Version history is for the rare moment somebody wants a
          previous version back. Open, it was the tallest thing in the column and pushed everything
          else off the screen. The count stays on the closed header so it is still findable.
        */}
        <section className="rounded-lg border border-ice-200">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
            aria-expanded={historyOpen}
            aria-controls="version-history"
            onClick={() => setHistoryOpen((v) => !v)}
          >
            <span className="text-sm font-medium text-ice-700">
              Earlier versions{versions?.builds.length ? ` (${versions.builds.length})` : ''}
            </span>
            <span aria-hidden="true" className="shrink-0 text-base leading-none text-ice-500">
              {historyOpen ? '−' : '+'}
            </span>
          </button>
          {historyOpen ? (
          <div id="version-history" className="border-t border-ice-100 p-3">
          <ul className="space-y-2">
            {versions?.builds.map((b) => {
              const edit = versions.edits.find((e) => e.versionTo === b.version)
              return (
                <li
                  key={b.version}
                  className={`rounded-lg border px-3 py-2 text-xs ${
                    b.version === versions.currentVersion ? 'border-ice-700 bg-ice-100' : 'border-ice-200'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">
                      Version {b.version}
                      {b.version === versions.currentVersion ? ' (showing)' : ''}
                    </span>
                    {b.version !== versions.currentVersion ? (
                      <button
                        className="font-medium text-ice-700 underline disabled:opacity-50"
                        disabled={running}
                        onClick={() => rollback(b.version)}
                      >
                        Go back to this
                      </button>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-ice-500">
                    {new Date(b.createdAt).toLocaleString('en-AU')} | {Math.round((b.bytes ?? 0) / 1024)}KB
                    {b.passed ? '' : ' | did not pass checks'}
                  </p>
                  {edit?.prompt ? <p className="mt-1 text-ice-700">&ldquo;{edit.prompt}&rdquo;</p> : null}
                </li>
              )
            })}
          </ul>
          <p className="field-hint mt-2">Going back to an earlier version does not use up a change.</p>
          </div>
          ) : null}
        </section>
      </div>

      <footer className="border-t border-ice-100 px-5 py-4">
        <label className="mb-1.5 block text-base font-semibold" htmlFor="editRequest">
          What needs changing?
        </label>
        {/*
          MADE TO LOOK LIKE SOMETHING YOU TYPE IN.

          A tester did not recognise this as somewhere to type. It already had a label, so that was
          not the gap: it was a shallow box, four lines tall, carrying a very long grey placeholder.
          A placeholder that runs to three lines stops reading as a prompt and starts reading as
          body text, and the box under it looked like a panel rather than a field.

          Taller, so it reads as somewhere to write a sentence rather than paste a word, and with a
          visible focus ring so tapping it does something obvious.
        */}
        <textarea
          id="editRequest"
          ref={requestRef}
          /*
           * BIGGER, AND OBVIOUSLY A FIELD. A tester did not recognise this as somewhere to type,
           * and it is the one control the whole panel exists for. Taller again, a heavier border
           * so it reads as a box rather than a panel, and a white ground against the tinted footer
           * so the writing surface is the lightest thing in the column.
           */
          className="input min-h-44 border-2 border-ice-300 bg-white text-base focus:border-polar-accent focus:ring-2 disabled:cursor-not-allowed disabled:bg-ice-50"
          value={request}
          disabled={running || !canEdit}
          onChange={(e) => setRequest(e.target.value)}
          placeholder={
            canEdit
              ? 'Send as many changes as you like in one go, it only counts as one. For example: make the header darker, change the phone number to 0400 111 222, and swap the second and third services around.'
              : 'Changes are switched off on this install. See the note above.'
          }
        />
        {canEdit ? (
          // The style chosen in the intake is on the plan, so a restyle is a normal edit. Worth
          // saying, because nobody guesses that the whole look is on the table.
          <p className="field-hint">
            You can change the overall look here too. Something like "can it feel more upmarket"
            or "this is too plain, make it tougher" counts as one change like any other.
          </p>
        ) : null}
        {/*
          TWO BUTTONS, NOT A BUTTON AND A FOOTNOTE.

          This was `text-xs ... underline` beside a solid accent button. A customer who had
          finished editing had to spot 12px of grey text to find the way out, and the loudest
          thing on the screen kept telling them to make another change. They are different jobs,
          so they get different colours - accent blue for "keep editing", near-black for "I am
          done" - but the same visual weight, because either one can be what the person came for.
        */}
        <div className="mt-3 flex items-center justify-between gap-3">
          <Link className="btn-primary" to={`/golive/${jobId}`}>
            I'm ready to go live →
          </Link>
          <button
            className="btn-accent"
            onClick={submitEdit}
            disabled={running || !canEdit || request.trim().length < 3}
          >
            {running ? 'Working' : 'Make this change →'}
          </button>
        </div>
      </footer>
    </aside>
  )
}
