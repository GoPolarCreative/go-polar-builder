import type { CheckResult } from '../../../shared/types.js'
import { config } from '../../config.js'

/**
 * Render verification. Brief s6, checks 13 to 16.
 *
 * Cloudflare Browser Rendering has no Vercel equivalent, so the browser sits behind a driver
 * interface with two implementations and room for a third:
 *
 *   playwright - playwright-core driving Chromium. On Vercel that is @sparticuz/chromium, a
 *                Lambda-sized build; locally it is whichever Chrome or Edge is already installed.
 *   hosted     - a remote headless browser over CDP (Browserless and friends), for when the
 *                bundle size or the cold start of the bundled Chromium is not worth it.
 *
 * Whatever is available, checks 1 to 12 and 17 run regardless: they need no browser at all.
 * When no driver can run, these four report "skipped", never "pass". Quietly passing a check
 * that never ran is how a broken build reaches a customer.
 *
 * The HTML handed in here must already have its images inlined as data URIs (lib/inline.ts).
 * setContent gives the page no base URL, so relative asset paths would 404 and the images check
 * would fail for the wrong reason.
 */

const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 390, height: 844 }

export interface PageFindings {
  consoleErrors: string[]
  pageErrors: string[]
  overflow: { overflows: boolean; scrollWidth: number; innerWidth: number; offenders: string[] }
  images: { total: number; broken: string[] }
  interactions: {
    accordions: number
    accordionOpened: boolean
    counters: number
    countersRan: boolean
    detail: string
  }
  /**
   * Text squeezed into a column too narrow to read, measured at 390px.
   *
   * `thin` is anything averaging under two words a line. `wrappedHeadings` is a heading of three
   * words or fewer that wraps at all. See check 22 for why these two numbers and not others.
   */
  squeeze: {
    thin: string[]
    wrappedHeadings: string[]
  }
  /**
   * Anything inside the header painting below it while nothing is hovered, measured at 1440px.
   *
   * A nav dropdown left without a resting state hangs open from page load, covering the link
   * beside it and sitting on the hero. See check 23.
   */
  headerOverhang: string[]
}

export interface RenderDriver {
  readonly name: string
  /** Cheap probe. Never launches a browser. */
  available(): Promise<{ ok: true } | { ok: false; reason: string }>
  inspect(html: string, viewport: { width: number; height: number }): Promise<PageFindings>
  dispose(): Promise<void>
}

const skipped = (id: CheckResult['id'], label: string, detail: string): CheckResult => ({
  id,
  label,
  status: 'skipped',
  detail,
})

export function renderChecksSkipped(reason: string): CheckResult[] {
  return [
    skipped('renders_clean', 'Loads with no console errors at 1440px and 390px', reason),
    skipped('no_horizontal_overflow', 'No horizontal overflow at 390px', reason),
    skipped('images_load', 'Every image loads after scrolling to the bottom', reason),
    skipped('interactions_work', 'Accordions open and counters run', reason),
    skipped('text_not_squeezed', 'No text squeezed into a column too narrow to read at 390px', reason),
    skipped('header_closed_at_rest', 'Nothing in the header hangs open before it is asked for', reason),
  ]
}

// ---------------------------------------------------------------------------------------------
// The browser-side probe. One function, shared by every driver, so all of them measure the same
// things in the same way.
// ---------------------------------------------------------------------------------------------

