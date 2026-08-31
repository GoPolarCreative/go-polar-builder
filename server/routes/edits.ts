import { Hono } from 'hono'
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { getDb, schema } from '../db/client.js'
import type { GenerationEvent } from '../../shared/types.js'
import type { ContentPlan } from '../../shared/plan.js'
import { intakeSchema, type IntakePayload } from '../../shared/intake.js'
import { EDITS_INCLUDED } from '../../shared/pricing.js'
import { EDITS_PER_HOUR, LIVE_EDITS_PER_MONTH } from '../../shared/allowance.js'
import { editCapability } from '../config.js'
import { getIntake, getJob, holdJob, listAssets, nextVersion, recordEvent, setJobStatus } from '../lib/db.js'
import { id } from '../lib/ids.js'
import { buildFacts } from '../lib/facts.js'
import { diffPlans, generateEditedPlan, summariseDiff } from '../lib/edit.js'
import { renderSite } from '../lib/render/site.js'
import { storage } from '../lib/storage.js'
import { summarise, verifyAndRepair } from '../lib/verify.js'
import { persistPageSet } from '../lib/buildSet.js'
import { liveHostnameFor, publishJob } from '../lib/publishJob.js'
import { editPhaseFor, editsInLastHour, liveAllowanceFor } from '../lib/liveEdits.js'
import { hostingBlock } from '../lib/subscription.js'

const app = new Hono()

/**
 * Phase 4. The edit loop, version history and rollback.
 *
 * One submitted request is one edit, however many changes it contains (brief s7). Rollback never
 * costs an edit and never destroys a version (DECISIONS.md D4). Passing the allowance escalates
 * rather than blocks (D5).
 */

async function loadPlan(jobId: string, version: number): Promise<ContentPlan | null> {
  const db = await getDb()
  const rows = await db
    .select({ plan: schema.plans.plan })
    .from(schema.plans)
    .where(and(eq(schema.plans.jobId, jobId), eq(schema.plans.version, version)))
    .limit(1)
  return (rows[0]?.plan as ContentPlan | undefined) ?? null
}

async function loadHtml(jobId: string, version: number): Promise<string | null> {
  const db = await getDb()
  const rows = await db
    .select({ blobKey: schema.builds.blobKey })
    .from(schema.builds)
    .where(and(eq(schema.builds.jobId, jobId), eq(schema.builds.version, version)))
    .limit(1)
  if (!rows[0]) return null
  return storage().getText(rows[0].blobKey)
}

/** Everything the preview screen needs in one call. */
app.get('/jobs/:jobId/versions', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const db = await getDb()
  const [builds, edits] = await Promise.all([
    db
      .select({
        version: schema.builds.version,
        bytes: schema.builds.bytes,
        pageWeightBytes: schema.builds.pageWeightBytes,
        passed: schema.builds.passed,
        repairPasses: schema.builds.repairPasses,
        createdAt: schema.builds.createdAt,
      })
      .from(schema.builds)
      .where(eq(schema.builds.jobId, jobId))
      .orderBy(desc(schema.builds.version)),
    db
      .select({
        versionFrom: schema.edits.versionFrom,
        versionTo: schema.edits.versionTo,
        prompt: schema.edits.prompt,
        diffSummary: schema.edits.diffSummary,
        counted: schema.edits.counted,
        createdAt: schema.edits.createdAt,
      })
      .from(schema.edits)
      .where(eq(schema.edits.jobId, jobId))
      .orderBy(desc(schema.edits.createdAt)),
  ])

  // The page set, so the preview can offer a switcher and the customer can see every page they
  // paid for. Derived from the current plan rather than a second source of truth.
  const planRow = await db
    .select({ plan: schema.plans.plan })
    .from(schema.plans)
    .where(and(eq(schema.plans.jobId, jobId), eq(schema.plans.version, job.currentVersion)))
    .limit(1)

  const currentPlan = planRow[0]?.plan as { servicePages?: Array<{ slug: string; service: string }> } | undefined
  const pages = [
    { url: '/', path: 'index.html', service: null as string | null },
    ...(currentPlan?.servicePages ?? []).map((sp) => ({
      url: `/services/${sp.slug}/`,
      path: `services/${sp.slug}/index.html`,
      service: sp.service,
    })),
  ]

  return c.json({
    pages,
    pagesAllowed: job.pagesAllowed,
    currentVersion: job.currentVersion,
    editsUsed: job.editsUsed,
    editsAllowed: job.editsAllowed,
    // Never negative in the customer's view, even though editsUsed keeps counting honestly.
    editsRemaining: Math.max(0, job.editsAllowed - job.editsUsed),
    overAllowance: job.editsUsed >= job.editsAllowed,
    held: job.held,
    heldReason: job.heldReason,
    builds,
    edits,
    // Answered when the panel loads, not after the customer has typed a request and pressed
    // send. An editor that cannot edit has to say so before it takes any typing.
    capability: editCapability(),
  })
})

