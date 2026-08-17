import type { Env } from '../env'
import type { AssetRecord, CheckResult, VerificationReport } from '../../shared/types'
import type { BuildFacts } from '../../shared/plan'
import { runStaticChecks } from './checks/static'
import { runRenderChecks, renderChecksSkipped } from './checks/render'
import { inlineAssets } from './inline'
import { callMessage, isTruncated, stripCodeFence, MAX_TOKENS_BUILD } from './anthropic'
import { REPAIR_SYSTEM } from '../prompts/houseRules'

/** Brief s6: maximum 2 repair attempts, then hold the job and notify Chris. */
export const MAX_REPAIR_ATTEMPTS = 2

export function reportPassed(statics: CheckResult[], render: CheckResult[]): boolean {
  return [...statics, ...render].every((c) => c.status !== 'fail')
}

export async function verify(
  env: Env,
  html: string,
  facts: BuildFacts,
  assets: AssetRecord[],
  opts: { runRender?: boolean } = {},
): Promise<VerificationReport> {
  const statics = await runStaticChecks(html, facts)

  let render: CheckResult[]
  let renderSkipped = false

  if (opts.runRender === false) {
    render = renderChecksSkipped('Render checks were not requested for this pass.')
    renderSkipped = true
  } else if (!env.BROWSER) {
    render = renderChecksSkipped(
      'Browser Rendering is not bound in this environment, so checks 13 to 16 did not run.',
    )
    renderSkipped = true
  } else {
    // The headless browser gets the inlined copy: setContent has no base URL, so relative asset
    // paths would 404 and the images check would fail for the wrong reason.
    const inlined = await inlineAssets(env, html, facts, assets)
    render = await runRenderChecks(env, inlined.html)
    renderSkipped = render.every((c) => c.status === 'skipped')
  }

  return {
    passed: reportPassed(statics, render),
    ranAt: new Date().toISOString(),
    static: statics,
    render,
    renderSkipped,
    repairPasses: 0,
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
 * attempts. If it still fails after that, the caller holds the job: the customer never sees a
 * broken build (brief s6).
 */
export async function verifyAndRepair(
  env: Env,
  args: {
    html: string
    facts: BuildFacts
    assets: AssetRecord[]
    onEvent?: (e:
      | { type: 'verification'; report: VerificationReport }
      | { type: 'repair'; attempt: number; failing: string[] }) => void | Promise<void>
  },
): Promise<RepairOutcome> {
  let html = args.html
  let report = await verify(env, html, args.facts, args.assets)
  await args.onEvent?.({ type: 'verification', report })

  let attempts = 0
  while (!report.passed && attempts < MAX_REPAIR_ATTEMPTS) {
    attempts++
    const failing = failingChecks(report)
    await args.onEvent?.({ type: 'repair', attempt: attempts, failing: failing.map((f) => f.label) })

    let repaired: string
    try {
      const result = await callMessage(env, {
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
    report = await verify(env, html, args.facts, args.assets)
    report.repairPasses = attempts
    await args.onEvent?.({ type: 'verification', report })
  }

  report.repairPasses = attempts
  return { html, report, attempts, held: !report.passed }
}

/** One-line summary for the events table and for the GHL notification in Phase 6. */
export function summarise(report: VerificationReport): string {
  const all = [...report.static, ...report.render]
  const failed = all.filter((c) => c.status === 'fail')
  const skippedCount = all.filter((c) => c.status === 'skipped').length
  if (failed.length === 0) {
    return `All ${all.length - skippedCount} checks passed${skippedCount ? `, ${skippedCount} skipped` : ''}.`
  }
  return `${failed.length} check(s) failed: ${failed.map((f) => f.label).join(', ')}.`
}
