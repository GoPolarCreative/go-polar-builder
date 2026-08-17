# Go Polar Website Builder

A self-serve web app where Australian trade businesses pay $200, answer a guided set of
questions, and watch a complete single-page website get generated in front of them. They get 10
rounds of changes, then choose to go live on Go Polar hosting or take the files elsewhere.

Built to the build brief dated 17 Aug 2026. **All six phases are built.** Nothing has been
deployed. Read `DECISIONS.md` for every judgement call the brief did not settle.

---

## Status

| Phase | Scope | Status |
|---|---|---|
| 0 | Scaffold, D1 schema, R2, wrangler config, runs locally | done |
| 1 | Intake wizard, validation, suburb and ABN lookups, R2 uploads, logo colour sampling, gap audit | done |
| 2 | Two-call generation, streaming, sectioned fallback, cached house rules | done |
| 3 | All 16 verification checks, repair loop, hold and notify | done, 4 of 16 unrun (see below) |
| 4 | Preview, edit loop, version history, rollback | done |
| 5 | Go live, three domain branches, WHOIS and MX lookups, discharge | done |
| 6 | Auth, Shopify, Resend, GHL, cron sweep, deploy-ready config | done, not deployed |

**133 unit tests.** `npm test`.

### What cannot run without credentials

Everything below is fully built and fails with an error naming the exact missing variable. None
of it is stubbed, mocked or silently skipped.

| Needs | Missing | What happens without it |
|---|---|---|
| `ANTHROPIC_API_KEY` | real generation and edits | Clear error, or set `DEV_OFFLINE_GENERATION=1` for the deterministic fixture |
| Browser Rendering binding | verification checks 13 to 16 | Reported as `skipped`, never `pass` |
| `SHOPIFY_*` | checkout links, webhooks, reconciliation | Checkout returns 503 naming the variable; webhooks refuse outright |
| `RESEND_API_KEY` | build links, receipts, handover emails | Recorded as `email.failed` and retried hourly |
| `GHL_INBOUND_WEBHOOK_URL` | CRM notifications | Recorded as `ghl.failed`, never blocks a payment |
| `APP_SECRET` | sessions, build tokens, download links | Loud error naming the variable |

The two live integrations that need **no** credentials do work today and were tested against
real services: RDAP domain lookups and DNS over HTTPS.

---

## Running it

Requires Node 20 or newer.

```bash
npm install
cp .env.example .dev.vars      # then fill in what you have, see below
npm run db:migrate:local       # applies db/schema.sql to the local D1
npm run dev                    # http://localhost:5173
```

One process runs everything: Vite serves the React client, and the Cloudflare plugin runs the
Worker in workerd with real local D1 and R2 bindings.

Seed a realistic test business (in a second terminal, with `npm run dev` running):

```bash
npm run seed
```

It prints a `/start?t=...` link. Open it and you are signed in exactly the way a paying customer
would be, then the wizard, generation, preview, edits, go live and discharge all work end to end.

### Minimum .dev.vars to see it work

```
APP_SECRET=anything-long-and-random-for-local
PUBLIC_APP_URL=http://localhost:5173
WEB3FORMS_ACCESS_KEY=11111111-2222-3333-4444-555555555555
DEV_OFFLINE_GENERATION=1        # or set ANTHROPIC_API_KEY for real generation
```

`DEV_OFFLINE_GENERATION=1` runs a hand-written fixture through the exact same plan, build,
verify and store pipeline. **It is a test harness, not the product.** The real output comes from
the two Anthropic calls. Never set it in production.

### Commands

```bash
npm run dev            # everything, one process
npm test               # 133 unit tests, inside workerd
npm run typecheck      # all three projects, strict
npm run build          # typecheck, build, then scan the client bundle for secrets
npm run seed           # seed a test business through the real API
npm run db:reset:local # wipe local D1 and R2 state, re-apply the schema
```

`npm run build` fails if an Anthropic key, a Shopify token or even the string `x-api-key` turns
up in `dist/client`. Brief section 14 calls that a build failure, so it is one.

