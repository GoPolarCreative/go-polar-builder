# Handover

Last updated 2026-08-20, end of day. Written for someone with no memory of today.

**It is deployed and it works.** A real customer journey has run end to end on production, against
the real Anthropic API, and produced a real website. What is left is three pieces of wiring, none
of which is code.

---

## The live thing

| | |
| --- | --- |
| **App** | https://go-polar-builder.vercel.app |
| **Repo** | https://github.com/GoPolarCreative/go-polar-builder |
| **Vercel project** | `go-polar-builder`, Pro plan, region syd1 |
| **Database** | Neon Postgres, 15 tables, all migrations applied |
| **File storage** | Vercel Blob, **private**, syd1 |

Everything below was verified against production, not read off a config file:

- Deployment reachable, protection off
- Database reads and writes
- Blob write → read back → compare → delete
- Photo upload and `sharp` processing (2.2MB → 413KB)
- **A real generation: 12m13s, two repair passes, 63,548 bytes, all checks passed**
- Shopify `orders/paid` webhook registered, HMAC verification confirmed active
- `/api/admin/*` refuses without the token, accepts with it

---

## What is left. Three things, in order.

### 1. The customer never receives their link — THE BLOCKER

Nothing sends it. A customer would pay $220 and hear nothing.

Get the GHL inbound webhook URL (**Automation → Workflows → new workflow → trigger "Inbound
Webhook"**), then:

```bash
cd /d "C:\Users\Chris\Desktop\GO POLAR WEBSITE" && npx vercel env add GHL_INBOUND_WEBHOOK_URL production --force
```

Then `ENABLE_LIVE_CRM=1` the same way, and redeploy. On payment the app fires:

```
event: payment_received
contact: { email, phone, firstName }
customValues: { builder_login_link: "https://.../start?t=..." }
```

Build the GHL workflow that emails `builder_login_link`. The same already happens for
`build_complete`, `intake_abandoned` and `editing_stalled`, each with the right link attached.

**Until this is connected, do not send traffic to the product page.** Nothing is lost if one slips
through — paid jobs appear in `/api/admin/queue` with the customer's email and the link can be sent
by hand — but they will be sitting there wondering.

### 2. The custom domain

CNAME `build` → `cname.vercel-dns.com`, then add `build.itscold.com.au` in Vercel → Settings →
Domains. `PUBLIC_APP_URL` already points there, so **every emailed link is currently dead** until
this exists. The Shopify webhook deliberately points at the `vercel.app` URL and needs no change.

### 3. Then, and only then

- `ENABLE_LIVE_PAYMENTS=1`, `ENABLE_LIVE_EMAIL=1` — deliberately still off. A half-configured
  deployment that is allowed to take money is worse than one that refuses.
- A real purchase with a real card. Check `/api/admin/trace?email=…` afterwards — it reports each
  of the four steps separately instead of "nothing happened".

---

## Optional, blocks nothing

- **Shopify Dev Dashboard app** (`SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`). Without it you
  lose the hourly sweep that catches dropped webhooks, and the store-verification checks. Payments,
  jobs, builds and links all work without it. DEPLOY.md section 6 has the click-by-click.
- **`extra-edits` price.** Never decided. Degrades honestly and does not block a launch.
- **Copy sign-off:** D28, D31, D35, D44 in DECISIONS.md.
- **The builder UI has never been opened in a browser on production.** The API is thoroughly
  tested; the React app builds clean and the bundle scan passes, but "builds clean" is not "works".
  Worth ten minutes.

---

## Numbers worth knowing

| | |
| --- | --- |
| Generation time | **12 minutes**, measured. Longer than any of the copy implies |
| Anthropic cost per build | ~$1–2 |
| Typical cost per customer incl. a few edits | ~$5–8. All ten edits, ~$15–20 |
| Vercel | $20/month. Neon and Blob on free tiers |

Against $220 inc GST, running cost is 3–10% of revenue.

---

## Decisions made today

- **D46: render checks are off in production** (`RENDER_DRIVER=none`). The four browser-based
  checks launch Chromium inside the function and that is what was killing the run. They report as
  **skipped, never passed**. The thirteen static checks still run on every page, and all seventeen
  still run locally through `npm run sample`.
- **`maxDuration` is 800 seconds**, which Fluid compute allows on Pro. 300 was not enough.
- **Blob is private**, and objects are written private to match. Everything is read server-side.
- **The webhook points at `go-polar-builder.vercel.app`**, not the custom domain, so it works today
  and never needs changing.

---

## Ten bugs fixed today, every one only findable by deploying

Local tests all passed throughout. These lived in the gap between this machine and the platform,
and between the offline fixture and the real API. Do not reintroduce them:

1. **Relative imports had no `.js` extensions.** `"type": "module"` plus per-file compilation meant
   the function died on its first line. 317 imports across 60 files. `npm run check:imports` guards
   it and runs at the front of every build.
2. **Vercel changed the function signature.** `export default handle(api)` is now read as the old
   `(req, res)` style. `api/index.ts` exports named HTTP methods instead.
3. **PGlite was the production fallback.** With no `DATABASE_URL` it spent three minutes failing to
   `mkdir` in a read-only function. Anywhere `VERCEL` is set the driver is postgres.
4. **`db/migrations` never shipped.** Nothing imports a `.sql` file, so tracing skipped it.
   `includeFiles` in vercel.json.
5. **`vercel.json` named an invalid `runtime`.** Node version comes from `engines`.
6. **Blob writes asked for public access on a private store.**
7. **`temperature` is removed on Claude 5** and returns 400. Every generation failed. Replaced with
   `effort` inside `output_config`.
8. **`max_tokens` did not allow for thinking.** Adaptive thinking is on by default and its tokens
   count against the ceiling, so the plan came back as JSON cut off mid-string.
9. **Three arrays require exactly four entries** and the prompt said so for one of them.
10. **A failed generation poisoned every retry.** `nextVersion` counts builds, so an orphaned plan
    row collided forever and the job could never build again. All plan writes are upserts now.

---

## Running it

```bash
npm run dev          # localhost:5173, demo mode, no accounts needed
npm run seed         # prints two signed-in links
npm test             # 368 tests
npm run sample       # rebuilds the committed sample, all 17 checks
npm run vercel:push  # push .env.local to Vercel (dry run; --apply to commit)
npm run vercel:env   # write a paste-ready env block
```

Stop the dev server with Ctrl-C, or `curl -X POST http://localhost:8787/api/dev/shutdown` if it is
detached. A hard kill has corrupted the embedded database before.

**Deploying:** `npx vercel deploy --prod`. Migrations run separately and afterwards:

```bash
curl -X POST https://go-polar-builder.vercel.app/api/admin/migrate -H "x-admin-token: $ADMIN_TOKEN"
```

---

## Operator endpoints

All behind `x-admin-token: $ADMIN_TOKEN` (the value is in `.env.local`).

| | |
| --- | --- |
| `GET /api/admin/queue` | Who is waiting and what is blocking them. Paid-but-blocked first |
| `GET /api/admin/jobs/:id/files` | Their finished website as a zip, ready for GitHub |
| `GET /api/admin/trace?email=` | Which of the four payment steps broke |
| `GET /api/admin/storage-check` | Round-trips a real file through Blob |
| `POST /api/admin/migrate` | Applies migrations, idempotent |
| `GET /api/health` | Config, store checks, Shopify auth mode |

---

## How a customer's website reaches them

You are **not** hosting their site from this app. The app builds it, you collect the files, you put
them live the way you already do for every other client site.

1. They finish building and pay for hosting
2. They verify their own Web3Forms key on the go-live screen — **this gates the download**, because
   a site put live carrying the Go Polar key sends their enquiries to us
3. They appear in `/api/admin/queue` with `readyForYou: true`
4. `GET /api/admin/jobs/:id/files` gives you the zip: every page, assets, favicon, a
   double-clickable `PREVIEW.html`, sitemap, robots, README
5. Unzip, `git init`, push, import to Vercel

Verified end to end: 22 files, 9.0MB, the Go Polar key appears nowhere in the archive.
