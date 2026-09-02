import type { AssetRecord, AuditFlag, GenerationEvent } from '../../shared/types.js'
import { formatAuPhone } from '../../shared/phone.js'
import type { BuildFacts, ContentPlan } from '../../shared/plan.js'
import { planSchema } from '../../shared/plan.js'
import { config } from '../config.js'
import type { IntakePayload } from '../../shared/intake.js'
import { TRADE_SCHEMA_TYPE } from '../../shared/trades.js'
import { constraintsFor, resolveDesignStyle } from '../../shared/styles.js'
import { callMessage, extractJson, MAX_TOKENS_PLAN } from './anthropic.js'
import { PLAN_SYSTEM } from '../prompts/houseRules.js'
import { planUserMessage } from '../prompts/messages.js'
import { buildFacts } from './facts.js'
import { isUsablePhoto } from './audit.js'
import { offlinePlan } from './offline.js'
import { renderSite } from './render/site.js'
import { enforcePagesAllowed, slugify } from './pages.js'

export type Emit = (e: GenerationEvent) => void | Promise<void>

// ---------------------------------------------------------------------------------------------
// Call 1 - content plan
// ---------------------------------------------------------------------------------------------

export async function generatePlan(args: {
    intake: IntakePayload
    facts: BuildFacts
    assets: AssetRecord[]
    auditFlags: AuditFlag[]
    emit: Emit
    /**
     * How many pages this job has paid for, home page included. Passed through to the invariants
     * so a first build cannot produce a page nobody bought, exactly as an edit cannot.
     */
    pagesAllowed: number
  },
): Promise<ContentPlan> {
  const { intake, facts, assets, auditFlags, emit } = args
  await emit({ type: 'status', stage: 'planning', message: 'Working out what your site should say' })

  const usablePhotos = assets.filter(isUsablePhoto).sort((a, b) => a.sortOrder - b.sortOrder)
  const photoInventory = facts.photos.map((p, i) => ({
    assetId: p.assetId,
    path: p.webWebp,
    note: describePhoto(usablePhotos[i]),
  }))

  if (config().offlineGeneration) {
    const fixture = offlinePlan(
      intake,
      facts,
      auditFlags,
      usablePhotos.length >= 3 ? photoInventory : [],
    )
    // Validate the fixture against the same schema the model output has to satisfy. If the
    // fixture drifts out of spec, that is a bug in the fixture and it should fail loudly here
    // rather than quietly produce a plan the real path would have rejected.
    const parsed = planSchema.safeParse(fixture)
    if (!parsed.success) {
      throw new Error(
        `Offline fixture plan failed its own schema:\n${parsed.error.issues
          .map((i) => `- ${i.path.join('.')}: ${i.message}`)
          .join('\n')}`,
      )
    }
    return enforcePlanInvariants(parsed.data, intake, facts, usablePhotos, {
      pagesAllowed: args.pagesAllowed,
    })
  }

  const style = resolveDesignStyle({
    chosen: intake.designStyle,
    trade: intake.trade,
    palette: intake.palette,
    description: `${intake.about} ${intake.different ?? ''}`,
  })

  const userMessage = planUserMessage({
    intake,
    facts,
    auditFlags,
    photoInventory,
    usablePhotoCount: usablePhotos.length,
    style: style.resolved,
    pagesAllowed: args.pagesAllowed,
  })

  let lastError = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await callMessage({
      system: [
        // Cached: identical on every build, and it is the expensive half of this call.
        { type: 'text', text: PLAN_SYSTEM, cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
      messages: [
        {
          role: 'user',
          content:
            attempt === 1
              ? userMessage
              : `${userMessage}\n\n# YOUR PREVIOUS ATTEMPT WAS REJECTED\n\n${lastError}\n\nReturn corrected JSON only.`,
        },
      ],
      maxTokens: MAX_TOKENS_PLAN,
      effort: 'medium',
    })

    let candidate: unknown
    try {
      candidate = { ...(JSON.parse(extractJson(result.text)) as object), style }
    } catch (err) {
      lastError = `The response was not valid JSON: ${(err as Error).message}`
      continue
    }

    const parsed = planSchema.safeParse(candidate)
    if (!parsed.success) {
      lastError = parsed.error.issues
        .slice(0, 12)
        .map((i) => `- ${i.path.join('.')}: ${i.message}`)
        .join('\n')
      continue
    }

    return enforcePlanInvariants(parsed.data, intake, facts, usablePhotos, {
      pagesAllowed: args.pagesAllowed,
    })
  }

  throw new Error(`Content plan did not validate after 3 attempts.\n${lastError}`)
}

function describePhoto(asset: AssetRecord | undefined): string {
  if (!asset) return 'client photo'
  const bits: string[] = []
  if (asset.filename) bits.push(`filename "${asset.filename}"`)
  if (asset.width && asset.height) {
    bits.push(asset.width >= asset.height ? 'landscape' : 'portrait')
  }
  return bits.join(', ') || 'client photo'
}

/**
 * Server-authoritative corrections to the plan.
 *
 * The model is good at copy and bad at being trusted with facts, so anything that can be decided
 * from the intake is decided here and overwritten, quietly and every time. This is the last line
 * against a fabricated testimonial or an invented statistic reaching a build.
 */
export function enforcePlanInvariants(
  plan: ContentPlan,
  intake: IntakePayload,
  facts: BuildFacts,
  usablePhotos: AssetRecord[],
  opts: {
    allowStyleChange?: boolean
    pagesAllowed?: number
    /**
     * Whether the plan may say where the business is and where it works.
     *
     * FALSE ON A FIRST BUILD, TRUE ON AN EDIT, AND THE DIFFERENCE IS WHO IS SPEAKING. On a
     * build the model has only the intake, so letting it name suburbs is letting it invent
     * coverage. On an edit the customer has just said "add six suburbs near the ones I
     * service" or "the footer should say Bli Bli, not Palmview", which is the owner correcting
     * the record about their own business.
     *
     * COORDINATES ARE NEVER INCLUDED. A placename is a word the owner can correct; a latitude
     * is not something either of us should be making up. They stay on the intake suburb, and
     * when the name moves away from it that is written into assumptions rather than hidden.
     */
    allowLocationChange?: boolean
    /**
     * Whether the plan may switch a section off.
     *
     * The invariants force the reviews and the gallery ON whenever the material exists, which
     * is right on a build and wrong on an edit: "turn off the photo gallery" was accepted and
     * silently undone. Off is always allowed to win; on still requires the material.
     */
    allowSectionToggle?: boolean
  } = {},
): ContentPlan {
  const out: ContentPlan = structuredClone(plan)

  // PAGES ARE PAID FOR, so the model does not get a vote on how many there are. It can be
  // generous or forgetful; neither changes what the customer bought. Two rules failing in opposite
  // directions: never generate a page nobody paid for, and never silently drop one they did.
  const requested = (intake.ownPageServices ?? []).filter((name) => intake.services.includes(name))

  /*
   * A PAID PAGE IS NEVER DROPPED, EVEN IF THE MODEL FORGOT IT.
   *
   * This used to look each requested service up in the model output and drop it when absent,
   * turning "the model omitted a page" into "the customer silently received fewer pages than
   * they paid for". It did exactly that on every real build, because the plan message never
   * named the services (D55). The message names them now, but a prompt instruction is a hope.
   * This synthesises an entry from the intake so a paid page always exists, and the
   * pages_delivered check in buildSet.ts fails the build if one still goes missing.
   *
   * THE SYNTHESISED COPY INVENTS NOTHING. Every line is the service name, the suburbs from the
   * intake, the years in business and the phone number. It is deliberately plainer than what the
   * model writes, because a thin true page is recoverable with one edit and a fabricated one is
   * not. It also satisfies the plan schema, so nothing downstream has to special-case it.
   */
  /*
   * ONE PAID SERVICE, ONE PAGE, ONE PATH OF ITS OWN.
   *
   * A page's path is built from its slug, and the slug was slugify(service) with nothing checking
   * the result was unique or even non-empty. slugify lowercases, turns "&" into "and" and strips
   * punctuation, so "Roof Repairs" and "roof repairs" both become roof-repairs, as do
   * "Decks & Pergolas" and "Decks and Pergolas", and "Gates" and "Gates!".
   *
   * Two services with one path meant the second page overwrote the first in storage, so a customer
   * who paid for two received one. The entitlement check did not catch it: it looked for
   * services/<slugify(service)>/index.html for each paid service, and both of them found the one
   * surviving page. It reported "2 additional page(s) paid for, 2 built" and passed.
   *
   * A name of pure punctuation slugged to "" and produced services//index.html.
   *
   * So slugs are made unique here, where the plan is settled, rather than being trusted wherever
   * they came from. The first service to claim a slug keeps it; the next gets -2. An empty one
   * falls back to its position, which is ugly and findable rather than broken and silent.
   */
  const claimed = new Set<string>()
  const uniqueSlug = (preferred: string, index: number): string => {
    const base = slugify(preferred) || 'service-' + (index + 1)
    if (!claimed.has(base)) {
      claimed.add(base)
      return base
    }
    let n = 2
    while (claimed.has(base + '-' + n)) n++
    claimed.add(base + '-' + n)
    return base + '-' + n
  }

  out.servicePages = requested.map((service, index) => {
    const existing = out.servicePages.find((sp) => sp.service === service)
    if (existing) return { ...existing, slug: uniqueSlug(existing.slug || service, index) }

    const nearby = intake.suburbsServiced.slice(0, 3).map((s) => s.name)
    const where = nearby.length > 0 ? nearby.join(", ") : intake.baseSuburb.name
    const phone = formatAuPhone(intake.phone)
    const meta = (
      service + " by " + intake.businessName + ", servicing " + where + ". " +
      "Call " + phone + " to talk through the job and get a price."
    ).slice(0, 165)

    return {
      slug: uniqueSlug(service, index),
      service,
      title: (service + " | " + intake.businessName).slice(0, 70),
      metaDescription: meta.length >= 70 ? meta : (meta + " " + intake.businessName + " services " + where + ".").slice(0, 165),
      h1: (service + " in " + intake.baseSuburb.name).slice(0, 90),
      /*
       * TWO PARAGRAPHS, because the schema requires two and the renderer uses the first as
       * the hero subtitle and the rest as the body. Both are still assembled entirely from
       * the intake: the name, the service, the suburbs, the years and the phone number. This
       * is the page nobody wrote, so it stays plainer than anything the model produces.
       */
      intro: [
        intake.businessName + " handles " + service.toLowerCase() + " across " + where +
          ". Ring us and we will talk through what your job actually involves.",
        "We have been working in the area for " + intake.yearsInBusiness +
          " years. Call " + phone + " and we will come and look at the job before quoting on it.",
      ],
      included: [
        "Servicing " + where + " and the surrounding suburbs.",
        intake.yearsInBusiness + " years in business.",
        "Call " + phone + " to talk through the job.",
      ],
    }
  })

  if (opts.pagesAllowed !== undefined) {
    const { plan: trimmed, dropped } = enforcePagesAllowed(out, opts.pagesAllowed)
    out.servicePages = trimmed.servicePages
    for (const service of dropped) {
      out.assumptions.push(
        `A page for "${service}" was asked for but not built: this job has an allowance of ${opts.pagesAllowed} page(s). Buy another additional page and it can be added.`,
      )
    }
  }

  /*
   * Design style.
   *
   * On a first build the style comes from what the customer picked, or from what we picked for
   * them, and the model does not get a vote. During an edit the customer may ask to change the
   * look, so a style the model set is accepted, with the constraints recomputed against their
   * palette either way: a style can never talk its way past the colour rules.
   */
  const fromIntake = resolveDesignStyle({
    chosen: intake.designStyle,
    trade: intake.trade,
    palette: intake.palette,
    description: `${intake.about} ${intake.different ?? ''}`,
  })

  if (opts.allowStyleChange && plan.style && plan.style.resolved !== fromIntake.resolved) {
    out.style = {
      chosen: plan.style.resolved,
      resolved: plan.style.resolved,
      reason: 'Changed during an edit at the request of the customer.',
      constraints: constraintsFor(plan.style.resolved, intake.palette),
    }
  } else {
    out.style = fromIntake
  }

  /*
   * TESTIMONIALS EXIST ONLY IF REAL REVIEWS WERE SUPPLIED, AND ONLY AS SUPPLIED.
   *
   * The forcing runs one way now. No reviews still means no section, because the alternative
   * is inventing them. But "turn off the reviews section" was a request the editor accepted,
   * reported as done, and then undid on the way past: enabled was set back to true because the
   * intake had reviews in it. Having supplied a review is not the same as wanting the section.
   */
  if (intake.reviews.length === 0) {
    out.testimonials = { enabled: false, heading: out.testimonials.heading, items: [] }
  } else {
    if (!opts.allowSectionToggle) out.testimonials.enabled = true
    out.testimonials.items = intake.reviews.map((r) => ({
      quote: r.quote,
      name: r.firstName,
      suburb: r.suburb,
    }))
  }

  // Gallery exists only with 3 or more usable photos, and only referencing real assets.
  const validAssetIds = new Set(facts.photos.map((p) => p.assetId))
  if (usablePhotos.length < 3) {
    out.gallery = { enabled: false, heading: out.gallery.heading, items: [] }
    if (!out.clientToSupply.some((c) => /photo/i.test(c))) {
      out.clientToSupply.push(
        'Three or more job photos so the Our Work gallery can be built. No stock photography is used in the meantime.',
      )
    }
  } else {
    out.gallery.items = out.gallery.items.filter((i) => validAssetIds.has(i.assetId))
    /*
     * Same one-way rule as the reviews. Too few photos still switches it off, because a gallery
     * of two is worse than none. Enough photos no longer switches it back ON over a customer
     * who has asked for it gone.
     */
    const enough = out.gallery.items.length >= 3
    out.gallery.enabled = opts.allowSectionToggle ? out.gallery.enabled && enough : enough
  }

  /*
   * ON A BUILD, THE SUBURBS THE CUSTOMER PICKED. NOT MORE, NOT FEWER.
   *
   * On an EDIT this line is what made "add six suburbs near the ones I service" impossible.
   * The model did the work, declared service_areas, returned the longer list, and this
   * overwrote it from the intake on the way past. Nothing was dropped and nothing failed, so
   * the customer was told the change had been made and the page came back identical.
   *
   * Two days were spent looking at the prompt for that, which was the wrong place: no wording
   * can survive an assignment further down the pipe.
   */
  if (!opts.allowLocationChange) {
    out.serviceAreas.suburbs = intake.suburbsServiced.map((s) => s.name)
  }

  // Schema type and areaServed shape are decided by the trade and the travel radius.
  out.schema.businessType = TRADE_SCHEMA_TYPE[intake.trade]
  out.schema.areaServed =
    intake.travelRadius === 'statewide'
      ? {
          mode: 'geocircle',
          lat: intake.baseSuburb.lat,
          lng: intake.baseSuburb.lng,
          radiusMetres: 250_000,
        }
      : {
          mode: 'city',
          /*
           * From the page, not the intake, once the customer is allowed to change it. The
           * structured data has to say the same thing the visible list says, or the site
           * claims one service area and tells Google another.
           */
          cities: opts.allowLocationChange
            ? out.serviceAreas.suburbs
            : intake.suburbsServiced.map((s) => s.name),
        }

  // sameAs is whatever social links were supplied, nothing else.
  out.schema.sameAs = Object.values(intake.socials).filter((v): v is string => Boolean(v))

  /*
   * THE COORDINATES COME FROM THE BASE SUBURB, ALWAYS. THE NAME IS THE OWNER'S TO CORRECT.
   *
   * "Change Palmview in the footer to Bli Bli" applied, reported success and changed nothing,
   * because this line put the intake suburb back on the way past. It is the same overwrite that
   * swallowed the service areas, one field along.
   *
   * A latitude is different from a name. Nobody should be inventing one, and the edit path has
   * no way to look a suburb up, so the position stays on the suburb the customer picked at
   * intake. When the name moves away from it the site is saying one place and the map data is
   * pointing at another, which is worth recording rather than leaving for somebody to find.
   */
  out.meta.geoRegion = `AU-${intake.baseSuburb.state}`
  out.meta.geoPosition = { lat: intake.baseSuburb.lat, lng: intake.baseSuburb.lng }

  if (!opts.allowLocationChange) {
    out.meta.geoPlacename = intake.baseSuburb.name
  } else if (out.meta.geoPlacename.trim().toLowerCase() !== intake.baseSuburb.name.toLowerCase()) {
    const note =
      `The site now says ${out.meta.geoPlacename} where the intake said ${intake.baseSuburb.name}. ` +
      `The map coordinates still point at ${intake.baseSuburb.name}. If the business has actually ` +
      `moved, change the base suburb rather than only the wording.`
    if (!out.assumptions.includes(note)) out.assumptions.push(note)
  }

  // Every stat has to be a number we can point at in the intake.
  const allowed = new Map<number, string>([
    [intake.yearsInBusiness, 'yearsInBusiness'],
    [intake.suburbsServiced.length, 'suburbsServiced.length'],
    [intake.services.length, 'services.length'],
  ])
  if (intake.reviews.length > 0) allowed.set(intake.reviews.length, 'reviews.length')

  const keptStats = out.stats.filter((s) => allowed.has(s.value))
  out.stats = keptStats.length >= 3 ? keptStats : derivedStats(intake)

  // Logo treatment is an audit decision, not a creative one.
  if (!facts.logo) out.brand.logoTreatment = 'css-logotype'

  // Last-resort scrub. The prompt already forbids it, the checks already catch it, and this
  // stops a plan-level slip from ever reaching the build call.
  if (!intake.freeQuotes) {
    const scrubbed = JSON.parse(
      JSON.stringify(out).replace(/free\s+quotes?/gi, 'quote'),
    ) as ContentPlan
    return scrubbed
  }

  return out
}

function derivedStats(intake: IntakePayload): ContentPlan['stats'] {
  const stats: ContentPlan['stats'] = [
    {
      value: intake.yearsInBusiness,
      suffix: '+',
      label: 'Years in the trade',
      source: 'yearsInBusiness',
    },
    {
      value: intake.suburbsServiced.length,
      suffix: '',
      label: 'Suburbs serviced',
      source: 'suburbsServiced.length',
    },
    {
      value: intake.services.length,
      suffix: '',
      label: 'Services offered',
      source: 'services.length',
    },
  ]
  return stats
}

// ---------------------------------------------------------------------------------------------
// Call 2 - build
// ---------------------------------------------------------------------------------------------

/**
 * The home page.
 *
 * THIS IS A TEMPLATE NOW, AND THE MODEL NO LONGER WRITES HTML.
 *
 * It used to: the whole document came back from a build call steered by three hundred and fifty
 * lines of house rules that already specified the section order, four style specs, the colour
 * system, the type scale, the spacing rhythm, the icons, the form markup and the JavaScript. The
 * model was re-typing a specification we already held, from a description of it, at four hundred
 * seconds a build, and getting it wrong often enough that the repair pass was routine rather than
 * exceptional. Chris counted four generations that looked the same anyway.
 *
 * Everything that went wrong in a fortnight of builds was the model failing to reproduce a rule
 * that was written down: a nav dropdown with no resting state, a missing mobile call bar, a logo
 * drawn at the wrong aspect, escaped tags showing in headings, a two column trust strip on a
 * phone, colour literals outside :root. None of those are possible now, because the markup is not
 * being invented each time.
 *
 * WHAT THE MODEL STILL DOES, AND IT IS THE PART THAT MATTERS: it writes the words. generatePlan
 * produces the headline, the service blurbs, the about copy, the FAQ, the service page copy, all
 * of it specific to this business. That call is untouched. The split is now the sensible one, with
 * the model doing the writing and the renderer doing the building.
 *
 * The four styles are the variation: different fonts, colour, section order, hero shape, section
 * joins and accent face, chosen per job. See shared/styles.ts.
 */
export async function generateHtml(args: { plan: ContentPlan; facts: BuildFacts; emit: Emit },
): Promise<{ html: string; sectioned: boolean }> {
  const { plan, facts, emit } = args

  await emit({ type: 'status', stage: 'building', message: 'Building your site' })

  const html = renderSite(plan, facts)

  /*
   * Streamed in chunks even though it is instant, because the front end is built around watching
   * the page arrive and that is worth keeping. It now arrives in under a second instead of after
   * four minutes of blank screen.
   */
  for (let i = 0; i < html.length; i += 2000) {
    await emit({ type: 'html_chunk', text: html.slice(i, i + 2000) })
  }

  return { html, sectioned: false }
}

/*
 * assembleSections is kept: it is a small pure helper with its own tests, and the edit path may
 * still want it. generateSectioned, which called the model section by section when a single build
 * call ran out of tokens, is gone. A template cannot truncate.
 */
export function assembleSections(parts: string[]): string {
  let html = parts.map((p) => p.trim()).join('\n\n')
  if (!/<\/body>/i.test(html)) html += '\n</body>'
  if (!/<\/html>/i.test(html)) html += '\n</html>'
  return html
}

// ---------------------------------------------------------------------------------------------
// Facts helper re-export, so callers only import from one place
// ---------------------------------------------------------------------------------------------
export { buildFacts }
