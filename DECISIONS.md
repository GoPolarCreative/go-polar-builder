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
