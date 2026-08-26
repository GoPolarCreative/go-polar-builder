# Handover

Last updated 2026-08-26. Written for someone with no memory of the days it describes.

**It is live and the whole customer path works**, from a Facebook ad to a website the public can
reach. A real order has gone through end to end. `REMAINING.md` is the current list of what is
left; this file is what the product IS.

> **This file was badly wrong until 2026-08-26.** It said, in bold, that this app does not host
> client sites and that Chris collects a zip and hosts them himself. That stopped being true at
> D24 and is now the opposite of the truth. If anything below disagrees with the code, the code
> wins, and fix this file.

---

## The live thing

| | |
| --- | --- |
| **App** | https://build.itscold.com.au |
| **Repo** | https://github.com/GoPolarCreative/go-polar-builder |
| **Vercel** | `go-polar-builder`, Pro, syd1 |
| **Database** | Neon Postgres, 16 tables |
| **Files** | Vercel Blob, private, syd1 |
| **Email** | **Klaviyo.** Not GoHighLevel, not Resend |
| **Model** | `claude-sonnet-5`, measured against Opus 5, D47 |
| **Tests** | 519, plus two proof scripts that need a database |

---

## THIS APP HOSTS THE WEBSITES. That is the part people get wrong.

A published site is HTML in Vercel Blob under `sites/{hostname}/`, and a `sites` row pointing at
it. A request on a customer hostname is answered by `GET /site`, which looks up the hostname and
serves the stored document. Images are absolute URLs to stored files and never pass through a
function. D24 and D25.

**There is no manual sync step after a publish, and there never was.** `siteObjectKey` derives the
blob key from **hostname and path only, never the version**, and `publishSite` overwrites that key.
The new bytes are live the moment they are written. The only delay is the cache header,
`max-age=60, s-maxage=300`, so up to about five minutes on a CDN-cached page. That is a cache, not
a queue.

Attaching a domain is genuinely one-time, on first connection through `/api/admin/publish`.

The discharge zip still exists, and is a different thing: a customer **leaving** pays $330 to take
their files elsewhere.

---

## The flow, as it actually runs

```
Facebook ad
  → itscold.com.au/products/diy-website-build
  → picks one page, or a page per service, pays $220 inc GST
  → Shopify orders/paid → HMAC verified → job created
  → Klaviyo "Website Build Purchased" carries the builder link
  → they build, and get 10 pre-launch rounds of changes
  → they connect their own enquiry inbox DURING the build (D57)
  → go live: domain question first, THEN hosting, then one cart
  → Chris connects the address, publishes
  → they edit their own live site, 10 changes a month, and publish themselves
```

**Two doors into the builder.** Pre-launch: email plus the order number off the receipt. Once the
site is **live**: a six digit code emailed to the address on record, because neither an email
address nor an order number is secret and a live site is worth more than a draft. D49, D64.

---

## Two allowances. Never conflate them.

| | Where | How many | Resets | Blocks? |
| --- | --- | --- | --- | --- |
| Pre-launch | `jobs.editsUsed` | 10, lifetime | never | No, escalates (D5) |
| Live | counted off `edits.phase = 'live'` | 10 per calendar month, AWST | 1st of the month | **Yes** |

The monthly one is **counted, never stored**: a stored counter needs a reset that can fail, run
twice, or run in the wrong timezone. `shared/allowance.ts`.

**A failed edit costs nothing**, because the edit row and the counter both sit inside the success
branch. Keep them there. Rollbacks write `counted: false`.

---

## Email: Klaviyo, and only Klaviyo

The app **never sends email**. It emits events; Klaviyo owns every template and every send, so
copy changes without a deploy. **Eleven metrics**, all in `server/lib/klaviyo.ts`, all documented
with their payloads in `KLAVIYO-FLOWS.md`.

- **`test/klaviyo.metrics.test.ts` pins all eleven names.** A flow binds to a metric by a string
  typed into Klaviyo by hand, so renaming one in code breaks no build and throws nothing. The
  emails just stop.
- **202 Accepted is the only success**, and acceptance is not delivery. Klaviyo answers 202 to an
  event whose flow does not exist.
- **Klaviyo will not offer a metric that has never fired.** Fire one with
  `POST /api/admin/test-email?email=…` before trying to build its flow.
