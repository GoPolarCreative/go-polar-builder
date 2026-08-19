# Shopify setup

What is left to do on the Go Polar Creative store before the builder can take money. In order.
Nothing here has been done for you: the store was read, never written to.

**Store as verified on 2026-08-19:** Go Polar Creative, itscold.com.au, Basic plan, AUD, AWST,
**prices entered GST-inclusive**, **Appstle installed and running**.

Most of it is already right. Three of the seven products exist, all three have a working monthly
selling plan, and two of the three are priced correctly. What is left is one price question and four
products that do not exist yet.

| # | Step | Skipping it costs |
| --- | --- | --- |
| 1 | Settle the email price | The email add-on shows no price and cannot be bought |
| 2 | Create `build-token` | **Nobody can buy a website at all** |
| 3 | Create `post-live-edit` and `discharge` | Post-launch changes and file handover cannot be paid for |
| 4 | Register the `orders/paid` webhook | Customers pay and nothing happens |
| 5 | Put the ids into Vercel | Every checkout link fails |

There is no tax setting to change and no subscription app to install. Both were on an earlier version
of this list and both were wrong.

---

## What is already correct

Do not touch these. Listed so it is clear what is being relied on.

| Product | Handle | Price on the store | Billing | Verdict |
| --- | --- | --- | --- | --- |
| Website Hosting | `website-hosting-australia` | $33.00 | Appstle "Monthly Subscription", every 1 MONTH | $33.00 inc GST is $30.00 + GST. Correct. |
| Domain Hosting | `domain-1-year` | $5.50 | Appstle "Monthly Subscription", every 1 MONTH | $5.50 inc GST is $5.00 + GST. Correct. |
| Email Hosting | `email-hosting` | $14.95 | Appstle "Monthly Subscription", every 1 MONTH | Product and plan correct. **Price in question, see step 1.** |

All three have `requiresSellingPlan: true`, which means Shopify **rejects any checkout line for them
that does not carry a selling plan id**. Not a downgrade to a one-off charge, a refusal. That is why
step 5 lists a selling plan id for each of them and why the app treats a missing one as fatal.

The hosting product also has a second variant, **"Hosting + 2 Monthly Website Edits" at $100.00**.
The app does not offer it anywhere and there is no decision on file about it. Leave it, remove it or
price it however you like; nothing in the app reads it. If you want it sold through the builder, that
needs a decision first and then a small change to the go-live screen.

---

## 1. Settle the email price

**This is the only open price question, and it is yours to answer.**

The store charges **$14.95 including GST**, which works out to **$13.59 + GST**.

You stated the price as **$14.95 + GST**, which on a GST-inclusive store would be **$16.45**.

Hosting and the domain were both grossed up correctly ($30 + GST entered as $33.00, $5 + GST entered
as $5.50). This one looks like it was missed, but it is equally possible you meant $14.95 as the
number the customer sees. Two ways to resolve it:

- **Leave the store at $14.95** and accept that the real price is $13.59 + GST.
- **Change the store to $16.45**, which makes it $14.95 + GST as you stated.

Until you say which, the app **shows no price for the email add-on and will not sell it**. It tells
the customer we do them and to ask, rather than quoting a number that might be wrong. Once you
decide, set `incGstCents` for `email` in `shared/pricing.ts` and the add-on turns back on.

**If you skip it:** custom email is offered but cannot be bought. Nothing is mispriced, which is the
point.

---

## 2. Create `build-token` — the front door

**Website build, $220.00.** That is $200 + GST on a GST-inclusive store.

One-off. No selling plan. Set the **SKU to `build-token`**.

This is how every customer enters the product: they buy this, the `orders/paid` webhook creates their
job, and they are emailed a build link. There is no other way in.

**If you skip it:** nobody can buy a website. Nothing else on this list matters.

---

## 3. Create the other two

### `post-live-edit` — Website update after launch, **$110.00**

$100 + GST. One-off, no selling plan, SKU `post-live-edit`.

Changes for a customer who is already live, done by your team.

**If you skip it:** the go-live confirmation screen quotes the price and the customer has no way to
pay it.

### `discharge` — Discharge and file handover, **$330.00**

$300 + GST. One-off, no selling plan, SKU `discharge`.

They take their files and go. Section 9 requires this to be offered visibly rather than buried.

**If you skip it:** the offer appears, they accept, and the checkout fails. Worse than not offering.

### `extra-edits` — do not create it yet

Another 5 edits before launch. **The price has never been decided.** The app shows no price and no
buy button while that is true: a customer who runs out of edits is offered a conversation or going
live, never a number. Decide the price, set `incGstCents` for `extraEdits` in `shared/pricing.ts`,
create the product, and the path turns on.

**If you skip it:** nothing breaks. This gap is already handled honestly.

### Why the SKU matters

The `orders/paid` webhook does not receive product handles. It matches on variant id first, then
SKU, then the product title. Setting the SKU to the handle makes the match exact.

---

## 4. Register the webhook

**Settings → Notifications → Webhooks → Create webhook.**

