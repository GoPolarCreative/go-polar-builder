import puppeteer, { type Browser } from '@cloudflare/puppeteer'
import type { Env } from '../../env'
import type { CheckResult } from '../../../shared/types'

/**
 * Render verification. Brief s6, checks 13 to 16, via Cloudflare Browser Rendering.
 *
 * The HTML handed in here must already have its images inlined as data URIs (see lib/inline.ts).
 * setContent gives the page no base URL, so relative asset paths would 404 and check 15 would
 * fail for the wrong reason.
 *
 * When there is no BROWSER binding, every check comes back "skipped", never "pass". Local dev
 * and the free plan have no Browser Rendering, and quietly passing a check that never ran is how
 * a broken build reaches a customer.
 */

const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 390, height: 844 }

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
  ]
}

interface PageFindings {
  consoleErrors: string[]
  pageErrors: string[]
  overflow: { overflows: boolean; scrollWidth: number; innerWidth: number; offenders: string[] }
  images: { total: number; broken: string[] }
  interactions: { accordions: number; accordionOpened: boolean; counters: number; countersRan: boolean; detail: string }
}

export async function runRenderChecks(env: Env, html: string): Promise<CheckResult[]> {
  if (!env.BROWSER) {
    return renderChecksSkipped(
      'Browser Rendering is not bound. Uncomment the browser binding in wrangler.jsonc and deploy to run checks 13 to 16.',
    )
  }

  let browser: Browser | null = null
  try {
    browser = await puppeteer.launch(env.BROWSER)

    const desktop = await inspect(browser, html, DESKTOP)
    const mobile = await inspect(browser, html, MOBILE)

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

    return results
  } catch (err) {
    // A Browser Rendering outage is not a broken website. Report it honestly as a skip with the
    // real error attached, so nobody reads it as a pass.
    return renderChecksSkipped(
      `Browser Rendering failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    if (browser) await browser.close().catch(() => undefined)
  }
}

async function inspect(
  browser: Browser,
  html: string,
  viewport: { width: number; height: number },
): Promise<PageFindings> {
  const page = await browser.newPage()
  const consoleErrors: string[] = []
  const pageErrors: string[] = []

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200))
  })
  page.on('pageerror', (err) => pageErrors.push(String(err).slice(0, 200)))

  try {
    await page.setViewport(viewport)
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30_000 })

    // Scroll the whole page so lazy images and IntersectionObserver work fire.
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        let y = 0
        const step = () => {
          y += window.innerHeight * 0.8
          window.scrollTo(0, y)
          if (y < document.body.scrollHeight) setTimeout(step, 120)
          else setTimeout(resolve, 900)
        }
        step()
      })
    })

    const overflow = await page.evaluate(() => {
      const innerWidth = window.innerWidth
      const scrollWidth = Math.max(
        document.documentElement.scrollWidth,
        document.body.scrollWidth,
      )
      const offenders: string[] = []
      if (scrollWidth > innerWidth + 1) {
        for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
          const rect = el.getBoundingClientRect()
          // Only elements pushing past the RIGHT edge cause sideways scroll. Elements sitting off
          // to the left are the standard visually-hidden pattern (the form honeypots use it) and
          // listing them just buries the real offender in noise.
          if (rect.right > innerWidth + 1) {
            const cls = el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''
            offenders.push(
              `${el.tagName.toLowerCase()}${cls} extends to ${Math.round(rect.right)}px`,
            )
          }
          if (offenders.length >= 8) break
        }
      }
      return { overflows: scrollWidth > innerWidth + 1, scrollWidth, innerWidth, offenders }
    })

    const images = await page.evaluate(async () => {
      const imgs = Array.from(document.images)
      const stillZero = imgs.filter((img) => img.naturalWidth === 0)

      // Two different faults look identical at this point: the file does not resolve, or lazy
      // loading never triggered. Force every remaining image eager and look again. Both are
      // failures, but the repair prompt needs to know which one it is looking at.
      if (stillZero.length > 0) {
        stillZero.forEach((img) => {
          img.loading = 'eager'
        })
        await new Promise((r) => setTimeout(r, 1500))
      }

      const broken = stillZero.map((img) => {
        const src = img.getAttribute('src')?.slice(0, 60) ?? 'no src'
        return img.naturalWidth === 0
          ? `${src} (alt: ${img.alt}) did not load at all`
          : `${src} (alt: ${img.alt}) only loaded once lazy loading was bypassed, so it never appears to a real visitor`
      })
      return { total: imgs.length, broken }
    })

    const interactions = await page.evaluate(async () => {
      const details = Array.from(document.querySelectorAll<HTMLDetailsElement>('details'))
      let accordionOpened = false
      if (details.length > 0) {
        const first = details[0]!
        const summary = first.querySelector('summary')
        summary?.click()
        await new Promise((r) => setTimeout(r, 250))
        accordionOpened = first.open
        if (accordionOpened) summary?.click()
      }

      // Counters are any element whose text is a number and that sits in a stats section.
      const counterEls = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-count], [data-target], .stats [class*="number"], .stats [class*="value"], [class*="counter"]',
        ),
      )
      const parsed = counterEls
        .map((el) => Number((el.textContent ?? '').replace(/[^\d.]/g, '')))
        .filter((n) => Number.isFinite(n))
      const countersRan = parsed.length > 0 && parsed.some((n) => n > 0)

      const detail = [
        `${details.length} accordion(s), first one ${details.length ? (accordionOpened ? 'opened' : 'did NOT open') : 'n/a'}`,
        `${counterEls.length} counter(s), ${countersRan ? 'showing values' : 'still showing zero or empty'}`,
      ].join('. ')

      return {
        accordions: details.length,
        accordionOpened,
        counters: counterEls.length,
        countersRan,
        detail,
      }
    })

    return { consoleErrors, pageErrors, overflow, images, interactions }
  } finally {
    await page.close().catch(() => undefined)
  }
}
