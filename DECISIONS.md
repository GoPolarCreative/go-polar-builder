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

**SUPERSEDED by D48 and D53.** Both providers are gone: Klaviyo sends every customer email and
the Resend transport was deleted from the code on 2026-08-25. The commit-first/notify-second
ordering this decision established still stands and now protects the Klaviyo calls.

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

---

## D40. The house style comes from four real sites, not from a written list

> **Partly reversed, 2026-08-23.** The half of this decision that said the section skeleton
> never varies is gone. It was a true reading of the four reference sites and a bad product:
> one skeleton in four skins meant the customer chose a typeface while being told they were
> choosing a layout, and the four previews looked like the same website four times. Each style
> now carries a `LayoutSpec` (`shared/styles.ts`): which sections appear, in what order, one of
> three hero compositions, and whether the dark bands hold still while the page scrolls. The
> other half of D40, that the treatments are measured off real sites rather than invented,
> stands unchanged. `test/styles.test.ts` now asserts the four orders differ and that no style
> loses a section by reordering.

**What went wrong.** The brief said "visual reference: the Gildon Constructions and CWM Modular
screenshots in the Claude project". Those screenshots were never available. The house rules were
therefore built from a written list of sections with **no visual quality bar at all**, and
everything downstream inherited that gap. The generated sample was structurally complete and
visually generic, which is exactly what a section list without a reference produces. Chris was
right to reject it.

**What replaced it.** Four full sites Chris built by hand, read as live CSS with a browser rather
than eyeballed from images:

| Style | Reference | What it is |
| --- | --- | --- |
| `industrial` | naarmearthmoving.com.au | Bebas Neue on near-black, cyan accent, dark on dark, no light section anywhere |
| `direct` | summithvacr.com.au | Navy and red, everything centred, capitals, hard contrast |
| `established` | gildonconstructions.com.au | Navy, gold and cream, sentence case, alternating light sections |
| `modern` | turquoiseplumbing.com.au | Space Grotesk, light and generous, the two-tone device on nearly every heading |

**THE INSIGHT, and it was Chris's.** The section skeleton does not vary between the four. What
varies is palette, heading case and weight, and density. That is why the four styles are values in
one renderer rather than four templates, and it is why the test that demanded four different heroes
was demanding the wrong thing and had to be rewritten.

**The component vocabulary**, now documented in the house rules and implemented in the renderer:
eyebrow labels above every section heading; the two-tone heading with the payoff phrase in the
accent; a full-bleed hero photo under a gradient scrim with the enquiry form as a card inside the
hero; a four-item trust bar with dividers; service cards with icon tiles, faint numbers and arrow
links; large faint 01-04 figures on why-choose and process; a full-width stat band; testimonial
cards with star rows; an asymmetric gallery; a dark CTA band; two-column contact; a multi-column
dark footer.

**Measured, not guessed.** Section padding 80px, wrap 1200px, h1 clamping to 52px, card radius 6px
with a 1px hairline and a `0 4px 24px` shadow, eyebrow 12px at 700 with 1.44px tracking. Those are
Gildon's numbers and the sample now computes the same ones.

**`refined` was renamed to `direct`.** It was the one style invented from adjectives rather than
taken from a real site, and it described something none of the four references do. It is now the
Summit treatment. Stored payloads carrying the old id would fail validation, which is acceptable
because no customer has ever submitted one.

**The labels still need Chris's sign-off** (D28), but they now describe real looks rather than
moods: "Heavy and industrial", "Bold and direct", "Warm and established", "Clean and modern".

---

## D41. What it took to make the sample hold up

Four passes, and the honest record of each.

**Pass 1.** Rebuilt the renderer against the measured vocabulary. Every device landed and the
numbers matched Gildon exactly. Three faults remained: the two-tone split was producing "Blocked
drains <em>in Chermside</em>", the h1 was an SEO string rather than a proposition, and the stat band
sat in navy directly under the navy why-section so the two read as one slab.

**Pass 2.** Split only on a real clause. Rewrote the headline to carry a payoff:
"Blocked drains in Chermside. <em>Answered day or night.</em>" Moved the `established` stat band to
the accent colour, which is what stops the dark blocks merging, exactly as Turquoise does.

**Pass 3.** The device was only firing three times because the renderer's own section headings were
written as single flat statements. Rewrote them with payoff clauses: "A better experience, from the
first call", "What we do, and how we work". Eight headings now carry it, which is the Turquoise
cadence.

**Pass 4.** A test caught the accent landing on "on the tools since 2012". Investigating it produced
a better rule than the one being tested: Gildon accents "Without Compromise.", so a preposition is
not the problem. A **locative** is. The renderer now refuses "in", "at", "near" and friends, which
covers model-written copy as well as the fixture's.

**Three tests had to be rewritten because they asserted the opposite of what the references do.**
The one demanding four different heroes, the one demanding a serif on `established`, and the
stylesheet-difference floor. The four sites share a skeleton, so most of the stylesheet SHOULD be
identical and the weight belongs on the named signals. The replacements assert the real design:
the skeleton is shared, the vocabulary is present in all four, and the treatment differs.

---

## D42. Additional pages are an entitlement, and entitlements are money

**The product.** The $220 build token buys ONE page. Each Additional DIY Page at $25 buys another.
Bought at the original checkout or later through a generated link.

**Chosen.** `jobs.pages_allowed`, defaulting to 1. Every `additional-page` line item increments it
by the line's **quantity**, so four bought in one go grants four. An INCREMENT, never a set, because
a later purchase has to top up the job the customer already has rather than replacing what they
already paid for.

**Two failures, in opposite directions, and both are tested.** Generating a page nobody paid for is
theft from Chris. Leaving a paid-for page unbuilt is theft from the customer, and they will not
notice until they go looking for a page that is not there. `enforcePagesAllowed` trims the plan to
the allowance and **returns what it dropped**, which is then written into the plan's assumptions so
the customer is told rather than left to discover it.

**The bug that would have shipped.** An order can carry a build token AND additional pages, and the
job does not exist until the build line is processed. Shopify does not promise line item order, so a
page line arriving first found no job and was skipped as unmatched: the customer paid for three
pages and got one, silently. The build line is now sorted to the front of the order. There is a test
that puts the page line first specifically.

**Idempotency is unchanged and still holds.** The unique index on (order id, product handle) means a
webhook retry or the hourly sweep re-examining the same order never double-grants.

---

## D43. A build is a page set, and every check runs per page

**URL structure**, chosen to be readable because this is sold as an SEO feature and an opaque URL
would undercut the whole point:

```
/                          index.html
/services/blocked-drains/  services/blocked-drains/index.html
```

Directories with an `index.html`, so the served URL is clean and the same file opens by double
click out of a discharge zip.

**Links between pages are relative, not root-absolute.** `/services/x/` is correct on a server and
resolves to the filesystem root when a customer opens the zip on their desktop. A test asserts no
rendered page contains a root-absolute internal link.

**EVERY CHECK IS PER PAGE.** "Exactly one h1" and "page weight within budget" are meaningless at the
level of a set: three h1s across three pages is correct, and a set whose home page is 1MB and whose
service page is 6MB has one page that fails. `verifySet` verifies each page independently and the
set passes only if all of them do. The failure this exists to prevent is a multi-page build
reporting success because the home page was checked and the rest were not, and there is a test that
breaks only the last page and asserts the set fails while the home page still passes.

**One design system, not two.** The service page renderer imports the same `stylesheet`, the same
cards, the same form and the same section heads as the home page. A test asserts the `:root` block
is byte identical across the set. A page set that looked like two different studios would be worse
than one page.

**Schema stops being decorative.** Each service page carries a real `BreadcrumbList` (home, then the
service) and a `Service` tied back to the `LocalBusiness` by `@id`, with `areaServed` in the same
shape the home page declares. Canonicals are per page. `sitemap.xml` and `robots.txt` are written
only when there is more than one page, because a sitemap listing one URL says nothing.

