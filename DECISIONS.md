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
price in that file is a decided number, in cents, ex GST. As of 2026-08-18 this is the only price
still open: hosting, domain and email were settled at $30, $5 and $14.95 per month ex GST. See D30.

While it is null the UI does not show a price or a buy button for extra edits. It offers to put
the customer in touch instead, and the "you have used all 10" screen still offers going live,
which is the other real option. Setting the constant to a number turns the whole path on with no
other change.

**If Chris disagrees.** Set the number. Also create the `extra-edits` product in Shopify with
that handle and set `SHOPIFY_VARIANT_EXTRA_EDITS` in the Vercel project environment. Nothing else
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

## D27. An editor that cannot edit says so, and never charges for it

**What happened.** Chris ran the app in demo mode, submitted a few change requests, and nothing
appeared to happen. The cause was not the obvious one. The request reached the server, the server
accepted it, wrote a new version, ran verification, reported success, and spent one of his ten
included changes. The offline fixture cannot apply a change, so the version it produced was the
same site with one extra HTML comment: invisible to a customer, and one round poorer each time.

**Why it matters more than it looks.** Brief section 14 requires every external call to surface a
real error rather than fail silently. This failed worse than silently, it reported success. A
customer would submit a change, see nothing move, try again in different words, and burn their
allowance discovering that the product does not work.

**Chosen.**

1. **Ask before accepting.** `editCapability()` answers whether this install can actually apply a
   change. It is checked at the top of the edit route, before any status change, any version, and
   above all before the counter moves. Unavailable means 503, a plain English reason naming the
   missing variable, and `editCharged: false` in the body.
2. **Say it on load, not on submit.** The same answer comes back from the versions endpoint, so
   the panel shows the reason and disables the box the moment it opens. Nobody types a paragraph
   into a field that was never going to work.
3. **The fixture edit path is gone.** It existed to exercise the plumbing offline, and it caused
   this. Regenerating identical output is not an edit, and pretending otherwise is what did the
   damage. The end to end script asserts the refusal instead.
4. **Every submission ends in something visible.** Success with the preview moved to the new
   version, a failure carrying the real reason, or a dropped connection reported as one. There is
   no fourth branch.

**Held down by tests, because this one costs money.** `test/edits.integration.test.ts` and
`test/edits.failure.test.ts` run the real routes against a real database and assert the invariant
directly: a change that was not made never costs an edit. One covers a missing key, the other
covers a key whose endpoint fails, pointed at a local stub so it is deterministic and never
touches the network.

**Two adjacent bugs found while in there.** The version history rendered every date as "Invalid
Date" and never showed the customer's own words, because the client types were still snake_case
after the Postgres migration. And killing the local API left the embedded database unopenable,
taking the whole app down on the next start with no explanation. Both fixed: the client types
match the API, and the server closes the database on the way out.

---

## D21. Test strategy

*Rewritten after the move to Vercel. The original version of this entry described tests running
inside workerd through `@cloudflare/vitest-pool-workers`, which is no longer true of anything.*

Unit tests run under plain Vitest on Node. The static checks parse with `node-html-parser` rather
than `HTMLRewriter`, so they need no special runtime. Tests that need a database run against
PGlite, which is Postgres compiled to wasm and needs no server and no account. Fixtures live in
`test/fixtures/`.

The 13 static checks are covered both ways: a known-good document must pass every one of them, and
a set of deliberately broken documents must each trip the specific check that owns that fault and
nothing else. That second half is the half that matters, and it has already caught two checks that
could never have failed.

The 4 render checks need a real browser. They are tested for the property that actually protects a
customer: with no render driver available they report `skipped`, never `pass`. They are exercised
for real by `npm run sample:verify`, which runs Playwright against the committed sample.

Integration tests that involve money or a customer's edit allowance run the real routes against a
real database rather than mocks, because that is the only way the assertion means anything.

---

## D28. The design style choice

**Question.** Chris wants the customer to feel they are customising the site to their taste, via a
style choice in the intake with an explicit "not sure, you pick" option. The brief settles none of
it: not the options, not the words, not how far the choice reaches into the output.

