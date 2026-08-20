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

**Done.** The repo is https://github.com/GoPolarCreative/go-polar-builder and `main` is pushed.

For reference, or to redo it elsewhere: create the repo empty, with no README, no .gitignore and no
licence, then

```bash
git remote add origin https://github.com/GoPolarCreative/go-polar-builder.git
git push -u origin main
```

`.env` and `.env.local` are gitignored and always have been. Check nothing secret went up:

```bash
git log --all --oneline -- .env .env.local
```

That must print nothing.

---

## 2. Import to Vercel

1. vercel.com → **Add New** → **Project** → **Import Git Repository** → `go-polar-builder`.
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

**Do not type these one at a time.** On Chris's machine:

```bash
npm run vercel:env
```

That writes `vercel-env.txt`: every value already settled carried across from `.env.local`, every
value that must differ in production already set to the production value, and every secret that is
not on this machine left blank with a note saying where it comes from. The gaps are listed again at
the bottom of the file so none is missed by scrolling past it.

Paste the whole thing into **Project -> Settings -> Environment Variables -> import .env**, fill the
blanks as you work through the sections below, then delete the file. It is gitignored and it holds
real credentials.

The reference list follows.

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
| `SHOPIFY_STORE_DOMAIN` | Settings → Domains. The **myshopify.com** one, which may be numeric like `473724-9e.myshopify.com` rather than anything resembling the brand |
| `SHOPIFY_WEBHOOK_SECRET` | Shown once when you create the webhook in section 7 |
| `SHOPIFY_CLIENT_ID` | Section 6. Dev Dashboard app, Settings page |
| `SHOPIFY_CLIENT_SECRET` | Section 6. Same page. The app exchanges these two for a 24 hour token and refreshes it itself |
| `SHOPIFY_STOREFRONT_TOKEN` | Section 6. Minted through `/api/admin/storefront-token`, because the Dev Dashboard does not show one |
| `SHOPIFY_ADMIN_API_TOKEN` | **Only if you are carrying over a pre-existing app.** Shopify no longer issues these. Setting it takes precedence over the two above |
| `SHOPIFY_VARIANT_*` and `SHOPIFY_SELLING_PLAN_*` | Ten variables, listed in full below. **Numeric ids only, never the `gid://` string**, and the names are derived rather than free text |

All three subscription products have `requiresSellingPlan: true`, so a checkout without the selling
plan id is rejected by Shopify. The app treats a missing plan id as fatal for exactly that reason.

The full set, with the values verified on the live store on 2026-08-19:

```
SHOPIFY_VARIANT_BUILD_TOKEN=62852208328863
SHOPIFY_VARIANT_ADDITIONAL_PAGE=62852241948831
SHOPIFY_VARIANT_WEBSITE_HOSTING_AUSTRALIA=62848019595423
SHOPIFY_VARIANT_DOMAIN_1_YEAR=62844878717087
SHOPIFY_VARIANT_EMAIL_HOSTING=62844876193951
SHOPIFY_VARIANT_POST_LIVE_EDIT=62852208361631
SHOPIFY_VARIANT_DISCHARGE=62852208394399
# Still unpriced and not created. Leave empty.
SHOPIFY_VARIANT_EXTRA_EDITS=

SHOPIFY_SELLING_PLAN_WEBSITE_HOSTING_AUSTRALIA=3911188639
SHOPIFY_SELLING_PLAN_DOMAIN_1_YEAR=3936321695
SHOPIFY_SELLING_PLAN_EMAIL_HOSTING=3936256159
```

**The names cannot be shortened or tidied.** Each is `SHOPIFY_VARIANT_<REF>`, derived from the
product's identifier in `shared/pricing.ts`. A variable named anything else is read as nothing at
all, silently, and the first symptom is a checkout that will not build. See DECISIONS.md D39.

Hosting has two variants and `62848019595423` is **Hosting Only** at $33.00. The other,
`62848019628191` at $100.00, is "Hosting + 2 Monthly Website Edits", a different offer this flow
does not sell. See DECISIONS.md D38.

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

## 6. Create the Shopify app

This is where the API credentials come from.

**The flow you may have read about is gone.** Settings → Apps and sales channels → Develop apps used
to hand you a permanent `shpat_` token. Shopify has removed admin-created custom apps: the page now
just points at the Dev Dashboard. Existing apps keep working, but you cannot make a new one that
way, which is why this section changed and why the app has two ways of authenticating.

