import { describe, expect, it } from 'vitest'
import { KLAVIYO_METRICS } from '../server/lib/klaviyo'

/**
 * The metric names, pinned.
 *
 * A Klaviyo flow is bound to a metric by its NAME, typed into Klaviyo by hand. Renaming one here
 * does not break a build, does not fail a type check and does not throw at runtime: the event
 * simply lands under a new metric that no flow is listening to, and the customer stops getting
 * the email. Nothing in the product would look wrong.
 *
 * So the names are asserted literally. If a change here fails this test, the question is not
 * "how do I make the test pass" - it is "which live flow do I have to rename in Klaviyo first".
 *
 * KLAVIYO-FLOWS.md documents what each one carries. Keep the two in step.
 */

describe('every metric name a live Klaviyo flow depends on', () => {
  it('matches exactly what is documented in KLAVIYO-FLOWS.md', () => {
    expect(KLAVIYO_METRICS).toEqual({
      build_purchased: 'Website Build Purchased',
      link_requested: 'Website Link Requested',
      build_complete: 'Website Build Complete',
      go_live_requested: 'Website Go Live Requested',
      files_ready: 'Website Files Ready',
      intake_abandoned: 'Website Intake Abandoned',
      editing_stalled: 'Website Editing Stalled',
      go_live_started: 'Website Go Live Started',
      login_code: 'Website Login Code',
      hosting_ending: 'Website Hosting Ending',
      site_live: 'Website Is Live',
      operator_alert: 'Operator Alert',
    })
  })

  it('has a distinct name for every metric, because two keys sharing one name merge two flows', () => {
    const names = Object.values(KLAVIYO_METRICS)
    expect(new Set(names).size).toBe(names.length)
  })

  it('carries the site-live metric the post-live nurture is built on', () => {
    expect(KLAVIYO_METRICS.site_live).toBe('Website Is Live')
  })
})
