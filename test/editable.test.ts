import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderSite } from '../server/lib/render/site'
import { makeFixture } from './fixtures/site'

/**
 * Things a customer can reasonably ask for have to be settable.
 *
 * This file exists because of a pattern rather than a bug. Every few days someone asked for
 * something ordinary - the wording above a heading, a field on the enquiry form, which photo a
 * section shows, how dark a tint is - and it turned out to be written into the renderer with no
 * way to reach it. Each time it was fixed as one more field, and the next request found the next
 * gap. The editor reported success either way, because some other part of the request had landed.
 *
 * So these are guards on the SHAPE of the renderer, not on one field. They fail when a new value
 * is hardcoded where a customer could be expected to want it changed, which is the only way to
 * stop the pattern rather than keep paying for it.
 */

const SITE = readFileSync('server/lib/render/site.ts', 'utf8')

describe('no section picks its own photo by position', () => {
  /*
   * hero was photos[0], about was photos[1], the closing band photos[2]. Fine as defaults, and
   * they still are - but each call site indexed the array itself, so there was nowhere for "use
   * the team photo in the who we are section" to go. pickPhoto is now the single answer to "which
   * photo is this", so a new section cannot invent a fourth way.
   */
  it('facts.photos is indexed in exactly one place', () => {
    const direct = [...SITE.matchAll(/facts\.photos\[[^\]]+\]/g)].map((m) => m[0])
    // pickPhoto itself contains the one legitimate index.
    expect(
      direct.length,
      `facts.photos is indexed ${direct.length} times: ${direct.join(', ')}. ` +
        'Sections should call pickPhoto so the choice is reachable from the plan.',
    ).toBeLessThanOrEqual(2)
  })

  it('pickPhoto exists and takes a chosen id', () => {
    expect(SITE).toContain('function pickPhoto(')
    expect(SITE).toContain('chosen: string | undefined')
  })
})

describe('a tint over a photo is a token, not a number in the stylesheet', () => {
  const { plan, facts } = makeFixture({})

  it('the closing band reads its opacity from a token', () => {
    expect(SITE).toContain('.band__scrim{position:absolute;inset:0;background:var(--dark-block);opacity:var(--band-scrim);}')
  })

  it('and that token is declared in :root, so check 1 still holds', () => {
    expect(renderSite(plan, facts)).toMatch(/--band-scrim:[0-9.]+;/)
  })
})

describe('setting each of them actually moves the page', () => {
  const { plan, facts } = makeFixture({})
  const withLayout = (layout: Record<string, unknown>) =>
    renderSite({ ...plan, layout: { ...(plan.layout ?? {}), ...layout } }, facts)

  const photoIn = (html: string, marker: string) => {
    const i = html.indexOf(marker)
    const m = /assets\/(photo-[0-9]+)/.exec(html.slice(i, i + 1400))
    return m ? m[1] : null
  }

  it('the about section shows the photo it is given', () => {
    const wanted = facts.photos[2]!
    const before = photoIn(renderSite(plan, facts), 'data-gp="about"')
    const after = photoIn(withLayout({ aboutPhotoAssetId: wanted.assetId }), 'data-gp="about"')
    expect(after).not.toEqual(before)
    expect(wanted.webJpeg).toContain(after!)
  })

  it('the closing band shows the photo it is given', () => {
    const wanted = facts.photos[0]!
    const after = photoIn(withLayout({ ctaBandPhotoAssetId: wanted.assetId }), 'data-gp="cta_band"')
    expect(wanted.webJpeg).toContain(after!)
  })

  it('an id that matches nothing falls back rather than emptying the section', () => {
    const after = photoIn(withLayout({ aboutPhotoAssetId: 'ast_deleted' }), 'data-gp="about"')
    expect(after).toEqual(photoIn(renderSite(plan, facts), 'data-gp="about"'))
  })

  it('the band overlay changes', () => {
    expect(withLayout({ ctaBandOverlay: 0.4 })).toContain('--band-scrim:0.4;')
  })

  it('the hero overlay scales all three stops together', () => {
    const html = withLayout({ heroOverlay: 0.4 })
    const stops = [...html.matchAll(/--scrim-[123]:rgba\(0,0,0,([0-9.]+)\)/g)].map((m) => Number(m[1]))
    expect(stops.length).toBe(3)
    expect(stops[0]).toBeCloseTo(0.4, 2)
    // Still a gradient: the later stops stay lighter than the first.
    expect(stops[1]!).toBeLessThanOrEqual(stops[0]!)
    expect(stops[2]!).toBeLessThanOrEqual(stops[1]!)
  })
})

describe('an overlay cannot be turned down until the words vanish', () => {
  /*
   * White type sits on both of these. "Lighter" means they want to see the photo, not that they
   * want their own headline to disappear, so the schema floors it rather than trusting the number.
   */
  it('the schema refuses an overlay below the floor', async () => {
    const { planSchema } = await import('../shared/plan')
    const { plan } = makeFixture({})
    const tooLight = planSchema.safeParse({ ...plan, layout: { ...plan.layout, ctaBandOverlay: 0 } })
    expect(tooLight.success).toBe(false)
    const ok = planSchema.safeParse({ ...plan, layout: { ...plan.layout, ctaBandOverlay: 0.4 } })
    expect(ok.success).toBe(true)
  })
})
