# SCOPE: Self-serve editing for live customers

Scoped 2026-08-25 against the real codebase, no code changed. The idea: a DIY hosting tier at
$42.90/month inc GST ($39 + GST) whose value is an editor the customer keeps using — 10
self-serve changes per calendar month, previewed, published, live site updated. Build stays
$220; discharge unchanged. Shopify product already created in DRAFT: "DIY Website Hosting",
product `10930879201439`, variant `62853864685727`, SKU `diy-hosting-monthly`, $42.90, **no
selling plan attached yet** (Appstle step in the admin — required, because subscriptions on this
store REFUSE checkout without a plan id, pricing.ts rule 3).

---

## 1. What already exists that this reuses

The read that "most of it is built" is correct. Named modules:

- **The edit loop** — `server/routes/edits.ts`. `POST /jobs/:jobId/edits` takes one plain-English
  request, streams the change live (SSE), rebuilds the whole page set from the revised plan
  (`server/lib/edit.ts`: `generateEditedPlan`, `rebuildFromPlan`, `diffPlans`), and runs
  verification with repair passes (`server/lib/verify.ts`). One request = one edit regardless of
  how many changes it contains.
- **Version history and rollback** — same file. Every version's plan (`plans` table) and HTML
  (`builds` table + Blob) is kept forever; `POST /jobs/:jobId/rollback` moves
  `jobs.currentVersion`, costs nothing, destroys nothing, and records an uncounted `edits` row.
  `GET /jobs/:jobId/versions` already returns the full history for the UI.
- **The 18 checks** — `server/lib/checks/static.ts` + `render.ts`, ids in `shared/types.ts`
  (`CheckId`, 18 values). Run on every edit via `verifyAndRepair`; a failing build is marked
  `passed: false` and the job is held with Chris notified.
- **The rebuild pipeline** — `server/lib/generate.ts`, `server/lib/buildSet.ts`
  (`persistPageSet` writes every page of the set for the new version). Multi-page aware.
- **Claim by email + order number** — `server/routes/auth.ts` `POST /auth/claim` (D49/D50
  hardening: order-number forms, confirmation numbers, failure-reason logging). Plus
  `POST /auth/resend`: email in → fresh 90-day token minted (`createBuildToken`,
  `TOKEN_TTL_DAYS = 90` in `server/lib/signing.ts:130`) → sign-in link sent via Klaviyo
  (`link_requested`). **A customer whose original token expired months ago is already handled:
  resend mints a new token; nothing depends on the old one.**
- **The deploy path** — `server/lib/publish.ts` (`publishSite`) + `server/routes/sites.ts`
  (serving) + `POST /api/admin/publish` in `server/routes/admin.ts:291-420` (the trigger).
  Detail in section 3.
- **Payments plumbing** — `shared/pricing.ts` is the single product registry;
  `server/lib/orders.ts` classifies webhook line items by SKU/handle and routes
  hosting/domain/email to go-live payment recording. Adding `diy-hosting-monthly` is one entry
  plus the Appstle selling-plan env var (`SHOPIFY_SELLING_PLAN_DIY_HOSTING_MONTHLY`).
- **The editor UI** — `src/pages/Preview.tsx` + `ChangesPanel` (nested route `/preview/:jobId/changes`),
  device preview, version list, common-changes chips. It is the pre-launch editor; most of it IS
  the post-live editor.

## 2. What is genuinely new

The read is right, with one addition and one correction:

1. **Post-live editing as a state.** Today the editor is a pre-launch phase; after publish the
   job sits in `live` and nothing customer-facing offers edits. New: jobs in status `live` can
   enter the edit loop, and the preview screen needs a "live" mode (you are editing a draft of
   your live site; nothing changes until you press publish).
2. **A monthly allowance that resets.** Today `jobs.editsUsed`/`editsAllowed`
   (`db/schema.ts:90-91`, defaults 0/10) are lifetime counters for the pre-launch 10. Monthly is
   new — see section 5 for the design that needs **no schema change and no reset cron**.
3. **Customer-triggered publish.** Publishing to a hostname exists but is **admin-only**
   (`/api/admin/publish`, ADMIN_TOKEN-guarded, run by Chris). New: a customer-facing
   `POST /jobs/:jobId/publish` that republishes `currentVersion` to the job's existing hostname
   with the same three gates (hosting paid, forms key verified, checks passed — no `force`
   for customers, ever).
