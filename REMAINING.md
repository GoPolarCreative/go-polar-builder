# Everything left to finish

Verified 2026-08-26 against the live store, the live deployment and the code. Not reconstructed
from the other documents, several of which are stale (see the last section).

Grouped by owner, then by when it bites.

---

# CHRIS

## Blocks the next paying customer

### 1. The Shopify product description still quotes $33 and $110. STILL BROKEN.

**Verified live**, `product.descriptionHtml` on `diy-website-build`:

> Hosting: **$33**/month inc GST
> Website updates after you're live: **$110 per update** inc GST, handled by our team

The cost block on the same page says **$42.90**, and the comparison section says **ten changes a
month included**. So the page states two hosting prices, and both "changes included" and "$110 per
change". It is also in the meta description Google indexes.

**Why it matters:** a customer pays $220 expecting $33 hosting and is charged $42.90. That is the
bait and switch D31 exists to prevent, and it is an Australian Consumer Law exposure before it is
anything else.

**How long:** ten minutes in Shopify admin, Products, DIY Website Build.

**If it never happens:** every ad dollar sends traffic to a page that misprices the product.

**Replace the two bullets with:**

```
Hosting and editor: $42.90/month inc GST, including ten changes a month
Your domain name: $5.50/month inc GST (or connect one you already own)
```

and delete the "$110 per update" line entirely, since it contradicts the tier.

### 2. The `Website Login Code` Klaviyo flow. THIS GATES THE EDITOR ENTIRELY.

Without it the "Edit your existing website" entry point sends nothing, and **no returning customer
can ever get back into their site.** The code exists only in the event payload; it is not stored
and cannot be looked up or resent by hand.

Metric: `Website Login Code`. Variables: `{{ event.login_code }}`, `{{ event.expires_in_minutes }}`.

**Put the code in the subject line** so it can be read from the phone notification without opening
the email. Send immediately, do not batch.

**How long:** twenty minutes.

**Klaviyo will not show a metric that has never fired.** Fire one first, then build the flow.

## Blocks the first go-live

### 3. Klaviyo flows: 2 of 11 exist

| # | Metric | Exists? | Consequence if missing |
|---|---|---|---|
| 1 | `Website Build Purchased` | **YES**, verified by Chris | — |
| 2 | `Website Link Requested` | **NO** | "Send my link again" silently does nothing |
| 3 | `Website Build Complete` | **NO** | They are not told their site is ready |
| 4 | `Website Go Live Started` | **NO** | No checkout link reaches them at go-live |
| 5 | `Website Go Live Requested` | **NO** | No "we have everything, here is what happens next" |
| 6 | `Website Is Live` | **NO** | Nobody is told their site went live. Also the whole nurture |
| 7 | `Website Files Ready` | **NO** | A paid discharge sends no download link |
| 8 | `Website Intake Abandoned` | **NO** | No recovery |
| 9 | `Website Editing Stalled` | **NO** | No recovery |
| 10 | `Operator Alert` | **NO** | Chris is not told anything. `/ops` still shows it |
| 11 | `Website Login Code` | **NO** | **No returning customer can sign in** |

Copy for 1, 2 and 3 above is written and paste-ready in `KLAVIYO-FLOWS.md`. The rest need copy.

**Order of urgency:** 11, then 4 and 5 and 10 (the go-live trio), then 2, then 6, then the rest.

**How long:** twenty minutes each. Two hours for the lot.

### 4. Copy sign-off, seven decisions

Nothing here has ever been approved by Chris. All of it is live or about to be.

| ID | What you are approving |
|---|---|
| **D28** | The four design style names and descriptions the customer picks from in the wizard |
| **D31** | Every price shown GST-inclusive, one number everywhere, "inc GST" on all of them |
| **D35** | The build product page copy, rewritten from section 11 of your brief with figures converted to GST-inclusive |
| **D44** | The additional-pages copy: persuades with the mechanism, never promises a result |
| **D52** | The whole rewritten landing page: single buy CTA, the one-page-vs-page-per-service fork, and the cost disclosure block |
| **D54** | The $42.90 hosting copy: what the tier includes, and the Australian servers claim |
| **D62** | Every Klaviyo email: the operator alert, the go-live confirmation, and the seven-email post-live nurture |

**Why it matters:** D44, D52 and D62 carry performance-claim risk. Tests grep for rankings,
traffic and timeframes, but a test cannot tell you whether a sentence is one you are willing to
stand behind.

