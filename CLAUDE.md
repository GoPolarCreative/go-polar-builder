# Go Polar Website Builder

Read HANDOVER.md for the full state of the world, DECISIONS.md for why things are the way they
are. What follows is only what a session gets wrong without being told.

## Email and CRM are Klaviyo. Full stop.

- **Klaviyo sends every customer email** (D48). This app fires events (`server/lib/klaviyo.ts`);
  the flows and copy live in Klaviyo. There is no other email path.
- **The post-purchase flow is LIVE AND WORKING**, verified end to end by Chris on 2026-08-25:
  pay $197 on itscold.com.au → webhook creates the job → Klaviyo emails the order ID and the
  build.itscold.com.au link → customer claims and builds.
- **Resend and GoHighLevel are gone.** Removed, not disabled (D48, D53). Do not reintroduce
  them, reference them as current, or report them as missing configuration. A health check that
  inspected the dead Resend key reported `emailConfigured: false` while email worked, and that
  false blocker was relayed to Chris as launch-blocking twice. `/api/health` now reports on
  Klaviyo. If a doc or check mentions Resend/GHL as current, it is wrong: fix it.

## The customer's route, end to end

Ads land on `itscold.com.au/products/diy-website-build`. They pick one page or a page per
service, pay $197, and Klaviyo emails the build link. They claim at build.itscold.com.au with
their email plus order number, answer the intake, watch it build, and get ten rounds of edits.

**During the edits, not after, they set up their enquiry inbox** (Web3Forms). It sits on the
editor page as its own task. Until it is verified the live site carries Go Polar's key, so every
enquiry the customer's website generates would arrive in Go Polar's inbox - go live refuses
without it and points them back (D57).

**Go live is domain first, money second** (D57):

1. Do you have a domain? *Have one* / *need one* / *cannot get into it*.
2. Have one: which one, and **where did you buy it** - the answer drives the connection call.
   Need one: availability is checked live, ABN collected for .au.
3. Then hosting, then **one** Shopify cart carrying hosting plus the domain if they need one.
4. They pay, Chris is alerted, and Chris makes contact to get logins and connect the domain.

The cart is derived from the **recorded domain branch**, not the browser's checkbox
(`goLiveCartLines`). Either can add the domain line; neither can remove it. A customer who says
"I need a domain" must not reach a checkout without one.

**Never promise a connection timeframe.** Contact within one business day, and nothing about the
domain being connected in 24 hours. Registrar locks and third parties are not ours to control.

## Klaviyo flows and copy

`KLAVIYO-FLOWS.md` is the reference: every metric the app fires, when, and every variable in
each payload. Keep it in step with `server/lib/klaviyo.ts`.

- **Metric names are a hand-typed contract.** A flow binds to a metric by string. Renaming one
  in code breaks no build and throws nothing; the emails just stop. `test/klaviyo.metrics.test.ts`
  pins all ten. If it fails, rename the live flow in Klaviyo first (D62).
- **`Website Is Live` fires on every publish**, re-publishes included. The flow must filter on
  `is_first_publish` or trigger once per profile, or an edit re-sends the whole welcome sequence.
- **Two operator alerts, told apart by `alert`.** `go_live_requested` is a button press,
  `go_live_paid` is money received and work owed. Only the second is an obligation.
- **The nurture copy is NOT approved** (D62). `test/klaviyo.copy.test.ts` enforces the claim
  rules, the banned jargon, no em dashes, and the fourteen-day gap before anything is sold.

## The live editor (D63)

`server/lib/publishJob.ts` is the ONLY place a website becomes public. Both the operator route
and the customer button go through it. Do not add a second publish path; the recurring failure in
this codebase is a rule that exists on one path and not the other.

- **Checks re-run at publish**, never read off `builds.passed`. Nothing is written until every
  page has been read and verified, so a refusal cannot half-publish a site.
- **In production 4 of the 19 checks report `skipped`** (no browser in a function). Only `fail`
  blocks. The render four are enforced at build time.
- **Restore republishes.** The pointer moves, publish runs, and the pointer is put BACK if publish
  refuses. It used to move the pointer only, so a live site kept serving the bad version.
- **Two allowances, never conflate them.** `jobs.editsUsed` is the lifetime pre-launch ten and
  does not hard block. The live ten is per calendar month in AWST, DOES block, and is COUNTED off
  `edits.phase = live` rather than stored. See `shared/allowance.ts`.
- **A failed edit costs nothing** because the row and the counter both sit in the success branch.
  Keep them there. Rollbacks write `counted: false`.
- **Live jobs cannot claim with email plus order number.** That is the claim step only; a link
  goes to the address on record. Pre-launch is unchanged.
- **Cancellation** stops editing and publishing but never takes a site down. `hostingStatus`
  defaults to `unknown` and only an explicit cancellation locks anything.
- **Prove changes with `scripts/proof-editor-loop.mjs`** (18 assertions, real DB and storage),
  not with the fixture alone.

## Returning customers, and the sync question (D64)

**There is no manual step after a customer publishes.** `siteObjectKey` derives the blob key from
hostname and path ONLY, never the version, and `publishSite` overwrites that key. The new bytes are
live immediately; the only wait is the `s-maxage=300` cache. Domain attachment is one-time on first
connection. If anyone says Chris has to sync something, they are wrong.

- **A live site is reachable only by proving control of the inbox.** Six digit code, ten minutes,
  five attempts, three sends per fifteen minutes, single use, constant-time compare, bound to the
  email. See `server/lib/loginCode.ts`. The two limits MULTIPLY: do not relax one thinking the
  other covers it.
- **Email plus order number stays for the pre-launch phase only.** It is evidence of a purchase,
  not of inbox control.
- **The code request answers identically for unknown addresses.** Do not add a "no account here"
  branch; it turns the endpoint into a customer list.
- **`customer_published` alerts Chris that something happened.** It is not a job queue item.
  Operator publishes deliberately do not alert.
- **Prove with `scripts/proof-login-code.mjs` (14) and `scripts/proof-editor-loop.mjs` (18).**

## The other standing rules

- **Prices**: `shared/pricing.ts` is the single registry; GST-inclusive, "inc GST", one number
  everywhere (D31). No performance claims in customer copy — mechanism, never promises (D44).
- **Shopify theme**: work on unpublished drafts; publishing is Chris's call, always.
- **Secrets**: Chris sets them himself (`npx vercel env add`, prompted). Never write secrets
  into files, commands, or the transcript.
- **Go-live is deliberately manual for the first customers** (D53): the customer's button fires
  a Klaviyo setup email plus an operator alert, and `/ops` shows who has been waiting, with
  anyone over 24 hours flagged for a phone call. The automated path is specced in
  SCOPE-EDITOR.md for when volume justifies it.
- **Typecheck with `npx tsc -b`**, not `tsc --noEmit`. The narrow command passed clean while
  the Vercel build (`tsc -b`) found three errors including a dead component (D57).
- **Verification**: this project proves changes against the running thing (Playwright + local
  Chrome for pages; fetch-after-deploy for the app). Vercel deploys go from the working tree.
