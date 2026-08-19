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

**And three Shopify products sitting in draft.** They exist and are priced correctly, but a draft
product cannot be bought by anybody, so publishing them is the last thing standing between the store
and a working checkout:

- **DIY Website Build**, SKU `build-token`, $220.00 — the front door of the entire product
- **Website Update**, SKU `post-live-edit`, $110.00
- **Website Discharge**, SKU `discharge`, $330.00

Read their descriptions before publishing. They were adapted from section 11 of the brief and have
not been signed off.

`extra-edits` still has no price and has not been created. That path degrades on purpose and blocks
nothing.

Full instructions are in **SHOPIFY-SETUP.md**. Do that document first.

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
Set them **after** the smoke test in section 9, not before.

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
| `SHOPIFY_WEBHOOK_SECRET` | Shown once when you create the webhook in section 7 |
| `SHOPIFY_ADMIN_API_TOKEN` | Section 6. Scopes `read_orders` and `read_products`, nothing else |
| `SHOPIFY_STOREFRONT_TOKEN` | Section 6. Scope `unauthenticated_write_checkouts` |
| `SHOPIFY_VARIANT_*` and `SHOPIFY_SELLING_PLAN_*` | One pair per subscription product. The three one-off products need neither: their ids are already recorded. Full list in SHOPIFY-SETUP.md |

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
| `ADMIN_TOKEN` | Another random string. Guards /api/admin/trace, which is how you diagnose a failed smoke test. Set this one before section 9 |

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

## 6. Create the Shopify custom app

This is where the two API tokens come from. You have not done this before, so here it is click by
click.

**Shopify admin → Settings → Apps and sales channels → Develop apps.**

If you see a button saying **Allow custom app development**, click it and confirm. It appears once,
the first time anyone in the store does this.

1. **Create an app**. Name it `Go Polar Website Builder`. App developer: you.
2. Open it and click **Configure Admin API scopes**.
3. Tick **exactly two**, and nothing else:

   | Scope | What the app does with it | What breaks without it |
   | --- | --- | --- |
   | `read_orders` | The hourly sweep lists recently paid orders and processes any whose webhook never arrived | A dropped webhook stays dropped forever. The customer paid, got no build link, and nothing ever notices |
   | `read_products` | Reads each product's status and its selling plan billing policy before building any checkout link | The store checks report "cannot verify" instead of passing. A product that has been unpublished, or a subscription silently billing yearly, is no longer caught |

   **No write scopes at all.** This app never creates, edits or deletes anything on the store, and
   it never touches customer records. If a scope is not one of those two, leave it unticked.

4. Click **Save**.
5. Click **Configure Storefront API scopes** and tick **`unauthenticated_write_checkouts`**.

   That one exists so the app can build a proper cart. A Shopify cart permalink carries only **one**
   selling plan, so a customer taking hosting **and** a custom email is two subscriptions and the
   permalink cannot express it. Rather than quietly dropping a line from their cart, the app refuses
   and says why. With this token it builds a real cart instead.

6. **Install app**, top right, and confirm.
7. Go to the **API credentials** tab. Two things to copy:

   - **Admin API access token**. Click **Reveal token once**. It starts `shpat_`. **You get one
     look at it**, so paste it straight into Vercel as `SHOPIFY_ADMIN_API_TOKEN`. If you lose it,
     uninstall the app and start again.
   - **Storefront API access token**, further down the same page. Paste into Vercel as
     `SHOPIFY_STOREFRONT_TOKEN`.

8. Redeploy so the functions pick up the new variables.

Check both landed:

```bash
curl -s https://build.itscold.com.au/api/health | grep -o '"storeChecks":[^]]*]'
```

Every product should report `ok: true`. "Cannot verify" means the admin token is missing or wrong.

---

## 7. Register the Shopify webhook

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

## 8. Point build.itscold.com.au at Vercel

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

## 9. Smoke test, with real money

Do it as a real purchase, so the whole path is exercised rather than a piece of it.

**Before you start, make sure `ADMIN_TOKEN` is set in Vercel.** Without it you cannot use the
diagnostic below, and the diagnostic is the difference between "it did not work" and "it broke at
step 2, here is why".

### First, check the wiring

```bash
curl -s https://build.itscold.com.au/api/health
```

