# Go Polar Website Builder

A self-serve web app where Australian trade businesses pay $220 inc GST, answer a guided set of
questions, and watch a complete website get generated in front of them. They get 10 rounds of
changes, then choose to go live on Go Polar hosting or take the files elsewhere.

The build token buys one page. Additional pages are $25 inc GST each: one service, its own URL at
`/services/<service>/`, its own copy, its own enquiry form and a link in the navigation.

Vercel, Postgres and Vercel Blob. Nothing is deployed. Nothing can charge money, email a real
person or touch a domain unless a flag is deliberately switched on.

---

# Preview It

Written for someone who has just cloned this and wants to look at it. In order.

## 1. Look at a finished website right now, no setup at all

Open this file by double clicking it:

```
sample/index.html
```

That is a complete generated site for a fictional plumbing business: sticky header, hero with a
quote form, services, gallery, animated counters, FAQ accordion, the lot. No server, no API key,
nothing to install. It works offline.

Beside it, `sample/verification.json` is the check report for that exact file. Every check that
ran, and what it found.

**Two honest notes.** The photos are generated fixtures, not real job photos, because there are
none to use. And the copy was produced by the offline fixture generator rather than by Claude,
because no Anthropic key was available while building. Structure, styling, schema, forms, image
handling and every check are the real pipeline.

### The design styles, side by side

```
sample/styles/index.html
```

The committed sample is a three-page set: the home page plus two service pages. Every one of the
17 checks passes on every page.

The same business built four times, once per design style the customer can choose in step 5.
Identical intake, identical photos, identical copy, identical colours. Only the look differs. That
page links all four and lists exactly what changed between each pair. All four pass all 17 checks.

## 2. Run the whole app locally, still with no accounts

```bash
npm install
npm run dev
```

Open <http://localhost:5173>.

That is it. No database to install, no `.env` to write, no services to sign up for. It runs in
**demo mode**: the database is Postgres compiled to wasm running inside the process, files go to a
folder on disk, and Shopify, email, the CRM and the registrar are all local fakes that print what
they would have done.

You should see the builder front door with a status grid at the bottom showing `Demo mode: on`.

## 3. Load the test business and click through it

In a second terminal, with `npm run dev` still going:

```bash
npm run seed
```

It prints two links. Both sign you in exactly the way a paying customer would, through the real
token flow:

- **Start the wizard from scratch** lands on question one, five steps, all validation live.
- **Straight to generating a site** lands on a job with the intake already submitted, four photos
  uploaded and processed, ready to press the button.

On the second one, press **Start the build**. You will watch the HTML stream in, then the
verification checks run, then the finished site appear in an iframe. From there:

- **Looks good, let me make changes** opens the preview and edit screen. The changes counter, the
  version history and rollback all work.
- **I am ready to go live** starts with the enquiry inbox step: a Web3Forms key is required before
  anything can go live, and the key is tested with a real submission before it is accepted (faked
  in demo mode, and it says so). Then the three go-live screens. The checkout is a local pretend
  checkout: confirming it runs the same code a real Shopify webhook would.
- **Take your files elsewhere** packages a real zip you can download and unzip.

Watch the terminal while you do it. Every integration that would have fired prints a line:

```
FAKE KLAVIYO: would fire "build_purchased" so Klaviyo emails them  [to=jobs@coldfrontplumbing.com.au ...]
FAKE SHOPIFY: would create a checkout  [jobId=job_... lines=website-hosting-australia]
```

## 4. Run the checks yourself

```bash
npm test              # 278 unit tests
npm run sample:verify # all 17 checks against sample/index.html, using a real browser
```

`sample:verify` uses whichever Chrome or Edge is already installed. If there is none it reports
checks 13 to 16 as skipped, with the reason, and still runs the other thirteen.

## What this preview does NOT do

Nothing deploys. Nothing bills. No email leaves the machine. No DNS record changes. There is no
`npm run deploy`, on purpose: deploying is `npx vercel --prod` typed by a human.

---

## Status