### The copy is not approved

The five labels and their one-line descriptions are a proposal and **need Chris's sign off before
any customer sees them**. They are all in one place, `DESIGN_STYLE_OPTIONS` in `shared/styles.ts`,
and nothing else reads the wording, so changing them is editing five strings:

| id | Label (draft) | Description (draft) |
| --- | --- | --- |
| `industrial` | Bold and industrial | Heavy condensed type, dark surfaces, high contrast, chunky blocks. |
| `modern` | Clean and modern | Light and airy, generous whitespace, crisp type, restrained. |
| `established` | Warm and established | Warmer neutrals, a serif for headings, softer edges, family business feel. |
| `refined` | Premium and refined | Restrained, wide spacing, smaller type set with more room around it. |
| `auto` | Not sure, pick for me | We will choose the one that suits your trade and your logo. Most people pick this. |

The `id` values are stored in the database and in every plan JSON. The labels are not. Rewording is
safe; renaming an id is a migration.

### The choice changes the output, and that is provable

A style that swapped a font would be worse than not offering the choice at all, so a style is
stored as concrete values rather than adjectives: font families and weights, the whole type scale,
section padding, gap, measure, corner radii, shadow weight, border weight, header treatment, hero
composition and card treatment. `STYLE_SPECS` in `shared/styles.ts` holds them. The renderer reads
them, and the model gets the same values read out as a directive, so a real build and the offline
fixture make the same decisions.

The proof is a file, not a claim. `npm run sample` builds the one seeded business four times and
writes `sample/styles/{industrial,modern,established,refined}.html` plus a comparison page at
`sample/styles/index.html`. Same intake, same photos, same copy, same colours. At the time of
writing the closest pair of styles differs in 12 of 13 measured signals, and all four pass all 17
verification checks. `test/styles.test.ts` fails the build if they ever converge.

### Style does not touch colour

The palette is sampled from the customer's logo and stays theirs. Style decides how the colours are
used and never what they are. Every colour still lives once in `:root`, which check 1 already
enforces.

The two only meet in one place: a style may want white text on large blocks of the brand colour. If
the sampled colour is too light to carry that, **the logo wins**. The hue is kept and deepened until
it is readable, and only if that is still not enough does the dark area fall back to the neutral,
with the brand colour kept for accents. Either way the compromise is recorded on the plan in
`style.constraints` and written into the document as a `STYLE NOTE` comment saying which of the two
happened. `resolveSurfaces` in `server/lib/render/site.ts` is the only code that decides it.

### Pictures, not words

Tradies are not designers and will not choose between four paragraphs of adjectives, so every option
carries a drawing of the shape it produces: header treatment, hero composition, heading weight,
corner radius, section density. They are inline SVG in `src/components/StylePicker.tsx`, drawn in
the customer's own sampled colours, so they cost nothing to serve and they make the point that the
style changes the shape and the logo decides the palette.

### Suggested, never preselected

Nothing is selected when step 5 loads. When the trade is known from step 1 the matching style is
softly badged "often suits electricians", and every option stays freely selectable.
`TRADE_STYLE_SUGGESTION` holds the mapping. The wizard does require an explicit pick before step 5
can be completed, which costs one tap given "not sure" is one of the five, and means a stored
`auto` is a decision the customer made rather than a field they never saw. The stored payload
schema keeps a default so records written before this feature existed still parse.

### When they ask us to pick

`resolveDesignStyle` starts from the trade, then reads the logo palette and their own description of
the business. A pale logo moves it off `industrial` because that style is built on dark blocks. Words
like "dad", "family", "since 1998" move it to `established`. The choice and the reason go into the
plan JSON so they survive edits and rollbacks. **The reasoning is never shown to the customer**;
telling someone we called their business a family operation is not a conversation this product
should start. It is in the plan for support and for Chris.

### Changing it later

The style lives on the plan, so a customer can ask for a different look during the edit loop and it
costs one round like any other change. The edit prompt allows `style.resolved` to move only for a
request that is genuinely about the overall look. "Make the header darker" is a request about the
header, not an invitation to restyle their site.

