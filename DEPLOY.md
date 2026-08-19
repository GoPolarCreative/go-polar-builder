# Deploying the Go Polar Website Builder

A runbook. Follow it top to bottom the first time. Assumes no prior context beyond having the repo
on your machine.

Nothing in here has been done for you. Nothing has been deployed and nothing was created on the
Shopify store.

**Roughly an hour**, most of it waiting for DNS.

---

## Before you start

You need all of this. Getting halfway and stopping leaves customers able to pay for something that
does not work, so gather it first.

| Thing | Where | Notes |
| --- | --- | --- |
| GitHub account with access to **GoPolarCreative** | github.com | The repo goes here |
| Vercel account, **Pro plan** | vercel.com | Hobby will not do: no cron, 10s function limit |
| Anthropic API key | console.anthropic.com | Billing enabled. This is what writes the sites |
| Shopify admin on itscold.com.au | admin.shopify.com | For the webhook and the product ids |
| Resend account | resend.com | Sending domain verified for itscold.com.au |
| GoHighLevel inbound webhook URL | GHL → Automation | Optional. Notifications only |
| DNS access for **itscold.com.au** | wherever the domain lives | To add one CNAME |

**And four Shopify products that do not exist yet.** Create them before you deploy, or customers
cannot buy anything:

- `build-token` — Website build, **$220.00** ($200 + GST, the store is GST-inclusive)
- `post-live-edit` — Website update after launch, **$110.00**
- `discharge` — Discharge and file handover, **$330.00**
- `extra-edits` — **do not create yet**, the price has never been decided

Full instructions, including the one outstanding price question on the email product, are in
**SHOPIFY-SETUP.md**. Do that document first.

---

## 1. Put the repo on GitHub

From the project folder:

```bash
git remote add origin https://github.com/GoPolarCreative/website-builder.git
git push -u origin main
```

Create the repo as **private** at github.com/organizations/GoPolarCreative/repositories/new first,
named `website-builder`, with no README, no .gitignore and no licence, so it is empty and the push
is clean.

`.env` and `.env.local` are gitignored and always have been. Check nothing secret went up:

```bash
git log --all --oneline -- .env .env.local
```

That must print nothing.

---

## 2. Import to Vercel

1. vercel.com → **Add New** → **Project** → **Import Git Repository** → `website-builder`.
2. Framework preset: **Other**. Do not let it guess Vite: `vercel.json` already sets the build.
3. Leave the build and output settings alone. `vercel.json` sets `npm run vercel:build` and `dist`.
4. **Do not deploy yet.** Click **Environment Variables** first and work through section 4 below.
   Deploying without them produces a broken first deployment and a confusing error.

The API runs as a single Node function, `api/index.ts`, at 2GB with a 300 second limit. Generation is
long-running and streamed, which is why it is Node and not Edge, and why Pro is required.

---

## 3. Provision the database and file storage

### Neon Postgres

Vercel project → **Storage** → **Create Database** → **Neon** → region **Sydney (syd1)** if offered,
otherwise the closest to Australia. Vercel injects `DATABASE_URL` automatically once it is attached.

Latency matters here: every page of the intake wizard is a round trip, so a US database makes the
whole thing feel slow from Perth.

### Vercel Blob

Same Storage tab → **Create** → **Blob**. It injects `BLOB_READ_WRITE_TOKEN`.

This holds generated sites, uploaded originals and processed images. Around 15MB per client, so 50
clients is under a gigabyte.

---

## 4. Environment variables

Vercel project → **Settings** → **Environment Variables**. Set every one of these for **Production**.
`.env.example` is the same list with comments.

### Required. Nothing works without these.