---

## D44. The additional pages copy persuades with the mechanism, never with a promise

**Why this is a decision and not just copy.** Chris sells to Australian small businesses. An
unsubstantiated performance claim is exposure under the Australian Consumer Law before it is
anything else, and it is exactly the kind of thing that destroys trust when it does not come true.

**Chosen.** Every word the builder says about additional pages lives in `shared/pages-copy.ts`, so
the entire claim surface can be read in one sitting and signed off in one go. What it says:

> A single page covering all your services is competing with itself for every one of them. A page
> about one service, in the suburbs you actually work in, gives a search engine something specific
> to match against.

That is a description of how search works. It is verifiable and it is not a promise. The copy also
states the limit plainly rather than burying it: *"This is not a guarantee of anything. It is a
structure that gives you a chance of being found for a specific job in a specific place, which one
page trying to cover everything does not."*

**Held down by a test, not by good intentions.** `test/pages.copy.test.ts` greps the copy module AND
the two components that render it for ranking claims, position claims, traffic and lead volume
claims, growth claims, timeframes and guarantees. Writing that test immediately caught one thing:
a blunt `/guarantee/` pattern banned the honest disclaimer, so the pattern was narrowed to
affirmative forms. The rule is about claims, not about a word.

**Two placements**, as asked: per service in intake step 2, where they are choosing services
anyway, and at the preview stage where they can see what a page actually is.

**COPY IS NOT APPROVED.** This needs Chris's sign-off before a customer reads it, same as D28.

## D46. Render checks are off in production, and say so

**Decided 2026-08-20, on the live deployment.**

`RENDER_DRIVER=none` is set on Vercel. The four checks that need a real browser — layout overflow,
tap target size, colour contrast, mobile viewport — do not run there. The thirteen static checks
run on every page of every build, as always.

**Why.** Those four launch Chromium (`@sparticuz/chromium`, 67MB) inside the function. On the first
real generation the run reached verification and never came back: the function was killed with the
build unsaved, after twelve minutes. With the browser checks off the same job completed in 12m13s
including two repair passes, and wrote a build that passed.

**What this costs.** Four checks of seventeen. They are reported as **skipped**, never as passed, so
no build is ever described as verified in a way it was not. Nothing silently becomes a pass.

**How to get them back.** They still run locally, so `npm run sample` exercises all seventeen on
every design style before anything ships. If they are wanted in production later, the route is to
move verification out of the request into a second invocation rather than to raise the timeout
again — a customer should not wait on a browser starting up.

**Generation takes about twelve minutes.** That is the real number on Claude Sonnet 5 with adaptive
thinking, for a plan call, a build call and two repair passes. The brief sells watching the site
being written, so this is not dead time, but it is longer than the wording anywhere implies and the
copy should not promise otherwise.

## D47. Sonnet 5 writes the websites, measured against Opus 5

**Decided 2026-08-21, on the live deployment, from measurements rather than vendor tables.**

Same job, same intake, same photos, same prompts. Only `ANTHROPIC_MODEL` differed.

| | Sonnet 5 | Opus 5 |
| --- | --- | --- |
| Time | 393s | 603s |
| Cost | $0.77 | $1.93 |
| Output tokens | 46,945 | 66,328 |
| API calls | 2 | 4 |
| Repair passes | 0 | 1 |
| HTML | 63,711 bytes | 66,378 bytes |
| Page weight | 1.53MB | 1.54MB |
| All checks passed | yes | yes |

**Opus 5 costs 2.51x and takes 53% longer.** Chris compared the two finished sites side by side and
called the difference extremely marginal.

**The hypothesis was wrong, and that is the useful part.** The case for Opus was that it would get
it right first time and drop the repair passes, partly paying for itself. It did the opposite:
Sonnet needed no repair pass on this run, Opus needed one, so Opus was more expensive, slower, AND
needed more correction. One run each, and Sonnet has been seen to need two repairs on another run,
so the noise is real — but there is no evidence Opus reduces rework, which was the entire argument
for it.

**Run to run variance, from two identical Sonnet runs:** about 7% on time and 2% on cost. Read no
single-run difference smaller than that as signal.

**Fable 5 was not tested.** At $10/$50 per million it is 3.3x Sonnet on output, it is slower rather
than faster, and this task — writing a trade website from a detailed content plan against house
rules — is well-specified work rather than the open-ended reasoning it is built for.

**Revisit when** the house rules change materially, or if repair passes start firing regularly on
Sonnet. `npm run compare -- <jobId> <versionA> <versionB>` reruns this comparison from the meter.

## D48. Klaviyo sends every customer email. GoHighLevel is deleted

**Decided 2026-08-21, after a day of email that never arrived.**

**What was wrong.** Two email systems, one wired. Klaviyo sent the purchase email through a flow
built by hand. Everything the app sent itself went through a Resend transport that was never
configured, failed, and returned a deliberately vague "if we have your email we've sent it" — so
nothing distinguished sent from silently discarded. The "email me my link again" form, which is the
second most important message in the product, went nowhere for every customer who used it.

**Why GoHighLevel could never have worked.** The root domain authorises only `spf.ax.email`:

```
itscold.com.au   v=spf1 +a +mx +include:spf.ax.email ~all
```

No GHL DKIM on the root, so GHL sending as `hello@itscold.com.au` failed SPF and had no aligned
signature. DMARC is `p=none`, so nothing was rejected — Gmail simply binned it. That is why the
symptom was silence rather than a bounce, and why it went unnoticed on a lead flow since July.

A GHL-authenticated subdomain did exist (`sales.itscold.com.au`, with `spf.leadconnectorhq.com` and
DKIM) but nothing was configured to send from it.

**Why Klaviyo.** `hello.itscold.com.au` is delegated to Klaviyo's nameservers with `s1` and `s2`
DKIM already published, and it is already used for real campaigns. The sending path was proven
before this app touched it.

**The design.** The app emits events and owns no templates, no copy and no send timing. Every event
carries its own link, because a flow that looks one up can send an email with a dead button. The
API revision is pinned, since Klaviyo versions by date and an unpinned client breaks on a morning
nobody deployed. 202 Accepted is the only status treated as success.

**Also removed:** the `ENABLE_LIVE_CRM` capability. Nothing read it once GHL was gone, and a flag
that does nothing is worse than no flag.

**What this cost.** Most of a day, and it was two things: one missing Email field in a GHL action,
and one SPF record. Neither announced itself, because every layer answered 200.

## D49

**Store the order number a customer can read, not the one Shopify counts with.**

The claim door failed on the first real order. Two independent bugs, stacked:

**One: the wrong field.** Shopify sends both `order_number` and `name`, and they are not the same
thing. On a store with a custom order prefix, `order_number` is the bare integer `1258` while
`name` is `#GPC1258`. Only `name` has ever been shown to the customer. The normaliser preferred
`order_number`, so it would have stored a value nobody could type.

**Two: the column was empty.** The order predated the deploy that started populating
`shopify_order_number`, so all five existing paid build orders hold NULL. They are permanently
unclaimable and always were. Every order from this deploy onward is fine.

Both were invisible from the outside: the endpoint answered "we could not match that" either way,
which is the same thing it says to somebody who mistyped.

**So:**

- `orderNumberOf` prefers `name` and strips the hash. `order_number` is the fallback.
- Matching accepts every form the same order could be typed as — `GPC1258`, `#gpc1258`, `1258` —
  folded on both sides, because the prefix reads as decoration to the person typing it.
- The order's identity is now kept in `orders.raw` alongside the line items. When the column was
  null there was nothing on the row to rebuild it from, and the only repair was asking a paying
  customer to buy again.
- A failed claim records **why** it failed: `no_paid_build_for_email`, `order_number_never_stored`
  or `order_number_mismatch`. The customer still gets one message; the operator does not. The
  middle one notifies Chris, because it means we lost their number, not that they mistyped it.

