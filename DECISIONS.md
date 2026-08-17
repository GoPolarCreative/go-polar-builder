# Decisions log

Every judgement call made during the build that the brief did not settle, what was chosen, and
what would have to change if Chris disagrees. Written as they were made, newest phase last.

Nothing customer-facing was invented. Where a number or a promise was missing, it is behind a
config constant or absent from the UI entirely, not guessed.

---

## D1. Payments go through Shopify, not Stripe

**Question.** Phase 6 of the build order says "Stripe". Section 3 and section 3a of the same
brief say all payments, one-off and recurring, go through Shopify.

**Chosen.** Shopify. Section 3a describes the entry flow, the webhook, the HMAC verification and
the reconciliation job in detail, so it is clearly the intent. "Stripe" in the build order reads
as a leftover.

**If Chris disagrees.** `worker/lib/shopify.ts` is the only file that knows about the payment
provider. The webhook route, the checkout-link builder and the order-to-job matching all live
there. `orders` rows store `shopify_order_id` and `product_handle`, which would become
`stripe_*` columns. Roughly a day of work, no schema rewrite.

---

## D2. `extra-edits` price is unset, not invented

**Question.** The pricing table lists "Additional 5 edits before launch, TBC, confirm with Chris".

**Chosen.** `PRICING.extraEdits.exGstCents` in `shared/pricing.ts`, set to `null`. Every other
price in that file is a real number from the brief, in cents, ex GST.

While it is null the UI does not show a price or a buy button for extra edits. It offers to put
the customer in touch instead, and the "you have used all 10" screen still offers going live,
which is the other real option. Setting the constant to a number turns the whole path on with no
other change.

**If Chris disagrees.** Set the number. Also create the `extra-edits` product in Shopify with
that handle and set `SHOPIFY_VARIANT_EXTRA_EDITS` in the Worker environment. Nothing else
changes: the offer, the checkout and the webhook handling that adds the 5 edits are all built.

---

## D3. Edits update the plan, then rebuild from it

**Question.** The brief says the content plan is "the editable source of truth" but does not say
whether an edit regenerates the plan, the HTML, or both.

**Chosen.** Both, in that order. An edit request goes to the model with the current plan and
returns a revised plan, which is validated by the same zod schema as a first build and put
through the same server-authoritative overrides. The HTML is then rebuilt from the revised plan,
with the previous HTML supplied as reference and an explicit instruction to leave everything the
plan did not change alone. Temperature is 0.1 for edits against 0.3 for first builds.

**Why not edit the HTML directly.** It drifts. The plan stops describing the site, and by edit
seven the "source of truth" is fiction. Rollback and the discharge export both read the plan.

**Cost of this choice.** A one word copy change costs a full rebuild. Prompt caching on the house
rules block absorbs most of it. The visible risk is unrelated drift between versions, which is
what the "change nothing else" instruction and the low temperature are there to hold down. Worth
watching in review: if drift shows up, the fix is a targeted section rebuild rather than
abandoning the plan.

---

## D4. Rollback does not consume an edit, and never destroys history

**Question.** The brief says rollback does not consume an edit. It does not say what happens to
versions after the one you roll back to.

**Chosen.** Rollback is a pointer move. `jobs.current_version` changes, every version stays in R2
and in the `builds` table, and the roll-back is written to `edits` with `counted = 0` and a null
prompt. Rolling forward again is therefore possible, and nothing a customer paid for is deleted.

---

## D5. Passing the edit limit escalates, it does not block

**Question.** "At 0 remaining: offer 5 more for a fee, or go live. Do not hard block, escalate to
Chris rather than let someone sit stuck and angry."

**Chosen.** At 0 remaining the UI leads with going live and with getting in touch about more
edits. If the customer submits another edit anyway, it runs. The job is marked as being over its
allowance, an `edit.overage` event is written, and that event is one of the GHL notifications so
Chris sees it the same day. The counter shows "0 of 10 remaining" and stops going negative in the
customer's view, while `edits_used` keeps counting honestly in the database.

---

## D6. Domain lookups use RDAP and DNS over HTTPS, with WHOIS over TCP as a fallback