/**
 * Submit one change request. Streams exactly like generation does, so the customer watches the
 * change land rather than staring at a spinner.
 */
app.post('/jobs/:jobId/edits', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const body = await c.req.json<{ request?: string }>().catch(() => ({}) as { request?: string })
  const request = (body.request ?? '').trim()
  if (request.length < 3) {
    return c.json({ error: 'bad_request', detail: 'Tell us what you would like changed.' }, 400)
  }
  if (request.length > 4000) {
    return c.json(
      { error: 'bad_request', detail: 'That is a lot at once. Send it through in a couple of goes.' },
      400,
    )
  }

  const fromVersion = job.currentVersion
  if (fromVersion < 1) {
    return c.json({ error: 'not_ready', detail: 'There is nothing built to change yet.' }, 409)
  }

  /*
   * Refuse before anything is written.
   *
   * This check used to be missing, and the offline fixture happily accepted the request, wrote a
   * new version that was byte-for-byte the same site, reported success, and charged the customer
   * one of their ten changes. From their seat that is indistinguishable from the product being
   * broken, and they are one round poorer for it.
   *
   * Nothing below this line runs unless a change can actually be applied: no status change, no
   * version, and above all no increment of edits_used.
   */
  const capability = editCapability()
  if (!capability.available) {
    await recordEvent(jobId, 'edit.refused', {
      reason: capability.reason,
      request: request.slice(0, 500),
      editsUsed: job.editsUsed,
      // Stated explicitly in the trail: this refusal cost the customer nothing.
      editCharged: false,
    })
    return c.json(
      {
        error: 'edits_unavailable',
        detail: capability.reason,
        editCharged: false,
        editsRemaining: Math.max(0, job.editsAllowed - job.editsUsed),
      },
      503,
    )
  }

  const db = await getDb()
  const [currentPlan, currentHtml, stored, assets] = await Promise.all([
    loadPlan(jobId, fromVersion),
    loadHtml(jobId, fromVersion),
    getIntake(jobId),
    listAssets(jobId),
  ])

  if (!currentPlan || !currentHtml) {
    return c.json({ error: 'not_found', detail: 'The current version could not be loaded.' }, 404)
  }

  const parsedIntake = intakeSchema.safeParse(stored?.payload)
  if (!parsedIntake.success) {
    return c.json({ error: 'invalid_intake', detail: 'Stored intake does not validate' }, 422)
  }
  const intake = parsedIntake.data as IntakePayload

  const priorEdits = await db
    .select({ prompt: schema.edits.prompt })
    .from(schema.edits)
    .where(and(eq(schema.edits.jobId, jobId), isNotNull(schema.edits.prompt)))
    .orderBy(schema.edits.createdAt)

  /*
   * WHICH ALLOWANCE THIS EDIT COMES OUT OF, and whether there is any of it left.
   *
   * Pre-launch and live behave differently ON PURPOSE.
   *
   * Pre-launch does not hard block (brief s7, D5). They have paid $220, they are trying to finish
   * a website, and stopping them dead at ten is how a build gets abandoned. It runs, and Chris is
   * told the same day.
   *
   * Live DOES stop, because the alternatives are worse. The hosting tier states ten changes a
   * month, there is no product to sell them an eleventh, and running it anyway would mean the
   * stated inclusion is not a real number. Stopping is only acceptable because the refusal says
   * exactly when it refills and offers a person to talk to. See DECISIONS.md D63 for the policy
   * question this leaves open.
   */
  /*
   * A CANCELLED SUBSCRIBER CANNOT CHANGE THEIR SITE. Their website stays up: taking a tradie
   * offline the hour a card bounces is a person's decision, not a webhook's. See subscription.ts.
   */
  const hostingStopped = await hostingBlock(jobId)
  if (hostingStopped) {
    return c.json({ error: 'hosting_ended', detail: hostingStopped.detail }, 402)
  }

  const phase = await editPhaseFor(jobId)
  const monthly = phase === 'live' ? await liveAllowanceFor(jobId) : null

  if (monthly?.exhausted) {
    return c.json(
      {
        error: 'monthly_allowance_used',
        detail: `You have used all ${monthly.allowed} of this month's changes. They refill on the first of ${monthly.resetsIntoMonth}. If something on your site is wrong and it cannot wait, reply to any of our emails and we will fix it for you.`,
        allowance: monthly,
      },
      429,
    )
  }

  /*
   * A PER HOUR CEILING ON TOP OF THE MONTHLY ONE.
   *
   * The monthly allowance caps what a customer can spend. It does not cap how fast, and the
   * expensive failure is a stuck customer regenerating over and over in one sitting: ten model
   * builds in ten minutes costs real money and never produces a better website than waiting a
   * moment and writing a clearer request.
   *
   * Deliberately generous enough that nobody editing normally will ever see it. It is a guard
   * against a loop, not a throttle on people.
   */
  const recent = await editsInLastHour(jobId)
  if (recent >= EDITS_PER_HOUR) {
    return c.json(
      {
        error: 'too_many_changes_too_fast',
        detail: `That is ${recent} changes in the last hour, which is as many as we run in one go. Give it a few minutes, and it is worth putting everything you want changed into one message: one request is one change however much is in it.`,
        retryAfterMinutes: 15,
      },
      429,
    )
  }

  const overAllowance = phase === 'prelaunch' && job.editsUsed >= job.editsAllowed
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const emit = async (event: GenerationEvent) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          closed = true
        }
      }

      try {
        await setJobStatus(jobId, 'editing')

        if (overAllowance) {
          // Brief s7: do not hard block. Run it, and make sure Chris knows the same day.
          await recordEvent(jobId, 'edit.overage', {
            editsUsed: job.editsUsed,
            editsAllowed: job.editsAllowed,
            request: request.slice(0, 500),
            notify: 'chris',
          })
        }

        const facts = buildFacts(intake, assets)
        await emit({ type: 'status', stage: 'planning', message: 'Working out what to change' })

        const edited = await generateEditedPlan({
          plan: currentPlan,
          facts,
          intake,
          assets,
          request,
          previousRequests: priorEdits.map((e) => e.prompt!).filter(Boolean),
        })
        const revisedPlan = edited.plan

        /*
         * WHAT THE EDIT STEP WANTED TO CHANGE BUT WAS NOT ALLOWED TO.
         *
         * Recorded rather than filtered quietly. The model declares which sections it intends to
         * touch and anything outside that declaration is dropped before the page is rebuilt, which
         * fixes the customer-facing problem on its own. But a model that keeps reaching for the FAQ
         * when somebody asked about the process section is telling us something about the prompt,
         * and that is only visible if the drops are written down.
         */
        if (edited.droppedKeys.length > 0) {
          await recordEvent(jobId, 'edit.keys_dropped', {
            declared: edited.declaredSections,
            dropped: edited.droppedKeys,
            request: request.slice(0, 200),
            notify: 'chris',
          })
        }

        const changes = diffPlans(currentPlan, revisedPlan)
        await emit({ type: 'plan', plan: revisedPlan })

        const toVersion = await nextVersion(jobId)
        await db
          .insert(schema.plans)
          .values({ id: id('pln'), jobId, version: toVersion, plan: revisedPlan })
          .onConflictDoUpdate({
            target: [schema.plans.jobId, schema.plans.version],
            set: { plan: revisedPlan },
          })

        /*
         * THE PAGE IS RENDERED FROM THE REVISED PLAN. THE MODEL DOES NOT TOUCH THE MARKUP.
         *
         * This was two model-driven paths: patch the sections the change reached, or hand the
         * whole document back to the model to rewrite. Both were right when the model had
         * written the document in the first place. renderSite replaced that for first builds and
         * this path was left behind, which made an edit the one operation that could throw the
         * template away and return something else.
         *
         * IT ALSO FAILED. Callum asked for nine changes at once and the rebuild came back
         * truncated: "The rebuild came back incomplete", after several minutes of streaming, on
         * a request that never needed a model to write markup at all. A renderer cannot
         * truncate, so that failure mode is gone rather than made less likely.
         *
         * What an edit changes now is the PLAN: the words, the colours, the fonts, the style,
         * which sections are on. The page is redrawn from it. Everything the template decides
         * stays decided, which is the point of having one, and it also means a fix to the
         * renderer reaches every customer on their next edit rather than only on a fresh build.
         */
        const html = renderSite(revisedPlan, facts)

        await recordEvent(jobId, 'edit.mode', { mode: 'render', fromVersion })

        await emit({ type: 'status', stage: 'verifying', message: 'Checking every line of it' })
        const outcome = await verifyAndRepair({
          html,
          facts,
          /*
           * Same reason as the build route: against a document the model did not author,
           * repair rewrites the template rather than fixing it. A failing check here is a bug
           * in the renderer, to be fixed once for everybody.
           */
          allowRepair: false,
          onEvent: async (e) => {
            if (e.type === 'repair') {
              await emit({ type: 'status', stage: 'repairing', message: 'Fixing what did not pass' })
            }
            await emit(e)
          },
        })

        /*
         * Did anything actually happen?
         *
         * An edit is now allowed to leave the plan completely untouched, because a request about
         * how the site looks is carried out on the document instead. That makes an empty plan diff
         * normal rather than suspicious, and it removes the only signal we had that a round of
         * work produced something.
         *
         * So compare the document itself. If the plan did not move AND the page came back byte for
         * byte identical, the customer asked for something and received their own site back. That
         * is the exact case this route already refuses to charge for. No version, no increment, and
         * a reason they can act on.
         */
        const planChanged = changes.length > 0
        const htmlChanged = outcome.html.trim() !== currentHtml.trim()

        if (!planChanged && !htmlChanged) {
          await recordEvent(jobId, 'edit.noop', {
            request: request.slice(0, 500),
            fromVersion,
            editCharged: false,
            notify: 'chris',
          })
          await emit({
            type: 'error',
            message: 'Nothing changed',
            detail:
              'We could not work out what to change from that, so your website has been left exactly as it was and this has not used up one of your changes. ' +
              'Editing changes your words, your photos, your colours and your fonts. The layout itself is fixed: things like the size of the logo, how the menu is arranged, how many photos sit in a row and how the sections are spaced are the same on every site we build, and asking for those here will not change anything. ' +
              'For anything else, name the section and what you want done to it, for example "change the heading on the about section to ...".',
          })
          // Back to where they were: something is built and they can still change it.
          await setJobStatus(jobId, 'preview')
          closed = true
          controller.close()
          return
        }

        // The whole set is rebuilt from the revised plan, not just the page the customer named.
        // The plan is the source of truth and the service pages are rendered from it, so a change
        // to the business name or the phone number lands on every page at once. That is also why
        // an edit spanning several pages still costs exactly one round.
        const set = await persistPageSet({
          jobId,
          version: toVersion,
          plan: revisedPlan,
          facts,
          homeHtml: outcome.html,
          homeReport: outcome.report,
          repairPasses: outcome.attempts,
          // What they paid for, so the set is checked against the entitlement (D55).
          paidPageServices: (intake.ownPageServices ?? []).filter((n) => intake.services.includes(n)),
          // And what they are ENTITLED to, which is the thing the choice above can fall short of.
          pagesAllowed: job.pagesAllowed,
        })

        const diffSummary = summariseDiff(changes)

        await db.insert(schema.edits).values({
          id: id('edt'),
          jobId,
          versionFrom: fromVersion,
          versionTo: toVersion,
          prompt: request,
          diffSummary,
          counted: true,
          // Which bucket this came out of. The monthly figure is counted off these rows.
          phase,
        })

        /*
         * THE ROW ABOVE AND THIS UPDATE BOTH SIT IN THE SUCCESS BRANCH, which is what makes
         * "a failed edit never costs an allowance" true rather than intended. A failure returns
         * before either runs, so there is no row to count and no counter to decrement. The same
         * shape now protects the monthly allowance, because the monthly figure is a count of
         * exactly these rows.
         *
         * jobs.editsUsed is the LIFETIME pre-launch ten and is only spent pre-launch. A live
         * customer editing their site must never eat into a counter that does not refill.
         */
        await db
          .update(schema.jobs)
          .set({
            ...(phase === 'prelaunch' ? { editsUsed: sql`${schema.jobs.editsUsed} + 1` } : {}),
            currentVersion: toVersion,
            status: 'editing',
            updatedAt: new Date(),
          })
          .where(eq(schema.jobs.id, jobId))

        if (!set.passed) {
          await holdJob(
            jobId,
            `Edit verification failed after ${outcome.attempts} repair pass(es): ${summarise(outcome.report)}`,
          )
          await recordEvent(jobId, 'build.held', {
            version: toVersion,
            summary: summarise(outcome.report),
            notify: 'chris',
          })
          await emit({
            type: 'status',
            stage: 'held',
            message:
              'That change hit a snag on the last few checks. One of our team has been notified. Your previous version is still safe and you can roll back to it.',
          })
        } else {
          await recordEvent(jobId, 'edit.applied', {
          request: request.slice(0, 500),
          fromVersion,
          toVersion,
          summary: diffSummary,
        })
        }

        await emit({
          type: 'done',
          version: toVersion,
          bytes: outcome.html.length,
          passed: set.passed,
          pageWeightBytes: outcome.report.pageWeightBytes,
        })
      } catch (err) {
        console.error('edit failed', err)
        const message = err instanceof Error ? err.message : String(err)
        await recordEvent(jobId, 'edit.failed', { message, request: request.slice(0, 500) })
        await setJobStatus(jobId, 'editing')
        /*
         * SAME RULE AS THE BUILD: THE UPSTREAM ERROR TEXT IS NOT FOR THE CUSTOMER.
         *
         * An Anthropic outage or a billing problem on our account would otherwise arrive here as
         * an instruction to go and buy credits, which is our job and not theirs. It happened on
         * the build screen to a customer who had already paid. The full message is in the event
         * log recorded just above.
         *
         * The reassurance is the part that matters: the job has been put back to editing, so the
         * failed attempt has not spent one of their ten changes.
         */
        await emit({
          type: 'error',
          message: 'That change did not go through. Your current version has not been touched.',
          detail:
            'This is our end rather than yours, and it has not used up one of your ten changes. Give it a minute and ask for the change again.',
        })
      } finally {
        closed = true
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
})