**A hole found while writing the tests, not while writing the code.** `orderNumberForms('#')`
returns an empty list. Drizzle's `or()` with no arguments is `undefined`, and an `undefined` inside
`and()` is dropped silently — so the order number would have stopped being a condition at all and
**email alone would have opened somebody's website**. The guard now tests the forms that will
actually be matched on, rather than the string that was typed. Two factors is a claim about the
query, so it has to be checked against the query.

## D50

**Accept the confirmation number, because that is the one people type.**

The claim door worked on the first real attempt — on the third try. The first two failed, and the
logs said what was typed: `6M2EGNICA`. Not a typo. That is Shopify's **confirmation number**, which
the thank-you page prints in larger type than the order number, on a page headed "confirmation".

Asking for "the order number from your confirmation" and expecting someone to skip past the biggest
number on the page is asking them to read our minds. The person who typed it wrote the store.

So both are stored and both are accepted. `shopify_confirmation_number` is a new column, migration
0004. They are equally private, equally per-order, and equally useless to anyone who did not buy,
so nothing about the two-factor argument changes.

**The bare-number fallback got narrower at the same time.** `orderNumberForms` used to strip every
non-digit, which turned `6M2EGNICA` into `62` — a form that matches nothing on purpose and
something by accident. It now only offers the bare number for the shape it was built for, letters
followed by digits: `gpc1258` → `1258`, and `6m2egnica` → nothing.

**This is only known because the failure was logged with the input.** D49 added the reason and the
typed value to `auth.claim.failed`. Without it this was two shrugs and a working third attempt, and
every customer after would have hit the same wall in private.

## D51

**The customer's own words reach the step that can act on them.**

First real edit. Nine requests, itemised: white text on the blue buttons, gallery images all one
size on one row, darker numerals on "why choose us", the "01 02" steps on cards, yellow stars in
the review cards, a heading renamed, two contact forms made to match, twenty Brisbane suburbs
added. What came back was ten silent re-wordings of the FAQ, the stats and a hero heading, none of
which were asked for, and not one of the nine.

**The cause.** An edit ran in two steps and only the first one ever saw the request.
`generateEditedPlan` got the customer's words and returned a revised content plan.
`rebuildFromPlan` then wrote the document from that plan and a summary of *how the plan changed* —
it was never given the request at all.

The plan holds content: headings, body copy, lists, which sections exist. It has no field for the
colour of text on a button, for how many images sit in a row, for whether a numeral is legible, for
star icons. So every request about appearance had nowhere to land. The planner, told to return a
revised plan and unable to express any of it, did the only thing it could and reworded some copy.
The renderer was then told "the FAQ wording changed" and faithfully changed the FAQ wording.

Nothing errored. Every layer reported success. The customer got their own site back.

**The fix.** `rebuildFromPlan` now receives `request` and the prompt says plainly that the plan is
the source of truth for content and the request is the source of truth for everything else — and
that if the plan does not express something the customer asked for, that does not mean it was
handled elsewhere, it means nobody has done it yet.

The planner is told the opposite half: a second step gets the full request and owns appearance, so
leave it alone. **Returning the plan unchanged is explicitly a valid and complete answer.** Untouched
is better than busy.

**Which removes the only signal that work happened**, since an empty plan diff is now normal. So
the document is compared instead: if the plan did not move and the page comes back byte for byte
identical, the customer asked for something and received their own site back. No version, no
increment of `edits_used`, and a reason naming how to phrase it better. Same rule this route
already had for the offline fixture, applied to the case that actually turned up.

**Unapplied parts are declared.** The renderer writes a one-line `UNAPPLIED:` HTML comment rather
than dropping part of a request in silence. Inventing a fact to satisfy a request stays forbidden:
putting stars on reviews that exist is presentation, writing a review is not.

**Found only because the request was recoverable.** The prompt was in a column nothing could read.
`GET /api/admin/jobs/:jobId/edits` now returns what they asked for beside what changed, and
`edit.applied` carries the request. "I asked for a change and nothing happened" is unanswerable
without the sentence they typed.

## D52. The landing page sells one thing, discloses every cost, and asks one question

**Decided 2026-08-25, Chris away, on his direction. Copy needs his sign-off before the theme is
published. Everything is on unpublished theme 174639841439; the live page is untouched.**

**The five-step configurator is gone.** It asked a buyer to assemble hosting, the web address,
email and page count into a cart before they had paid for anything, duplicating decisions the
app already asks at go-live (brief s8) and pulling them to the worst possible moment. The buy
section is now: one qualifying question, a cost disclosure, one button. A cart permalink, no
checkout script.

**Hosting, the web address and email moved to post-build**, where GoLive.tsx already asks about
them once the customer has seen their website. No new app work: the flow existed, the landing
page was front-running it.

**Extra pages stayed, by Chris's explicit amendment.** The page count is a fork in what is being
bought, not an upsell, so it belongs in the buying decision. It is framed as a qualifying
question with two options: "Most of my work is word of mouth" (one page covers it) and "I want
new work from people searching" (a page per major service, $25 each, with a stepper, 1 to 8).
The stepper updates the button, its price and the cart permalink
(`/cart/{build}:1,{pages}:N`); the webhook already honours page quantity (D42). Without
JavaScript the button holds the single-page cart and the copy says pages can be added after the
build, which the app supports. **One fork, two options, one stepper. If it grows a second step
or a running bundle total, the wizard is being rebuilt.**

**The claim discipline is D44 and held.** The fork's expanded explanation says the mechanism
("a page about exactly that gives the search engine something specific to match... one page
covering all your services is competing with itself"), keeps the solar-in-Newcastle example as
what the page is FOR, and repeats the honest caveat ("not a guarantee of anything"). No
rankings, positions, traffic, timeframes or "higher". Verified by regex against the rendered
page.

**Brief s11 outranks the redesign.** The cost block sits directly above the button, in the same
visual block: Today $220 inc GST (updating with pages picked), When you go live $33/month inc
GST hosting, Only if you need one $5.50/month inc GST for a web address, then "Nothing else is
compulsory. Hosting starts when you go live, not today." Removing the pre-purchase decisions is
fine; removing the disclosure would be a consumer-law exposure, so it is stated plainly and not
sold.

**The paid-but-not-live state is handled and was checked, not assumed.** Nothing in the codebase
expires, abandons or deletes a job in `preview` or `editing`: the customer can sit on a finished
site indefinitely. `flagStalledEditing` in server/lib/sweep.ts (hourly cron) flags 72h of
inactivity once and sends the recovery email with the preview link through Klaviyo
(`editing_stalled`, D48). If their build token has expired, the claim door (email + order
number, D49/D50) reissues access. No paid customer can end up with a finished site and no route
forward.

**COPY IS NOT APPROVED. Customer-facing wording changed this decision, for sign-off:**

- Buy section subheading: "One question, one payment. Your build link is emailed to you and you
  can start straight away."
- Fork question: "One page, or a page for each service?"
- Option one: "Most of my work is word of mouth — The website is there to look professional
  when someone checks you out. One page covers it."
- Option two: "I want new work from people searching — Give each major service its own page.
  $25 each, picked here or added after the build."
- Stepper: "Extra service pages [- N +] $25 each, on top of the $220"
- Disclosure summary: "Why a page for each service, in plain English" with the two-paragraph
  mechanism + caveat body (mirrors shared/pages-copy.ts).
- Cost rows and "Nothing else is compulsory. Hosting starts when you go live, not today."
- Button fine print: "Secure Shopify checkout. Ten rounds of changes included, and nothing goes
  live until you approve it."
- How-section note now: "One payment and it starts. Hosting, your web address and email are all
  sorted after you have seen your website." (pages removed from the "after" list because they
  are picked up front again).

**Measured** (390x844 / 1280x900, height and visible words): wizard era 16,918px / 9,705px at
~2,043 words; single-button interim 14,211px / 9,670px at ~1,534/1,543; with the fork and the
full cost disclosure 14,776px / 10,091px at ~1,599/1,608. The fork plus disclosure costs about
65 words and half a screen, which is the price of the page count being a real purchase decision
and the ongoing costs being stated before payment.

