/**
 * Mobile audit at a real width, run in a real browser, across every page of every export.
 *
 *   node scratchpad/mobile-audit.mjs
 *
 * Reasoning about the CSS is what let these through in the first place. This drives Chrome via
 * playwright-core, which is already a dependency for the render checks, sets a phone viewport, and
 * measures what the layout actually did.
 */
import { chromium } from 'playwright-core'
import { readdirSync, statSync, writeFileSync } from 'node:fs'

const ROOT = 'C:/Users/Chris/Desktop/go-polar-sites'
const BASE = 'http://localhost:4400'
const WIDTHS = [320, 360, 390, 414]

const walk = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const full = `${dir}/${n}`
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('index.html') ? [full] : []
  })

const MEASURE = () => {
  const vw = innerWidth
  // Text nodes only: an inline SVG icon beside text otherwise counts as an extra line.
  const lineTops = (el) => {
    const tops = new Set()
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) {
      if (!n.textContent || !n.textContent.trim()) continue
      const r = document.createRange()
      r.selectNodeContents(n)
      for (const x of Array.from(r.getClientRects())) if (x.width > 0 && x.height > 0) tops.add(Math.round(x.top))
    }
    return [...tops]
  }
  // A styled fragment inside a sentence is not a squeezed label.
  const isFragment = (el) => {
    const t = (n) => n && n.nodeType === 3 && !!(n.textContent || '').trim()
    return t(el.previousSibling) || t(el.nextSibling)
  }
  const nm = (e) => e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).trim().split(/\s+/)[0] : '')
  const out = { vw, scrollW: document.documentElement.scrollWidth }
  out.overflowX = out.scrollW > vw + 1

  out.outside = [...document.querySelectorAll('body *')]
    .filter((e) => {
      const r = e.getBoundingClientRect()
      return r.width > 0 && (r.right > vw + 1 || r.left < -1) && getComputedStyle(e).position !== 'fixed'
    })
    .filter((e) => e.getBoundingClientRect().left > -100)
    .map((e) => ({ n: nm(e), r: Math.round(e.getBoundingClientRect().right), txt: (e.textContent || '').trim().slice(0, 24) }))
    .slice(0, 8)

  out.clipped = [...document.querySelectorAll('body *')]
    .filter((e) => e.children.length === 0 && e.scrollWidth > e.clientWidth + 1 && /hidden|clip/.test(getComputedStyle(e).overflowX))
    .map((e) => ({ n: nm(e), sw: e.scrollWidth, cw: e.clientWidth, txt: (e.textContent || '').trim().slice(0, 30) }))
    .slice(0, 8)

  const thin = []
  for (const el of document.querySelectorAll('p,h1,h2,h3,h4,li,span,a,button,strong,em,small,b,div,label')) {
    if (el.children.length) continue
    const t = (el.textContent || '').trim()
    if (t.length < 3) continue
    const lines = lineTops(el).length
    const words = t.split(/\s+/).filter(Boolean).length
    if (lines < 2 || words < 2) continue
    if (isFragment(el)) continue
    const wpl = words / lines
    if (wpl < 2) thin.push({ wpl: +wpl.toFixed(2), lines, words, n: nm(el), txt: t.slice(0, 40) })
  }
  thin.sort((a, b) => a.wpl - b.wpl)
  out.thinCount = thin.length
  out.thin = thin.slice(0, 6)

  out.wrappedHeadings = [...document.querySelectorAll('h1,h2,h3,h4')]
    .map((h) => {
      const t = (h.textContent || '').trim()
      return { words: t.split(/\s+/).length, lines: lineTops(h).length, txt: t.slice(0, 40) }
    })
    .filter((h) => h.words <= 3 && h.lines > 1)

  out.wrappedButtons = [...document.querySelectorAll('a[class*=btn],button,.btn,[class*=call]')]
    .map((e) => {
      const t = (e.textContent || '').trim()
      if (!t) return null
      const r = e.getBoundingClientRect()
      return { txt: t.slice(0, 24), lines: lineTops(e).length, h: Math.round(r.height), ws: getComputedStyle(e).whiteSpace }
    })
    .filter((b) => b && b.lines > 1)

  out.multiColGrids = [...document.querySelectorAll('body *')]
    .filter((e) => getComputedStyle(e).display === 'grid')
    .map((e) => ({ n: nm(e), cols: getComputedStyle(e).gridTemplateColumns }))
    .filter((g) => g.cols.split(/\s+/).filter(Boolean).length > 1 && !/mobile|sticky/i.test(g.n))

  const bar = document.querySelector('[class*=mobile-bar],[class*=mobile-sticky]')
  const foot = document.querySelector('footer')
  out.bar = bar && foot
    ? { h: Math.round(bar.getBoundingClientRect().height), footPad: getComputedStyle(foot).paddingBottom,
        covers: parseFloat(getComputedStyle(foot).paddingBottom) < bar.getBoundingClientRect().height - 1 }
    : 'none'

  // Tap targets under 44px, the accessibility floor a thumb needs.
  out.smallTaps = [...document.querySelectorAll('a,button')]
    .map((e) => { const r = e.getBoundingClientRect(); return { n: nm(e), w: Math.round(r.width), h: Math.round(r.height), txt: (e.textContent||'').trim().slice(0,20) } })
    .filter((e) => e.h > 0 && e.h < 40 && e.w > 0)
    .slice(0, 6)

  return out
}

const pages = walk(ROOT)
  .map((f) => f.slice(ROOT.length + 1).replace(/\\/g, '/'))
  .filter((p) => !p.includes('PREVIEW'))

const browser = await chromium.launch({ channel: 'chrome' })
const report = []
for (const width of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  for (const p of pages) {
    await page.goto(`${BASE}/${p}`, { waitUntil: 'networkidle' })
    const r = await page.evaluate(MEASURE)
    report.push({ width, page: p, ...r })
  }
  await ctx.close()
}
await browser.close()

writeFileSync('C:/Users/Chris/AppData/Local/Temp/claude/C--Users-Chris-Desktop/23d4e26d-e28b-4202-912f-9d6619ca961d/scratchpad/mobile-report.json', JSON.stringify(report, null, 1))

// Summary
for (const w of WIDTHS) {
  console.log(`\n===== ${w}px =====`)
  for (const r of report.filter((x) => x.width === w)) {
    const bits = []
    if (r.overflowX) bits.push(`OVERFLOW ${r.scrollW}`)
    if (r.outside.length) bits.push(`outside:${r.outside.length}`)
    if (r.clipped.length) bits.push(`clipped:${r.clipped.length}`)
    if (r.thinCount) bits.push(`thin:${r.thinCount}`)
    if (r.wrappedHeadings.length) bits.push(`wrapHead:${r.wrappedHeadings.length}`)
    if (r.wrappedButtons.length) bits.push(`wrapBtn:${r.wrappedButtons.length}`)
    if (r.multiColGrids.length) bits.push(`grids:${r.multiColGrids.length}`)
    if (r.bar !== 'none' && r.bar.covers) bits.push('BAR COVERS FOOTER')
    if (r.smallTaps.length) bits.push(`smallTap:${r.smallTaps.length}`)
    console.log(`  ${bits.length ? bits.join('  ') : 'clean'}   ${r.page}`)
  }
}
console.log('\nfull detail in scratchpad/mobile-report.json')
