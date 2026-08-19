# Shopify setup

Everything that has to be done on the Go Polar Creative store before the builder can take money.
In order. Nothing here has been done for you: the store was read, never written to.

**Store as read on 2026-08-18:** Go Polar Creative, itscold.com.au, **Basic** plan, currency AUD,
timezone AWST, **zero selling plan groups**.

The app knows all of this. `shared/pricing.ts` is the single place handles, prices and store status
live, and it contains no invented defaults: a product that does not exist there has `handle: null`,
and anything trying to sell it throws by name rather than building a broken cart link. With
`ENABLE_LIVE_PAYMENTS=1` the API **refuses to start** while any of this is outstanding, and prints
exactly which items are missing.

| # | Step | Skipping it costs |
| --- | --- | --- |
| 1 | Tax to prices-exclusive | Every price is 10% short |
| 2 | Fix hosting to $30.00 | Customers overcharged $3/month |
| 3 | Fix the domain product | Domain billed once, never renewed |
| 4 | Subscription app + selling plans | Nothing rebills. Ever. |
| 5 | Create the four missing products | No builds can be sold at all |
| 6 | Webhook + secret | Payments never reach the app |
| 7 | Variant ids into Vercel | Every checkout link fails |

---

## 1. Switch tax to prices-entered-exclusive-of-tax

**Settings → Taxes and duties → Australia.** Turn **off** "All prices include tax".

> **Warning, read this before you click it.** This changes the displayed price of **every product on
> the store**, not just the three below. Anything currently priced GST-inclusive will start showing
> its full price with GST added on top at checkout, so a $110 product becomes $110 + GST = $121.
> Go through your whole catalogue afterwards, not just the website products.

Why it has to be this way: every price in the app and every price in this document is ex GST, and
the app labels all of them "+ GST" because it must. If Shopify holds tax-inclusive prices, the store
and the app disagree in front of the customer.

**If you skip it:** every sale is 10% short. $30 hosting collects $27.27 plus $2.73 GST instead of
$30 plus $3.00.

---

## 2. Correct the three existing products

Do this **after** step 1, because step 1 changes what the numbers in these fields mean.

### Website Hosting — handle `website-hosting-australia`

| | Now | Should be |
| --- | --- | --- |
| Price | $33.00 | **$30.00** |
| Billing | one-off | monthly (step 4) |

$33.00 is $30 with GST already inside it. Once tax is exclusive, leaving it at $33.00 charges
$33 + GST = $36.30.

There is also a second variant, **"Hosting + 2 Monthly Website Edits" at $100.00**. The app does not
offer it anywhere, and there is no decision on file about it. Leave it, remove it or price it as you
like: nothing in the app reads it. If you want it sold through the builder, that needs a decision
first and then a small change to the go-live screen.

**If you skip it:** every hosting customer is overcharged by $3 a month, or $6.30 after tax changes.

### Email Hosting — handle `email-hosting`

Price is already right at **$14.95**. It only needs the monthly selling plan from step 4.

**If you skip that:** custom email is charged once and never again.

### Domain (1 Year) — handle `domain-1-year`

| | Now | Should be |
| --- | --- | --- |
| Title | Domain (1 Year) | **Domain name** |
| Price | $5.00 one-off, for a year | **$5.00 per month** |
| Billing | one-off | monthly (step 4) |

This is the one that needs the most thought, because it is a repositioning and not just a number.
The decision is $5 + GST **per month**, which is $60 a year for something that costs you roughly a
year's registration. Retitle it so the product page does not say "1 Year" while the checkout bills
monthly, and reword the description to match.

Keep the handle `domain-1-year` as it is. Handles are awkward to change safely, the app already
points at it, and no customer sees it.

**If you skip it:** a customer pays $5 once and the renewal never bills again, while the app tells
them it is $5/month. The two disagree, and you carry the renewal cost.

---

## 3. Install a subscription app

**There are zero selling plan groups on the store**, so nothing is set up to bill again, ever. Every
"monthly" price above is currently a one-off.

Install **Shopify Subscriptions** from the Shopify App Store. It is free, made by Shopify, and works
on your Basic plan. Any subscription app that creates real selling plans will do, but this one costs
nothing and needs no extra account.

**If you skip it:** hosting, domain and email are all charged once. Recurring revenue does not exist,
and every live site is being hosted for a single $30 payment.

---

## 4. Create the monthly selling plans

One monthly plan, attached to all three recurring products:

- **Website Hosting** — every 1 month, $30.00
- **Domain name** — every 1 month, $5.00
- **Email Hosting** — every 1 month, $14.95

No discount, no minimum term, no lock-in. The app tells customers there is no lock-in contract, so
do not add one.

Then copy each **selling plan id** out (the numeric id, not the name) for step 7.

**If you skip it:** same as step 3. The products exist and are priced correctly but only ever bill
once.

---

## 5. Create the four products that do not exist

None of these are on the store. The app knows they are missing and refuses to sell them.

### `build-token` — Website build, **$200.00 + GST**, one-off

**The front door of the entire product.** A customer buys this, the `orders/paid` webhook creates
their job, and they are emailed a build link. There is no other way into the app.

**If you skip it:** nobody can buy a website. Nothing else in this document matters.

### `post-live-edit` — Website update after launch, **$100.00 + GST**, one-off

Changes for a customer who is already live, handled by your team.

**If you skip it:** the go-live confirmation screen still quotes $100 + GST, and a customer who wants
a change has no way to pay for one.