## D53. The health check reports on the provider in use, Resend is deleted, and go-live is manual-first

**Decided 2026-08-25, Chris away, on his correction.**

**The false blocker.** `/api/health` reported `emailConfigured: Boolean(resendApiKey)` months
after D48 had moved every customer email to Klaviyo. Production therefore said
`emailConfigured: false` while the build-link email worked end to end (Chris verified the full
purchase path on 2026-08-25), and that reading was relayed to him twice as a launch blocker. A
health check that cries wolf about a dead dependency trains everyone to ignore it, which is
worse than no check. `emailConfigured` now reports on the Klaviyo key.

**Resend is deleted, not dormant.** `server/lib/email.ts` (the transport and every message
template) is gone; the discharge email, its last consumer, now fires the Klaviyo `files_ready`
metric like every other customer email. `RESEND_API_KEY`/`RESEND_FROM` are out of the config,
`fakeResend` out of the demo fakes, and the docs (README, DEPLOY.md, .env.example) name Klaviyo.
**A Klaviyo flow on "Website Files Ready" must be live before the next discharge**, or that
email quietly stops existing; the old path was wired to a transport that was never configured,
so nothing that worked has been lost.

**Two stale spots found while purging, both fixed:**
- The hourly sweep's "was the build link sent" guard still looked for the Resend-era
  `email.sent` event, which the Klaviyo path never writes, so every job sitting in `paid` for
  over an hour was re-sent its build link on every sweep. It now recognises `klaviyo.sent` for
  the build-purchased metric (and still honours the legacy event for pre-D48 jobs).
- The operator trace's step 4 diagnosed Resend by name. It reads the Klaviyo events now.

**Go-live is deliberately manual-first.** Chris's call, made knowing it does not scale: for the
first customers he wants a human in the loop rather than an untested automated path. What the
button does now:

1. Customer presses go live (the existing plan screen). On the first press, two Klaviyo events
   fire: `go_live_started` to the customer, carrying the hosting checkout link and the domain
   context, and `operator_alert` to `OPERATOR_EMAIL` naming the business, contact details and
   what they want. Chris hears the same minute.
2. `/ops` grew a "Waiting to go live" list: everyone who has asked and is not live yet, longest
   wait first, phone number shown, red flag at 24 hours. That is the call list. The timestamp
   is the first `golive.requested` event, which does not move when they revisit the screen.
3. The wording rule is unchanged and applies to the Klaviyo templates as much as the app:
   "in touch within one business day", never a promise that a domain is connected in 24 hours.

Both flows (`Website Go Live Started`, `Operator Alert`) need creating in Klaviyo; until then
the events still land in Klaviyo's activity feed and /ops shows the queue regardless, so the
24-hour rule holds even with no flow built.

**The automated path is already specced**, in SCOPE-EDITOR.md (customer-triggered publish with
the same gates the admin publish enforces), for when volume justifies replacing the phone call.

## D54. DIY hosting is $42.90 sold on what it includes, and the compute moved to Sydney so the page could say so

**Decided 2026-08-25, on Chris's direction. WORDING NOT APPROVED: every customer-facing line
below needs his sign-off before the theme is published.**

**The price.** DIY customers' hosting is $42.90/month inc GST ($39 + GST), the draft "DIY
Website Hosting" product (variant 62853864685727, SKU diy-hosting-monthly), replacing $33 for
this funnel. All five places the landing page said $33 now say $42.90: the hero figure, the
comparison card, the hosting section heading and card, and the s11 cost block. Verified
rendered at 390px and 1280px: zero occurrences of $33 remain, no banned jargon (cPanel, uptime,
CDN, DNS, patching as bare nouns), no horizontal overflow.

**The Australian-servers claim was FALSE when asked for, and was made true rather than
written soft.** The claim was verified before a word of it was written: `X-Vercel-Id` read
`syd1::iad1` — requests entered at the Sydney edge but every function, including the one that
serves customer sites, executed in Washington DC, Vercel's default. Blob and Neon were already
Sydney; only compute had defaulted wrong, against HANDOVER's documented intent and at a cost of
~200-250ms per database query for every customer. Fixed by pinning `"regions": ["syd1"]` in
vercel.json, deployed, verified `syd1::syd1`; the DB-heavy admin queue endpoint went from
~1.35s to ~0.35s. The rule this leaves behind: **the "Australian servers" line on the landing
page is load-bearing on that region pin. If the region ever changes, the copy changes the same
day.** The speed wording is "loads quickly for the people looking you up", deliberately not
"near-instant": modest, mechanism-grounded, defensible.

**The hosting line sells the four things Chris named, worded to survive scrutiny:**

- Hosting heading: "Then $42.90 a month, and your website is never out of date."
- Lede: "Your website is live, and it stays yours to change. New photos, new wording, new
  reviews, whenever you like. We keep it secure and online."
- The list, in order: (1) "Change it yourself, any time. Upload new photos, rewrite the text,
  add new reviews. Ten changes a month included." (2) "An SSL certificate, kept valid: the
  padlock that shows visitors your site is secure" — SSL named then immediately glossed,
  jargon-as-reassurance not jargon-as-spec. (3) "Security handled by us: kept up to date,
  backed up, and if it ever goes down we get told before you do" — describes what actually
  happens (platform automates, we monitor and answer for it), no invented security team.
  (4) "Hosted on Australian servers, so it loads quickly for the people looking you up."
  (5) "Your web address kept pointed at it."
- Cost block hosting row: "$42.90/month inc GST — hosting with the editor: change your photos,
  wording and reviews yourself, ten changes a month. The SSL padlock, security and Australian
  servers are handled by us." The s11 discipline is untouched: $220 and the monthly in the
  same visual block, above the button.
- Comparison card: "$220, then $42.90 a month" and the change row now ends "then ten a month
  once live."

**Two obligations this copy creates, written into the section comments as well:**

1. **The self-serve editor must ship before the first customer goes live on this tier.** The
   page now sells it as the reason for the price, and it is scoped (SCOPE-EDITOR.md), not
   built. Weeks of runway exist; do not let it reach zero.
2. **The app still sells the $33 product at go-live.** shared/pricing.ts `hosting` remains
   website-hosting-australia at $33 because diy-hosting-monthly is a DRAFT with no Appstle
   selling plan, and switching before the plan exists would break every go-live checkout
   (requiresSellingPlan). Before the first DIY go-live: Chris attaches the monthly selling
   plan in Appstle and publishes the product, then pricing.ts switches to the new SKU/variant
   and `SHOPIFY_SELLING_PLAN_DIY_HOSTING_MONTHLY` is set. Until then the go-live screen
   quoting $33 against a landing page quoting $42.90 is a D31 violation waiting at the end of
   the funnel; acceptable only because go-live is weeks away and flagged here so it cannot be
   forgotten.

## D55 — Extra pages were sold and never built. A check, not a prompt, now stops it.

**2026-08-25.** A customer could buy three service pages, be charged for three, and receive one,
with every check passing.

Three things had to be true at once. `planUserMessage` never told the model which services had
been paid for, so it had no way to know. The model returned `servicePages: []`. And
`enforcePlanInvariants` treated a missing page as "the model chose not to", so it dropped them.
Nothing anywhere compared what was delivered against what was bought.

The fix is in three parts, and only the third is a guarantee:

1. `planUserMessage` now carries a `# PAGES THEY HAVE PAID FOR` section naming each service and
   the total allowance.
2. `enforcePlanInvariants` **synthesises** a missing page from the intake instead of dropping it.
3. **Check 19, `pagesDeliveredCheck`.** Compares paid services against delivered paths. A short
   build fails and cannot be published, and the failure names the missing services.