The `products` block should list only `extra-edits`, and every entry in `storeChecks` should be
`ok: true`. "Cannot verify" means `SHOPIFY_ADMIN_API_TOKEN` is missing or wrong.

### Then buy a website

1. Set `ENABLE_LIVE_PAYMENTS=1` and `ENABLE_LIVE_EMAIL=1`, and redeploy.
2. Buy **DIY Website Build** on itscold.com.au with a real card, using an email you can read. $220,
   refundable afterwards.
3. **Within a minute or so a build link should arrive in that inbox.**
4. Click it. You should land in the intake wizard, signed in.
5. Fill it in and press **Build it**. Watch the HTML stream in, the checks run, the site appear.
   This is the part that costs Anthropic credit and takes a minute or two.
6. Ask for a change in the edit box. Confirm a new version appears and the counter drops by one.
7. Press go live. The first screen asks for a Web3Forms key. Create a free one at web3forms.com
   with an inbox you can read, paste it in, and confirm **a test enquiry actually arrives**. Then
   confirm the checkout link opens a real Shopify cart carrying the monthly subscription.
8. **Refund yourself** in Shopify. The job stays in the database, which is worth keeping.

### If the link does not arrive

Four separate things have to happen between the card being charged and an email landing, and "no
email" is the same symptom for all four failures. This tells you which one:

```bash
curl -s -H "x-admin-token: $ADMIN_TOKEN" \
  "https://build.itscold.com.au/api/admin/trace?email=you@example.com"
```

Use the email you paid with. It answers in four steps, each independently, with the fix:

```json
{
  "verdict": "Broke at step 2: Signature verified.",
  "jobId": null,
  "steps": [
    { "step": 1, "name": "Shopify sent the webhook", "status": "ok" },
    { "step": 2, "name": "Signature verified", "status": "failed",
      "detail": "A webhook arrived and its HMAC signature did not match, so it was refused.",
      "fix": "SHOPIFY_WEBHOOK_SECRET in Vercel does not match ..." },
    { "step": 3, "name": "Job created", "status": "waiting" },
    { "step": 4, "name": "Build link emailed", "status": "waiting" }
  ]
}
```

What each step separates out:

| Step | Answers | Typical cause when it fails |
| --- | --- | --- |
| 1. Shopify sent the webhook | Did anything at all reach the deployment? | Webhook not registered, wrong URL, or the deployment was down |
| 2. Signature verified | Did HMAC pass? | `SHOPIFY_WEBHOOK_SECRET` wrong or unset, or `DEMO_MODE` still 1 so webhooks are inert |
| 3. Job created | Did the order become a user and a job? | The line item matched no known product, usually a changed SKU. The trace prints what arrived |
| 4. Build link emailed | Did Resend accept it? | Sending domain not verified, `RESEND_API_KEY` unset, or `ENABLE_LIVE_EMAIL` still 0 |

A step reading `waiting` rather than `failed` means it never got that far, so fix the earliest
`failed` step and buy again. Steps 1 and 2 work without the `email` parameter, so you can check
whether webhooks are arriving at all before an order exists.

**Step 4 saying "ok" but no email in the inbox** means Resend accepted it and delivery is Resend's
problem: check spam, then Resend's own delivery log. The hourly sweep retries failed sends, so a
transient failure fixes itself.

### The raw event log

For anything the trace does not cover. Every stage of the app writes to it.

```bash
# Everything in the last hour
curl -s -H "x-admin-token: $ADMIN_TOKEN" \
  "https://build.itscold.com.au/api/admin/events?hours=1"

# Just the failed sends
curl -s -H "x-admin-token: $ADMIN_TOKEN" \
  "https://build.itscold.com.au/api/admin/events?type=email.failed"

# Everything that happened to one job
curl -s -H "x-admin-token: $ADMIN_TOKEN" \
  "https://build.itscold.com.au/api/admin/events?job=job_xxxxx"
```

Useful types: `webhook.received`, `webhook.rejected`, `webhook.refused`, `order.paid.build`,
`order.unmatched`, `email.sent`, `email.failed`, `error.unhandled`.

### The two places outside the app worth checking

- **Shopify admin → Settings → Notifications → Webhooks** lists recent delivery attempts and the
  response code each got. A 401 is a signature mismatch, a 404 is a wrong URL, a timeout means the
  function did not answer.
- **Vercel → your project → Logs**, filtered to `/api/webhooks/shopify`, shows what the function
  did with the request.

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