**If Chris disagrees.** Dropping a style is deleting its entry from `STYLE_SPECS`,
`DESIGN_STYLE_OPTIONS` and the trade mapping. Adding one is adding the same three. The renderer,
the prompt directive and the tests all iterate `NAMED_STYLES`, so nothing else needs touching.

---

## D29. The Web3Forms key is collected at go-live, and tested before it is believed

**A reversal, and the original reasoning is worth keeping.** Section 4 of the brief explicitly
removed this field from the intake, and it was right to: of 59 submissions, nearly every one came
back with an email address or a phone number instead of a UUID. A tradie filling in an intake form
has no website yet, no motivation, and no idea what an access key is. The field produced garbage.

**What changed.** Removing the field did not remove the problem, it moved it. Every generated site
posts its enquiry forms to Go Polar's Web3Forms account. A site that goes live still carrying that
key sends every enquiry the tradie ever receives to us instead of them. That is a lost lead for the
person paying for lead generation, and someone else's customer data in our account. Chris is right
about the consequence, so the field comes back.

**Where it went instead.** The go-live flow, as a required step before the site can be published,
and not in the intake. At go-live the customer has a finished website in front of them and
something concrete to protect, which is the difference between the 59 bad submissions and a
motivated one. It is guided rather than a bare text box: what Web3Forms is, why they need it, a
link that opens in a new tab, and exactly what will happen (they enter their email, the key arrives
in their inbox, they paste it back).

**Naming the mistake.** "Invalid key" tells someone who pasted their email address nothing, and
they will paste it again. So an email address, a phone number, the web3forms.com URL and the
example text each get their own message saying what we can see they pasted. The three things that
actually came back in the 59 submissions each have their own branch.

**The part that matters most: shape proves nothing.** A syntactically valid but wrong key is worse
than no key at all. The forms look fine, they submit, the success message appears, and every
enquiry goes nowhere. A tradie would find out when they wondered why the phone stopped ringing. So
a key is never accepted for being a UUID. A real test submission is sent through Web3Forms with it,
and only a genuine success response gets it saved. Nothing is written to the job until it passes,
because an unverified key in the database is a key somebody will later assume was checked.

**Three gates, in order:** the shape, the live test, then the rebuild. The rebuild is a
deterministic swap of the `access_key` values and nothing else, deliberately not a model call, so
not a word of their copy can move. If it cannot switch both forms cleanly it refuses and saves
nothing rather than reporting a success it did not achieve.

**Blocked until it is done.** Go-live is refused at the checkout with a plain-English reason, and
`publishSite` refuses outright to publish a document still containing the Go Polar key. Two gates
rather than one, because the second one is the one that actually protects the customer's leads no
matter which route got there.

**Not an edit.** The rebuild writes a new version but does not touch `edits_used`. The customer did
not ask for a change to their website, they completed a step we require of them.

**One code path, shared with section 9.** Discharge already forced a key swap and had its own
copy of the validation. Two copies drift, and one of them ends up being the lenient one. Both now
come through `server/lib/web3forms.ts`, and a customer who supplied a key at go-live is not asked
for it again at discharge.

**In demo mode** the submission is faked and says so, and `live: false` travels with the result so
nothing downstream can claim a test enquiry was delivered when none was. A key of all zeroes is
treated as rejected so the failure path can be walked locally, which is also the placeholder the
config falls back to and therefore the one key that must never be accepted.

---

## D30. Shopify products come from the store, and nothing is invented to fill the gaps

**What the store actually has**, read on 2026-08-18: Go Polar Creative, itscold.com.au, Basic plan,
AUD, AWST, and **zero selling plan groups**. Three of the seven products the app needs exist:
`website-hosting-australia` ("Website Hosting", $33.00, two variants), `email-hosting` ($14.95) and
`domain-1-year` ("Domain (1 Year)", $5.00 one-off). The handles in the brief were fiction.