The first two are hopes. A prompt instruction is a request to a model, and a fallback only runs if
the code path is reached. The check is the part that makes silent loss impossible, which was the
requirement. Proven on the real Anthropic path (`claude-opus-5`), 2 requested and 2 delivered,
plus the check proven failing at 1-of-2 and 0-of-3.

## D56 — Hosting is $42.90/month inc GST, on the DIY SKU.

**2026-08-25.** The switch flagged at the end of D54 is done. `shared/pricing.ts` points at
`diy-hosting-monthly` (variant 62853864685727) at 4290 cents, and the landing page, the
comparison section and the go-live screen all quote one number, as D31 requires.

**This broke production once, for about ten minutes.** The SKU was switched before checking that
`SHOPIFY_SELLING_PLAN_DIY_HOSTING_MONTHLY` existed. `assertProductConfig` refused to boot and
build.itscold.com.au returned 500. Reverted, redeployed, then re-applied only after verifying the
variable was actually set. **Verify the environment before pointing code at it**, particularly for
config a boot assertion depends on: the failure is total and immediate, not degraded.

The Australian-hosting claim on the landing page was also verified rather than asserted.
`X-Vercel-Id` read `syd1::iad1` - functions were executing in Washington DC while the copy said
Australian servers. Rather than softening a false claim into a vague one, `vercel.json` now pins
`"regions": ["syd1"]`. Verified `syd1::syd1`, and the database round trip fell from 1.35s to
0.35s as a side effect.

## D57 — The domain question comes before the money, and the enquiry inbox moved into the build.

**2026-08-25.** Chris's call, and both halves fix a real ordering problem rather than a taste one.

**The domain now precedes the payment.** The plan screen used to ask the customer to tick
"I need a domain, +$5.50" *before* anyone had checked whether the name they wanted was free. Two
ways to lose money on that: pay for a domain that turns out to be taken, or pay for a second one
when you already own one. The order is now ask, check, then charge - domain screen, then hosting,
then one Shopify cart carrying both.

**The cart is derived from the record, not the checkbox.** The two screens are separate requests
with a page load between them, so the browser's copy of "I need a domain" can go stale. If it
does, the customer pays for hosting, goes live, and has no web address - and nothing downstream
catches it, because the build passes and the payment clears. So `goLiveCartLines` in
`server/lib/products.ts` takes the recorded domain branch and the client flag, and either can
**add** the domain line while neither can **remove** it. Pulled out of the route specifically so
the rule is testable; `test/golive.cart.test.ts` covers it. Same principle as check 19 in D55.

**"Where did you buy it?" is a new question**, on the own/locked branches, stored on
`domains.registrar` (migration 0005, additive) and carried into the operator alert. WHOIS reports
the *reseller*, which is often not the brand on the login page the customer has to open, and the
first question on the connection call is always "where do we log in". A picker rather than a text
box so the alert stays scannable, with "I am not sure" as a real option - that answer means
*we* look it up, which is different from the question being skipped.

**The enquiry inbox moved from go-live into the build step.** Third home for it: intake (D29 -
59 submissions produced nothing usable, because there was no site yet to care about), then
go-live, now the editor page. Go-live was wrong because it is a *paying* sequence, and dropping a
third-party sign-up in front of a checkout turns a payment into an errand - they leave to make a
Web3Forms account and the cart is still sitting there when they get back, if they get back. On
the editor page they are already looking at their website with edits left, which is the one moment
where "let's point your form at your own inbox" reads as part of the build.

**The invariant did not move with it.** Until it is verified, the live site carries Go Polar's
Web3Forms key, so every enquiry from the website the customer just paid for lands in Go Polar's
inbox and they never see one. Go live still refuses without it - `InboxOutstanding` sends them
back to the build page rather than offering the form a second time. Two places to complete one
task means two places to keep working.

**Process note.** `tsc --noEmit -p tsconfig.json` passed clean while `tsc -b` - what the Vercel
build actually runs - found three errors, including a dead component and a client type that had
not been widened. **Verify with `npx tsc -b`.** The narrower command is not the build.

## D58 — Two silent image bugs, found by probing the publish rewrite instead of trusting it.

**2026-08-26.** Chris ran a dress rehearsal and asked for a favicon and a share image. Adding them
meant emitting an absolute `og:image` URL, and before doing that I checked what the publish-time
asset rewrite does to a URL that is not a bare relative path. It mangled it. Two things were
already broken in production because of the same mechanism:

1. **Every image on every paid service page.** `rewriteAssetPaths` was a substring replace over
   manifest paths like `assets/photo-01.jpg`. A service page lives at `services/<slug>/` and
   references `../../assets/photo-01.jpg`, so the replace left `../../https://blob.../key`. The
   page rendered, the build passed, the pictures did not load. These are the pages customers pay
   $25 each for.
2. **The JSON-LD `image` field**, which builds `${canonicalUrl}${logo.path}` and so became
   `https://theirsite.com.au/https://blob.../key`.

The rewrite now swallows whatever prefix names the same file — a run of `../`, or an absolute
origin — so all four ways this codebase names an asset resolve to one URL. Eleven tests in
`test/rewrite.test.ts`, including both bugs by name.

**The lesson is the method, not the fix.** Neither bug was visible from inside the product and
neither would ever have failed a check. They surfaced because a new feature depended on the same
code path and the behaviour was probed rather than assumed. The dress rehearsal did not catch them
either, because a missing image looks like a design choice.

## D59 — The favicon and the share card.

**2026-08-26.** The built website had no `<link rel="icon">` at all. The favicon existed only
inside the downloadable zip, so every live site and every preview showed the browser default.

Worse, the head declared `twitter:card=summary_large_image` and never named an image. That is a
positive claim that a picture is available, so the site produced a large blank card everywhere it
was pasted. A page with no card tags degrades to a tidy link; a page that declares a card and
withholds the image does not. `headMeta.ts` now emits `summary` when there is no usable image, and
**that branch must not be simplified away**.

**The share image is a photo, not the logo**, whenever one exists, and always the JPEG — crawlers
do not render WebP or SVG reliably, so handing Facebook a WebP produces the same blank card as
handing it nothing.

**The favicon uses the logo, with one exception.** Chris asked for the logo automatically. A wide
lockup at 16px is an illegible smear, and the audit already flags that shape (`logo_wide_lockup`,
aspect >= 3.2), so a wide logo falls back to the generated mark — their initials on their brand
colour. Following the instruction literally there would have produced a worse icon than the
alternative.

The generated `favicon.svg` is now written into the published site at publish time. It was linked
but never shipped, so the link 404'd. Check 8 (`assets_exist`) correctly failed the build the
moment the link was added, which is the check doing its job; it now knows the favicon is generated
rather than uploaded.

## D60 — Going live is a button, not a footnote.

**2026-08-26.** The way out of the editor was `text-xs text-ice-500 underline` sitting beside a
solid accent button. The one action that finishes the job, and takes the next payment, read as a
footnote to the one that does not.

Now two real buttons of equal weight in different colours: accent blue for "make this change",
near-black for "I'm ready to go live". Plus a card in the left column, because on a phone the
changes panel is `absolute inset-0` and covers the screen — somebody reading their site and its
history never sees the footer at all.

**Not gated on the checklist.** The checklist is advice, nothing in it blocks going live, and a
customer who is happy after two minutes should not have to tick eight boxes to find the door.

## D61 — Shopify notification templates cannot be automated. Copy handed over instead.

**2026-08-26.** The order confirmation email said "$500 website" to people paying $220, because it
had been hand-written for the `websites` deposit product.

There is **no Admin API** for this. Searching the GraphQL `Mutation` type for `notification` or
`template` returns only the two gift-card send mutations, and `checkoutBranding` is unavailable on
this store (Basic, not Plus). Shopify also allows exactly **one** order confirmation template per
store, so "a separate one per product" is not possible.

The answer is one template that branches in Liquid on
`line.product.handle == 'diy-website-build'`, giving DIY buyers a "your next step is in your inbox"
block and everyone else generic wording. Exact copy and paste locations are in
`SHOPIFY-NOTIFICATIONS.md`. This one is Chris's to apply.