4. **Rollback that reaches the live site** (the addition). Rollback today moves the version
   pointer only — it does NOT touch `sites/{hostname}/` in Blob. For a live customer, "restore
   the old version" must be pointer-move + republish in one action, or the live site keeps
   serving the bad version they just rolled back from.
5. **The correction:** "publishing an update to an already-live site" is not new machinery —
   `publishSite` is already an idempotent overwrite (upserts the `sites` row, overwrites the
   Blob objects). What is new is only *who may trigger it*.

## 3. The publish path, in detail

**There is no GitHub anywhere in this system.** Chris's "push those updates live to GitHub" does
not describe the architecture. What actually happens (D24, `server/lib/publish.ts`):

1. A live site is a set of HTML documents in Vercel Blob under `sites/{hostname}/…`
   (`index.html`, `services/{slug}/index.html`, `sitemap.xml`, `robots.txt`).
2. `publishSite` takes the stored build for one version, rewrites every relative asset path to
   an absolute `/api/site-asset/{key}` URL, asserts no page still carries the Go Polar Web3Forms
   key (D29 — throws, never softened), writes each document to Blob, and upserts the `sites`
   row (`hostname → jobId, version, live`).
3. A visitor's request on a customer hostname is answered by `GET /site` in
   `server/routes/sites.ts`: look up hostname in `sites`, fetch the document from Blob, serve it
   with `cache-control: public, max-age=60, s-maxage=300`. Images come straight off the Blob CDN
   with immutable 1-year caching and never touch compute.

**No deploy, no build step, no git, no Vercel deployment.** Publishing an update = overwriting a
few Blob objects and one DB row. What has to change: nothing in this path — only a
customer-facing route that calls it (section 2, item 3).

**Timing, from button to live:** the Blob writes take low single-digit seconds (one home page +
N service pages + 2 files, written sequentially). After that, caches: a fresh visitor sees the
new version immediately; a returning browser may hold the old page up to **60 seconds**; the
Vercel edge may serve it up to **5 minutes** (`s-maxage=300`). Call it "live within seconds,
everywhere within five minutes."

**Broken or stale mid-publish?** Stale, never broken. Each document write is atomic — no visitor
can receive half a file. But a multi-page set is written page by page, so there is a window of a
few seconds where the home page is the new version and a service page is the old one (plus the
cache windows above). Both versions are complete, valid pages; internal links all resolve.
Acceptable for this product; worth one sentence in the customer UI ("your update can take a few
minutes to show everywhere").

## 4. Auth

Confirmed, and the concern is real: **`POST /auth/claim` today grants a session cookie directly
from email + order number** (`server/routes/auth.ts:151-162`). Both values live on a receipt, an
invoice, a CC'd email. For a pre-launch preview that trade-off was deliberate (two factors as
evidence of purchase, D49); for write access to a live tradie's site it is not good enough.

The plan, using the existing pattern:

- Claim stays as the front door, but **for a job in status `live` it stops returning a session**.
  Instead it verifies the pair, then does exactly what `/auth/resend` does: `createBuildToken`
  → Klaviyo `link_requested` → sign-in link to **the email on record** (not an email the caller
  supplies). Response: "we have emailed a sign-in link to the address on this account."
- The emailed token is minted fresh with a 90-day TTL, so the customer whose original link
  expired months ago is covered — this is already how `/auth/resend` behaves today, verified in
  `server/lib/auth.ts:31`.
- Pre-launch claim behaviour can stay as it is (status ≠ `live`), so tomorrow's funnel is
  untouched.
- Dependency called out plainly: this makes **working email a hard requirement for live
  editing** — and that requirement is already met. Klaviyo is configured in production
  (`klaviyoConfigured: true` on `/api/health`) and the purchase email was verified end to end by
  Chris on 2026-08-25. The only new piece is a Klaviyo flow on the sign-in-link metric.
- Publish, rollback and edit routes for live jobs must check the session's `jobId` matches — the
  session mechanics (`readSession`, cookie, 90-day TTL) already exist and are fine.

## 5. The allowance

- **Where it lives:** no new column needed. The `edits` table (`db/schema.ts:250`) already
  records every counted edit with `createdAt` and `counted` (rollbacks are `counted: false`).
  For a live job, "used this month" = `count(*) where jobId = ? and counted and createdAt >=
  start of current calendar month`. `jobs.editsUsed/editsAllowed` stay as the lifetime/pre-launch
  counters and are left alone.