**Four products do not exist at all:** `build-token`, `post-live-edit`, `discharge` and
`extra-edits`.

**Chosen.** `shared/pricing.ts` is the single configuration module, and a product that is not on the
store has `handle: null`. There is no fallback and no guess. `checkoutHandle()` is the only way a
handle reaches a checkout, and for a missing product it throws by name saying what to create, what
to price it, which env var to set, and what is broken until then.

**Why null rather than the proposed handle.** A guessed handle produces a cart permalink that 404s
in front of a customer who has decided to buy. An error we can see is far cheaper. The proposed
handle is still recorded, as documentation for SHOPIFY-SETUP.md and so that an order for a product
Chris creates before this file is updated is still understood rather than dropped.

**Fail loudly at startup.** `assertProductConfig()` runs at boot and reports every gap and what each
one costs. With `ENABLE_LIVE_PAYMENTS=1` it refuses to start at all, because an install that intends
to take money must not run in a state where a customer can reach a broken checkout. With payments
off it warns instead and stays runnable, because a preview install is expected to be half configured.
`/api/health` carries the same report.

**Prices are now decided and final**, all ex GST, all monthly for the three recurring ones: hosting
$30/month, domain $5/month, email $14.95/month. This supersedes anything earlier that recorded them
as open. `extra-edits` is still the one undecided price and stays null, so no customer ever sees a
number for it. See D2.

**The store does not match these decisions yet**, and that is recorded rather than smoothed over:
hosting is $33.00 which is $30 GST-inclusive, the domain is a one-off year rather than a monthly
subscription, and nothing has a selling plan because there are no selling plan groups. Every
mismatch is in the `store` field of each product with what it breaks, and SHOPIFY-SETUP.md is the
ordered checklist for fixing it. **Nothing was changed on the store.**

**Title matching order matters.** The `orders/paid` webhook does not carry product handles, so a
line item is matched by configured variant id, then SKU, then title. "Email Hosting" and "Website
Hosting" both contain the word hosting, and getting that backwards would read a $14.95 email add-on
as a hosting subscription. Email is checked first, and there is a test for it.

---

## D31. Prices are shown GST-inclusive, because that is what the store charges

**Supersedes the ex-GST display rule in D30 and in the brief.** The brief said every displayed price
carries a "+ GST" label, and that was right for a store configured with tax-exclusive prices. This
store is not. `taxesIncluded: true` was verified on 2026-08-19: prices are entered with GST already
inside them.

**Chosen.** The app displays the number the customer is actually charged, labelled "inc GST".
Hosting reads $33/month inc GST, not $30/month + GST.

**Why.** Advertising "$30 + GST" and then landing a tradie on a Shopify checkout that says $33.00 is
a mismatch they are entitled to read as a bait and switch. They are the same amount of money, but one
of those numbers is the one that leaves their account and the other is an accounting convention.
One number, the real one, everywhere.

**This is customer-facing copy and needs Chris's sign-off.** It changes every price on every screen
and in the emails.

**The ex-GST figure did not disappear.** `exGstCents()` derives it, `orders.amount_ex_gst` still
stores it, and it is how Chris states prices internally. It is simply never what a customer reads.

**Two prices are unresolved and therefore invisible.**

`extra-edits` has never been priced. That was already true.

`email` is new: the store charges $14.95 inc GST, which is $13.59 + GST, while the stated decision
was $14.95 + GST, which would be $16.45 on the store. Hosting and the domain were both grossed up
correctly, so this looks like an oversight, but "looks like" is not good enough to price something
with. Both readings are recorded in `PRICING.email.openQuestion` so the question can be asked
precisely rather than as "check the email price". Until it is answered the add-on shows no price and
cannot be bought, and the screen says we do them and to ask rather than quoting a number.

---

## D32. Selling plans are load-bearing, and the store is asked what it will actually bill

**Two corrections to what was recorded in D30**, both from reading the store properly.

**There are selling plans.** The earlier reading of "zero selling plan groups" came from a shop-level
query, and app-owned groups are not exposed at that level to another app's token. Per product they
are there: Appstle is installed, and hosting, domain and email each have a monthly plan.