- **`Website Login Code` gates the returning-customer door entirely.** No flow, nobody gets back
  in, and the code exists only in the event payload so it cannot be looked up.

---

## Publishing, and the one gate

`server/lib/publishJob.ts` is the **only** place a website becomes public. The operator route and
the customer's own button both go through it. Do not add a second path.

It refuses: hosting unpaid, enquiry inbox unverified, any page missing from storage, any check
failing, any paid service page absent, hosting subscription cancelled.

- **Checks are re-run at publish, never read off `builds.passed`.** That flag is a memory of a
  check; running the check is the check.
- **Nothing is written until everything is read**, so a refusal cannot half-publish a site.
- **In production four of the nineteen checks report `skipped`** because there is no browser in a
  serverless function (D46). Only `fail` blocks. The render four are enforced at build time.
- **Restore republishes.** The pointer moves, publish runs, and the pointer goes back if publish
  refuses.

---

## Things that will bite you

- **`jobs.status` is NOT a reliable answer to "is this site live".** A live customer editing flips
  it back to `editing`. Read the `sites` row instead. This already caused a false waiting list in
  `/ops`. D65.
- **The builder's own hostname is hardcoded once**, in `vercel.json`. It decides whether a request
  gets the app or a published customer site.
- **`npx tsc -b` is the typecheck that matters**, not `tsc --noEmit -p tsconfig.json`. The narrow
  one has passed clean while the build found real errors.
- **Vercel runs a second, non-fatal type inspection** of `api/index.ts` with `strict` off, where
  discriminated unions stop narrowing. It reports errors the real build does not. Known noise.
- **No performance claims in customer-facing copy.** No rankings, positions, traffic or
  timeframes. Australian Consumer Law, and two test files grep for it.
- **Secrets go in via `npx vercel env add`**, prompted, never piped and never `--value` for a real
  secret.
- **Duplicate `_dmarc` record** on itscold.com.au. Unrelated to this app, weakens every email.
- **Five old paid orders cannot be claimed** by order number: they predate the column. Test orders
  only, and the emailed link still opens them. D49.

---

## Operator endpoints

All behind `x-admin-token: $ADMIN_TOKEN`.

| | |
| --- | --- |
| `GET /api/admin/queue` | Who is waiting and what blocks them |
| `GET /api/admin/trace?email=` | Which of the four payment steps broke |
| `POST /api/admin/publish` | Publish a job. Takes `force` |
| `POST /api/admin/restore` | Put a live site back to an earlier version |
| `GET /api/admin/jobs/:id/versions` | What versions exist and which is live |
| `GET /api/admin/jobs/:id/files` | The discharge zip |
| `POST /api/admin/test-email?email=` | Fires a real Klaviyo event |
| `GET /api/admin/storage-check` | Round-trips a real file through Blob |
| `GET /api/admin/domain-check` | Calls Vercel for real, read-only |
| `POST /api/admin/migrate` | Applies migrations, idempotent |
| `GET /api/health` | Config, model, store checks |

---

## Numbers

| | |
| --- | --- |
| Generation | 6 to 12 minutes |
| Anthropic cost | **$0.77 per build**, measured |
| Per customer, few edits | ~$3.85. All ten edits, ~$8.50 |
| Vercel | $20/month. Neon and Blob on free tiers |

Against $200 ex GST, running cost is under 2%.

---

## Running it

```bash
npm run dev          # localhost:5173, demo mode, no accounts
npm run seed         # prints two signed-in links
npm test             # 519 tests
npm run sample       # rebuilds the committed sample
```

Two proof scripts need a database and are not in the suite:

```bash
npx tsx scripts/proof-editor-loop.mjs   # 18 assertions: publish, restore, checks, cancellation
npx tsx scripts/proof-login-code.mjs    # 14 assertions: the six digit code and its limits
npx tsx scripts/proof-paidpages.mjs     # the real model path, costs money
```

Deploy with `npx vercel --prod --yes`. Migrations run afterwards via the admin endpoint, because
the Neon connection string is Sensitive and cannot be pulled locally.

Stop the dev server with Ctrl-C. A hard kill has corrupted the embedded database before.