export const PROBE_SCRIPT = `async () => {
  const scrollAll = async () => {
    await new Promise((resolve) => {
      let y = 0
      const step = () => {
        y += window.innerHeight * 0.8
        window.scrollTo(0, y)
        if (y < document.body.scrollHeight) setTimeout(step, 120)
        else setTimeout(resolve, 900)
      }
      step()
    })
  }
  await scrollAll()

  const innerWidth = window.innerWidth
  const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
  const offenders = []
  if (scrollWidth > innerWidth + 1) {
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const rect = el.getBoundingClientRect()
      // Only elements pushing past the RIGHT edge cause sideways scroll. Elements off to the
      // left are the standard visually-hidden pattern, and listing them buries the real culprit.
      if (rect.right > innerWidth + 1) {
        const cls = typeof el.className === 'string' && el.className.trim()
          ? '.' + el.className.trim().split(/\\s+/).join('.')
          : ''
        offenders.push(el.tagName.toLowerCase() + cls + ' extends to ' + Math.round(rect.right) + 'px')
      }
      if (offenders.length >= 8) break
    }
  }

  const imgs = Array.from(document.images)
  const stillZero = imgs.filter((img) => img.naturalWidth === 0)
  if (stillZero.length > 0) {
    // Two faults look identical here: the file does not resolve, or lazy loading never fired.
    // Force the remainder eager and look again, so the repair prompt knows which one it is.
    stillZero.forEach((img) => { img.loading = 'eager' })
    await new Promise((r) => setTimeout(r, 1500))
  }
  const broken = stillZero.map((img) => {
    const src = (img.getAttribute('src') || 'no src').slice(0, 60)
    return img.naturalWidth === 0
      ? src + ' (alt: ' + img.alt + ') did not load at all'
      : src + ' (alt: ' + img.alt + ') only loaded once lazy loading was bypassed, so it never appears to a real visitor'
  })

  const details = Array.from(document.querySelectorAll('details'))
  let accordionOpened = false
  if (details.length > 0) {
    const first = details[0]
    const summary = first.querySelector('summary')
    if (summary) summary.click()
    await new Promise((r) => setTimeout(r, 250))
    accordionOpened = first.open
    if (accordionOpened && summary) summary.click()
  }

  const counterEls = Array.from(document.querySelectorAll('[data-count], [data-target], [class*="counter"]'))
  const parsed = counterEls
    .map((el) => Number((el.textContent || '').replace(/[^\\d.]/g, '')))
    .filter((n) => Number.isFinite(n))
  const countersRan = parsed.length > 0 && parsed.some((n) => n > 0)

  /*
   * How many words the reader gets per line.
   *
   * Line count comes from Range.getClientRects, which returns one rect per line box, so this is
   * the layout the browser actually produced rather than an estimate from character counts.
   *
   * ONLY NON-INLINE ELEMENTS ARE MEASURED. An <em> inside a heading is two words on its own and
   * routinely falls onto a second line as part of a longer sentence; that is normal typesetting,
   * not a squeeze. A <strong> that the CSS has made display:block IS the whole label, and when
   * that averages under two words a line the column is too narrow. Measuring only block-level
   * boxes is what separates the two without a list of exceptions.
   */
  /*
   * Lines are counted over the element's TEXT NODES only, never the element box.
   *
   * A button that is an inline SVG icon beside a phone number returns two rectangles at different
   * tops, one for the icon and one for the words, and counting those as two lines reported
   * "0424 111 201" as wrapped when white-space:nowrap was holding it on one line perfectly well.
   * Ranging over the text nodes measures what the reader reads.
   */
  const lineTops = (el) => {
    const tops = new Set()
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      if (!node.textContent || !node.textContent.trim()) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      for (const r of Array.from(range.getClientRects())) {
        if (r.width > 0 && r.height > 0) tops.add(Math.round(r.top))
      }
    }
    return tops.size
  }

  /*
   * A styled fragment inside a sentence is not a squeezed label.
   *
   * The two-tone headings wrap their tail in <em>: "Cockroach Control, <em>done properly</em>".
   * That <em> is two words and routinely lands on a second line as the heading wraps, which is
   * ordinary typesetting. A <strong> that IS the whole label in a trust strip has no text beside
   * it. The difference is whether a text node sits next to the element, so that is the test,
   * rather than a list of tag names to ignore.
   */
  const isSentenceFragment = (el) => {
    const hasTextSibling = (n) => n && n.nodeType === 3 && !!(n.textContent || '').trim()
    return hasTextSibling(el.previousSibling) || hasTextSibling(el.nextSibling)
  }

  const thin = []
  const wrappedHeadings = []
  for (const el of Array.from(document.querySelectorAll('p,h1,h2,h3,h4,li,span,a,button,strong,em,small,b,div,label'))) {
    if (el.children.length > 0) continue
    const text = (el.textContent || '').trim()
    if (text.length < 3) continue
    if (getComputedStyle(el).display === 'inline') continue
    if (isSentenceFragment(el)) continue
    const lines = lineTops(el)
    const words = text.split(/\\s+/).filter(Boolean).length
    if (lines < 2 || words < 2) continue
    const perLine = words / lines
    if (perLine < 2) {
      thin.push(perLine.toFixed(2) + ' words per line over ' + lines + ' lines: "' + text.slice(0, 60) + '"')
    }
  }
  for (const h of Array.from(document.querySelectorAll('h1,h2,h3,h4'))) {
    const text = (h.textContent || '').trim()
    const words = text.split(/\\s+/).filter(Boolean).length
    if (words > 0 && words <= 3 && lineTops(h) > 1) {
      wrappedHeadings.push(h.tagName.toLowerCase() + ' of ' + words + ' word(s) wraps: "' + text.slice(0, 60) + '"')
    }
  }

  /*
   * A CLOSED MENU IS CLOSED. Nothing has been hovered or focused at this point, so anything inside
   * the header that paints below the header's own bottom edge is showing when it should not be.
   *
   * Measured as geometry rather than by looking for a class named "dropdown", because the markup is
   * the model's to choose and the invariant is not: at rest the header occupies the header.
   *
   * The mobile panel is excluded by the viewport, being hidden above the breakpoint, and a fixed
   * sticky bar is excluded because it is not a descendant of the header. The tolerance absorbs a
   * shadow or a border sitting a pixel or two proud.
   */
  const headerOverhang = []
  const headerEl = document.querySelector('header, .site-header, [class*="site-header"]')
  if (headerEl) {
    const hb = headerEl.getBoundingClientRect()
    for (const el of Array.from(headerEl.querySelectorAll('*'))) {
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
      if (cs.position === 'fixed') continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.bottom > hb.bottom + 4) {
        const cls = typeof el.className === 'string' && el.className.trim()
          ? '.' + el.className.trim().split(/\\s+/)[0]
          : ''
        const name = el.tagName.toLowerCase() + cls
        const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40)
        headerOverhang.push(
          name + ' hangs ' + Math.round(r.bottom - hb.bottom) + 'px below the header at rest: "' + text + '"',
        )
      }
      if (headerOverhang.length >= 6) break
    }
  }

  return {
    overflow: { overflows: scrollWidth > innerWidth + 1, scrollWidth, innerWidth, offenders },
    images: { total: imgs.length, broken },
    squeeze: { thin, wrappedHeadings },
    headerOverhang,
    interactions: {
      accordions: details.length,
      accordionOpened,
      counters: counterEls.length,
      countersRan,
      detail:
        details.length + ' accordion(s), first one ' +
        (details.length ? (accordionOpened ? 'opened' : 'did NOT open') : 'n/a') + '. ' +
        counterEls.length + ' counter(s), ' +
        (countersRan ? 'showing values' : 'still showing zero or empty'),
    },
  }
}`