**They are not optional.** All three carry `requiresSellingPlan: true`, which means Shopify rejects a
checkout line for them that has no selling plan id. Not a downgrade to a one-off charge, a refusal.
So the selling plan id is now exactly as load-bearing as the variant id: first-class in the config
module, and a missing one fails the checkout loudly by name instead of producing a cart that Shopify
will not accept.

**And the store is asked what it will really do.** The domain product was configured with a plan
*named* "Monthly Subscription" whose billing policy was interval YEAR, count 1. Shopify has no
objection to that: the name is a label and the policy is the behaviour. The app would have advertised
$5.50 a month while the store charged $5.50 a year, and the only way anyone finds out is by reading
a billing policy or noticing the revenue is missing twelve months later.

**Chosen.** Before any checkout link is built, the real billing policy is read from the Admin API and
compared against what the app believes it is selling. A monthly product whose plan does not bill
every 1 MONTH gets no checkout link, and the operator error names the product, the plan and the
actual interval. `/api/health` carries the same report. Results are cached for ten minutes, because
a billing policy changes when a human changes it.

**Without `SHOPIFY_ADMIN_API_TOKEN` the check reports "cannot verify", never "pass".** A check that
quietly passes when it did not run is worse than no check, and this class of error has already
happened once on this store.

**If Chris disagrees:** the guard is `checkBillingPolicies` in `server/lib/shopify.ts`. Loosening it
to a warning is a one-line change, and a bad idea.

---

## D33. The builder wears the Go Polar brand, taken from the live site rather than invented

**Question.** The builder looked templatey and did not feel like Go Polar. It was a generic blue-grey
palette with an orange accent that appears nowhere in the business.

**Chosen.** The design tokens were read off itscold.com.au on 2026-08-19 with a browser, not guessed
at, and the whole builder UI is driven from them: `--color-accent #38b6ff` and its `#1da7f5` hover,
`#0a0a0a` text, `#4a4a4a` secondary, `#e8edf3` hairline borders, `#f5f9fc` tinted surface, `#070b12`
for dark panels. Poppins, headings at 800 with negative tracking that tightens as they grow, body at
17px on 1.6. Buttons at 8px radius that lift 1px on hover with a blue shadow. They live in
`src/index.css` as Tailwind theme tokens, the same one-place discipline the generated client sites
use with `:root`.

**The patterns matter as much as the palette**, and they came from the same read: ALL CAPS eyebrows
in accent blue above headings, the wordmark as "Go Polar" with the full stop always in brand blue,
large figure over small label for stats, and CTAs written as a phrase with a right arrow that moves
on hover rather than the text moving.

**The copy was rewritten at the same time**, because templatey wording was half the problem. "Tell us
about the business" became "Who are you?". "Building your website" became "Writing your website."
The generation screen leads with "Everything is in. Build it." and the stream is labelled "This is
the actual page being built. Nothing here is a template."

**Poppins 800 is now actually loaded.** The live site asks Google Fonts for 400 to 700 and then sets
headings to 800, so every heading on itscold.com.au is currently faux-bold. The builder requests 800
properly. Worth mentioning to Chris as a one-line fix on the main site.

**Scope.** Builder UI and Go Polar's own transactional emails only. **The house rules for generated
client sites were not touched.** Those sites carry the client's brand, sampled from the client's own
logo, and nothing about Go Polar's palette or voice belongs in them.

---

## D34. The custom email price is $14.95 including GST

**Decided by Chris on 2026-08-19**, closing the question raised in D31.

$14.95 inc GST, which is $13.59 ex GST. Chosen on **shelf price rather than margin**: the number a
customer compares against other providers is the one with GST already in it, and $14.95 is the
number that competes. The store already charges exactly this, so nothing changed in Shopify.

The open-question state is gone: `PRICING.email.incGstCents` is 1495, the add-on can be bought
normally, and the "ask us, we are settling the price" fallback has been removed from the go-live
screen.

**`extra-edits` remains the only undecided price**, and the only path still deliberately dark.