| Variable | Where to get it |
| --- | --- |
| `PUBLIC_APP_URL` | `https://build.itscold.com.au`. Emailed links and the webhook URL are built from it |
| `APP_SECRET` | Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Signs session cookies and download links |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys. **Server-side only. If this ever appears in a client bundle the build fails** |
| `DATABASE_URL` | Injected by Neon in step 3 |
| `BLOB_READ_WRITE_TOKEN` | Injected by Blob in step 3 |
| `DATABASE_DRIVER` | `postgres` |
| `STORAGE_DRIVER` | `vercel-blob` |
| `DEMO_MODE` | `0`. Anything else and every integration stays a local fake |
| `WEB3FORMS_ACCESS_KEY` | web3forms.com, Go Polar's own account. Used for previews only, and a site cannot go live carrying it |

### The live-action flags

Everything that spends money, emails a person or touches DNS is off unless deliberately switched on.
Set them **after** the smoke test in section 8, not before.

```
ENABLE_LIVE_PAYMENTS=1
ENABLE_LIVE_EMAIL=1
ENABLE_LIVE_CRM=1
ENABLE_LIVE_DOMAINS=1
```

With `ENABLE_LIVE_PAYMENTS=1` the API **refuses to start** if any Shopify product is unconfigured,
and the startup error names each one. That is intentional. If the deployment will not boot, read the
error and finish SHOPIFY-SETUP.md.

### Shopify

| Variable | Where |
| --- | --- |
| `SHOPIFY_STORE_DOMAIN` | `itscold.myshopify.com` |
| `SHOPIFY_WEBHOOK_SECRET` | Shown once when you create the webhook in section 6 |
| `SHOPIFY_ADMIN_API_TOKEN` | Settings → Apps → Develop apps → your app → Admin API. Scopes `read_orders`, `read_products` |
| `SHOPIFY_STOREFRONT_TOKEN` | Same app → Storefront API, scope `unauthenticated_write_checkouts` |
| `SHOPIFY_VARIANT_*` and `SHOPIFY_SELLING_PLAN_*` | One pair per product. The full list is in SHOPIFY-SETUP.md step 5 |

All three subscription products have `requiresSellingPlan: true`, so a checkout without the selling
plan id is rejected by Shopify. The app treats a missing plan id as fatal for exactly that reason.

### Email, CRM and domains

| Variable | Where |
| --- | --- |
| `RESEND_API_KEY` | resend.com → API Keys |
| `RESEND_FROM` | `Go Polar Creative <build@itscold.com.au>`. The domain must be verified in Resend or every send bounces |
| `GHL_INBOUND_WEBHOOK_URL` | GoHighLevel → Automation → inbound webhook trigger |
| `VERCEL_API_TOKEN` | vercel.com/account/tokens. Attaches customer domains to the project |
| `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID` | Project → Settings → General |
| `CRON_SECRET` | Generate another random hex string. Bearer secret on the cron endpoint |
| `ADMIN_TOKEN` | Another random string. Guards the admin routes |

---

## 5. Run the migrations

Migrations are a deliberate step, not part of the build, so a bad deploy cannot half-migrate the
database. Run them from your machine against the Neon database:

```bash
npx vercel env pull .env.production.local
DATABASE_URL="<the value from that file>" DATABASE_DRIVER=postgres npm run db:migrate
```

It prints `Migrations applied (postgres).` Two migrations exist: the initial schema and the
Web3Forms columns.

Then delete `.env.production.local`. It is gitignored, but it holds every secret you just set.

---

## 6. Register the Shopify webhook

**Shopify admin → Settings → Notifications → Webhooks → Create webhook.**

- Event: **Order payment** (`orders/paid`)
- Format: **JSON**
- URL: `https://build.itscold.com.au/api/webhooks/shopify`
- API version: **2025-01** or later

Copy the **signing secret** it shows you into `SHOPIFY_WEBHOOK_SECRET` in Vercel, then redeploy so
the function picks it up.

Every request is HMAC-verified against the raw body. Without the secret the endpoint refuses
everything rather than trusting it.

---

## 7. Point build.itscold.com.au at Vercel

1. Vercel project → **Settings** → **Domains** → **Add** → `build.itscold.com.au`.
2. Vercel shows the record to create. Add it wherever itscold.com.au's DNS lives:

   | Type | Name | Value | TTL |
   | --- | --- | --- | --- |
   | CNAME | `build` | `cname.vercel-dns.com` | Auto, or 300 |