**Also worth knowing for the thank-you page:** on a Basic plan the *Additional scripts* box may
already be gone, in which case customising it needs a checkout UI extension, which means an app.
The email block does the same job, so that is where the effort went.

## D62 - Klaviyo flow content. NEEDS CHRIS'S SIGN-OFF BEFORE A CUSTOMER READS IT.

**2026-08-26.** `KLAVIYO-FLOWS.md` documents every event the app fires and carries paste-ready
copy for three flows: the operator alert, the go-live confirmation, and a seven-email post-live
nurture sequence.

**The copy is not approved.** Same status as `shared/pages-copy.ts` under D44. It is the most
legally exposed writing in the product after the landing page, because emails 6 and 7 describe
search and advertising, which is the hardest place to describe a product without promising a
result.

### Three gaps found while establishing the facts

Writing the flows meant listing what actually fires, and the listing found three things:

1. **No site-live event existed.** Publishing wrote a `site.published` row to the events table and
   told the customer nothing at all. The one moment the thing they bought becomes real was the
   quietest moment in the product. Built as `Website Is Live`, fired from `publishSite`.
2. **Chris was alerted on the button press and never on the payment.** A press is an intention
   some people will not act on. The payment is the obligation: hosting starts billing and an
   address has to be connected. Added as `alert: go_live_paid`.
3. **`ops_link` pointed at `/ops`**, so an alert meant searching a list. Both alerts now deep link
   to `/ops#job-<id>`, with a matching anchor on the card.

`Website Go Live Requested` was also enriched with the business name, domain name and domain
branch. It carried a preview link and nothing else, which is not enough to write an honest "here
is what happens next": the next step genuinely differs between a domain they own, one we are
buying, and one stuck with a previous designer.

### is_first_publish exists for one reason

`Website Is Live` fires on EVERY publish, including a re-publish after an edit. Without a filter,
a customer gets the entire seven-email welcome sequence again every time they change a photo. The
flag is computed before the `sites` upsert, because after it every publish looks like an existing
one.

### The metric names are pinned by a test

`test/klaviyo.metrics.test.ts` asserts all ten names literally. A flow is bound to a metric by a
string typed into Klaviyo by hand, so renaming one in code breaks no build, fails no type check
and throws nothing. The event lands under a name nothing is listening to and the emails silently
stop. If that test fails, the question is which live flow needs renaming first.

### The copy rules are enforced, not asserted

`test/klaviyo.copy.test.ts` greps the document for the same forbidden patterns as
`test/pages.copy.test.ts` (rankings, positions, volume, growth, timeframes, guarantees), plus em
dashes and the banned jargon list. It also checks the structure Chris asked for: seven emails,
free advice inside the first two weeks, and **at least fourteen clear days** before anything that
costs money.

The list is deliberately duplicated rather than shared with the pages test. Two separate approval
surfaces, and neither should be able to relax the other.

Three real violations were caught by that test on the first run, one of them an em dash in a
heading of this author's own writing.

### One wording decision worth keeping

Chris asked for "contact within 24 hours". The copy says **one business day** instead. Somebody
who presses go live at 9pm on a Friday counts twenty four hours forward and lands on Saturday
night. The commitment is identical in substance and survives a weekend, which the hours version
does not.

### The cadence, and why

Seven emails over eight weeks: day 0, 3, 8, 15, then 29, 43, 57.

The first four are free advice, clustered into the fortnight when the site is new and the customer
is actually motivated to act on it. Then fourteen clear days before the first paid suggestion,
because they have just paid $220 plus hosting plus possibly a web address, and asking for more
money in week one reads as a business that was only ever going to keep asking. The paid emails go
one at a time and cheapest first: email address, then service pages, then advertising.

Anyone who replies should be removed from the sequence. That is a Klaviyo setting, not code.

## D63 - The post-build editor. Bucket 2 of SCOPE-EDITOR.md, built.

**2026-08-26.** Built while there were **zero published sites**, which was deliberate. Every change
here touches the publish path, and that path had no live mileage at all. Doing the structural work
with nothing at stake was the safest window this feature will ever have.

### One publish gate, two callers

`server/lib/publishJob.ts` is now the only place a website becomes public. The operator endpoint
and the customer's button both go through it, and the only thing the operator gets that the
customer does not is `force`.

This replaced 155 lines in `admin.ts`. Had the customer route been written separately it would
have been a second 155 lines, and the two would have drifted within a month. The failure this
codebase keeps producing is a rule that exists on one path and not the other: the Web3Forms guard,
the paid-pages check, the asset rewrite. One implementation is the fix for the category, not just
for this instance.

**Checks are re-run at publish time, not read off `builds.passed`.** That flag records how a
version looked when it was built. Publishing can happen weeks later, against a different version
after a rollback. A stored boolean is a memory of a check; running the check is the check.

**The paid-pages check now runs on the live path too.** D55 put it on the build path only. A
rollback can select a version that predates a page the customer has since paid for, and publishing
that would quietly remove it from their live site.

**Nothing is written until everything is read.** Every page is loaded and verified before the
first byte reaches storage, so a refusal halfway cannot leave a live site as a mix of old and new
pages.

**What "all 19 checks" honestly means in production:** four of them drive a real browser and
production runs `renderDriver: none`. Those four report `skipped`, which is not `pass`, and only
`fail` blocks. So production enforces 15 static checks plus the paid-pages check; the render four
are enforced at build time on a machine that has a browser. Stated rather than papered over.

### Restore now reaches the live site

This was shipped broken and is the reason it was built first. Rollback moved
`jobs.currentVersion` and wrote an edit row, and stopped. For a live customer the preview went
back and the public website kept serving the version they were panicking about. The panic button
did nothing about the panic.

Now: the pointer moves, publish runs, and **if publish refuses the pointer is put back**. Ending
up with the database saying one version while the internet serves another is the exact
inconsistency this button exists to get somebody out of.

The UI moved too. It was `text-xs underline` inside a collapsed version history. A person who has
just put a mistake in front of their customers is not reading, they are scanning for the way out,
so it is now a full-width button on the surface of the live panel labelled as an undo rather than
as a version operation.

### Two allowances, kept apart on purpose

- **Pre-launch:** `jobs.editsUsed` / `editsAllowed`. Ten, lifetime, never resets. Does not hard
  block (D5).
- **Live:** ten per calendar month, AWST. **Does** block, because the tier states ten a month,
  there is no product to sell an eleventh, and running it anyway would make the stated inclusion
  a fiction. The refusal names the date it refills and offers a person.

**Counted, never stored.** `edits.phase` marks which bucket a row came from and the monthly figure
is a query over those rows. A stored counter needs a reset that can fail to run, run twice, or run
in the wrong timezone, and when it drifts nothing notices. A count cannot disagree with the rows
it is counting.

**A failed edit still costs nothing.** The edit row and the counter update both sit inside the
success branch, which is what made that true pre-launch. The monthly figure is a count of exactly
those rows, so the same shape protects it. A rollback writes `counted: false` and costs nothing on
either allowance.

### Claim-to-email-link, for live jobs only

Email plus order number is evidence of a purchase. It is enough to open a build that only exists
on our servers. It is **not** enough to edit a website the public is already looking at: neither
half is secret, an address is on the side of the van and an order number is on a forwarded receipt.

So for a live job the match is now the claim step only, and a fresh link goes to the address on
record. `createBuildToken` mints a **new** token, so somebody whose original link lapsed months
ago is the normal case and works. Pre-launch is unchanged, because that flow is verified and
working and the stakes there are different.

### Cancellation, which nothing consumed until now

A cancelled subscriber kept their site, kept editing, and kept costing money. With a self-serve
editor that stops being a slow leak and becomes somebody actively using a product they stopped
paying for.