---

## Layout

```
shared/     types, zod schemas, pricing, trades, suburbs, ABN and phone.
            Imported by BOTH sides, so client and server validation cannot drift.
worker/     Hono API. routes/ is thin, lib/ does the work, prompts/ holds the system prompts.
src/        React: intake wizard, build screen, preview and edit loop, go live, discharge.
db/         D1 schema.
test/       unit tests, run inside workerd.
scripts/    seed, webhook signer, local db reset, client bundle secret scan.
```

The generated sites share nothing with this app. They are single-file vanilla HTML with their own
`:root` tokens, no framework, no build step.

---

## How it works

### Intake to first build

```
Shopify orders/paid -> HMAC verified -> user + job created -> build token emailed -> GHL
  -> intake wizard, five steps, validated by one schema shared with the server
  -> gap audit (never blocks, always flags)
  -> call 1: content plan as strict JSON, validated, server overrides its facts
  -> call 2: HTML, streamed to the browser
  -> truncated? sectioned fallback, assembled server side
  -> 16 verification checks, up to 2 repair passes
  -> pass: preview. fail: job held, Chris notified, customer never sees it
```

### The two calls

**Call 1** produces the content plan, which is the editable source of truth and what the edit
loop, rollback and the discharge export all read. Validated against a strict zod schema, with one
corrective retry that feeds the validation errors back.

**Call 2** produces the HTML and streams it, because watching the site assemble is the product.

Both mark the system prompt `cache_control: ephemeral`. The house rules block is large and
byte-identical on every build. **Do not interpolate anything into `HOUSE_RULES`**: one changed
character invalidates the cache for every job.

### The model is never trusted with facts

`enforcePlanInvariants` overwrites, on every build and every edit:

- testimonials, which exist only if real reviews were supplied, and only verbatim
- the gallery, which is off below 3 usable photos, with no stock photography substituted
- the suburb list, the schema.org type, `areaServed`, `sameAs`, the geo coordinates
- every stat counter, which must match a number that actually appears in the intake

`BuildFacts` carries what the model may not reword at all: phone numbers, the Web3Forms key, form
subject lines, asset paths.

### Verification

**Checks 1 to 12** run in the Worker. Structure via HTMLRewriter, text rules over the raw source.
Every failure carries evidence, and that evidence goes into the repair prompt verbatim.

**Checks 13 to 16** need Cloudflare Browser Rendering. The binding is commented out in
`wrangler.jsonc` because it needs a paid plan and stops local dev booting. Uncomment before
deploying. Until then those four report `skipped` with a reason. **They never report `pass`.**

**Repair loop:** failing checks go back to the model, twice at most. Still failing holds the job,
writes the event that becomes Chris's GHL notification, and shows the customer a holding message
rather than a broken site.

Beyond the unit tests there is a live self-test that takes a passing build, breaks it twelve
specific ways and asserts each break is caught:

```bash
curl http://localhost:5173/api/dev/selftest/<JOB_ID>/1
```

### Edits

One submitted request is one edit, however many changes it contains, and the placeholder text
says so. An edit revises the plan, then rebuilds the document from it with the previous version
supplied and an instruction to change nothing else. Rollback moves a pointer, costs no edit and
deletes no version. Passing the allowance escalates to Chris rather than blocking.

### Go live and discharge

Hosting starts billing at go live and not before. The job only advances when Shopify confirms the
checkout. Domain screen has the three branches from the brief, with real RDAP and DNS lookups
behind branch A and C, real availability behind branch B, and auDA eligibility collected up front
for .au. Nothing anywhere promises a connection timeframe.

Discharge packages `index.html`, `assets/`, both favicons, a standalone inlined `PREVIEW.html`
and a `READ-ME-FIRST.txt` into a zip. Go Polar's Web3Forms key never leaves in an exported file:
it is swapped for the customer's own validated key, or for a placeholder commented above every
form. Prepared by the automation, released by a human.

### The hourly sweep

Cron, `0 * * * *`. Four jobs, each because something goes missing silently otherwise:

1. paid Shopify orders with no matching job, because webhooks get dropped
2. jobs that are paid but whose build link never actually sent
3. intake abandoned for 24 hours, the warmest lead in the business
4. stalled in editing for 72 hours

---

## Deploying

Nothing has been deployed. This is the whole list.

```bash
# 1. Create the resources
npx wrangler d1 create go-polar-builder          # put the id in wrangler.jsonc
npx wrangler r2 bucket create go-polar-builder
npx wrangler r2 bucket create go-polar-builder-dev

# 2. Apply the schema
npm run db:migrate:remote

# 3. Set the secrets (see .env.example for what each one does)
npx wrangler secret put APP_SECRET
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put WEB3FORMS_ACCESS_KEY
npx wrangler secret put SHOPIFY_WEBHOOK_SECRET
npx wrangler secret put SHOPIFY_ADMIN_API_TOKEN
npx wrangler secret put SHOPIFY_STOREFRONT_TOKEN
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put GHL_INBOUND_WEBHOOK_URL
npx wrangler secret put ADMIN_TOKEN
# plus one SHOPIFY_VARIANT_* per product, and SHOPIFY_SELLING_PLAN_* per subscription

# 4. Uncomment the browser binding in wrangler.jsonc so checks 13 to 16 run

# 5. Deploy
npm run deploy
```

Then in Shopify, point the `orders/paid` webhook at
`https://<your-domain>/api/webhooks/shopify` and use the same signing secret.

---

## Things a reviewer should know

Each is flagged in the code as well.

1. **The visual reference was not available.** The brief names the Gildon Constructions and CWM
   Modular screenshots. They live in the Claude project, not in this session. The visual
   direction in `worker/prompts/houseRules.ts` is reconstructed from the written spec. Compare a
   real generated build against those two sites and tighten the prompt, not the code.

2. **Checks 13 to 16 have never executed.** No Browser Rendering binding exists locally. The code
   is written against the real API. They report `skipped` so nothing false reaches a customer,
   and that behaviour is unit tested.

3. **The suburb dataset is a development seed**, about 150 localities in `shared/suburbs.ts` with
   approximate centroids. Replace it with Australia Post or G-NAF locality data before launch.
   Everything goes through the `SuburbProvider` interface, so it is a one-file change.

4. **Address autocomplete is partial.** Street-level autocomplete needs a Places or Geoscape key
   that is not configured. The suburb comes from the verified dataset and the street line is
   typed. The suburb is what drives NAP and geo tags, so the half that matters is verified.

5. **ABN validation is checksum only.** That catches typos. The live ABR lookup belongs at .au
   domain purchase, where auDA needs the registered entity name to match.

6. **Domain registration is queued, not automated.** There is no registrar API and no account to
   charge. Availability is real, the eligibility details are collected, and a human completes the
   purchase. See DECISIONS.md D6.

7. **Image analysis happens in the browser.** A Worker has no image decoder. `src/lib/image.ts`
   computes the signals the gap audit uses to spot mockup renders and wide lockups. They are
   advisory: nothing security relevant depends on them.

8. **`database_id` in `wrangler.jsonc` is a placeholder.** Replace it with the real id before
   deploying. Local dev ignores it.

## Open questions for Chris

- **Price for `extra-edits`.** Listed as TBC in the brief, so it is `null` in
  `shared/pricing.ts` and the UI offers to get in touch instead of showing a number. Everything
  else on that path is built.
- **Which subscription app is installed on Shopify.** Needed for the selling plan ids.
- **Whether the Shopify storefront is framed business to business.** Ex GST display is normal for
  ABN holders, but Australian Consumer Law wants a single GST-inclusive total shown prominently
  to consumers. Worth a word with your accountant.
- **The real Web3Forms key.** A placeholder UUID is used until then.
- **Where the generated sites get hosted at go live.** The flow takes the payment, collects the
  domain and queues the connection, which is what section 8 describes. It does not publish the
  site anywhere, because the brief never says where hosting lives. See DECISIONS.md D13.