- **When it resets:** implicitly, at midnight on the 1st — nothing to run, no cron, no reset
  job that can silently fail. Timezone must be pinned (store is AWST, `shared/pricing.ts`
  `STORE.timezone`); compute month boundaries in `Australia/Perth`, not UTC, or a customer
  edits at 7am on the 1st and is told it is still last month.
- **At zero:** decision needed, and it differs from pre-launch. Pre-launch deliberately
  escalates rather than blocks (D5; `edits.ts:200,218` records `edit.overage`, notifies Chris,
  runs anyway). For a monthly subscription allowance, silently running an 11th edit gives the
  allowance no meaning. Recommendation: **hard stop at 10 for live jobs**, with copy that says
  the allowance and the reset date, and a "need it sooner? reply to any email from us" line.
  Chris to confirm, since it reverses D5 for the live state only.
- **A failed edit never consumes an allowance** — already the invariant, enforced in three
  places in `edits.ts`: capability refusal before any write (`edit.refused`, `editCharged:
  false`), the no-op detector (plan unchanged AND HTML byte-identical → `edit.noop`, no charge),
  and the catch block (`edit.failed`, status restored, no increment; the increment only runs
  after `persistPageSet` succeeds).
- **One honest nuance to carry over deliberately:** an edit that *completes* but fails final
  verification is charged today (`editsUsed` incremented at `edits.ts:336-344` before the
  `set.passed` check that holds the job). Pre-launch that is defensible — work was done, Chris
  is notified, rollback is free. Post-live it needs a decision: the held version can never be
  published (checks gate), so the customer paid an allowance unit for something they cannot use.
  Recommendation: for live jobs, refund the unit on hold (decrement or mark uncounted).

## 6. Risks and what breaks — bluntly

- **A customer publishes a bad change to a site that is ranking.** The 18 checks gate the
  publish (single H1, heading hierarchy, valid JSON-LD, working forms, no overflow, page
  weight), so structurally broken pages cannot go live. But the checks cannot catch *bad
  content*: a customer can rewrite their own headline into something worse, delete the suburb
  copy doing the local-search work, or rename services. That is inherent to self-serve editing —
  the mitigation is free rollback plus every version kept. Sitemap/robots are republished from
  the build, and page *deletion* is bounded by the plan structure, but content quality is the
  customer's pen. Say this to customers plainly rather than promising safety.
- **Is rollback genuinely one button from live? Not yet.** It is one button to move the pointer
  (`/jobs/:jobId/rollback`, free, non-destructive), but the live hostname keeps serving the old
  Blob objects until something republishes. The scope must include "restore" = rollback +
  republish as a single customer action, or the panic button doesn't work when it matters most.
  With that built: yes, one button, live again within the same seconds-to-five-minutes window.
- **Cost per edit against $39 ex GST.** Each edit is an LLM plan revision + full page-set
  rebuild + verification with up to two repair passes (Sonnet 5 writes the sites, D47).
  Order-of-magnitude at current Sonnet pricing: roughly $0.20–$0.80 per edit, worst case near
  $1.50 with repairs on a multi-page set. Ten edits/month worst case ≈ $8–15 against $39 ex GST,
  plus pennies of Blob/function cost. Margin holds even for a customer who maxes the allowance
  every month; a customer who edits twice costs almost nothing. The cap is what makes this safe.
- **What stops abuse.** The monthly cap (if hard, per section 5), the 4,000-character request
  limit, one-request-at-a-time streaming, and the checks gate. What does NOT exist: rate
  limiting per hour, or anything stopping a customer putting objectionable content on a site Go
  Polar hosts and serves. Worth a light content check in the edit prompt plus terms wording, but
  do not pretend the checks are a content filter.