/**
 * Roll back to an earlier version. Costs nothing, destroys nothing: the pointer moves and every
 * version stays in storage, so rolling forward again works too.
 */
/**
 * The customer's own publish button.
 *
 * SESSION, NOT ADMIN TOKEN. It sits under /jobs/:jobId/, which `requireSession` guards: the job
 * id in the path must equal the job id in the session, so knowing somebody else's job id gets a
 * caller a 403 and nothing else. A customer cannot publish another customer's site.
 *
 * NO HOSTNAME FROM THE BROWSER. The operator endpoint takes one because Chris is connecting a
 * domain for the first time. Here it comes from the `sites` row we already wrote. Accepting a
 * hostname from a customer would be accepting an instruction about which key in shared storage to
 * overwrite, and there is no version of that worth the convenience.
 *
 * NO `force`. Every gate in publishJob applies: hosting paid, enquiry inbox verified, every page
 * present, every check re-run and passing, every paid page delivered. The operator route keeps
 * force for the cases where a human has taken payment another way and knows what they are doing.
 * A customer never gets to skip a check on their own live website.
 */
app.post('/jobs/:jobId/publish', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const hostname = await liveHostnameFor(jobId)
  if (!hostname) {
    return c.json(
      {
        error: 'not_connected_yet',
        detail:
          'Your web address has not been connected to your website yet, so there is nowhere to publish to. We do that part, and we will be in touch to get it sorted.',
      },
      409,
    )
  }

  const out = await publishJob({ jobId, hostname, actor: 'customer' })

  if (!out.ok) {
    return c.json({ error: out.error, detail: out.detail, failures: out.failures ?? [] }, out.status)
  }

  return c.json({
    ok: true,
    hostname: out.result.hostname,
    version: out.result.version,
    pages: out.result.pages,
    siteUrl: `https://${out.result.hostname}`,
  })
})