Shopify's own subscription topics are handled (signed with the secret the route already verifies,
rather than a second Appstle integration with a second secret). Editing and publishing refuse.
`hostingStatus` defaults to `'unknown'` and only an explicit cancellation locks anything, because
absence of a cancellation is not evidence of one and every customer predating the column must
carry on working.

**A billing failure is not a cancellation.** Shopify retries and cards recover.

### Rate limiting

Six edits an hour, on top of the ten a month. The monthly cap limits what a customer spends, not
how fast, and the expensive failure is a stuck customer regenerating ten times in ten minutes.
Rollbacks are excluded: the moment somebody most needs to undo is right after making several
changes quickly.

### Proven, not asserted

`scripts/proof-editor-loop.mjs`, 18/18 against a real database and real storage: publish, live
bytes change, rollback, **live bytes revert**, a failing page refused with the check named, the
live site untouched by that refusal, a cancelled subscription blocked, the operator force still
working, and the allowance counting live edits but not pre-launch ones or undos.

Three of those assertions failed on the first run and all three were the system being right and
the fixture being wrong: the assets were not in the database, the fixture still carried the Go
Polar forms key, and the "customer" key chosen for the swap happened to be identical to the dev
`WEB3FORMS_KEY`. The guards were fixed in place and the fixture was made realistic.

---

## TWO POLICY QUESTIONS FOR CHRIS. Neither is a code decision.

**1. What happens to a cancelled customer's live website, and after how long?**

Right now: editing and publishing stop, the site **stays up indefinitely**, and Chris gets an
alert. Nothing takes a site down automatically, deliberately: pulling a tradie's website offline
the hour a card bounces is a person's decision, and the person who loses is the one whose phone
number is on it. But "indefinitely" is not a policy, it is the absence of one, and it means Go
Polar pays to host cancelled customers forever.

Needs: a grace period, and what replaces the site at the end of it.

**2. Is a hard stop at ten changes a month right?**

It is what the landing page promises and what is now enforced. The alternative is to keep going
and bill, which needs a price that does not exist yet, or to keep going free, which makes the
number meaningless. Worth deciding before the first customer hits it rather than during.

## D64 - The returning customer signs in with a six digit code, not a link.

**2026-08-26.** Chris's specified flow, built. Supersedes the magic-link approach in D63.

**A code beats a link for this audience.** A tradie reading email on a phone has to leave the
browser for the mail app and come back, and on an older phone whatever they had open is often gone
by then. A code is read once, from the notification if the Klaviyo flow puts it in the subject, and
typed into the screen already in front of them.

**A code is only as good as its constraints**, because six digits is one million possibilities and
a million is nothing to a script. All of these are in `server/lib/loginCode.ts` and all of them are
load-bearing:

| Constraint | Value | Why |
|---|---|---|
| Attempts | 5, then the code dies | 1 in 200,000 per code |
| Send limit | 3 per address per 15 min | Caps the guessing budget AND stops this being a mail bomb |
| Expiry | 10 minutes | A code found later is worthless |
| Single use | `consumedAt` | A code that worked cannot work again |
| Comparison | constant time over hashes | The code itself is never stored |
| Binding | the email it was sent to | Can only ever open jobs for that address |

**The two limits multiply, and that is the number that matters.** 3 sends x 5 attempts = 15 guesses
per 15 minutes against a million. Either limit alone is not enough: attempts alone lets an attacker
mint fresh codes forever, sends alone gives a million guesses on three codes.

**Minting a new code kills the outstanding one.** Otherwise five requests means five times the
guessing budget, and a customer who pressed the button twice has two working codes.

**Rows are consumed, never deleted.** The send limit counts recent rows for an address, so deleting
them would reset the limit and hand back the mail bomb.

**Every failure costs an attempt, including one against an expired code.** Otherwise an attacker
learns which guesses were merely late.

**The request endpoint answers identically whether or not the address is a customer**, so it cannot
be used to find out who has bought a website. The email is only sent when there is a job to open.

**Order number stays for the pre-launch phase.** That pair is evidence of a purchase, which is fine
for opening a draft on our servers. It is not enough for a website the public is looking at:
neither half is secret. Control of the inbox is the only acceptable evidence once a site is live.

**Someone whose original token lapsed months ago is the normal case.** Nothing in this path
consults the old token. Proven: `scripts/proof-login-code.mjs` deletes every token for the job and
signs in anyway. 14/14.

### Chris's manual sync step does not exist, and never did

He said he expected to do something manual after a customer publishes. **He does not.** Verified in
the code rather than assumed:

`sites.ts` serves a request by calling `findSiteByHostname`, which looks up the `sites` row by
hostname and derives the blob key with `siteObjectKey(hostname, path)`. That function takes the
**hostname and the path only, never the version**. `publishSite` overwrites
`sites/{hostname}/index.html`. So the moment publish returns, the same key holds the new bytes and
the next request serves them.

The only wait is the cache header: `max-age=60, s-maxage=300`. Up to about five minutes for a
CDN-cached response, and a hard refresh sees it immediately. That is a cache, not a sync step, and
nothing anybody does makes it happen faster.

Domain attachment is genuinely one-time, done on first connection through `/admin/publish`. After
that every publish is self-serving.

**So the notification is purely so he knows.** It is not a queue item.

### The alert carries what changed

`alert: customer_published` (or `customer_restored`), with the business name, hostname, the version
now live, the previous published version, the customer's own words for the change, and a deep link
to `/ops#job-<id>`. Readable without opening anything, which is the point of an alert that is not a
task.

Operator publishes do not alert. Chris does not need an email about his own action.

### And a way to put it back

`POST /api/admin/restore { jobId, version }` and `GET /api/admin/jobs/:jobId/versions`. For the
call where a customer publishes something wrong and rings rather than pressing undo themselves,
which is what a worried person does.

It goes through the same `publishJob` gate, so an operator restoring a version cannot skip the
checks either, and the pointer is put back if the publish refuses. `force` remains on
`/admin/publish` as a deliberate second decision.

## D65 - The brief's data model, audited. The status lifecycle no longer holds.

**2026-08-26.** Section 10 of the brief specifies the schema explicitly. Compared against the real
one.

**Nothing specified is missing.** Every table and column exists. The divergences are all either
additive or renames that followed a real move:

| Brief | Actual | Why |
|---|---|---|
| `users.ghl_contact_id` | still there, **dead** | GoHighLevel deleted in D48. Column kept, nothing writes it |
| `assets.r2_key` | `original_key` | Storage moved off Cloudflare R2 to Vercel Blob |
| `builds.r2_key` | `blob_key` | Same move |
| `orders.amount_ex_gst` | unchanged | Name is wrong for a GST-inclusive store (D31). The value is genuinely ex-GST, so the name is accurate and the concept is the odd one |

Five tables the brief never anticipated exist for features built since: `golive`, `build_pages`,
`discharges`, `sites`, `login_codes`.

### The lifecycle broke, and it had already caused a bug

The brief treats `live` as terminal: `paid → intake → generating → preview → editing →
go_live_pending → live → discharged | abandoned`. The enum still matches exactly.

**It is no longer true.** A live customer editing their own site sets the status back to `editing`
(`edits.ts`). `live` is not terminal and `jobs.status` cannot answer "is this site public".

That was not theoretical. `/ops` computed its waiting list as
`status !== 'live' && status !== 'discharged'`, so **every customer who went live and then changed
something reappeared on the go-live waiting list**, with an hours-waiting counter climbing, on the
screen whose only job is telling Chris who needs a phone call. Fixed to read the `sites` table,
which is the fact that matters. Same reasoning as `editPhaseFor`.

**The rule to carry forward: `jobs.status` is a workflow position, not a statement about the
internet. Anything asking "is this live" reads `sites.live`.**

## D66 - extra-edits is removed, not priced. Running out means going live.

**2026-08-26. Chris's call.** The $42.90 tier includes ten changes a month, so selling five more
pre-launch rounds stopped making sense: the honest answer to "I have used my ten" is now "go live,
and you get ten a month from that day", not "pay us more to keep drafting".

