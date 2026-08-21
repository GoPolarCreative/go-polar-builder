import { useEffect, useState } from 'react'
import type { GenerationStage } from '../../shared/types'

/**
 * What the customer sees while the machine works, on both screens that make them wait.
 *
 * This lived on the build screen only. An edit rebuilds the entire document and takes just as
 * long, and it showed a bare spinning dial for the whole of it, which is indistinguishable from
 * the thing having hung. Same component, both places.
 */
export const STAGE_COPY: Record<GenerationStage, string> = {
  planning: 'Working out what goes on the page',
  building: 'Writing your website',
  assembling: 'Putting it together section by section',
  verifying: 'Checking every line of it',
  repairing: 'Fixing what did not pass',
  complete: 'Done',
  held: 'Held. A human is looking at it.',
}

/**
 * The order the build actually moves through, and how far along each stage means it is.
 *
 * The bar advances on stages the server has genuinely reached, never on a timer. A bar that
 * crawls forward on its own is a lie that gets found out at minute nine, and this screen is where
 * the customer decides whether the thing they paid for is working.
 *
 * It stops short of 100 until the build is really done, because arriving at full and then sitting
 * there is worse than arriving at eighty and moving.
 */
const STAGE_ORDER: GenerationStage[] = ['planning', 'building', 'assembling', 'verifying', 'repairing']

function progressFor(stage: GenerationStage | null, done: boolean): number {
  if (done) return 100
  if (!stage) return 4
  if (stage === 'complete') return 100
  if (stage === 'held') return 100
  const index = STAGE_ORDER.indexOf(stage)
  if (index < 0) return 8
  // Spread across 8..88 so the first stage looks started and the last does not look finished.
  return Math.round(8 + (index / STAGE_ORDER.length) * 80)
}

function elapsedLabel(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
}

/**
 * What the customer sees while it works.
 *
 * The old copy said it takes a minute or two. It takes six to twelve, and somebody who was told
 * two minutes starts refreshing at three — which on this screen means losing the stream and
 * believing it broke.
 */
export function BuildProgress(props: { stage: GenerationStage | null; done: boolean; startedAt: number }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const pct = progressFor(props.stage, props.done)
  const seconds = Math.max(0, Math.floor((now - props.startedAt) / 1000))

  return (
    <div className="mb-6 rounded-xl border border-ice-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{props.stage ? STAGE_COPY[props.stage] : 'Starting'}</p>
        <p className="text-sm text-ice-600">{elapsedLabel(seconds)} so far</p>
      </div>

      <div
        className="mt-3 h-2 w-full overflow-hidden rounded-full bg-ice-100"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Build progress"
      >
        <div
          className="h-full rounded-full bg-accent transition-all duration-700 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      <ol className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
        {STAGE_ORDER.filter((s) => s !== 'repairing' || props.stage === 'repairing').map((s) => {
          const reached = props.done || STAGE_ORDER.indexOf(s) <= STAGE_ORDER.indexOf(props.stage ?? 'planning')
          return (
            <li key={s} className={reached ? 'font-medium text-ice-900' : 'text-ice-400'}>
              {reached ? '\u2713 ' : ''}
              {STAGE_COPY[s]}
            </li>
          )
        })}
      </ol>

      <p className="field-hint mt-3">
        This takes about five to ten minutes. Leave this screen open and do not refresh it. It is
        writing your copy, compressing and arranging your photos, and building your search data.
      </p>
    </div>
  )
}