**Question.** Screen 2 of the go-live flow needs WHOIS and MX lookups. Workers cannot open
arbitrary sockets in the way a server can, and no third-party lookup API key is available.

**Chosen.** Three real mechanisms, no key required:

- registration data from RDAP over HTTPS, with the endpoint for each TLD resolved from the IANA
  bootstrap at `data.iana.org/rdap/dns.json` rather than guessed. This matters: the .au service
  lives at `rdap.cctld.au`, which is not a hostname anyone would guess, and the first version of
  this code guessed wrong. `rdap.org` is kept as a last-resort fallback.
- MX, NS and A records from Cloudflare DNS over HTTPS at `cloudflare-dns.com/dns-query`
- if RDAP has nothing, WHOIS on port 43 through `cloudflare:sockets`, which Workers do support

The lookups are then read into plain English for the customer: registrar, nameservers, who
appears to be hosting the site, and who is handling the mail. That is the screen the brief asks
for, and it is more reliable than asking a tradie where their domain is.

**Availability for branch B** comes from RDAP returning 404, which is a real signal.
**Registration does not.** There is no registrar API and no account to charge, so a purchase is
queued for a human with the ABN and entity name already collected. The customer is told a person
will be in touch within one business day, which is the promise the brief allows. Nothing tells
them the domain is bought when it is not.

**If Chris disagrees.** Wire a registrar API (Cloudflare Registrar has no .au, so realistically
Synergy Wholesale or VentraIP for .au) into `worker/lib/domains.ts` behind the same interface.

---

## D7. Favicons come from the logo, or are generated as SVG

**Question.** The discharge package must include a favicon. Nothing says where it comes from.

**Chosen.** If a usable logo was uploaded, it ships as the favicon. If not, an SVG favicon is
generated with the business initials on the brand primary colour. SVG because a Worker cannot
encode a PNG without shipping a codec, and SVG favicons are supported everywhere that matters
now. A PNG fallback link is included for older browsers only when a logo exists.

---

## D8. The discharge zip is written by hand, stored uncompressed

**Question.** Packaging `index.html`, `assets/`, the favicon and a standalone preview into a zip,
inside a Worker, with no zip library available.

**Chosen.** A minimal ZIP writer in `worker/lib/zip.ts`, store method, no compression. Images are
already compressed, and the HTML is the only thing that would benefit. It keeps the dependency
count at zero and the format is a documented one that every unzip tool reads.

---

## D9. Discharge without a customer Web3Forms key ships a commented placeholder

**Question.** The brief requires the key swap, and says to prompt for their own key, validate it
as a UUID, and rebuild, "or replace with a clearly commented placeholder and tell them plainly it
must be changed".

**Chosen.** Both paths are built. The discharge screen asks for their key and validates the UUID
before it will accept it. If they do not have one, the export goes ahead with
`YOUR-WEB3FORMS-ACCESS-KEY-GOES-HERE` in place of the Go Polar key, an HTML comment above each
form explaining what it is and where to get one, and a `READ-ME-FIRST.txt` in the zip saying the
forms will not work until it is replaced. Go Polar's key never leaves in an exported file either
way, which is the actual point of the rule.

---

## D10. Sessions are signed cookies, not stored sessions

**Question.** "Token link by email. No passwords." Nothing specifies the session mechanism.

**Chosen.** The build token is a random 32 byte value; only its SHA-256 hash is stored, so the
database never holds anything that can be used to log in. On first click it is exchanged for a
session cookie containing the job id and an expiry, signed with HMAC-SHA256 using `APP_SECRET`.
HttpOnly, Secure, SameSite=Lax, 90 days, matching the token life.

Stateless verification means no session table and no read on every request. The trade is that
revoking a single session before it expires requires rotating `APP_SECRET`, which logs everyone
out. For a tool where the worst case is somebody else seeing a half-built website for a business
that is about to publish it, that is an acceptable trade.

**If Chris disagrees.** Add a `sessions` table and check it in `requireSession`. One file.

---

## D11. Resend and GoHighLevel fail loudly, and never take a payment down with them