The replacement is a **Dev Dashboard app using the client credentials grant**. Instead of a token
you paste once, you get a **client id and a client secret**, and the app exchanges them for a token
that **expires every 24 hours** and refreshes itself. That is handled in
`server/lib/shopifyAuth.ts` and there is nothing to maintain.

### Create it

1. From **Settings → Apps and sales channels → App development**, click **Build apps in Dev
   Dashboard**. Or go to the Dev Dashboard directly.
2. **Apps** in the left panel → **Create app** (top right) → **Start from Dev Dashboard**.
3. Name it `Go Polar Website Builder`. Create.

### Release a version with the scopes

An app has no permissions until a version is released. This trips people up: you can create the app,
install it, and get a 403 on everything, because there is no released version.

1. Open the app → **Versions** → fill in the fields.
2. **App URL**: `https://build.itscold.com.au`. The app is not embedded in the Shopify admin, so
   this is only ever a link back to it.
3. **Webhooks API version**: the newest offered.
4. **Scopes.** Tick **exactly these three**, and nothing else:

   | Scope | What the app does with it | What breaks without it |
   | --- | --- | --- |
   | `read_orders` | The hourly sweep lists recently paid orders and processes any whose webhook never arrived | A dropped webhook stays dropped forever. The customer paid, got no build link, and nothing ever notices |
   | `read_products` | Reads each product's status and its selling plan billing policy before building any checkout link | The store checks report "cannot verify" instead of passing. A product that has been unpublished, or a subscription silently billing yearly, is no longer caught |
   | `unauthenticated_write_checkouts` | Builds a real cart through the Storefront API | A cart permalink carries only **one** selling plan, so a customer taking hosting **and** email cannot be expressed as a link. The app refuses that checkout and says why rather than dropping a line from their order |

   **No write scopes on the Admin API.** This app never creates, edits or deletes anything on the
   store and never reads a customer record. Anything not in that table stays unticked.

   Those three are what the code actually calls: `orders`, `productByHandle` / `productById` /
   `sellingPlanGroups`, and `cartCreate`. Not a generous guess.

5. **Release.**

### Install it on the store

1. **Home** in the left panel → scroll down → **Install app**.
2. Select **Go Polar Creative** and install.

### Copy the credentials

**Settings** page of the app. Two values:

- **Client ID** → Vercel as `SHOPIFY_CLIENT_ID`
- **Client secret** → Vercel as `SHOPIFY_CLIENT_SECRET`

Unlike the old token, you can come back and read these again. Rotating the secret invalidates every
token already issued from it, immediately.

### The Storefront token

The Storefront API needs its own token, and it is not shown on the Settings page. It is created
through the Admin API and inherits the unauthenticated scopes of the app that creates it, which is
why `unauthenticated_write_checkouts` had to be on the version you just released.

Once `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` are set in Vercel and deployed:

```bash
curl -s -X POST https://build.itscold.com.au/api/admin/storefront-token \
  -H "x-admin-token: $ADMIN_TOKEN"
```

It reuses an existing token if this app already made one, creates one if not, and prints it. Put it
in Vercel as `SHOPIFY_STOREFRONT_TOKEN` and redeploy.

If it reports that the app has no unauthenticated scopes, the version was released without
`unauthenticated_write_checkouts`. Release a new version with it, approve the change on the store,
and run it again.

### Check it worked

```bash
curl -s https://build.itscold.com.au/api/health
```

Look at `shopify.auth`. It should say `client-credentials` with `scopes ok`. Then every product in
`storeChecks` should report `ok: true`. "Cannot verify" means the credentials are missing or wrong,
and the message says which.

If you see **`shop_not_permitted`**, the app and the store are not in the same Shopify organisation.
Owning a store does not put it in one. Open the Dev Dashboard, confirm the app is under **Apps** and
that Go Polar Creative is listed under **Stores** in the same organisation.

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

### The builder host is named in vercel.json

```json
{ "type": "host", "value": "(build\.itscold\.com\.au|.*\.vercel\.app|localhost(:\d+)?)" }
```

That rule is what decides whether a request gets the builder app or a customer's published website.
A host that matches gets the builder; every other host is treated as a customer domain and answered
from that site's published files.