---

## D35. Products are identified by whatever identifier is actually reliable, which is not always the handle

**What happened.** Three products were created on the store on 2026-08-19: DIY Website Build,
Website Update and Website Discharge, in **draft** so Chris can review them. Each has a deliberate
SKU (`build-token`, `post-live-edit`, `discharge`), a known product id and a known variant id. Their
**handles were auto-generated by Shopify from the titles**, and nobody here has seen them.

**Chosen.** Each product records which kind of identifier it actually has. `refKind: 'handle'` for
the three subscriptions, whose handles are known and verified. `refKind: 'sku'` for the three new
ones. Nothing derives a handle from a title.

**Why not just guess the handle.** "DIY Website Build" most likely became `diy-website-build`, and
"most likely" is exactly how you produce a checkout link that 404s in front of a customer who has
decided to buy. The identifier that was *set deliberately* is the SKU, so that is the one used.

**Order matching, in descending order of trust:**

1. **Variant id.** Exact and numeric, and now known for all three because they were read off the
   store at creation. Cannot be confused with anything.
2. **SKU.** Set deliberately, so for these three it is the identifier rather than an incidental
   field. **Changing a SKU in Shopify breaks the match**, and that is worth knowing before somebody
   tidies one up.
3. **Title.** Last resort and genuinely fragile. All three titles contain the word "website", and
   "Email Hosting" contains "hosting", so the matcher tests the distinguishing word first and
   returns null rather than guessing when nothing fits.

**Variant ids are recorded in code, not only in the environment.** They are not secrets: a variant
id appears in every cart URL. Recording the verified ones means a published product sells
immediately with nothing to paste in, while an env var of the same name still overrides, so pointing
at a different store stays a configuration change rather than a code change.

**Draft status is checked live, not from this file.** `checkoutRef` deliberately does not look at
the draft flag. The Admin API does, immediately before a checkout link is built, so the moment Chris
publishes a product it starts selling with no code change and nothing for anyone to remember. The
static flag drives the setup checklist and the startup report only.

**The section 11 copy on the build product page is adapted, not approved.** It was rewritten from
section 11 of the brief with the figures converted to GST-inclusive. **Chris should read it before
publishing**, because it is the copy a customer reads immediately before paying $220. The draft is
in SHOPIFY-SETUP.md.

---

## D36. The published handles are recorded, and still not what anything sells by

**Verified on the live store on 2026-08-19.** All three one-off products are ACTIVE, taxable, with
`requiresSellingPlan: false`, which is correct for a one-off. SKUs and variant ids are unchanged
from what was recorded. The handles Shopify generated are now known:

| Title | Handle | SKU | Variant |
| --- | --- | --- | --- |
| DIY Website Build | `diy-website-build` | `build-token` | 62852208328863 |
| Website Update | `website-update` | `post-live-edit` | 62852208361631 |
| Website Discharge | `website-discharge` | `discharge` | 62852208394399 |

**None of them is what the app sells by, and that is deliberate.** The handle is recorded in
`storeHandle` so somebody looking at a Shopify URL can find the product in this file, and nothing
else reads it. Selling, env var naming and order matching all key off the SKU, because a handle
follows whatever the title happens to be and a SKU does not. Rename "Website Update" to "Website
Updates" and the handle moves; the SKU does not. A test asserts the two are recorded separately and
that a handle does not resolve to a product.

**The draft flags are gone**, but the draft *check* is not: the store is still asked whether each
product is active immediately before every checkout, so unpublishing one is caught without anybody
editing this file.

---

## D37. The smoke test tells the operator where it broke, not that it broke

**Question.** The deployment smoke test is "buy the build product with a real card and see whether a
link arrives". When it arrives, everything worked. When it does not, that single fact is useless:
the webhook might never have fired, or fired and failed HMAC, or verified and matched no product, or
created the job perfectly and then failed to send. Four failures, four different fixes, one symptom.