**Question.** What happens when the build link email cannot be sent, or GHL is unreachable, at
the moment a Shopify webhook arrives.

**Chosen.** The webhook does the database work first and commits it, then attempts email and GHL.
A failure in either is caught, written to `events` as `email.failed` or `ghl.failed` with the
real error, and the webhook still returns 200 so Shopify does not retry a payment that was
already recorded. The nightly reconciliation job picks up any job that is paid but has never had
a link emailed and tries again.

A paying customer who never receives a link is called out in the brief as the worst possible
failure in this system, so it has two independent paths to being caught.

---

## D12. Cron runs hourly, not nightly

**Question.** The brief says a nightly job reconciles missed Shopify webhooks.

**Chosen.** Hourly. The cost is one Worker invocation an hour, and the difference to the customer
is waiting an hour rather than most of a day for a link that never arrived. The same handler also
sweeps the two time-based GHL events, intake abandoned after 24 hours and stalled in editing for
72 hours, which need to be checked more often than daily to fire near the right time.

**If Chris disagrees.** One line in `wrangler.jsonc`.

---

## D13. The generated site is not deployed by this app yet

**Question.** Going live implies hosting the generated site somewhere.

**Chosen.** Out of scope, and deliberately so. The go-live flow takes the payment, collects the
domain, queues the connection and notifies Chris, which is exactly what section 8 describes. It
does not push the site anywhere, because the brief never says where hosting lives and guessing
would mean inventing infrastructure.

The pieces are in place for whatever comes next: every build is a single self-contained
`index.html` plus assets in R2, and the discharge packager already assembles the complete file
set. Publishing to Cloudflare Pages, to R2 behind a custom domain, or to a third-party host is
one function away.

---

## D14. No live deploy was run

Instructed explicitly, and it matches the credential situation. `wrangler.jsonc` is complete,
the deploy command is documented, the cron trigger is configured, and every secret is listed.
`npx wrangler deploy` is the only step left, after `wrangler d1 create` supplies a real
`database_id` and the secrets are set.

---

## D15. Colour tokens over a customer-chosen theme

**Question.** Nothing in the brief says whether the customer can restyle the site during the edit
loop.

**Chosen.** They can, through ordinary edits ("make the buttons darker"), which go through the
plan and end up changing `tokens` in the plan JSON. There is no separate theme editor. Adding one
before seeing whether customers actually ask for it would be guessing at a feature.

---

## D17. The webhook refuses rather than degrades when it cannot verify

**Question.** What should `/api/webhooks/shopify` do when `SHOPIFY_WEBHOOK_SECRET` is not set?

**Chosen.** Return 503 and process nothing. The alternative, accepting unverified payloads on an
unconfigured install, would let anyone POST themselves a paid job, and it would do it quietly.
The refusal is logged as `webhook.refused` so it is obvious in the event trail rather than
looking like Shopify never called.

The same principle runs through the whole Phase 6 surface: the dev-only routes (job creation,
manual sweep, verification self-test) refuse the moment a Shopify secret exists, so a production
deployment cannot be left with a door open by forgetting a flag.

---

## D18. Scripts authenticate with a bearer token, not a cookie jar

**Question.** Every job route sits behind a session cookie now. The seed script and any command
line testing need to act as a customer.

**Chosen.** `readSession` accepts the same signed value from either the cookie or an
`Authorization: Bearer` header, and the dev job-creation route returns the raw session alongside
setting the cookie. It is the same signed value with the same expiry and grants nothing extra, so
there is no second auth path to keep secure. It also means the seed script proves the auth layer
works rather than tunnelling under it.

The dev route additionally mints a real build token and prints the `/start?t=...` link, so a
browser can sign in exactly the way a paying customer does.

---

## D19. Admin actions are gated by a shared token, not by a user model

**Question.** Releasing a discharge package is a human step performed by Chris. There is no staff
login, and building one was not asked for.

**Chosen.** `ADMIN_TOKEN` in Worker secrets, sent as `x-admin-token`. If it is not set, the admin
routes refuse on any install that has Shopify configured, and allow on a development one. It is
one shared secret for one person, which is honest about the size of the team.

