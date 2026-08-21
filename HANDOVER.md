# Handover

Last updated 2026-08-21. Written for someone with no memory of the days it describes.

**It is live and the whole customer path works.** A real order has gone through end to end: paid on
Shopify, job created, email delivered, website generated, files downloadable.

---

## The live thing

| | |
| --- | --- |
| **App** | https://build.itscold.com.au |
| **Repo** | https://github.com/GoPolarCreative/go-polar-builder |
| **Vercel** | `go-polar-builder`, Pro, syd1 |
| **Database** | Neon Postgres, 15 tables |
| **Files** | Vercel Blob, private, syd1 |
| **Email** | **Klaviyo.** Not GoHighLevel, not Resend. See below |
| **Model** | `claude-sonnet-5` — measured against Opus 5, see DECISIONS D47 |

---

## The flow, as it actually runs

```
Facebook ad
  → itscold.com.au/products/diy-website-build
  → pays $220 inc GST
  → Shopify fires orders/paid  →  app verifies HMAC, creates the job
  → app emits Klaviyo event "Website Build Purchased" with builder_login_link
  → Klaviyo flow sends the email
  → they land on build.itscold.com.au and build their site
  → Chris downloads the files and hosts them like any other client site
```

Lost their link? The form on the landing page emits **"Website Link Requested"**, same shape, and a
second Klaviyo flow sends it again.

**They do not need the email at all.** The card at the top of build.itscold.com.au takes the email
they paid with plus the order number off their receipt — `#GPC1258` — and lets them straight in.
Two factors, because email alone would open somebody else's website. This exists because the
product spent a day unreachable behind an email that was not being delivered, and a door that
depends on someone else's DNS is not a door. D49.

---

## Email: Klaviyo, and only Klaviyo

**The app never sends email.** It emits events; Klaviyo owns every template, every subject line and
every send. Copy changes without a deploy.

Seven metrics, all in `server/lib/klaviyo.ts`:

| Metric | Fires when | Carries |
| --- | --- | --- |
| `Website Build Purchased` | build token paid | `builder_login_link` |
| `Website Link Requested` | "lost your link" form | `builder_login_link` |
| `Website Build Complete` | generation finished | `preview_link` |
| `Website Go Live Requested` | hosting purchased | `preview_link` |
| `Website Files Ready` | discharge purchased | — |
| `Website Intake Abandoned` | started, stopped 24h | `builder_login_link` |
| `Website Editing Stalled` | built, untouched 72h | `preview_link` |

**Every event carries its own link.** A flow that has to look one up is a flow that can send an
email with a dead button, and the whole product is one link in one email.

**The API revision is pinned** in `klaviyo.ts`. Klaviyo versions by date; unpinned means a working
integration breaks on a morning nobody deployed. Bump it deliberately.

**202 Accepted is the only success.** Anything else, including 200, is treated as a failure.

**Klaviyo will not offer a metric that has never fired.** A new metric is invisible in the flow
trigger picker until one event of that name arrives. Fire one with
`POST /api/admin/test-email?email=…` before trying to build its flow.

**GoHighLevel is gone** — deleted from the code on 2026-08-21, not disabled. Two flows were built
there and neither ever delivered: the root domain `itscold.com.au` authorises only `spf.ax.email`,
so GHL could not send as `hello@itscold.com.au` and Gmail binned everything. Klaviyo already owned a
verified sending subdomain, which is why it works.

---

## What is left

**Nothing blocking.** These are improvements, not gaps:

- **`ENABLE_LIVE_PAYMENTS=1`** — still off. It only gates the app *creating* checkout links, which
  happens at go-live for hosting. The purchase path does not touch it. Needed before testing go-live.
- **Shopify Dev Dashboard app** (`SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`) — never created.
  Without it: no hourly sweep for dropped webhooks, and store checks report "cannot verify".
  Payments, jobs, builds and emails all work without it. DEPLOY.md section 6.