**If you ever move the builder to a different hostname, change that value in `vercel.json` in the
same deploy.** Miss it and the builder host starts being treated as a customer site, which means
every page of the app 404s. It is one line and it is the only place the builder's own hostname is
hardcoded.

---

## 8b. Customer domains

A customer's own domain is added the same way as the builder's, once, per customer:

1. Vercel project → **Settings** → **Domains** → **Add** → their domain.
2. Give them the record Vercel shows. For a bare domain that is usually an A record to
   `76.76.21.21`; for `www` it is a CNAME to `cname.vercel-dns.com`.
3. Once it resolves, publish their site (below). Order does not matter: publishing first is fine,
   the site simply is not reachable until DNS points here.

Then put their site live:

```bash
curl -X POST https://build.itscold.com.au/api/admin/publish   -H "authorization: Bearer $ADMIN_TOKEN"   -H "content-type: application/json"   -d '{"jobId":"job_...","hostname":"theirbusiness.com.au"}'
```

It publishes **every page of their build** together, with the sitemap and robots file, and returns
the URLs it wrote. It refuses, with the reason, when:

- hosting has not been paid for on that job
- the customer has not verified their own Web3Forms key, because a live site posting to the Go Polar
  account sends their enquiries to us
- the current version did not pass its checks

`force: true` overrides the first and the third. Nothing overrides the second.

To move them to a newer version later, run the same call again. To take a site down, set `live` to
false on its row in the `sites` table.

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

## If the first deploy fails on function size

The error reads something like *"A Serverless Function has exceeded the unzipped maximum size of
250 MB"*. It is not a code problem and nothing is broken.

The API function carries some genuinely large things, all of them on purpose:

| Package | Roughly | Why it is there |
| --- | --- | --- |
| `@sparticuz/chromium` | 67 MB | The four render checks open the page in a real browser |
| `@electric-sql/pglite` | 25 MB | The local embedded database. **Never used in production** |
| `playwright-core` | 14 MB | Drives the above. `-core`, so it ships no browsers of its own |
| `sharp` | ~30 MB on Linux | Resizes and compresses every uploaded photo |

Two fixes, cheapest first.

**1. Drop PGlite from the bundle.** It is only imported when `DATABASE_DRIVER=pglite`, which is a
local-development setting, so in production it is 25 MB of nothing. In `vercel.json`:

```json
"functions": {
  "api/index.ts": {
    "runtime": "nodejs22.x",
    "memory": 2048,
    "maxDuration": 300,
    "excludeFiles": "node_modules/@electric-sql/pglite/**"
  }
}
```

If you do this, **`DATABASE_URL` must be set in production**, because the fallback is now gone. It
already must be, so this is safe, but it is the thing that would break.

**2. Turn the render checks off.** Set `RENDER_DRIVER=none`. That removes the need for Chromium
entirely, and the 13 static checks keep running on every page. You lose the four checks that need a
real browser: layout overflow, tap target size, contrast and the mobile viewport. The build still
reports honestly, saying those four were skipped rather than passed.

Do the first one before the second. Losing four verification checks to save disk is a bad trade if
there is another way, and there is.

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
- **The builder hostname in `vercel.json`.** See section 8. It is the one place the builder's own
  host is hardcoded, and getting it wrong 404s the whole app.
- **Publishing before the customer has verified their Web3Forms key.** The publish endpoint refuses,
  and that refusal is deliberate: it is the difference between their leads reaching them and their
  leads reaching us.

---

## Stopping the local server

On Windows there is no clean way to interrupt a detached console process, and a forced kill of the
embedded Postgres has already corrupted the local database once.

Ctrl+C in the terminal running `npm run dev` is the normal way. If it is running detached:

```bash
curl -X POST http://localhost:8787/api/dev/shutdown
```

It closes the database and exits. Development installs only: it refuses once a Shopify webhook
secret is configured.

---

## Checking a page set end to end

```bash
npm run dev:api
npm run e2e:pageset
```

Buys two additional pages on a throwaway job, builds, checks that every page was verified rather
than only the home page, swaps the forms key across the set, publishes it and asks the live site for
each path. Twenty-odd assertions, each printed separately, so a failure names itself.

`npm run e2e` does the same for the single-page path and the discharge package.