3. Wait. Usually minutes, up to an hour. Vercel issues the certificate itself once it resolves.

Check it:

```bash
nslookup build.itscold.com.au
curl -I https://build.itscold.com.au/api/health
```

**Your storefront is untouched.** `itscold.com.au` and `www` keep pointing at Shopify. `build` is a
separate host on separate infrastructure, which is the whole reason it is a subdomain.

---

## 8. Smoke test, with real money

Do this before switching the live flags on for real customers, and do it as a real purchase so the
whole path is exercised rather than a piece of it.

**First, check the wiring:**

```bash
curl https://build.itscold.com.au/api/health
```

Read the `products` block. Every problem listed there is a real gap. It should be empty apart from
`extra-edits`, and the billing policy check should report all three subscriptions billing every 1
MONTH. If it says "cannot verify", `SHOPIFY_ADMIN_API_TOKEN` is missing.

**Then buy a website.**

1. Set `ENABLE_LIVE_PAYMENTS=1`, `ENABLE_LIVE_EMAIL=1` and redeploy.
2. Go to the `build-token` product page on itscold.com.au and buy it with a real card. Use an email
   you can read. It costs $220 and you can refund yourself afterwards.
3. **Within a minute or so, a build link should arrive in that inbox.** That single email proves the
   whole chain: Shopify took the payment, fired `orders/paid`, the HMAC verified, the user and job
   were created, the token was minted and Resend delivered it.
4. Click it. You should land in the intake wizard, signed in.
5. Fill it in with a real-ish business and press **Build it**. Watch the HTML stream in, the checks
   run and the site appear. This is the part that costs Anthropic credit and takes a minute or two.
6. Ask for a change in the edit box. Confirm a new version appears and the counter drops by one.
7. Press go live. The first screen asks for a Web3Forms key. Create a free one at web3forms.com with
   an inbox you can read, paste it in, and confirm **a test enquiry actually arrives**. Then confirm
   the checkout link opens a real Shopify cart carrying the monthly subscription.

**If step 3 fails**, in order: Shopify admin → Notifications → Webhooks shows recent deliveries and
their response codes. A 401 means the signing secret is wrong. A 404 means the URL is wrong. No
delivery at all means the webhook was never registered. Vercel → your project → Logs shows what the
function did with it.

**If the email never arrives but the webhook returned 200**, the job exists and the email failed.
Resend → Logs will say why, usually an unverified sending domain. The hourly sweep retries.

**Then refund yourself** in Shopify. The job stays in the database, which is fine and worth keeping
as a reference.

---

## What runs on a schedule

One cron, registered in `vercel.json`, hourly on the hour:

`GET /api/cron/sweep` — finds paid Shopify orders whose webhook never arrived and processes them,
retries failed emails, and expires stale download links. It needs `SHOPIFY_ADMIN_API_TOKEN` and
`CRON_SECRET`. Vercel supplies the bearer token automatically for its own cron requests.

A paying customer who never receives a link is the worst failure this system has, so this is the
backstop for it.

---

## Rolling back

Vercel → Deployments → the previous one → **Promote to Production**. Instant.

Database migrations are forward-only. Nothing in the two existing migrations drops a column, so an
older deployment runs fine against a newer database.

---

## Things that will bite you

- **Hobby plan.** No cron, and a 10 second function limit that generation blows through immediately.
- **`DEMO_MODE` left at `1`.** Everything appears to work and nothing is real: fake checkouts, fake
  emails, fake CRM. The front page says `Demo mode: on`.
- **Resend domain not verified.** Sends are accepted and then bounce. Verify itscold.com.au in Resend
  before the smoke test.
- **Neon in a US region.** Every wizard step is a round trip. It will feel slow and you will blame
  the app.
- **`ANTHROPIC_API_KEY` set as a Vite variable.** It must be a plain environment variable. Anything
  prefixed `VITE_` is compiled into the browser bundle. `npm run vercel:build` scans the built bundle
  for secrets and fails the deploy if it finds one.
