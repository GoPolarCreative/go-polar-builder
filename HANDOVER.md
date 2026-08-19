# Handover

Written 2026-08-19, end of day. For someone with no memory of today.

## State

**Working tree is clean.** Everything is committed, nothing stashed, no half-applied change.
Last commit: `baf1b37` "Sell additional pages: a build is now a page set".

- **Typecheck:** clean (`npx tsc -b`)
- **Tests:** 326 passing, 13 files (`npm test`)
- **Build:** clean, client bundle secret scan passes (`npm run build`)
- **Sample:** 3 pages, all 17 checks passing on each (`npm run sample`)
- **Dev server and embedded database:** both shut down. The PGlite database was verified healthy
  by opening it through `npm run db:migrate`, which closes it properly on the way out.

Nothing was left mid-refactor. Work stopped at a deliberate boundary, described below.

## Where the multi-page feature actually got to

The $220 build token buys one page. Each $25 Additional DIY Page buys another, and an additional
page is a dedicated service page at `/services/<service>/`.

### Done, committed, tested

- **Product** `additional-page` in `shared/pricing.ts`. Real Shopify ids: variant `62852241948831`,
  product `10930420875423`, SKU `additional-page`, $25.00 inc GST, one-off.
- **Entitlement.** `jobs.pages_allowed` (default 1). The `orders/paid` webhook increments it by the
  line item **quantity**, tops up an existing job rather than replacing, is idempotent on retry, and
  sorts the build-token line to the front of the order so pages bought in the same checkout are not
  dropped. 8 tests in `test/pages.entitlement.test.ts`, both directions.
- **Page set library** `server/lib/pages.ts`: URL structure, slugify, relative links, per-page
  canonicals, `sitemap.xml`, `robots.txt`, `BreadcrumbList`, `Service` schema, and
  `enforcePagesAllowed` which trims to what was paid for and reports what it dropped.
- **Renderers.** `server/lib/render/servicePage.ts` and `server/lib/render/set.ts`. The service page
  imports the same stylesheet, cards and form as the home page, so the set is one design system.
- **Per-page verification.** `verifySet` in `server/lib/verify.ts`. All 17 checks run on every page
  and the set passes only if every page passes. `assets_exist` was made page-aware so `../../assets/`
  resolves.
- **Schema.** `servicePages` on the plan, `ownPageServices` on intake, `build_pages` table, migration
  `0002_even_redwing.sql` (applied locally).
- **Copy.** `shared/pages-copy.ts`, with `test/pages.copy.test.ts` grepping it and the two components
  that render it for ranking, position, traffic, growth, timeframe and guarantee claims.
- **UI.** Per-service page picker in intake step 2; explanation block in the preview.
- **Sample.** `sample/` is a real 3-page set with sitemap and robots, committed.

### NOT done. This is the gap.

The set path is built and tested but **is not wired into the live job flow**. A real customer's job
still produces a single `index.html`. Specifically:

1. `server/routes/generate.ts` calls the single-page renderer, not `renderSiteSet`, and writes no
   `build_pages` rows.
2. `publishSite` in `server/lib/publish.ts` publishes one file.
3. The discharge zip packages one file.
4. The edit loop does not target a page; edits apply to the home page.
5. The preview page switcher renders and `/versions` returns the page list, but the iframe always
   loads the home page.

Roughly a day. All of it is the same shape as what is already there.

## First three things when work resumes

1. **Wire the set into generation.** `server/routes/generate.ts`: call `renderSiteSet`, verify with
   `verifySet`, write one `build_pages` row per page, and pass `pagesAllowed` into
   `enforcePlanInvariants` so the allowance is actually enforced on a real build. Until this is done
   the feature is not real for a paying customer.
2. **Then publish and discharge the set.** `publishSite` and the discharge zip iterate pages. Watch
   the relative-link rule: the discharge zip is opened by double-click, so nothing may become
   root-absolute. There is a test for that in `test/pageset.test.ts`.
3. **Then the preview iframe and edit targeting.** Load the selected page, and let an edit name a
   page while still costing one round.

## Other open items, unrelated to multi-page

- **`extra-edits` has no price** and is not created on the store. It degrades correctly and blocks
  nothing. The only outstanding price decision.
- **Copy awaiting Chris's sign-off:** design style labels (D28), the three product descriptions
  (D35), the inc-GST display decision (D31), the additional-pages copy (D44).
- **Shopify:** register the `orders/paid` webhook and copy the ids into Vercel. See SHOPIFY-SETUP.md.
- **`.env.local` gotchas:** `DEV_OFFLINE_GENERATION=1` is set, so the real Anthropic key is ignored
  and builds come from the offline fixture. `APP_SECRET` is empty, which is fine in demo mode and a
  500 with `DEMO_MODE=0`.

## Running it

```bash
npm run dev     # localhost:5173, demo mode, no accounts needed
npm run seed    # prints two signed-in links
npm test
npm run sample  # rebuilds the committed sample
```

Stop the dev server with Ctrl-C rather than killing the process. It closes the embedded database on
the way out; a hard kill has corrupted it before and cost time.