- **`extra-edits` price** — never decided. Degrades honestly, blocks nothing.
- **Copy sign-off:** D28, D31, D35, D44 in DECISIONS.md.
- **The builder UI has never been properly exercised in a browser.** The API is well tested and the
  page loads, but that is not the same as clicking through the whole wizard.
- **Duplicate `_dmarc` record** on itscold.com.au. Two exist, only one is valid. Unrelated to this
  app but it weakens every email you send.
- **The five existing paid build orders cannot be claimed.** Their `shopify_order_number` is NULL
  because they predate the column. Not worth repairing — they are all test orders and the emailed
  link still opens them. Every order placed from 2026-08-21 onward stores the number. D49.

---

## Numbers

| | |
| --- | --- |
| Generation | 6–12 minutes, depending on whether a repair pass fires |
| Anthropic cost | **$0.77 per build**, measured |
| Per customer, few edits | ~$3.85. All ten edits, ~$8.50 |
| Vercel | $20/month. Neon and Blob on free tiers |

Against $200 ex GST, running cost is under 2%.

---

## Operator endpoints

All behind `x-admin-token: $ADMIN_TOKEN` (value in `.env.local`).

| | |
| --- | --- |
| `GET /api/admin/queue` | Who is waiting and what blocks them. Paid-but-blocked first |
| `GET /api/admin/jobs/:id/files` | Their finished website as a zip, ready for GitHub |
| `GET /api/admin/trace?email=` | Which of the four payment steps broke |
| `POST /api/admin/test-email?email=` | Fires a real Klaviyo event to a real inbox |
| `GET /api/admin/storage-check` | Round-trips a real file through Blob |
| `POST /api/admin/migrate` | Applies migrations, idempotent |
| `GET /api/health` | Config, model, store checks, Shopify auth mode |

---

## How a customer's website reaches them

You are **not** hosting their site from this app. It builds; you collect the files and host them
the way you already host every other client site.

1. They finish, pay for hosting
2. They verify their **own** Web3Forms key on the go-live screen. **This gates the download**,
   because a site put live carrying the Go Polar key sends their enquiries to us
3. They appear in `/api/admin/queue` with `readyForYou: true`
4. `GET /api/admin/jobs/:id/files` gives the zip: every page, assets, favicon, a double-clickable
   `PREVIEW.html`, sitemap, robots, README
5. Unzip, `git init`, push, import to Vercel

Verified: 22 files, 9.0MB, the Go Polar key appears nowhere in the archive.

---

## Running it

```bash
npm run dev          # localhost:5173, demo mode, no accounts
npm run seed         # prints two signed-in links
npm test             # 375 tests
npm run sample       # rebuilds the committed sample
npm run vercel:push  # push .env.local to Vercel (dry run; --apply to commit)
```

Stop the dev server with Ctrl-C, or `curl -X POST http://localhost:8787/api/dev/shutdown` if
detached. A hard kill has corrupted the embedded database before.

Deploy with `npx vercel deploy --prod`. Migrations run separately, afterwards, via the admin
endpoint — the Neon connection string is marked Sensitive and cannot be pulled locally.

---

## Things that will bite you

- **The builder's own hostname is hardcoded once**, in `vercel.json`. It decides whether a request
  gets the app or a published customer site.
- **`RENDER_DRIVER=none` in production** (D46). Four browser-based checks do not run there; they
  report as *skipped*, never passed. All thirteen static checks still run on every page.
- **Klaviyo answers 202 to an event whose flow does not exist.** Acceptance is not delivery. The
  profile's activity feed in Klaviyo is the only proof.
- **The "lost your link" form always says the same thing**, whether or not the address exists. That
  is deliberate, and it means only `/api/admin/events` can tell a real send from a failure.
- **No performance claims in customer-facing copy.** No rankings, positions, traffic or timeframes.
  Australian Consumer Law, and `test/pages.copy.test.ts` greps for it.
- **Secrets go in via `npx vercel env add --value`**, never piped on stdin. The CLI grew a prompt
  mid-session once and silently kept the old value.