- **The $110 post-live edit product is cannibalised, correctly.** `postLiveEdit` in
  `shared/pricing.ts:212` ("Website Update", $110, SKU `post-live-edit`) exists precisely
  because live customers had no self-serve path. Under this tier it is dead for DIY customers —
  ten included edits at $42.90/month make a $110 single edit absurd. Decision for Chris: retire
  it for DIY-tier customers (keep for legacy $33 customers who don't upgrade), and decide the
  upgrade story for any existing $33 subscribers (price change on an active Appstle subscription
  is an admin/Appstle operation, not code).
- **Two-tier price collision on the landing page — this one bites TOMORROW.** The draft theme's
  buy section (brief s11 block) and hosting section state **$33/month inc GST**, and D31 says
  one price, the real one, everywhere. If DIY hosting is becoming $42.90, the ads land on a page
  disclosing a price Chris intends to retire. Publishing the theme with $33 and then charging
  $42.90 at go-live is exactly the bait-and-switch D31 exists to prevent. The price decision has
  to precede the theme publish; the copy change itself is minutes.
- **Subscription lifecycle is unhandled.** Nothing today reacts to a hosting subscription being
  cancelled or a payment failing (Appstle events are not consumed). A cancelled customer keeps
  editing and their site stays up forever. Pre-existing gap, but this feature makes it load-
  bearing: the editor is the reason they keep paying, so cancellation must at minimum revoke
  editing. Taking the site down on cancellation is a Chris decision with its own risks.

## 7. Effort, honestly

**Chris's "inside an hour or two" is not achievable for the editor, and half-building auth or
publish for live sites is the one place half-building causes real harm.** What two hours CAN
ship is the commercial wrapper; the editor itself is a solid day-plus because three of its
pieces (customer publish, live-reaching rollback, auth hardening) are new code on the live path
and each needs the Playwright verification pass this project treats as non-negotiable.

- **Bucket 1 — ~2 hours, shippable independently:** `diy-hosting-monthly` entry in
  `shared/pricing.ts` (SKU, variant `62853864685727`, $42.90, `requiresSellingPlan: true`) so
  the webhook classifies orders for it; landing page + go-live copy to whichever hosting price
  Chris picks; Appstle selling plan attached in the admin and the product published (admin UI
  work, Chris or assisted). None of this exposes the editor.
- **Bucket 2 — a focused day, the actual feature:** customer `POST /jobs/:jobId/publish`
  (reusing the `/admin/publish` body minus `force`, gated on session + status `live` + checks +
  forms key + hosting paid); "restore" = rollback + republish; edits allowed in status `live`
  with the calendar-month allowance (AWST) and the zero-behaviour decision; claim→email-link for
  live jobs; Preview/Changes UI in live mode (publish button, "editing a draft" banner, monthly
  counter, restore). Plus the end-to-end Playwright pass: edit → preview → publish → live
  hostname serves the new version → restore → old version back.
- **Bucket 3 — more than a day, can trail the launch of the feature:** Appstle webhook
  consumption (cancellation/payment-failure → revoke editing, site policy), migration/upgrade
  path for existing $33 subscribers, per-hour rate limiting and content-abuse guardrails,
  retiring the $110 product for DIY tier, held-edit refund semantics, admin visibility for
  monthly usage across customers.

## 8. What this does NOT affect

**Nothing in this scope is required for tomorrow's ad launch.**

- A customer who buys tomorrow: pays $220 → build link emailed by Klaviyo → wizard → build → 10
  pre-launch edits → go-live. Every step exists, and the purchase-to-builder path was verified
  end to end by Chris on 2026-08-25. They cannot need the live editor until they are live AND
  into a later month — weeks away at minimum.
- **Email is NOT a blocker. The earlier version of this section said it was, and that was
  wrong.** The claim came from `/api/health` reporting `emailConfigured: false` — a check that
  was still inspecting the decommissioned Resend key after D48 moved all email to Klaviyo
  (`klaviyoConfigured: true` in the same response, and the email demonstrably arrives). The
  check is fixed and the correction is recorded in D53. Nothing email-related stands between
  Chris and tomorrow's ads.
- Also unaffected: discharge (`server/routes/discharge.ts` and the $330 product), the build
  price, the pre-launch edit allowance, and the existing $33 product for anyone already on it.

**What DOES genuinely gate tomorrow's ads — none of it engineering in this scope:**

1. **Publish the draft theme, or ads land on the old page.** All landing-page work (short copy,
   single buy CTA, the page fork, the s11 cost disclosure) lives on unpublished theme
   174639841439. The live page still shows the old long-copy five-step configurator. It works —
   money in produces a build link — but it is not the page the ads were priced against.
   Publishing is Chris's call and takes a minute.
2. **The hosting price on that page must be the real one before it goes live.** The cost block
   above the buy button says $33/month. If DIY hosting is becoming $42.90, publishing $33 and
   charging $42.90 at go-live is the bait-and-switch D31 exists to prevent. Decision plus a
   minutes-long copy edit — but it must precede the publish.
3. **The two go-live Klaviyo flows should exist before the first customer presses the button**
   (`Website Go Live Started`, `Operator Alert` — D53). Not strictly launch-blocking: /ops shows
   the waiting list and the 24-hour flags regardless, so the manual net catches everyone even
   with no flow built. Same for `Website Files Ready` before the first discharge.
