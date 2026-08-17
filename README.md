# Go Polar Website Builder

A self-serve web app where Australian trade businesses pay $200, answer a guided set of
questions, and watch a complete single-page website get generated in front of them.

Built to the build brief dated 17 Aug 2026. **Phases 0 to 3 are done. Phase 4 has not started.**

---

## Where the build is up to

| Phase | Scope | Status |
|---|---|---|
| 0 | Scaffold, D1 schema, R2, wrangler config, runs locally | done |
| 1 | Intake wizard, validation, suburb and ABN lookups, R2 uploads, logo colour sampling, gap audit, seeded test business | done |
| 2 | Two-call generation, streaming, sectioned fallback, cached house rules | done |
| 3 | All 16 verification checks, repair loop, hold and notify | done, with one caveat below |
| 4 | Preview, edit loop, version history, rollback | not started |
| 5 | Go live, domains, discharge | not started |
| 6 | Auth, Shopify, GHL, deploy | not started |

**The caveat:** checks 13 to 16 need Cloudflare Browser Rendering, which is a paid binding and
does not exist locally. Their code is written and wired up, but they have never executed. They
report `skipped`, never `pass`, so nothing false ever reaches a customer. See
[Verification](#verification) below.

---

## Running it

Requires Node 20 or newer.

```bash
npm install
cp .env.example .dev.vars      # then edit .dev.vars, see below
npm run db:migrate:local       # applies db/schema.sql to the local D1
npm run dev                    # http://localhost:5173
```

One process runs everything: Vite serves the React client and the Cloudflare plugin runs the
Worker in workerd with real local D1 and R2 bindings.

Seed a realistic test business (run it in a second terminal while `npm run dev` is going):

```bash
npm run seed
# prints a JOB_ID, then open http://localhost:5173/build/<JOB_ID>
```

If Vite reports the port is in use it will move to 5174. Point the seed at it with
`BASE=http://localhost:5174 npm run seed`.

### .dev.vars

`.dev.vars` is gitignored and holds local secrets. The two that matter right now:

```
ANTHROPIC_API_KEY=sk-ant-...     # real generation
DEV_OFFLINE_GENERATION=1         # deterministic offline fixture, no API key needed
```

With no `ANTHROPIC_API_KEY` set, generation fails with a clear error unless
`DEV_OFFLINE_GENERATION=1` is on. That flag runs a hand-written fixture through the exact same
plan, build, verify and store pipeline. **It is a test harness, not the product.** The real
output comes from the two Anthropic calls. Never set it in production.

### Other commands

```bash
npm run typecheck      # both projects, strict
npm run build          # typecheck, build, then scan the client bundle for secrets
npm run check:bundle   # the secret scan on its own
npm run db:reset:local # wipe local D1 and R2 state and re-apply the schema
```

`npm run build` fails if an Anthropic key, a Shopify token or even the string `x-api-key` turns
up in `dist/client`. Brief section 14 calls that a build failure, so it is one.

---

## How it is laid out

```
shared/     types, zod schemas, trades, suburbs, ABN and phone. Imported by BOTH sides,
            so client and server validation cannot drift.
worker/     Hono API. routes/ is thin, lib/ does the work, prompts/ holds the system prompts.
src/        React intake wizard and the build screen.
db/         D1 schema.
scripts/    seed, local db reset, client bundle secret scan.
```

The generated sites share nothing with this app. They are single-file vanilla HTML with their
own `:root` tokens, no framework, no build step.

---

## The pipeline

```
intake submitted
  -> gap audit (worker/lib/audit.ts)          never blocks, always flags
  -> call 1: content plan (JSON, validated against shared/plan.ts)
  -> server overrides the plan's facts (worker/lib/generate.ts)
  -> call 2: build, streamed to the browser
  -> truncated? sectioned fallback, assembled server side
  -> verification, up to 2 repair passes
  -> pass: stored, job moves to preview
     fail: job held, Chris notified, customer never sees it
```

### The two calls

**Call 1** produces the content plan. That plan is the editable source of truth and is what
Phase 4's edit loop will operate on. It is validated against a strict zod schema, and a failure
gets one corrective retry with the validation errors fed back.

**Call 2** produces the HTML and streams it to the browser, because watching the site assemble is
the product.

Both calls mark the system prompt with `cache_control: ephemeral`. The house rules block is large
and byte-identical on every build, which is what prompt caching is for. **Do not interpolate
anything into `HOUSE_RULES`.** One changed character invalidates the cache for every job.

### Server-authoritative facts

The model writes copy. It is never trusted with facts. `enforcePlanInvariants` in
`worker/lib/generate.ts` overwrites, on every build:

- testimonials, which exist only if real reviews were supplied, and only verbatim
- the gallery, which is off below 3 usable photos, with no stock photography substituted
- the suburb list, the schema.org type, `areaServed`, `sameAs` and the geo coordinates
- every stat counter, which must match a number that exists in the intake

`BuildFacts` (`worker/lib/facts.ts`) carries the things the model may not reword at all: phone
numbers, the Web3Forms key, form subject lines and asset paths.

### Sectioned fallback

A finished site runs 80 to 150KB and one response may not carry it. Truncation is detected from
`stop_reason` and a missing `</html>`. The fallback generates the head and the complete
stylesheet first, then each section against that stylesheet, then **the server** concatenates
them. Assembly server side is the point: it cannot forget a section.

---

## Verification

Runs after every generation, before the customer sees anything. All 16 checks from brief
section 6.

**Checks 1 to 12, static, in the Worker.** Structure via HTMLRewriter, text rules over the raw
source. Every failure carries evidence, which is fed into the repair prompt verbatim.

**Checks 13 to 16, render, via Browser Rendering.** Loads at 1440px and 390px, checks for console
errors and horizontal overflow, scrolls to the bottom before checking that every image resolved
(lazy images report `naturalWidth` 0 until they enter the viewport, so the scroll is the check),
and exercises the accordions and counters.

The binding is commented out in `wrangler.jsonc` because it needs a paid plan and stops local dev
booting. Uncomment before deploying. Until then those four report `skipped` with a reason
attached. They never report `pass`.

**Repair loop:** on failure the failing checks go back to the model, maximum 2 attempts. Still
failing means the job is held, an event is written for the GHL notification in Phase 6, and the
customer is shown a holding message rather than a broken site.

### Proving the checks work

A check that never fails is not a check. There is a self-test that takes a passing build, breaks
it twelve specific ways, and asserts each break is caught:

```bash
curl http://localhost:5173/api/dev/selftest/<JOB_ID>/1
```

Last run: baseline passes, 12 of 12 mutations caught, no false positives.

---

## Things a reviewer should know

Each of these is flagged in the code as well.

1. **The visual reference was not available.** The brief names the Gildon Constructions and CWM
   Modular screenshots. They live in the Claude project, not in this session. The visual
   direction in `worker/prompts/houseRules.ts` is reconstructed from the written spec. Compare a
   real generated build against those two sites and tighten the prompt, not the code.

2. **The suburb dataset is a development seed**, about 150 localities in `shared/suburbs.ts`,
   with approximate centroids. Replace it with the Australia Post or G-NAF locality data before
   launch. Everything goes through the `SuburbProvider` interface, so it is a one-file change.

3. **Address autocomplete is partial.** Street-level autocomplete needs a Places or Geoscape key
   that is not configured. The suburb comes from the verified dataset and the street line is
   typed. The suburb is what drives NAP and geo tags, so the half that matters is verified.

4. **ABN validation is checksum only.** That catches typos. The live ABR lookup belongs at .au
   domain purchase in Phase 5, where auDA needs the registered entity name to match.

5. **Image analysis happens in the browser.** A Worker has no image decoder. `src/lib/image.ts`
   computes dimensions, flat-colour ratio, distinct colours, transparency and a photographic
   score at upload time, and the gap audit uses them to spot mockup renders and wide lockups.
   They are advisory: nothing security relevant depends on them.

6. **There is no auth yet.** A job id is currently the only thing between a caller and a job.
   Fine locally, not fine in production. The middleware slot is marked in `worker/index.ts`, and
   the dev-only routes refuse to run once `SHOPIFY_WEBHOOK_SECRET` is set.

7. **`database_id` in `wrangler.jsonc` is a placeholder.** Replace it with the id from
   `npx wrangler d1 create go-polar-builder` before deploying. Local dev ignores it.

## Open questions for Chris

- Price for `extra-edits`, the additional 5 edits before launch. Listed as TBC in the brief and
  not invented here.
- Whether the Shopify storefront is framed business to business. Ex GST display is normal for
  ABN holders, but Australian Consumer Law wants a single GST-inclusive total shown prominently
  to consumers. Worth a word with your accountant.
- Which subscription app is installed on Shopify, needed before Phase 6.
- The real Web3Forms key for `WEB3FORMS_ACCESS_KEY`. A placeholder UUID is used until then.