**How long:** an hour to read all seven properly.

**If it never happens:** copy nobody signed off is in front of customers, and you find out what it
says when somebody quotes it back at you.

## Not urgent

### 5. The `extra-edits` price, never decided

Live health reports it as the only outstanding product problem. The path is dark by design: a
customer out of pre-launch edits is offered a conversation, never a number.

**Breaks nothing.** Decide the number and the path turns on.

### 6. Existing $33 subscribers

`website-hosting-australia` is still on the store and still billing anyone on it. The app no longer
sells it. There is **no migration path** to the $42.90 tier and no decision about whether they get
the editor.

**Bites when:** an existing $33 customer asks why they cannot edit their site, or notices new
customers pay more for more.

### 7. Two policy questions from D63

- **What happens to a cancelled customer's live site, and after how long?** Editing stops, the
  site stays up **indefinitely**. That is the absence of a policy, and it means you host cancelled
  customers forever.
- **Is a hard stop at ten changes a month right?** It is what the page promises and what is now
  enforced. Decide before somebody hits it.

---

# ME

## Blocks the first go-live

### 8. The first production publish has never run

`/api/admin/queue` reports **zero published sites**, one job waiting at `go_live_pending`. The
publish path is proven locally (18/18 against a real database and real storage) but has never
executed in production against Neon and Vercel Blob.

**How long:** thirty minutes, done together with Chris watching.

**If it never happens:** the first time it runs is in front of a paying customer.

### 9. The go-live confirmation screen contradicts the product. NEW, nobody has flagged this.

`GET /jobs/:jobId/golive/confirmation` returns, and the confirmation screen renders:

> Changes after you are live are handled by our team. Website update after launch: **$110.00 inc GST**

That is the **last screen of the purchase flow**, shown to a customer who has just bought the tier
that includes **ten self-serve changes a month**. It contradicts the landing page, the comparison
section and the product they just paid for.

**How long:** fifteen minutes. Replace with the monthly allowance.

**If it never happens:** a customer either pays $110 for something they already have, or catches
it and stops trusting the pricing.

## Bites soon

### 10. Restore and versions have no buttons in `/ops`

`POST /api/admin/restore` and `GET /api/admin/jobs/:jobId/versions` exist and work. There is **no
UI**. Chris can only reach them with curl.

**Why it matters:** this is the phone-call path. A customer publishes something broken and rings
rather than pressing undo themselves, which is what a worried person does. Chris needs it on a
screen, on a phone, not in a terminal.

**How long:** an hour.

### 11. HANDOVER.md is actively wrong and would mislead the next session

It says, in bold:

> You are **not** hosting their site from this app. It builds; you collect the files and host them
> the way you already host every other client site.

**That has not been true since D24.** The app publishes to Blob and serves live sites by hostname,
and customers now publish their own changes. It also says seven Klaviyo metrics (eleven),
375 tests (519), thirteen static checks (fifteen), and lists `ENABLE_LIVE_PAYMENTS` and the
Shopify Dev Dashboard app as missing when both are set.

**Why it matters most of all the documentation items:** it is the file a new session is told to
read first, and it describes an architecture that no longer exists.

**How long:** an hour to rewrite properly.

### 12. The 6 pre-existing TypeScript errors are now 25

**They are not build failures.** `tsc -b`, which `npm run vercel:build` gates on, is clean and the
deploy succeeds. These come from Vercel's separate, non-fatal type inspection of `api/index.ts`,
which runs with default compiler options where `strict` is off, so discriminated unions stop
narrowing.

Every one is the same shape: `Property 'reason' does not exist on type 'CheckResult'` after a
correct `if (!result.ok)` guard. One of the original six (`render.ts:321`) is identical, which is
what identifies the cause. The count grew because the editor work added more result unions.

**Why it matters:** twenty-five lines of known-harmless noise is where a real error goes to hide.

**How long:** an hour, adding a strict `tsconfig.json` inside `api/`. Low risk but it changes how
the function is built, so it wants a careful deploy rather than a quick one.

### 13. Multiple jobs per email resolves by guess

A verified sign-in code opens the customer's **live** site first, then most recently updated.
Correct for anyone with one website, a guess for the handful who bought twice. They cannot pick.

**Bites when:** somebody buys a second site and cannot reach the first.

## Not urgent

### 14. Appstle cancellation is built but never tested against a real webhook