// ---------------------------------------------------------------------------------------------
// Playwright driver
// ---------------------------------------------------------------------------------------------

class PlaywrightDriver implements RenderDriver {
  readonly name = 'playwright'
  private browser: import('playwright-core').Browser | null = null

  private async executable(): Promise<{ path?: string; channel?: string; args: string[] } | null> {
    if (process.env.CHROME_PATH) return { path: process.env.CHROME_PATH, args: [] }

    // On Vercel there is no system browser, so a Lambda-sized Chromium ships with the function.
    if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
      try {
        const chromium = (await import('@sparticuz/chromium')).default
        return { path: await chromium.executablePath(), args: chromium.args }
      } catch {
        return null
      }
    }

    // Locally, use whatever browser is already installed rather than downloading one.
    const { existsSync } = await import('node:fs')
    const candidates =
      process.platform === 'win32'
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          ]
        : process.platform === 'darwin'
          ? [
              '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
              '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            ]
          : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']

    for (const candidate of candidates) {
      if (existsSync(candidate)) return { path: candidate, args: [] }
    }
    return null
  }

  async available(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const exe = await this.executable()
    if (exe) return { ok: true }
    return {
      ok: false,
      reason:
        'No Chromium available. On Vercel this comes from @sparticuz/chromium; locally it uses an installed Chrome or Edge. Set CHROME_PATH to a browser binary, or set RENDER_DRIVER=hosted with BROWSERLESS_URL.',
    }
  }

  private async launch(): Promise<import('playwright-core').Browser> {
    if (this.browser) return this.browser
    const exe = await this.executable()
    if (!exe) throw new Error('No Chromium executable available')

    const { chromium } = await import('playwright-core')
    this.browser = await chromium.launch({
      executablePath: exe.path,
      args: [...exe.args, '--no-sandbox', '--disable-dev-shm-usage'],
      headless: true,
    })
    return this.browser
  }

  async inspect(html: string, viewport: { width: number; height: number }): Promise<PageFindings> {
    const browser = await this.launch()
    const context = await browser.newContext({ viewport })
    const page = await context.newPage()

    const consoleErrors: string[] = []
    const pageErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200))
    })
    page.on('pageerror', (err) => pageErrors.push(String(err).slice(0, 200)))

    try {
      await page.setContent(html, { waitUntil: 'networkidle', timeout: 45_000 })
      const findings = (await page.evaluate(`(${PROBE_SCRIPT})()`)) as Omit<
        PageFindings,
        'consoleErrors' | 'pageErrors'
      >
      return { ...findings, consoleErrors, pageErrors }
    } finally {
      await context.close().catch(() => undefined)
    }
  }

  async dispose(): Promise<void> {
    await this.browser?.close().catch(() => undefined)
    this.browser = null
  }
}

