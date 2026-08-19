import type { CheckResult, VerificationReport } from '../../shared/types'
import type { BuildFacts } from '../../shared/plan'
import { measurePageWeight, runStaticChecks } from './checks/static'
import { renderChecksSkipped, runRenderChecks } from './checks/render'
import { inlineAssets } from './inline'
import { callMessage, isTruncated, stripCodeFence, MAX_TOKENS_BUILD } from './anthropic'
import { REPAIR_SYSTEM } from '../prompts/houseRules'
import { config } from '../config'

/** Brief s6: maximum 2 repair attempts, then hold the job and notify Chris. */
export const MAX_REPAIR_ATTEMPTS = 2

/**
 * A warning is not a failure. Page weight over the target is worth telling somebody about, but
 * it does not justify holding a job that is otherwise correct.
 */
export function reportPassed(statics: CheckResult[], render: CheckResult[]): boolean {
  return [...statics, ...render].every((c) => c.status !== 'fail')
}

export async function verify(
  html: string,
  facts: BuildFacts,
  opts: { runRender?: boolean } = {},
): Promise<VerificationReport> {
  const statics = await runStaticChecks(html, facts)

  let render: CheckResult[]
  let renderSkipped = false

  if (opts.runRender === false || config().renderDriver === 'none') {
    render = renderChecksSkipped('Render checks were not requested for this pass.')
    renderSkipped = true
  } else {
    // The browser gets the inlined copy: setContent has no base URL, so relative asset paths
    // would 404 and the images check would fail for the wrong reason.
    const inlined = await inlineAssets(html, facts)
    render = await runRenderChecks(inlined.html)
    renderSkipped = render.every((c) => c.status === 'skipped')
  }

  return {
    passed: reportPassed(statics, render),
    ranAt: new Date().toISOString(),
    static: statics,
    render,
    renderSkipped,
    repairPasses: 0,
    pageWeightBytes: measurePageWeight(html, facts),
  }
}

export function failingChecks(report: VerificationReport): CheckResult[] {
  return [...report.static, ...report.render].filter((c) => c.status === 'fail')
}

/** The failing-check list, formatted for the repair prompt. Evidence included, verbatim. */
export function repairBrief(failing: CheckResult[]): string {
  return failing
    .map((c, i) => {
      const evidence = c.evidence?.length
        ? `\n   Evidence:\n${c.evidence.map((e) => `     - ${e}`).join('\n')}`
        : ''
      return `${i + 1}. FAILED: ${c.label}\n   ${c.detail ?? ''}${evidence}`
    })
    .join('\n\n')
}

export interface RepairOutcome {
  html: string
  report: VerificationReport
  attempts: number
  held: boolean
}

/**
 * Verify, and on failure send the failing check list back for a repair pass. Maximum two
 * attempts. If it still fails, the caller holds the job: the customer never sees a broken build.
 */
export async function verifyAndRepair(args: {
  html: string
  facts: BuildFacts
  onEvent?: (
    e:
      | { type: 'verification'; report: VerificationReport }
      | { type: 'repair'; attempt: number; failing: string[] },
  ) => void | Promise<void>
}): Promise<RepairOutcome> {
  let html = args.html
  let report = await verify(html, args.facts)
  await args.onEvent?.({ type: 'verification', report })

  let attempts = 0
  while (!report.passed && attempts < MAX_REPAIR_ATTEMPTS) {
    attempts++
    const failing = failingChecks(report)
    await args.onEvent?.({ type: 'repair', attempt: attempts, failing: failing.map((f) => f.label) })

    let repaired: string
    try {
      const result = await callMessage({
        system: [{ type: 'text', text: REPAIR_SYSTEM }],
        messages: [
          {
            role: 'user',
            content: `The following automated checks failed. Fix exactly these and nothing else.\n\n${repairBrief(
              failing,
            )}\n\n# THE DOCUMENT\n\n${html}`,
          },
        ],
        maxTokens: MAX_TOKENS_BUILD,
        temperature: 0.1,
      })
      repaired = stripCodeFence(result.text)

      if (isTruncated(repaired, result.stopReason)) {
        // A truncated repair is worse than the original. Keep what we had and let the loop
        // record the failure honestly.
        console.error('repair pass returned truncated HTML, discarding')
        break
      }
    } catch (err) {
      console.error('repair pass failed', err)
      break
    }

    html = repaired
    report = await verify(html, args.facts)
    report.repairPasses = attempts
    await args.onEvent?.({ type: 'verification', report })
  }

  report.repairPasses = attempts
  return { html, report, attempts, held: !report.passed }
}

/** One-line summary for the events table and the GHL notification. */
export function summarise(report: VerificationReport): string {
  const all = [...report.static, ...report.render]
  const failed = all.filter((c) => c.status === 'fail')
  const warned = all.filter((c) => c.status === 'warn')
  const skippedCount = all.filter((c) => c.status === 'skipped').length

  if (failed.length === 0) {
    const warnNote = warned.length > 0 ? `, ${warned.length} warning(s)` : ''
    return `All ${all.length - skippedCount} checks passed${skippedCount ? `, ${skippedCount} skipped` : ''}${warnNote}.`
  }
  return `${failed.length} check(s) failed: ${failed.map((f) => f.label).join(', ')}.`
}

// -----------------------------------------------------------------------------------------------
// Page sets
// -----------------------------------------------------------------------------------------------

export interface PageVerification {
  path: string
  url: string
  title: string
  report: VerificationReport
}

export interface SetVerification {
  /** True only when every page passed. A set is as good as its worst page. */
  passed: boolean
  pages: PageVerification[]
  /** The heaviest page, which is the one that matters for the weight budget. */
  heaviestBytes: number
  failures: Array<{ path: string; checkId: string; detail: string }>
}

/**
 * Verify every page in a set.
 *
 * EVERY CHECK IS PER PAGE. "Exactly one h1" and "page weight within budget" are meaningless at the
 * level of a set: a set with three h1s across three pages is correct, and a set whose home page is
 * 1MB and whose service page is 6MB has one page that fails. So each page is verified on its own
 * and the set passes only if all of them do.
 *
 * The failure this exists to prevent: a multi-page build reporting success because the home page
 * was checked and the rest were not.
 */
export async function verifySet(
  pages: Array<{ path: string; url: string; title: string; html: string }>,
  facts: BuildFacts,
  opts: { runRender?: boolean } = {},
): Promise<SetVerification> {
  const results: PageVerification[] = []

  for (const page of pages) {
    const report = await verify(page.html, facts, opts)
    results.push({ path: page.path, url: page.url, title: page.title, report })
  }

  const failures = results.flatMap((p) =>
    [...p.report.static, ...p.report.render]
      .filter((c) => c.status === 'fail')
      .map((c) => ({ path: p.path, checkId: c.id, detail: c.detail ?? '' })),
  )

  return {
    passed: results.length > 0 && results.every((p) => p.report.passed),
    pages: results,
    heaviestBytes: Math.max(0, ...results.map((p) => p.report.pageWeightBytes)),
    failures,
  }
}