Shopify subscription topics are consumed, editing and publishing refuse when cancelled, Chris is
alerted, and the site stays up. Proven in `scripts/proof-editor-loop.mjs` by calling
`applySubscriptionStatus` directly. **No real Appstle cancellation has ever hit the endpoint**, so
the payload shape is an assumption.

**How long:** thirty minutes to cancel a test subscription and read the event log.

### 15. Retire the $110 product for DIY customers

Item 9 removes it from the confirmation screen. Deciding whether the product stays on the store for
legacy $33 customers is a separate call, and it is Chris's.

---

# The original brief

**The brief is not in this repository.** I checked: it exists only as references in code comments
and DECISIONS.md. So this is an honest partial audit, not a complete one, and it should be treated
that way.

Sections referenced in code, all with working implementations:

| Section | What it covers | Built? |
|---|---|---|
| s3 | Auth and job creation | Yes |
| s4 | Intake, and the deliberate removal of the Web3Forms question from it | Yes |
| s5 | Generation and streaming | Yes |
| s6 | Verification and holding a failed build | Yes |
| s7 | The edit loop, allowance, rollback | Yes |
| s8 | Go live, domains, three branches | Yes |
| s9 | Discharge package | Yes |
| s11 | The cost disclosure block | Yes |
| s12 | Abandoned intake and stalled editing sweeps | Yes, **but no Klaviyo flow behind either** |
| s14 | Every external call surfaces a real error | Yes |

**Sections 1, 2, 10 and 13 are never referenced anywhere in the code or the decisions.** That means
one of two things and I cannot tell which without the brief: either they are positioning and
commercial sections with nothing to build, or something was specified and dropped so early it left
no trace.

**This is the one gap in this document I cannot close myself.** If Chris still has the brief, thirty
minutes reading sections 1, 2, 10 and 13 against this list would settle it. I would rather say that
than pretend the audit is complete.

Two things I can confirm were specified and then deliberately removed, both recorded:

- **The Web3Forms question in the intake** (D29). Moved out, then moved again into the build step
  (D57). Working.
- **GoHighLevel, and later Resend** (D48, D53). Both deleted, not disabled. Klaviyo replaced them.

---

# Already done, in case you are working from stale notes

- **The draft theme is published.** Theme 174639841439 is `role: MAIN`.
- **The Appstle plan is attached to DIY Website Hosting and the product is live.** Verified on the
  store: selling plan group `DIY Website Hosting`, plan `Monthly Subscription` (3944349855), and
  live health reports `diy-hosting-monthly: Active, and bills every 1 MONTH as advertised`.
- **`shared/pricing.ts` is flipped and the env var is set.** $42.90, variant 62853864685727.
- **`ENABLE_LIVE_DOMAINS` is set and the credentials work.** `/api/admin/domain-check` reaches
  project `go-polar-builder` for real.
- **`ENABLE_LIVE_PAYMENTS` is on**, and the Shopify Dev Dashboard app exists. HANDOVER.md says
  neither, and is wrong.
- **Extra pages are wired and proven** on the real model path (D55).
- **The landing page cost block is correct**: $220, $42.90 and $5.50 all present, no stale $33.

---

# Closed since this was written (2026-08-26)

| Item | Status |
|---|---|
| Product description $33 | **Fixed by Chris.** Now $42.90. One line still to delete, see below |
| $110 on the go-live confirmation screen | **Fixed.** Now says ten changes a month, included (D67) |
| HANDOVER.md misleading | **Rewritten.** Opens by naming what it used to claim |
| Klaviyo observability | **Built.** `/ops` panel plus `GET /api/admin/klaviyo-health` |
| Restore and versions buttons | **Built.** The "Put a site back" panel in `/ops` |
| `extra-edits` price | **Removed, not priced** (D66). Product config is now completely clean |
| Appstle cancellation | **Built with a 60 day clock** (D68). 24 assertions against a real database |
| Brief section 10 | **Audited** (D65). Nothing missing, but the status lifecycle no longer holds and that had already broken the `/ops` waiting list |

**Still outstanding on the product description:** the bullet reading "Website updates after you're
live: $110 per update inc GST, handled by our team". It contradicts the tier the same page sells.
One line to delete in Shopify admin.

**Still outstanding, unchanged:** the twelve Klaviyo flows (seven have never fired), copy sign-off
on D28, D31, D35, D44, D52, D54, D62 and now D68, the first production publish, the TypeScript
noise, multiple jobs per email, and existing $33 subscribers.