### `discharge` — Discharge and file handover, **$300.00 + GST**, one-off

They take their files and go. Section 9 requires this to be offered visibly rather than buried.

**If you skip it:** the offer appears, the customer accepts it, and the checkout fails. Worse than
not offering it.

### `extra-edits` — Another 5 edits before launch, **price not decided**

**Do not create this one yet.** It has never been priced, and the app deliberately shows no price and
no buy button while that is true: a customer who runs out of edits is offered a conversation or going
live, never a number. Decide the price, put it in `PRICING.extraEdits.exGstCents` as cents ex GST,
create the product, and the whole path turns on with no other change.

**If you skip it:** nothing breaks. This is the one gap that is already handled honestly.

### For all four

Set the **SKU to the handle** (`build-token`, `post-live-edit`, `discharge`). The `orders/paid`
webhook does not receive product handles, so it matches on variant id first, then SKU, then the
product title. Setting the SKU makes the match exact instead of relying on the title.

---

## 6. Register the webhook

**Settings → Notifications → Webhooks → Create webhook.**

- **Event:** `Order payment` (`orders/paid`)
- **Format:** JSON
- **URL:** `https://build.itscold.com.au/api/webhooks/shopify`
- **API version:** 2025-01 or later

Shopify shows a **signing secret** once the webhook is created. Copy it into the Vercel project as:

```
SHOPIFY_WEBHOOK_SECRET=<the signing secret>
```

Every request is HMAC-verified against the raw body. Without the secret the endpoint **refuses every
webhook** rather than trusting it, which is deliberate: accepting unverified payment webhooks would
let anyone create paid jobs by posting JSON at it.

**If you skip it:** customers pay and nothing happens. No job, no build link, no email. They have
been charged $200 and have no website and no way in. There is a nightly reconciliation sweep that
catches dropped webhooks, but it needs `SHOPIFY_ADMIN_API_TOKEN` and it is a safety net, not a
substitute.

---

## 7. Put the ids into Vercel

For every product, copy the **variant id** (Products → the product → Variants → the id at the end of
the URL) and the **selling plan id** where it has one.

```
SHOPIFY_STORE_DOMAIN=itscold.myshopify.com
SHOPIFY_WEBHOOK_SECRET=

# On the store today
SHOPIFY_VARIANT_WEBSITE_HOSTING_AUSTRALIA=
SHOPIFY_VARIANT_DOMAIN_1_YEAR=
SHOPIFY_VARIANT_EMAIL_HOSTING=

# Monthly selling plans, from step 4
SHOPIFY_SELLING_PLAN_WEBSITE_HOSTING_AUSTRALIA=
SHOPIFY_SELLING_PLAN_DOMAIN_1_YEAR=
SHOPIFY_SELLING_PLAN_EMAIL_HOSTING=

# Once created in step 5
SHOPIFY_VARIANT_BUILD_TOKEN=
SHOPIFY_VARIANT_POST_LIVE_EDIT=
SHOPIFY_VARIANT_DISCHARGE=
# Only once its price is decided
SHOPIFY_VARIANT_EXTRA_EDITS=
```

**Also worth setting:**

```
SHOPIFY_STOREFRONT_TOKEN=
```

A cart permalink can only carry **one** subscription line. A customer taking hosting **and** email
is two subscriptions, and rather than quietly dropping one from their cart the app refuses and says
why. With a Storefront API token it creates a proper cart instead and the problem disappears. Get one
from **Settings → Apps and sales channels → Develop apps → your app → Storefront API**, scope
`unauthenticated_write_checkouts`.

```
SHOPIFY_ADMIN_API_TOKEN=
```

Read-only `read_orders`, used by the nightly sweep that finds paid orders whose webhook never
arrived. Without it a dropped webhook stays dropped.

**If you skip the variant ids:** every checkout fails with a configuration error naming the exact
variable that is missing. Nothing silently half-works.

---

## Checking your work

Once it is all in, `GET https://build.itscold.com.au/api/health` returns a `products` block listing
anything still outstanding, with what each gap breaks. Empty problems list means the store and the
app agree.

With `ENABLE_LIVE_PAYMENTS=1` the API refuses to boot while anything is outstanding, and the startup
error names every missing item. That is on purpose: an install that intends to take money should not
run in a state where a customer can reach a checkout that does not work.

---

## Product page copy

**DRAFT, needs your sign-off before it goes on the store.** Prices are the decided ones and every one
carries "+ GST", which is now confirmed. Everything else here is restated from what the app already
tells customers, so the product page and the app cannot contradict each other.

### Website build — $200 + GST

> A real website for your trade business, built while you watch.
>
> Answer a guided set of questions about your business, upload your logo and some photos of your
> work, and your website is written and built in front of you. You get 10 rounds of changes to get
> it right, and you talk to us in plain English rather than filling in a form.
>
> **$200 + GST**, once, to build it.
>
> To keep it online afterwards:
>
> - Hosting **$30/month + GST**
> - Domain name **$5/month + GST**, if you need us to get you one
> - Custom email address like enquiries@yourbusiness.com.au, **$14.95/month + GST**, optional
>
> No mandatory ongoing maintenance fees. No lock-in contracts. If you ever want to take your website
> and go elsewhere, you can, for $300 + GST.

### What to check before you approve it

- "10 rounds of changes" matches `EDITS_INCLUDED` in the app.
- The three monthly prices match steps 2 and 4 above.
- $300 + GST for the handover is from the brief and is in the app.
- Nothing here promises a timeframe for anything. Keep it that way.