- **Event:** `Order payment` (`orders/paid`)
- **Format:** JSON
- **URL:** `https://build.itscold.com.au/api/webhooks/shopify`
- **API version:** 2025-01 or later

Shopify shows a **signing secret** once created. Copy it into Vercel as `SHOPIFY_WEBHOOK_SECRET`.

Every request is HMAC-verified against the raw body. Without the secret the endpoint **refuses every
webhook** rather than trusting it: accepting unverified payment webhooks would let anyone create paid
jobs by posting JSON at it.

**If you skip it:** customers pay and nothing happens. No job, no build link, no email. They have
been charged $220 and have no website and no way in. The nightly reconciliation sweep catches dropped
webhooks, but it needs `SHOPIFY_ADMIN_API_TOKEN` and it is a safety net, not a substitute.

---

## 5. Put the ids into Vercel

Variant id: Products → the product → Variants → the number at the end of the URL.
Selling plan id: Appstle → the plan → the numeric id.

```
SHOPIFY_STORE_DOMAIN=itscold.myshopify.com
SHOPIFY_WEBHOOK_SECRET=

# Already on the store. All three REQUIRE their selling plan id: without it Shopify rejects the
# checkout outright.
SHOPIFY_VARIANT_WEBSITE_HOSTING_AUSTRALIA=
SHOPIFY_SELLING_PLAN_WEBSITE_HOSTING_AUSTRALIA=
SHOPIFY_VARIANT_DOMAIN_1_YEAR=
SHOPIFY_SELLING_PLAN_DOMAIN_1_YEAR=
SHOPIFY_VARIANT_EMAIL_HOSTING=
SHOPIFY_SELLING_PLAN_EMAIL_HOSTING=

# Once created in steps 2 and 3. One-off products, so no selling plan.
SHOPIFY_VARIANT_BUILD_TOKEN=
SHOPIFY_VARIANT_POST_LIVE_EDIT=
SHOPIFY_VARIANT_DISCHARGE=
# Only once its price is decided.
SHOPIFY_VARIANT_EXTRA_EDITS=
```

**Also set these two.**

```
SHOPIFY_ADMIN_API_TOKEN=
```

Custom app token with `read_orders` and `read_products`. Two jobs: the nightly sweep that finds paid
orders whose webhook never arrived, and the billing policy check described below. Without it the app
cannot verify what the store will actually charge.

```
SHOPIFY_STOREFRONT_TOKEN=
```

Scope `unauthenticated_write_checkouts`. A cart permalink can only carry **one** selling plan, and a
customer taking hosting **and** email is two subscriptions. Rather than quietly dropping one from
their cart, the app refuses and says why. With a Storefront token it builds a proper cart instead.
Given all three recurring products need selling plans, treat this as required rather than optional.

---

## The billing policy guard

The domain product spent a period configured with a selling plan **named** "Monthly Subscription"
whose billing policy was **interval YEAR, count 1**. Shopify does not object to that: the name is a
label, the policy is the behaviour. The app would have advertised $5.50 a month while the store
charged $5.50 a year, and nobody finds out for twelve months.

You have fixed it, and the app now guards against it happening again. Before building any checkout
link it reads each product's real billing policy from the Admin API and **refuses** if a product
advertised as monthly does not bill every 1 MONTH. The error names the product, the plan and the
actual interval. `GET /api/health` shows the same report.

This needs `SHOPIFY_ADMIN_API_TOKEN`. Without it the check reports "cannot verify" rather than
passing, because a check that quietly passes when it did not run is worse than no check.

---

## Checking your work

`GET https://build.itscold.com.au/api/health` returns a `products` block listing anything still
outstanding and what each gap breaks, plus the billing policy result for all three subscriptions.

With `ENABLE_LIVE_PAYMENTS=1` the API **refuses to boot** while anything is outstanding, and names
every missing item. An install that intends to take money should not run in a state where a customer
can reach a checkout that does not work.

---

## Product page copy

**DRAFT, needs your sign-off before it goes on the store.**

Prices here are the numbers the customer is actually charged, labelled inc GST, because that is how
the store bills. This is deliberate and it changed recently: the app used to say "$30 + GST" and the
checkout said $33.00, which reads as a bait and switch to a tradie. One number, the real one, in the
app and on the store. See DECISIONS.md D31.

### Website build — $220 inc GST

> A real website for your trade business, built while you watch.
>
> Answer the questions about your business, upload your logo and some photos of your work, and your
> website gets written and built in front of you. Ten rounds of changes to get it right, and you ask
> for them in plain English rather than filling in a form.
>
> **$220 inc GST**, once, to build it.
>
> To keep it online:
>
> - Hosting **$33/month inc GST**
> - Domain name **$5.50/month inc GST**, if you need us to get you one
> - Custom email address like enquiries@yourbusiness.com.au, optional, ask us
>
> No maintenance retainer. No lock-in contract. If you ever want to take your website and go
> elsewhere, you can, for $330 inc GST.

### Before you approve it

- "Ten rounds of changes" matches `EDITS_INCLUDED` in the app.
- The prices match the store exactly, because they are the store's numbers.
- The email line has no price on purpose. See step 1.
- Nothing promises a timeframe for anything. Keep it that way.
