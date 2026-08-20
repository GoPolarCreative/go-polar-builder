import type { AssetRecord, AuditFlag, GenerationEvent } from '../../shared/types.js'
import type { BuildFacts, ContentPlan } from '../../shared/plan.js'
import { planSchema } from '../../shared/plan.js'
import { config } from '../config.js'
import type { IntakePayload } from '../../shared/intake.js'
import { TRADE_SCHEMA_TYPE } from '../../shared/trades.js'
import { constraintsFor, resolveDesignStyle } from '../../shared/styles.js'
import {
  callMessage,
  extractJson,
  isTruncated,
  streamMessage,
  stripCodeFence,
  MAX_TOKENS_BUILD,
  MAX_TOKENS_PLAN,
  MAX_TOKENS_SECTION,
} from './anthropic.js'
import { HOUSE_RULES, PLAN_SYSTEM } from '../prompts/houseRules.js'
import {
  SECTION_SPECS,
  buildUserMessage,
  planUserMessage,
  sectionUserMessage,
} from '../prompts/messages.js'
import { buildFacts } from './facts.js'
import { isUsablePhoto } from './audit.js'
import { offlinePlan, offlineHtml } from './offline.js'
import { enforcePagesAllowed } from './pages.js'

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
  })

  let lastError = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await callMessage({
      system: [
        // Cached: identical on every build, and it is the expensive half of this call.
        { type: 'text', text: PLAN_SYSTEM, cache_control: { type: 'ephemeral' } },
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
      effort: 'high',
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
  opts: { allowStyleChange?: boolean; pagesAllowed?: number } = {},
): ContentPlan {
  const out: ContentPlan = structuredClone(plan)

  // PAGES ARE PAID FOR, so the model does not get a vote on how many there are. It can be
  // generous or forgetful; neither changes what the customer bought. Two rules failing in opposite
  // directions: never generate a page nobody paid for, and never silently drop one they did.
  const requested = (intake.ownPageServices ?? []).filter((name) => intake.services.includes(name))
  out.servicePages = requested
    .map((service) => {
      const existing = out.servicePages.find((sp) => sp.service === service)
      return existing ?? null
    })
    .filter((sp): sp is NonNullable<typeof sp> => sp !== null)

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

  // Testimonials exist only if real reviews were supplied, and only as supplied.
  if (intake.reviews.length === 0) {
    out.testimonials = { enabled: false, heading: out.testimonials.heading, items: [] }
  } else {
    out.testimonials.enabled = true
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
    out.gallery.enabled = out.gallery.items.length >= 3
  }

  // Service areas are the suburbs the customer picked. Not more, not fewer.
  out.serviceAreas.suburbs = intake.suburbsServiced.map((s) => s.name)

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
      : { mode: 'city', cities: intake.suburbsServiced.map((s) => s.name) }

  // sameAs is whatever social links were supplied, nothing else.
  out.schema.sameAs = Object.values(intake.socials).filter((v): v is string => Boolean(v))

  // Geo comes from the base suburb, never from the model.
  out.meta.geoRegion = `AU-${intake.baseSuburb.state}`
  out.meta.geoPlacename = intake.baseSuburb.name
  out.meta.geoPosition = { lat: intake.baseSuburb.lat, lng: intake.baseSuburb.lng }

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

export async function generateHtml(args: { plan: ContentPlan; facts: BuildFacts; emit: Emit },
): Promise<{ html: string; sectioned: boolean }> {
  const { plan, facts, emit } = args

  if (config().offlineGeneration) {
    await emit({
      type: 'status',
      stage: 'building',
      message: 'Building your site (offline fixture, no Anthropic key configured)',
    })
    const html = offlineHtml(plan, facts)
    // Stream it out in chunks anyway, so the front end path is exercised exactly as it will be.
    for (let i = 0; i < html.length; i += 2000) {
      await emit({ type: 'html_chunk', text: html.slice(i, i + 2000) })
    }
    return { html, sectioned: false }
  }

  await emit({ type: 'status', stage: 'building', message: 'Building your site' })

  let html = ''
  let stopReason: string | null = null

  for await (const chunk of streamMessage({
    system: [
      // The cached prefix. Large, identical every build. Do not interpolate into HOUSE_RULES.
      { type: 'text', text: HOUSE_RULES, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: buildUserMessage(plan, facts) }],
    maxTokens: MAX_TOKENS_BUILD,
    effort: 'high',
  })) {
    if (chunk.type === 'text') {
      html += chunk.text
      await emit({ type: 'html_chunk', text: chunk.text })
    } else {
      stopReason = chunk.stopReason
    }
  }

  html = stripCodeFence(html)

  if (!isTruncated(html, stopReason)) return { html, sectioned: false }

  // Brief s5: a finished site runs 80-150KB and one response may not carry it. Build the
  // sectioned path from the start, it will be needed.
  await emit({
    type: 'status',
    stage: 'assembling',
    message: 'This one is a big site. Building it section by section',
  })
  const sectioned = await generateSectioned({ plan, facts, emit })
  return { html: sectioned, sectioned: true }
}

/**
 * Sectioned fallback. Part 1 emits the head and the complete stylesheet, then each section is
 * generated against that stylesheet, then the parts are concatenated here rather than by the
 * model. Assembly server side is the point: it cannot forget a section.
 */
export async function generateSectioned(args: { plan: ContentPlan; facts: BuildFacts; emit: Emit },
): Promise<string> {
  const { plan, facts, emit } = args

  const specs = SECTION_SPECS.filter((s) => {
    if (s.id === 'gallery' && !plan.gallery.enabled) return false
    if (s.id === 'testimonials' && !plan.testimonials.enabled) return false
    return true
  })

  const parts: string[] = []
  let stylesheet: string | null = null
  const done: string[] = []

  for (const [index, spec] of specs.entries()) {
    await emit({
      type: 'status',
      stage: 'assembling',
      message: `Building ${spec.label.toLowerCase()}`,
    })

    let text = ''
    for await (const chunk of streamMessage({
      system: [{ type: 'text', text: HOUSE_RULES, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: sectionUserMessage({
            plan,
            facts,
            spec,
            stylesheet,
            previousSectionIds: done,
          }),
        },
      ],
      maxTokens: spec.id === 'head' ? MAX_TOKENS_BUILD : MAX_TOKENS_SECTION,
      effort: 'high',
    })) {
      if (chunk.type === 'text') {
        text += chunk.text
        await emit({ type: 'html_chunk', text: chunk.text })
      }
    }

    const cleaned = stripCodeFence(text)
    parts.push(cleaned)
    done.push(spec.id)

    if (spec.id === 'head') {
      const match = cleaned.match(/<style[^>]*>([\s\S]*?)<\/style>/i)
      stylesheet = match?.[1]?.trim() ?? null
    }

    await emit({
      type: 'section_done',
      section: spec.label,
      index: index + 1,
      total: specs.length,
    })
  }

  return assembleSections(parts)
}

/** Join the parts and make sure the document actually closes, whatever the last part did. */
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