// ---------------------------------------------------------------------------------------------
// Hosted driver: a remote Chromium over CDP. Same probe, same findings.
// ---------------------------------------------------------------------------------------------

class HostedDriver implements RenderDriver {
  readonly name = 'hosted'
  private browser: import('playwright-core').Browser | null = null

  constructor(private readonly endpoint: string) {}

  async available(): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.endpoint
      ? { ok: true }
      : {
          ok: false,
          reason: 'RENDER_DRIVER=hosted but BROWSERLESS_URL is not set, so there is nothing to connect to.',
        }
  }

  private async connect(): Promise<import('playwright-core').Browser> {
    if (this.browser) return this.browser
    const { chromium } = await import('playwright-core')
    this.browser = await chromium.connectOverCDP(this.endpoint)
    return this.browser
  }

  async inspect(html: string, viewport: { width: number; height: number }): Promise<PageFindings> {
    const browser = await this.connect()
    const context = await browser.newContext({ viewport })
    const page = await context.newPage()

    const consoleErrors: string[] = []
    const pageErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200))
    })
    page.on('pageerror', (err) => pageErrors.push(String(err).slice(0, 200)))

    try {
      await page.setContent(html, { waitUntil: 'networkidle', timeout: 45_000 })
      const findings = (await page.evaluate(`(${PROBE_SCRIPT})()`)) as Omit<
        PageFindings,
        'consoleErrors' | 'pageErrors'
      >
      return { ...findings, consoleErrors, pageErrors }
    } finally {
      await context.close().catch(() => undefined)
    }
  }

  async dispose(): Promise<void> {
    await this.browser?.close().catch(() => undefined)
    this.browser = null
  }
}

export function createRenderDriver(): RenderDriver | null {
  const cfg = config()
  if (cfg.renderDriver === 'none') return null
  if (cfg.renderDriver === 'hosted') return new HostedDriver(cfg.browserlessUrl ?? '')
  return new PlaywrightDriver()
}

// ---------------------------------------------------------------------------------------------