**If Chris disagrees, or when someone else joins.** Replace `requireAdmin` with a real staff
session. One function, one file.

---

## D20. Timestamp comparison convention

Not a preference, a trap worth writing down. Every timestamp column holds an ISO 8601 string
(`2026-08-18T07:05:00.123Z`). SQLite's `datetime('now')` returns `2026-08-18 07:05:00`, and
string comparison places every ISO value above every `datetime('now')` value. A sweep query
written with `created_at < datetime('now')` returns nothing, forever, silently.

All queries bind an ISO string computed in JavaScript. There is a warning at the top of
`db/schema.sql` so the next person does not have to find this out the way it was found here.

---

## D22. Vercel, Postgres and Vercel Blob, with an embedded Postgres for local work

**Question.** The stack moved from Cloudflare to Vercel. Postgres from the marketplace was
specified, Neon by default. But local preview has to run on a fresh clone with no accounts, and
Neon is an account.

**Chosen.** One Drizzle schema and one set of migrations, run against two drivers:

- **postgres** through postgres.js, pointed at Neon (or any Postgres) in production
- **pglite**, which is Postgres compiled to wasm running inside the Node process, for local work

PGlite is real Postgres, so the SQL, the types, the enums and the migrations are identical rather
than approximated. `npm run dev` on a fresh clone creates and migrates the local database on boot
with nothing installed and nothing signed up for.

**What was migrated, not rewritten.** The intake wizard and its validation, the house rules
prompt, both generation calls, the sectioned fallback, the verification checks, the gap audit, the
data model and the Shopify webhook handling are all the same code. What changed underneath:
D1 to Drizzle over Postgres, R2 to Blob, `HTMLRewriter` to a Node HTML parser, `cloudflare:sockets`
to `node:net`, Worker secrets to environment variables, and the `env` binding threaded through
every function to a `config()` read. The mechanical parts of that are in `scripts/migrate-env.mjs`
and `scripts/migrate-images.mjs`, kept so the migration commit is legible.

**The one Cloudflare thing that was NOT a product dependency.** Domain lookups used Cloudflare's
DNS-over-HTTPS resolver. That now defaults to Google Public DNS and is configurable, so no
Cloudflare service is contacted at all. The `Cloudflare` string that remains in
`server/lib/domains.ts` is a signature used to tell a customer who currently hosts their domain,
which is data about them, not a dependency of ours.

---

## D23. Render checks sit behind a driver interface, with Playwright first

**Question.** Cloudflare Browser Rendering has no Vercel equivalent, and checks 13 to 16 need a
headless browser.

**Chosen.** A `RenderDriver` interface with one browser-side probe shared by every implementation,
so all of them measure the same things:

- **playwright** (default). On Vercel, `@sparticuz/chromium`, a Lambda-sized build, in a Node
  function with 2GB memory and a 300 second limit. Locally, whichever Chrome or Edge is already
  installed, so nothing is downloaded.
- **hosted**. A remote Chromium over CDP, for when the bundled browser's size or cold start is not
  worth it. Set `RENDER_DRIVER=hosted` and `BROWSERLESS_URL`.
- **none**. Explicitly skip.

Checks 1 to 12 and 17 need no browser and run regardless, which is the property that matters: the
majority of real faults are caught with no browser at all.

**Status.** Playwright against a locally installed browser has been run and all four checks pass
against the sample site, which is the first time checks 13 to 16 have ever executed on this
project. The bundled `@sparticuz/chromium` path on Vercel is written but unrun, because nothing
has been deployed. If its cold start turns out to be unworkable, switching to `hosted` is one
environment variable and no code.

---

## D24. Client sites are served from Blob through one function, by hostname

**Question.** The $30/month product is hosting the generated site, and it now has to run on
Vercel.

**Chosen.** At go live, the stored `index.html` is rewritten so every asset path becomes an
absolute URL to the stored file, and the result is saved as that site's live document. A request
arriving on a customer hostname is answered by the API function with that document. Domains are
attached to the project with the Vercel Domains API, which is what issues the certificate.

