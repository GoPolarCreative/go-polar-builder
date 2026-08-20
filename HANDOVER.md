# Handover

Last updated 2026-08-20. Written for someone with no memory of the day it was written.

## State

**Working tree is clean.** Everything is committed, nothing stashed, no half-applied change.

- **Typecheck:** clean (`npx tsc -b`)
- **Tests:** 340 passing, 14 files (`npm test`)
- **Build:** clean, client bundle secret scan passes (`npm run build`)
- **Sample:** 3 pages, all 17 checks passing on each (`npm run sample`)
- **End to end, single page:** 45/45 (`npm run e2e`, needs the dev API running)
- **End to end, page set:** all passed (`npm run e2e:pageset`)

The multi-page feature described in the previous version of this file as "not wired into the live
job flow" **is now wired in and proven end to end**. A real job produces a real page set, previews
it, edits it, publishes it and packages it.

## What the product is

A trade business pays $220 inc GST, answers guided questions, watches a website generate, gets ten
rounds of changes in plain English, then either goes live on Go Polar hosting or takes the files
elsewhere for $330 inc GST. Additional service pages are $25 inc GST each.

## What is left before it can take real money

Everything remaining is Chris's to do; none of it is code. In order:

1. **Publish the repo and deploy it.** `DEPLOY.md` is an ordered runbook. Sections 1 to 5 are
   GitHub, Vercel, Neon Postgres, Vercel Blob and the migrations.
2. **Create the Shopify custom app** (DEPLOY.md section 6). Scopes: `read_orders` and
   `read_products` for the Admin token, `unauthenticated_write_checkouts` for the Storefront token.
   Those are the calls the app actually makes, not a generous guess.
3. **Register the `orders/paid` webhook** and copy its signing secret into Vercel (section 7).
   Without it, customers pay and nothing happens.
4. **Paste six ids into Vercel.** The variant id and the Appstle selling plan id for each of the
   three subscriptions. This is the entire remaining gap between the repo and taking money, and
   there is a test that fails if that list ever grows:

   ```
   SHOPIFY_VARIANT_WEBSITE_HOSTING_AUSTRALIA      SHOPIFY_SELLING_PLAN_WEBSITE_HOSTING_AUSTRALIA
   SHOPIFY_VARIANT_DOMAIN_1_YEAR                  SHOPIFY_SELLING_PLAN_DOMAIN_1_YEAR
   SHOPIFY_VARIANT_EMAIL_HOSTING                  SHOPIFY_SELLING_PLAN_EMAIL_HOSTING
   ```

5. **Point `build.itscold.com.au` at Vercel** with a CNAME (section 8). The storefront is untouched.
6. **Set `APP_SECRET`, unset `DEV_OFFLINE_GENERATION`, set `DEMO_MODE=0`.** Until the offline flag is
   off, every build comes from a fixture and the Anthropic key is ignored.
7. **Smoke test with a real card** (section 9). The four-checkpoint trace at `/api/admin/trace` tells
   you which of the four things failed rather than that something did.

### Decisions still open

- **`extra-edits` has no price** and is not on the store. It degrades honestly: a customer out of
  edits is offered a conversation or going live, never a number. It does **not** block a launch.
- **Copy awaiting sign-off:** design style labels (D28), the inc-GST display decision (D31), the
  three product descriptions (D35), the additional-pages copy (D44). See DECISIONS.md.

## How a customer's website gets to them

Two ways, and they share one validated path for the Web3Forms key.

- **Hosted.** They verify their own Web3Forms access key on the go-live screen. The app sends a real
  test submission through that key before accepting it, so a valid-looking UUID that belongs to
  nobody is refused. That swap is then applied to **every page** of the set as a new version. Chris
  publishes with `POST /api/admin/publish` (DEPLOY.md section 8b), which refuses if hosting is
  unpaid, if the key is unverified, or if the build did not pass its checks.
- **Discharge, $330 inc GST.** A zip with every page, the assets, the favicon, a standalone
  `PREVIEW.html`, `sitemap.xml`, `robots.txt` and a plain-English README. If they have not given a
  key, the forms carry a commented placeholder rather than Go Polar's key. Available from the go-live
  screen and at any time after launch.

Go Polar's Web3Forms key never leaves the building on a live site or in an export. There is an
assertion on every page at publish time and a test for each path.

## Shape of the code

```
server/routes/     one file per surface: intake, generate, edits, builds, golive, discharge,
                   webhooks, admin, sites, dev
server/lib/        buildSet.ts is the one place that knows what a version is made of;
                   pages.ts is URL structure; render/ is the design system; verify.ts is the
                   17 checks; publish.ts puts a set on the internet
shared/            pricing.ts (every handle and id, no invented defaults), plan.ts, intake.ts,
                   styles.ts, pages-copy.ts
src/               the React builder UI
```

- **A build is a page set.** `index.html` plus `services/<slug>/index.html` per page bought. Links
  between pages are relative so the files work when served **and** when opened from a folder.
- **Every page is verified.** All 17 checks per page; a version passes only when every page passes.
- **The page allowance is money.** `jobs.pages_allowed`, incremented by line item quantity. Never
  generate a page nobody paid for, never leave a paid page unbuilt. Tested both directions.

## Running it

```bash
npm run dev          # localhost:5173, demo mode, no accounts needed
npm run seed         # prints two signed-in links
npm test
npm run sample       # rebuilds the committed sample
npm run e2e          # needs the dev API running
npm run e2e:pageset  # needs the dev API running and ADMIN_TOKEN in the environment
```

Stop the dev server with Ctrl-C, or `curl -X POST http://localhost:8787/api/dev/shutdown` if it is
detached. It closes the embedded database on the way out. A hard kill has corrupted it before and
cost a morning.

## Things worth knowing before changing anything

- **The builder's own hostname is hardcoded once**, in `vercel.json`. It decides whether a request
  gets the builder app or a published customer site. Moving the builder means changing that line in
  the same deploy.
- **The verification self-test** (`/api/dev/selftest/:jobId/:version`) breaks a passing build in
  thirteen specific ways and asserts each check catches its own breakage. When the renderer changes,
  its anchors can go stale; it now reports "the mutation did not apply" separately from "the check
  did not fire", because those look identical in a pass count and have opposite causes.
- **House rules are the product.** `server/prompts/houseRules.ts` was rebuilt against four sites
  Chris built by hand. The section skeleton is fixed; palette, heading case and density vary by
  trade. Do not loosen it to make a build pass.
- **No performance claims anywhere in customer-facing copy.** No rankings, positions, traffic
  volumes or timeframes. Australian Consumer Law, and `test/pages.copy.test.ts` greps for it.