| Phase | Scope | Status |
|---|---|---|
| 0 | Scaffold, schema, storage, config, runs locally | done |
| 1 | Intake wizard, validation, lookups, uploads, image pipeline, gap audit | done |
| 2 | Two-call generation, streaming, sectioned fallback, cached house rules | done |
| 3 | 17 verification checks, repair loop, hold and notify | done |
| 4 | Preview, edit loop, version history, rollback | done |
| 5 | Go live, three domain branches, RDAP and DNS lookups, discharge | done |
| 6 | Auth, Shopify, Klaviyo, cron, demo mode, deploy-ready config | done, deployed |

**278 unit tests.** Plus a 45-check end-to-end script and a verification self-test.

### What needs real credentials

Everything below is fully built and fails with an error naming the exact missing variable. None of
it is stubbed or silently skipped.

| Needs | For | Without it |
|---|---|---|
| `ANTHROPIC_API_KEY` | real generation and edits | Clear error, or `DEV_OFFLINE_GENERATION=1` for the fixture |
| `SHOPIFY_*` | checkout links, webhooks, reconciliation | Demo checkout locally; webhooks refuse; 503 naming the variable. **Six of seven products are live on the store; only extra-edits is unpriced: SHOPIFY-SETUP.md** |
| `KLAVIYO_API_KEY` | every customer email: build links, receipts, handover, recovery (D48) | Printed to the terminal in demo mode; recorded as `klaviyo.failed` and the build link retried by the sweep otherwise |
| `DATABASE_URL` | Neon in production | Embedded PGlite locally |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob | Local folder |
| `VERCEL_API_TOKEN` | attaching customer domains | Logged as a fake, nothing attached |
| Chrome or Chromium | checks 13 to 16 | Reported as `skipped`, never `pass` |

The two live integrations that need **no** credentials do work today and were tested against real
services: RDAP domain lookups and DNS over HTTPS.

---

## Layout

```
shared/     types, zod schemas, pricing, trades, suburbs, ABN and phone.
            Imported by BOTH sides, so client and server validation cannot drift.
server/     Hono API. routes/ is thin, lib/ does the work, prompts/ holds the system prompts.
api/        the Vercel function entry point. One line: it hands off to server/.
src/        React: intake wizard, build screen, preview and edit loop, go live, discharge.
db/         Drizzle schema and generated migrations.
sample/     the committed sample website and its verification report.
test/       unit tests.
scripts/    seed, sample builder, migrations, end to end, bundle secret scan.
```

The generated sites share nothing with this app. They are single-file vanilla HTML with their own
`:root` tokens, no framework, no build step.

---

## How it works

```
Shopify orders/paid -> HMAC verified -> user + job created -> Klaviyo emails the build link
  -> intake wizard, five steps, validated by one schema shared with the server
  -> uploads processed: original kept, web and thumbnail derivatives generated as WebP and JPEG
  -> gap audit (never blocks, always flags)
  -> call 1: content plan as strict JSON, validated, server overrides its facts
  -> call 2: HTML, streamed to the browser
  -> truncated? sectioned fallback, assembled server side
  -> 17 verification checks, up to 2 repair passes
  -> pass: preview. fail: job held, Chris notified, customer never sees it
```

### The two calls

**Call 1** produces the content plan, which is the editable source of truth and what the edit
loop, rollback and the discharge export all read. Validated against a strict zod schema with one
corrective retry.

**Call 2** produces the HTML and streams it, because watching the site assemble is the product.

Both mark the system prompt `cache_control: ephemeral`. The house rules block is large and
byte-identical on every build. **Do not interpolate anything into `HOUSE_RULES`**: one changed
character invalidates the cache for every job.

Function duration limits make the sectioned fallback more likely to be needed, not less, so it is
built, exercised and tested rather than merely present.

### The model is never trusted with facts

`enforcePlanInvariants` overwrites, on every build and every edit: testimonials (only real ones,
verbatim), the gallery (off below 3 usable photos, no stock substitute), the suburb list, the
schema.org type, `areaServed`, `sameAs`, the geo coordinates, and every stat counter, which must
match a number that actually appears in the intake.

### Images and page weight

Whatever a generated site references is what every visitor downloads, forever, and Vercel bills
the bandwidth. So originals are stored for rebuilds and never served. What ships is a 1920px web
derivative and an 800px thumbnail, each as WebP with a JPEG fallback, wired up with `<picture>`.
Galleries use thumbnails. Check 17 measures the total and fails the build above 5MB.