**Why this split.** One function invocation serves the HTML, which is tens of kilobytes. The
images, which are the actual bandwidth, come straight from Blob with a one year immutable cache
header and never touch compute. Serving images through a function would pay for the bytes twice,
once in bandwidth and once in invocation time.

**Not done, deliberately.** Nothing is deployed and no domain has been attached, so this path is
written and unit tested but has not served a real request.

---

## D25. Images are processed at upload, and the bandwidth maths behind it

**Question.** Vercel bills bandwidth. R2 did not. These are static single-file sites with plain
image tags, so there is no framework image pipeline downstream: whatever byte size is stored is
the byte size every visitor downloads, on every site, forever.

**The maths.** 50 client sites, up to 20 photos each, originals up to 10MB. Serving originals
would be up to 200MB of images on a single page. A thousand visits to one such site is 200GB.
Vercel Pro includes 1TB, then $0.15/GB. Five site-months of that pattern eats the entire included
allowance, and every month after that is a bill that grows with the customer's success. Against
$30/month per site, that is the difference between hosting being profitable and hosting being a
liability.

**Chosen.** Nothing that was uploaded is ever served.

- The original is stored, untouched, for rebuilds only.
- A web derivative is generated, capped at 1920px on the longest edge.
- A thumbnail is generated at 800px, and the gallery grid uses that, not the full width file.
- Each is encoded as WebP with a JPEG fallback, and the generated site uses `<picture>` so every
  browser takes the smaller file it supports.
- EXIF orientation is honoured, or half the phone photos land sideways.

**Measured on the committed sample:** 10.1MB of originals become a 1.4MB page. The fixture
images are gaussian noise, which is close to the worst case for a compressor; real photographs do
considerably better.

**Check 17** enforces it. The page weight, HTML plus every asset the page actually fetches, is
computed on every build, recorded on the build row, warned above 2.5MB and failed above 5MB
against a 2MB target. It is a static check: no browser needed, so it always runs.

**If Chris wants to raise the quality ceiling.** The knobs are all in `server/lib/images.ts`:
`WEB_MAX_EDGE`, `THUMB_MAX_EDGE` and the quality constants. Going from 1920px to 2560px, or WebP
quality 78 to 88, roughly doubles image bytes and therefore roughly doubles the bandwidth cost per
visit. That is a real trade to make deliberately, not a setting to nudge.

---

## D26. Local preview is a first-class deliverable

**Question.** Nothing may deploy, bill, email a real person or touch a domain before it has been
looked at on a laptop.

**Chosen.** Three layers, so an accident cannot become a live action:

1. **Demo mode.** Every outbound integration is behind an interface with a local fake. Shopify,
   Resend, GoHighLevel, WHOIS and the registrar all have one, and each fake logs what it would
   have done: `FAKE RESEND: would send build link to x@y.com`. Demo mode is the default when
   nothing is configured.
2. **Live switches.** Payments, email, CRM and domains each have an `ENABLE_LIVE_*` flag, off in
   the example config. A blocked action throws an error naming the flag rather than silently doing
   nothing, because a silent no-op in a payment path is indistinguishable from success.
3. **The webhook is inert.** It refuses in demo mode and refuses without a signing secret, so
   pointing a real webhook at a preview install does nothing.

The demo checkout is worth calling out: it does not simulate the outcome, it runs the same
`processPaidOrder` the real webhook runs. The flows after payment are therefore exercised by the
production code path rather than a parallel imitation of it.

**The sample site** is committed to the repo as real files at `sample/index.html`, with its
verification report beside it, so it can be judged by double clicking with no server, no key and
no setup. It is built by the offline fixture, not the model, and both the folder and the report
say so.

---

## D21. Test strategy

Unit tests run inside workerd through `@cloudflare/vitest-pool-workers`, because the verification
checks use `HTMLRewriter` and there is no honest way to test them outside the runtime they run
in. Fixtures live in `test/fixtures/`.

The 16 checks are covered both ways: a known-good document must pass every check, and a set of
deliberately broken documents must each trip the specific check that owns that fault and nothing
else. Checks 13 to 16 cannot be unit tested without Browser Rendering, so what is tested there is
that they report `skipped` rather than `pass` when the binding is missing, which is the property
that actually protects a customer.