Removed entirely: the `PriceKey`, the `PRICING` entry, `EXTRA_EDITS_QUANTITY`, the order handler
branch that granted them, the store-title mapping, and the endpoint that quoted the price. There is
no dark path left quoting a number that does not exist.

**Running out still does not hard block** (brief s7, D5). A customer who sends another change
anyway gets it made and Chris is told the same day. Running out is a prompt to finish, not a wall.

**The product configuration is now completely clean.** `productConfigProblems` returns an empty
array for the first time, and two tests assert that rather than having been deleted, because
"there is nothing left to configure" is a fact worth knowing when it stops being true.

## D67 - No $110 post-live edit in the DIY flow.

**2026-08-26. Chris's call.** The go-live confirmation screen, the last thing a customer read
before paying, said *"Changes after you are live are handled by our team. Website update after
launch: $110.00 inc GST"* to somebody who had just bought the tier including ten self-serve changes
a month. It contradicted the landing page, the comparison section and the product itself.

Now: *"Changes after you go live. Included. You get 10 changes a month, and you make them yourself
in the same chat box you used to build it."* The number comes from `shared/allowance.ts` so it
cannot drift from what the editor enforces.

**The product is NOT archived.** It stays on the store because Chris's other website customers use
it, and because a legacy $33 subscriber genuinely has no editor. It simply has nothing to do with
the DIY path, and the only remaining reference is inbound order parsing so a legacy order is still
recognised.

## D68 - A cancelled customer's site comes down after 60 days.

**2026-08-26. Chris's call**, closing the policy question left open in D63.

```
DAY 0    Cancellation received. Site stays up and keeps serving. Editing stops.
DAY 30   Warning. Still up.
DAY 53   A week to go.
DAY 59   Tomorrow.
DAY 60   The site stops serving.
```

**Editing ends at cancellation** because that is the thing they stopped paying for. **The site does
not**, because taking a business website offline the hour a card bounces is not a decision a
webhook should make.

**Nothing is ever deleted.** Takedown flips `sites.live` to false, which stops
`findSiteByHostname` answering. The build, every version, the plan and the images stay exactly
where they are. A customer who resubscribes in month four, or pays for a discharge in year two, is
somebody who can still be helped. Proven against real storage: the document is still readable after
takedown.

**Resubscribing before day 60 undoes everything with no intervention.** Every date is derived from
one field, `golive.hostingEndedAt`, so clearing it IS cancelling the takedown. There is no second
place a stale countdown could survive. A site already dark comes back up.

**Discharge stays available throughout, including after takedown.** They paid $220 for the build
and the files are theirs to buy. Verified: the discharge route never consults live state.

**Only a confirmed cancellation starts the clock.** `hostingStatus` defaults to `'unknown'` and a
failed payment is not a cancellation, because Shopify retries and cards recover. Both proven.

**Warnings are sent BEFORE any takedown is considered**, in the same sweep pass, so a site cannot
go dark without its last warning even if the sweep has been down for a fortnight and catches up in
one run. And a catch-up sends only the LATEST warning, not four at once: somebody who has heard
nothing for two weeks should get "your site comes down tomorrow", not a pile of history.

**Visible in `/ops` before it happens**, at `GET /api/admin/takedowns`, with days remaining. A list
that only appeared after a site went dark would be a log, not a safeguard.

**One metric, four stages.** `Website Hosting Ending`, told apart by `stage`. The headline and body
are computed in `shared/takedown.ts` and travel in the payload, so the wording of a message that
ends with a website going offline lives in one place beside the clock that drives it, not in four
Klaviyo templates that can drift apart. Every warning says how to stop it, names the date, and says
nothing has been deleted.

**Proven:** `test/takedown.test.ts` (18 assertions on the clock, both sides of every edge) and
`scripts/proof-takedown.mjs` (24 assertions against a real database and real storage, including
that day 59 is not a takedown, that the bytes survive, and that resubscribing at 45 days cancels
it).

**FOR SIGN-OFF:** the four warning emails in `shared/takedown.ts` are customer-facing copy Chris
has not read. Same status as D62.

## D69

**A page the customer paid for must be allocated before the build runs, and the check that
guards it reads the entitlement rather than the choice.**

Found in a dress rehearsal on 2026-08-26, job `job_03b9657cf7f24757828ab158`. The tester bought
four additional pages, scrolled past the picker without choosing any, and got a one page website.
Every stage reported success.

The purchase chain was correct throughout: `pages.granted {granted: 4, pagesAllowed: 5}`. What was
empty was `intake.ownPageServices`, and nothing objected. `pagesDeliveredCheck` compared the
delivered pages against the services the customer had CHOSEN, so an empty choice had nothing
missing from it and the check passed, reporting "0 paid page(s) requested, 0 built".

Two changes, and both are needed. `unallocatedPages()` in `shared/intake.ts` is one rule used by
the wizard and by the submit route, and submit returns 422 rather than building short.
`pagesDeliveredCheck` now takes `pagesAllowed` and fails when pages were bought and never
allocated.

`pagesAllowed` is a REQUIRED argument on purpose. Optional would have restored the bug the first
time a call site forgot it, which is the same shape of hole the check itself was.

**Why the tests missed it:** every case in `test/paidpages.test.ts` populated `paidPageServices`.
The single case passing an empty array also passed an allowance of one, where empty is correct.
Nothing asserted on the combination that actually shipped. It does now.

## D70

**Accent blue is a background colour. Accent text on a light ground uses `--color-polar-accent-ink`.**

The same rehearsal reported that text in the chat box could not be read. Measuring the running app
rather than reasoning about it: white on `#38b6ff` is 2.26:1, against the 4.5:1 AA asks for. That
was `.btn-accent`, so every primary button in the product, and `.chip-on`. `.eyebrow` was the same
blue as 11px ink on white, also 2.26:1.

`#38b6ff` is unchanged, because it is the value read off itscold.com.au. Buttons now carry
near-black labels, which measures 8.77:1 on the real rendered button. Accent-coloured TEXT uses
`--color-polar-accent-ink: #1f6690`, the same hue taken down to 6.25:1. Darkening the background
blue enough for white to pass would have taken it to `#267cad`, which is a different brand colour.

Two dead utility classes were found the same way and are worth recording, because neither failed
any build: `bg-accent` on the generation progress bar (the token is `polar-accent`, so the fill
was transparent and the bar had no colour at all, which is exactly what the tester reported), and
`text-ice-400` / `text-ice-600`, shades this palette does not define.

## D71

**The Web3Forms key is collected BEFORE the build, and it never blocks the build.**

Third position for this task. Intake (D29) produced 59 submissions of email addresses and phone
numbers, because at that point there is no website to care about. Go-live turned a payment into an
errand. The editing page, which was the previous answer, is where the rehearsal tester stopped
dead: the task arrived after the exciting part was over, beside a website he was already happy
with, and read as an interruption.

Before the build, it is one setup question among the setup questions, and the five to ten minutes
of generation they are about to wait through is time to make the account.

Everything that made the go-live version safe is kept: guided explanation, a link that opens
web3forms.com in a new tab, validation that names what was pasted wrongly, and a live test
submission that must actually arrive before a key is accepted. What is added is a skip: the build
button is never disabled, and `InboxTask` still carries the reminder afterwards. Being trapped is
the failure being fixed, so trapping people would be a worse bug than the one it replaces.

The `why` copy is now written to be true in both places it appears. It previously opened with
"Right now the enquiry forms on your website send to our account", which is false on a screen
shown before the website exists.

## D72

**A logo is sized from its own dimensions.**

The header emitted `width="180" height="44"` and the footer `width="240" height="70"`, both
hardcoded. Those attributes are what the browser reserves space with, so a square logo was given a
footer box 3.43:1 and looked squished. `logoBox()` in `server/lib/render/site.ts` computes the box
from `facts.logo.width/height`, capped on both axes, and the CSS carries `object-fit:contain` so
nothing can distort whatever the attributes say.