export async function runRenderChecks(html: string, driver = createRenderDriver()): Promise<CheckResult[]> {
  if (!driver) {
    return renderChecksSkipped('RENDER_DRIVER is set to none, so checks 13 to 16 did not run.')
  }

  const availability = await driver.available()
  if (!availability.ok) return renderChecksSkipped(availability.reason)

  try {
    const desktop = await driver.inspect(html, DESKTOP)
    const mobile = await driver.inspect(html, MOBILE)

    const consoleErrors = [
      ...desktop.consoleErrors.map((e) => `1440px: ${e}`),
      ...desktop.pageErrors.map((e) => `1440px uncaught: ${e}`),
      ...mobile.consoleErrors.map((e) => `390px: ${e}`),
      ...mobile.pageErrors.map((e) => `390px uncaught: ${e}`),
    ]

    const results: CheckResult[] = []

    results.push(
      consoleErrors.length === 0
        ? { id: 'renders_clean', label: 'Loads with no console errors at 1440px and 390px', status: 'pass' }
        : {
            id: 'renders_clean',
            label: 'Loads with no console errors at 1440px and 390px',
            status: 'fail',
            detail: `${consoleErrors.length} console error(s) during load.`,
            evidence: consoleErrors.slice(0, 8),
          },
    )

    results.push(
      !mobile.overflow.overflows
        ? { id: 'no_horizontal_overflow', label: 'No horizontal overflow at 390px', status: 'pass' }
        : {
            id: 'no_horizontal_overflow',
            label: 'No horizontal overflow at 390px',
            status: 'fail',
            detail: `The page is ${mobile.overflow.scrollWidth}px wide in a ${mobile.overflow.innerWidth}px viewport, so it scrolls sideways on a phone.`,
            evidence: mobile.overflow.offenders.slice(0, 8),
          },
    )

    // Check 15 runs on mobile after the full scroll, because lazy images below the fold report
    // naturalWidth 0 until they enter the viewport. The scroll is the whole point of the check.
    results.push(
      mobile.images.broken.length === 0
        ? { id: 'images_load', label: 'Every image loads after scrolling to the bottom', status: 'pass' }
        : {
            id: 'images_load',
            label: 'Every image loads after scrolling to the bottom',
            status: 'fail',
            detail: `${mobile.images.broken.length} of ${mobile.images.total} images did not load.`,
            evidence: mobile.images.broken.slice(0, 8),
          },
    )

    const i = desktop.interactions
    const interactionsOk =
      (i.accordions === 0 || i.accordionOpened) && (i.counters === 0 || i.countersRan)
    results.push(
      interactionsOk
        ? { id: 'interactions_work', label: 'Accordions open and counters run', status: 'pass' }
        : {
            id: 'interactions_work',
            label: 'Accordions open and counters run',
            status: 'fail',
            detail: i.detail,
            evidence: [i.detail],
          },
    )

    /*
     * CHECK 22. Text squeezed into a column too narrow to read.
     *
     * WHY THIS IS SEPARATE FROM CHECK 14. Overflow asks whether the page is wider than the phone.
     * A two column grid at 390px is not wider than the phone; it just leaves each column about
     * seventy pixels of text, so the words wrap instead of overflowing and check 14 passes. On
     * Pest-Aside that produced "Same-day service" as two words over three lines and "No obligation
     * pricing before any work starts" as seven words over six. Every check passed. Chris opened it
     * on a phone and saw a trust strip taking most of a screen.
     *
     * THE TWO NUMBERS.
     *
     * Under two words a line, averaged over the element. One word per line is the failure everyone
     * recognises, and two is far enough above it to leave normal typesetting alone: ordinary body
     * copy on a phone runs six to nine words a line, and even a tight button label manages three.
     * Nothing legitimate on these sites sits between one and two.
     *
     * A heading of three words or fewer that wraps at all. Averages hide short headings, because
     * three words over two lines is 1.5 and only just trips, while two words over two lines is
     * exactly 1.0 and would be caught anyway. Stating it directly makes the intent readable: a
     * three word heading has no business breaking on a phone.
     *
     * Both are measured from Range.getClientRects, which returns one rectangle per line box, so
     * this is the layout the browser produced rather than a guess from character counts.
     */
    const squeeze = mobile.squeeze
    const squeezeEvidence = [...squeeze.wrappedHeadings, ...squeeze.thin]
    results.push(
      squeezeEvidence.length === 0
        ? {
            id: 'text_not_squeezed',
            label: 'No text squeezed into a column too narrow to read at 390px',
            status: 'pass',
          }
        : {
            id: 'text_not_squeezed',
            label: 'No text squeezed into a column too narrow to read at 390px',
            status: 'fail',
            detail:
              `${squeezeEvidence.length} block(s) of text are in a column too narrow for them at 390px. ` +
              `This is not horizontal overflow, the words wrap instead, so the page still fits the screen ` +
              `while being unreadable. Usually a grid that is still two columns on a phone, or a label that ` +
              `needs white-space:nowrap.`,
            evidence: squeezeEvidence.slice(0, 8),
          },
    )

    /*
     * CHECK 23. A closed menu is closed.
     *
     * A fencing site shipped with the Services dropdown hanging open from page load: a white panel
     * under the nav covering the FAQ link beside it and sitting on top of the hero headline. The
     * model had written the panel and the hover rule and left out the resting state, which is the
     * one line that makes a dropdown a dropdown rather than a permanent box.
     *
     * Nothing else saw it. It is not overflow, the page is not too wide, no text is squeezed and
     * the markup is perfectly valid. It is simply open when it should be shut, which is only
     * visible to something that looks at where things are drawn.
     *
     * Measured as geometry at 1440px with nothing hovered: no descendant of the header may paint
     * below the header. That holds whatever the model called its classes, and it is exactly the
     * property a visitor experiences.
     */
    results.push(
      desktop.headerOverhang.length === 0
        ? {
            id: 'header_closed_at_rest',
            label: 'Nothing in the header hangs open before it is asked for',
            status: 'pass',
          }
        : {
            id: 'header_closed_at_rest',
            label: 'Nothing in the header hangs open before it is asked for',
            status: 'fail',
            detail:
              `${desktop.headerOverhang.length} element(s) inside the header are drawn below it before anything has been ` +
              `hovered or focused. A dropdown needs a resting state that genuinely hides it: display:none, or opacity:0 ` +
              `with visibility:hidden and pointer-events:none, shown on :hover and :focus-within of the nav item that ` +
              `owns it. As it stands the menu covers the link beside it and sits on the hero.`,
            evidence: desktop.headerOverhang.slice(0, 6),
          },
    )

    return results
  } catch (err) {
    // A browser outage is not a broken website. Report it honestly as a skip with the real error
    // attached, so nobody reads it as a pass.
    return renderChecksSkipped(
      `Render checks could not run: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    await driver.dispose()
  }
}