/** What the live view needs to render: is it live, what is published, what is left this month. */
app.get('/jobs/:jobId/live', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const db = await getDb()
  const [site] = await db
    .select({ hostname: schema.sites.hostname, version: schema.sites.version, live: schema.sites.live })
    .from(schema.sites)
    .where(eq(schema.sites.jobId, jobId))
    .limit(1)

  const phase = await editPhaseFor(jobId)
  const monthly = phase === 'live' ? await liveAllowanceFor(jobId) : null

  return c.json({
    isLive: Boolean(site?.live),
    hostname: site?.hostname ?? null,
    siteUrl: site?.hostname ? `https://${site.hostname}` : null,
    /** The version the public is seeing right now. */
    publishedVersion: site?.version ?? null,
    /** The version they are editing. Different means unpublished changes. */
    currentVersion: job.currentVersion,
    hasUnpublishedChanges: Boolean(site?.live) && site?.version !== job.currentVersion,
    monthly,
  })
})

app.post('/jobs/:jobId/rollback', async (c) => {
  const jobId = c.req.param('jobId')
  const job = await getJob(jobId)
  if (!job) return c.json({ error: 'not_found' }, 404)

  const body = await c.req.json<{ version?: number }>().catch(() => ({}) as { version?: number })
  const version = Number(body.version)
  if (!Number.isInteger(version) || version < 1) {
    return c.json({ error: 'bad_request', detail: 'Which version would you like to go back to?' }, 400)
  }

  const db = await getDb()
  const target = await db
    .select({ version: schema.builds.version })
    .from(schema.builds)
    .where(and(eq(schema.builds.jobId, jobId), eq(schema.builds.version, version)))
    .limit(1)
  if (!target[0]) {
    return c.json({ error: 'not_found', detail: 'There is no version with that number.' }, 404)
  }

  const from = job.currentVersion

  await db
    .update(schema.jobs)
    .set({ currentVersion: version, held: false, heldReason: null, updatedAt: new Date() })
    .where(eq(schema.jobs.id, jobId))

  await db.insert(schema.edits).values({
    id: id('edt'),
    jobId,
    versionFrom: from,
    versionTo: version,
    prompt: null,
    diffSummary: `Rolled back to version ${version}`,
    counted: false,
  })

  await recordEvent(jobId, 'version.rolled_back', { from, to: version })

  /*
   * ROLLBACK HAS TO REACH THE LIVE SITE. This is the panic button.
   *
   * Until now it moved jobs.currentVersion and wrote an edit row, and stopped. For a job that was
   * not live that is the whole job. For a LIVE customer it was close to useless: the preview went
   * back, the public website kept serving the version they were panicking about, and the button
   * that exists for exactly that moment quietly did nothing about it.
   *
   * THE POINTER MOVES FIRST, THEN PUBLISH, AND THE POINTER GOES BACK IF PUBLISH REFUSES.
   * publishJob reads the version off the job, so the pointer has to be set before it runs. If the
   * target version cannot pass its checks, restoring it would put a broken site in front of the
   * public, so the publish is refused, the pointer is put back where it was, and the customer is
   * told. Ending up with the database saying one version and the internet serving another is the
   * exact inconsistency this button exists to get them out of.
   */
  const liveHost = await liveHostnameFor(jobId)
  if (!liveHost) {
    return c.json({ ok: true, currentVersion: version, editsCharged: 0, republished: false })
  }

  const published = await publishJob({
    jobId,
    hostname: liveHost,
    actor: 'customer',
    restoredFromVersion: version,
  })

  if (!published.ok) {
    await db
      .update(schema.jobs)
      .set({ currentVersion: from, updatedAt: new Date() })
      .where(eq(schema.jobs.id, jobId))
    await recordEvent(jobId, 'version.rollback_reverted', {
      attempted: version,
      restoredTo: from,
      reason: published.error,
    })
    return c.json(
      {
        error: published.error,
        detail: `That version could not be put back: ${published.detail} Your website has not changed and you are still on version ${from}.`,
        failures: published.failures ?? [],
      },
      published.status,
    )
  }

  return c.json({
    ok: true,
    currentVersion: version,
    editsCharged: 0,
    republished: true,
    hostname: published.result.hostname,
  })
})

/**
 * What to say when the ten pre-launch rounds are gone (brief s7).
 *
 * THE OLD ANSWER WAS TO SELL FIVE MORE, AND THAT PRODUCT IS GONE (D66). It never had a price, so
 * the path was already dark, and it stopped making sense entirely once the $42.90 tier began
 * including ten changes a month. The honest answer to "I have run out" is now "go live, and you
 * get ten a month from that day", not "pay us more to keep drafting".
 *
 * NOTHING HARD BLOCKS. Brief s7 and D5. A customer who sends another change anyway still gets it
 * made, and Chris is told the same day. Running out is a prompt to finish, not a wall.
 */
app.get('/jobs/:jobId/edits/extra', (c) =>
  c.json({
    available: false,
    goLiveInstead: true,
    included: EDITS_INCLUDED,
    monthlyAllowance: LIVE_EDITS_PER_MONTH,
    detail: `You have used the ${EDITS_INCLUDED} changes that come with the build. The next step is to go live: from the day your website is online you get ${LIVE_EDITS_PER_MONTH} changes a month, and that starts fresh.`,
    ifStuck:
      'If something is wrong and it cannot wait, send it through anyway. We will make it and get in touch about it.',
  }),
)

export default app
