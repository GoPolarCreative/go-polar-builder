import { NavLink } from 'react-router-dom'

/**
 * Moving between the three screens of a finished build, and the edit counter.
 *
 * REAL LINKS, NOT TABS THAT SWAP A PANEL. Back goes back, a URL can be sent to someone, and the
 * screen a customer is looking at has a name. The old build screen stacked the preview, the
 * checklist and the chat into one column, which on a 390px phone meant the website they had just
 * paid for was a slice at the top of a very long scroll.
 *
 * NOT A HAMBURGER. Three destinations is not enough to hide, and a hamburger on a screen this
 * small buys nothing but a tap. They sit in a row along the top, always visible, with the current
 * one filled in.
 *
 * THE COUNTER IS HERE BECAUSE THE BRIEF WANTS IT VISIBLE AT ALL TIMES, and "all times" now means
 * three routes rather than one screen. Putting it in the nav is the only way it cannot be scrolled
 * away from on any of them.
 */
export function JobNav({
  jobId,
  remaining,
  allowed,
}: {
  jobId: string
  remaining: number | null
  allowed: number | null
}) {
  const tab = ({ isActive }: { isActive: boolean }) =>
    [
      'flex-1 rounded-lg px-2 py-2 text-center text-[13px] font-semibold transition-colors',
      isActive ? 'bg-ice-900 text-white' : 'bg-ice-100 text-ice-700 hover:bg-ice-200',
    ].join(' ')

  return (
    <nav className="flex items-center gap-2 border-b border-ice-200 bg-white px-3 py-2">
      <div className="flex min-w-0 flex-1 gap-1.5">
        <NavLink to={`/answers/${jobId}`} className={tab}>
          Answers
        </NavLink>
        {/* end, or /preview would stay lit while the changes panel is open. */}
        <NavLink to={`/preview/${jobId}`} end className={tab}>
          Website
        </NavLink>
        <NavLink to={`/preview/${jobId}/changes`} className={tab}>
          Changes
        </NavLink>
      </div>

      {remaining !== null && allowed !== null ? (
        <span
          className={[
            'shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums',
            remaining === 0 ? 'bg-amber-100 text-amber-900' : 'bg-ice-100 text-ice-700',
          ].join(' ')}
          title={`${remaining} of your ${allowed} included changes are left`}
        >
          {remaining}/{allowed} left
        </span>
      ) : null}
    </nav>
  )
}