On the sample: 10.1MB of originals become a 1.4MB page. The full reasoning and the bandwidth
maths are in DECISIONS.md D25.

### Verification

**Checks 1 to 12 and 17** run in the API with no browser. Structure via a real HTML parser, text
rules over the raw source. Every failure carries evidence, and that evidence goes into the repair
prompt verbatim.

**Checks 13 to 16** need a browser, behind a driver interface: bundled Chromium on Vercel, an
installed Chrome or Edge locally, or a hosted browser over CDP. When none is available they report
`skipped`, never `pass`.

**Repair loop:** failing checks go back to the model, twice at most. Still failing holds the job,
notifies Chris, and shows the customer a holding message rather than a broken site.

Prove the checks work:

```bash
npm run sample:verify                            # all 17 against the sample
curl http://localhost:8787/api/dev/selftest/<JOB_ID>/1   # break a build 13 ways, assert each is caught
```

---

## Deploying

Nothing has been deployed. This is the whole list.

```bash
# 1. Provision, from the Vercel dashboard
#    - Postgres (Neon) from the marketplace
#    - a Blob store

# 2. Environment variables, from .env.example. At minimum:
#      APP_SECRET, PUBLIC_APP_URL, DATABASE_URL, BLOB_READ_WRITE_TOKEN,
#      ANTHROPIC_API_KEY, WEB3FORMS_ACCESS_KEY, DEMO_MODE=0
#    Then, only when you actually want them live:
#      ENABLE_LIVE_PAYMENTS, ENABLE_LIVE_EMAIL, ENABLE_LIVE_CRM, ENABLE_LIVE_DOMAINS

# 3. Migrate
DATABASE_URL=... npm run db:migrate

# 4. Deploy, deliberately
npx vercel --prod
```

Then in Shopify point the `orders/paid` webhook at
`https://<your-domain>/api/webhooks/shopify` with the same signing secret. The hourly cron is
already declared in `vercel.json`.

---

## Things a reviewer should know

1. **The visual reference was not available.** The brief names the Gildon Constructions and CWM
   Modular screenshots. They live in the Claude project, not in this session. The visual direction
   in `server/prompts/houseRules.ts` is reconstructed from the written spec. Compare the sample
   against those two sites and tighten the prompt, not the code.

2. **The sample was generated by the offline fixture, not by Claude.** With an API key the same
   pipeline calls the model instead. The fixture exists so the pipeline and the checks can run
   without one, and it is labelled everywhere it appears.

3. **The suburb dataset is a development seed**, about 150 localities in `shared/suburbs.ts` with
   approximate centroids. Replace it with Australia Post or G-NAF data before launch. Everything
   goes through the `SuburbProvider` interface, so it is a one-file change.

4. **Address autocomplete is partial.** Street-level autocomplete needs a Places or Geoscape key.
   The suburb comes from the verified dataset and the street line is typed. The suburb is what
   drives NAP and geo tags, so the half that matters is verified.

5. **ABN validation is checksum only.** The live ABR lookup belongs at .au domain purchase, where
   auDA needs the registered entity name to match.

6. **Domain registration is queued, not automated.** There is no registrar API and no account to
   charge. Availability is real, eligibility details are collected, a human completes the purchase.

7. **Serving live client sites is written but has never served a request**, because nothing is
   deployed. See DECISIONS.md D24.

## Open questions for Chris

- **Price for `extra-edits`.** TBC in the brief, so it is `null` in `shared/pricing.ts` and the UI
  offers to get in touch instead of showing an invented number. Everything else on that path is
  built.
- **Which subscription app is installed on Shopify.** Needed for the selling plan ids.
- **Whether the Shopify storefront is framed business to business.** Ex GST display is normal for
  ABN holders, but Australian Consumer Law wants a single GST-inclusive total shown prominently to
  consumers. Worth a word with your accountant.
- **The real Web3Forms key.**
- **Image quality ceiling.** The current settings put a finished page near 1MB. Raising them costs
  bandwidth on every visit forever; the trade is spelled out in DECISIONS.md D25.