**Chosen.** `GET /api/admin/trace?email=`, guarded by `ADMIN_TOKEN`, walks those four steps and
reports each independently with the reason and the fix. It reads the event log, which every stage of
that path already writes to, rather than adding new instrumentation that could itself be wrong and
would then need its own diagnosis.

**Downstream steps report "waiting", never "failed".** The first version of this said "Broke at step
3: Job created" when no webhook had ever arrived, which would have sent Chris to look at product
SKUs when the real problem was an unregistered webhook. Writing the test caught it. A step that
never ran does not get to claim it failed, and the verdict names the earliest step that is not ok.

**The fixes are specific rather than generic.** A refusal because `DEMO_MODE` is still 1 says that,
not "check your webhook secret". A send blocked by `ENABLE_LIVE_EMAIL` says that, not "check your
sending domain". An unmatched line item prints the product title that actually arrived, so it can be
compared against the SKU on the store.

**It never claims delivery.** Step 4 says Resend accepted the message, because that is all the app
can know. Whether it reached an inbox is Resend's log to answer.

`GET /api/admin/events` sits beside it for anything the four steps do not cover, filterable by type,
job and time window.

**The Admin API scopes are `read_orders` and `read_products`, and nothing else.** Derived from the
three Shopify calls this app actually makes rather than from a generous guess: listing paid orders
for the reconciliation sweep, reading product status and billing policy, and creating a cart through
the Storefront API. No write scope of any kind, and no access to customer records. DEPLOY.md section
6 walks through creating the custom app click by click and says what each scope is for.

---

## D38. Hosting sells the "Hosting Only" variant, not the bundle

**The Website Hosting product has two variants**, and the app has to pick one:

| Variant | Id | Price | Status |
| --- | --- | --- | --- |
| Hosting Only | `62848019595423` | $33.00 | **This is what the app sells.** $33.00 inc GST is the $30 + GST hosting from the brief |
| Hosting + 2 Monthly Website Edits | `62848019628191` | $100.00 | A different offer. Not part of this flow |

**Chosen: Hosting Only**, confirmed by Chris on 2026-08-19. It is the one the brief describes and
the one every price in the app and on the go-live screen refers to.

**The bundle is a real product with no decision behind it.** It is not wrong, it is simply not
something this flow has ever been asked to sell, and quietly attaching a $100 monthly charge to a
customer who agreed to $33 would be the worst possible way to find that out. It is recorded here
rather than left as an unexplained second variant nobody remembers.

**If Chris wants it offered later**, it is a genuine product decision rather than a config change:
the go-live screen currently presents hosting as a single required line with one price. Offering a
choice means a second option on that screen, wording that explains what "2 monthly edits" buys, and
a decision about what happens to the edit counter for a customer on that plan. The variant id above
is all the plumbing needs.

---

## D39. Variant ids live in the environment under derived names

**A trap worth writing down**, because it cost nothing to avoid here and would have been invisible
if missed.

The env var names are **derived**, not free text: `SHOPIFY_VARIANT_<REF>` where REF is the
product's identifier. So the three subscriptions are `SHOPIFY_VARIANT_WEBSITE_HOSTING_AUSTRALIA`,
`SHOPIFY_VARIANT_DOMAIN_1_YEAR` and `SHOPIFY_VARIANT_EMAIL_HOSTING`, from their handles, while the
one-off products use their SKUs.

Chris's `.env.local` was carrying the brief-era names `SHOPIFY_VARIANT_HOSTING_MONTHLY`,
`SHOPIFY_VARIANT_DOMAIN_MONTHLY` and `SHOPIFY_VARIANT_EMAIL_MONTHLY`, which no longer correspond to
anything. **A wrongly named variable is not an error, it is silence**: the value is simply never
read, and the failure surfaces later as a checkout that will not build. The startup report catches
it, because it reports the id as missing rather than assuming it is fine, but the name itself has
to be right.

**Format is the numeric id only**, never the full `gid://shopify/ProductVariant/…` string. A cart
permalink is built as `/cart/{variantId}:{qty}`, and a gid in there produces a URL that 404s.

Both points are now stated in `.env.example` above the block they apply to.
