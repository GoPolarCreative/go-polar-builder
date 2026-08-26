# Klaviyo flows, in build order

Twelve metrics. **One flow exists.** Build the other eleven in the order below, most urgent first.

Every variable in this document was checked against the code on 2026-08-26. If a token is not
listed for a flow, that flow does not carry it and it will render empty.

## What already exists. Do not rebuild.

| Metric | Status |
|---|---|
| `Website Build Purchased` | **BUILT AND WORKING.** Leave it alone |

Everything else below has never had a flow. Seven of them have never even fired.

## Two things that will waste your time if you do not know them

**Klaviyo will not offer a metric that has never fired.** It does not appear in the trigger picker
until one event of that name arrives. Fire one first:

```
POST https://build.itscold.com.au/api/admin/test-email?email=you@itscold.com.au
Header: x-admin-token: <the admin token>
```

That fires `Website Build Purchased`. For the others, the metric appears the first time a real
customer action fires it, so build those flows when the metric shows up. `/ops` has a panel
listing all twelve and when each last fired.

**A 202 from Klaviyo is not a delivery.** The app records a success when Klaviyo accepts the
event, and Klaviyo accepts events for metrics no flow is listening to. A missing flow looks
identical to a working one from our side. The only proof is the profile's activity feed.

## Rules the copy follows

Read these before changing any wording, because a test greps this file for all of them.

- Short declaratives. Plain words. No fluff.
- No em dashes.
- No jargon a tradie will not know. No DNS, SSL, CDN, uptime, cPanel, patching, responsive.
- **No performance claims.** No rankings, no positions, no traffic or lead numbers, no timeframes,
  no "get found on Google". Describe what the thing is and what it does. Recommending is fine.
  Predicting is not.
- **Never promise the site is live within 24 hours.** Contact within one business day is the only
  promise, and it survives a weekend.

**Every event also carries `{{ event.job_id }}` and `{{ event.source }}`** (always
`go-polar-builder`). They are not repeated per flow.

**Copy is not approved.** None of this has Chris's sign-off. See DECISIONS.md D62 and D68.

---

# Flow 1: Website Login Code

**Build this first. Nothing else on the list locks a customer out.**

**Trigger:** `Website Login Code`
**Timing:** immediately. Do not batch, do not add a delay
**Filter:** none

**Subject:** `{{ event.login_code }} is your Go Polar code`

**Preview text:** `It expires in {{ event.expires_in_minutes }} minutes.`

**Body:**

```
Here is your code to sign in and edit your website.

{{ event.login_code }}

Type it into the page you have open. It works once and it expires in
{{ event.expires_in_minutes }} minutes.

If you did not ask for this, you can ignore it. Nobody can get into your website with just
this email.

Chris
Go Polar
```

**Variables:**

| Token | What it holds |
|---|---|
| `{{ event.login_code }}` | Six digits |
| `{{ event.expires_in_minutes }}` | `10` |

**Why the code goes in the subject line:** they are sitting on the screen waiting to type it. In
the subject they can read it off the phone notification without opening anything.

**If this flow does not exist, no returning customer can ever get back into their website.** The
code is only in this event. It is not stored anywhere and cannot be looked up or resent by hand.

---

# Flow 2: Operator Alert

**Trigger:** `Operator Alert`
**Timing:** immediately
**Goes to:** Chris only, never a customer
**Filter:** none on the flow. Use a conditional split on `{{ event.alert }}` inside it

There are **five kinds**, told apart by `{{ event.alert }}`. Build one flow with a split, or five
flows each filtered on the value. Only two of them are things you have to act on.

### Split A. `alert` equals `go_live_paid`. ACT ON THIS ONE

**Subject:** `PAID go live: {{ event.business_name }}`
**Preview text:** `Hosting is billing. Their address needs connecting.`

```
{{ event.business_name }} has paid for hosting.

Email: {{ event.customer_email }}
Job: {{ event.job_id }}

Their site: {{ event.preview_link }}
Open in ops: {{ event.ops_link }}

Hosting is now billing. Next step is yours: get their logins and connect their web address.
```

Tokens: `business_name`, `customer_email`, `job_id`, `preview_link`, `ops_link`.

### Split B. `alert` equals `go_live_requested`

**Subject:** `Go live request: {{ event.business_name }}`
**Preview text:** `Pressed the button. Not paid yet.`

```
{{ event.business_name }} has pressed go live. No payment yet.

Email: {{ event.customer_email }}
Phone: {{ event.customer_phone }}
Wants a web address: {{ event.wants_domain_addon }}
Wants an email address: {{ event.wants_email_addon }}
Checkout built: {{ event.checkout_built }}

Their site: {{ event.preview_link }}
Open in ops: {{ event.ops_link }}

Nothing to do yet. If checkout built says false, the checkout link failed to build and they
cannot pay. That one needs looking at now.
```

Tokens: `business_name`, `customer_email`, `customer_phone`, `wants_domain_addon`,
`wants_email_addon`, `checkout_built`, `job_id`, `preview_link`, `ops_link`.

### Split C. `alert` equals `customer_published` or `customer_restored`

**Subject:** `{{ event.business_name }} updated their website`
**Preview text:** `Version {{ event.version }} is live. Nothing to do.`

```
{{ event.business_name }} has published a change to their live website.

What they asked for: {{ event.what_changed }}

Now live: version {{ event.version }} at {{ event.site_url }}
Before that: version {{ event.previous_version }}
Pages: {{ event.pages }}

{{ event.note }}

Open in ops: {{ event.ops_link }}
```

Tokens: `business_name`, `customer_email`, `job_id`, `hostname`, `site_url`, `version`,
`previous_version`, `what_changed`, `pages`, `ops_link`, `note`.

**This is not a job.** Publishing already put the change on the internet. This exists so you know
it happened, and so you can put the old version back from `/ops` if they ring about it.

### Split D. `alert` equals `hosting_cancelled`

**Subject:** `CANCELLED: {{ event.business_name }}`
**Preview text:** `Their site stays up for 60 days.`

```
{{ event.business_name }} has cancelled their hosting.

Email: {{ event.customer_email }}
Job: {{ event.job_id }}
Subscription status: {{ event.subscription_status }}

{{ event.note }}

Comes offline on: {{ event.takedown_on }}
Open in ops: {{ event.ops_link }}
```

Tokens: `business_name`, `customer_email`, `job_id`, `subscription_status`, `takedown_on`,
`ops_link`, `note`.

### Split E. `alert` equals `site_taken_down`. ACT ON THIS ONE

**Subject:** `OFFLINE: {{ event.business_name }}`
**Preview text:** `60 days up. Their website has stopped serving.`

```
{{ event.business_name }} has been offline since just now.

{{ event.hostname }}
Job: {{ event.job_id }}

{{ event.note }}

Open in ops: {{ event.ops_link }}
```

Tokens: `business_name`, `hostname`, `job_id`, `ops_link`, `note`.

**Worth a phone call.** A website coming down is the kind of thing somebody notices a fortnight
later and is upset about.

---

# Flow 3: Website Go Live Started

**Trigger:** `Website Go Live Started`
**Timing:** immediately
**Filter:** none. The app already fires this only once per job

**Subject:** `One step left to put {{ event.business_name }} online`

**Preview text:** `Your checkout is ready.`

**Body:**

```
Hi,

Your website is ready to go online. The last step is setting up your hosting.

Finish it here: {{ event.checkout_url }}

That is $42.90 a month inc GST. It covers your website being online, your changes, and us
keeping an eye on it. Ten changes a month are included and you make them yourself.

Have another look at your site first if you want: {{ event.preview_link }}

Nothing goes live until you have paid and we have connected your web address, so there are no
surprises.

Chris
Go Polar
```

**Variables:**

| Token | What it holds |
|---|---|
| `{{ event.checkout_url }}` | Shopify checkout, hosting plus the address if they need one |
| `{{ event.business_name }}` | |
| `{{ event.preview_link }}` | |
| `{{ event.email_addon }}` | `true` / `false` |
| `{{ event.domain_addon }}` | `true` / `false` |

---

# Flow 4: Website Go Live Requested

Fires when the **hosting payment lands**. This is the "they have done everything and now they
wait" email.

**Trigger:** `Website Go Live Requested`
**Timing:** immediately
**Filter:** send once per profile

**Subject:** `That is everything we need`

**Preview text:** `Here is what happens next, and when.`

**Body:**

```
Hi,

That is everything we need from you. Your part is done.

Here is what happens next, in order.

1. One of our team will be in touch within one business day. If you press this on a Friday
   night, that means Monday.

2. We will ask you for the logins to your web address. That is the account you bought
   {{ event.domain_name }} from. If you cannot find them, tell us and we will work it out with
   you.

3. We point your address at your website. How long this takes is not up to us. Some providers
   move in an hour, some take a couple of days, and a few need you to approve something before
   anything happens. We will tell you where it is up to.

4. Your website goes live at your address, and we email you to say so.

Your website while you wait: {{ event.preview_link }}

Hosting has started. Ten changes a month are included, and you make them yourself once you are
live.

Anything at all, reply to this email.

Chris
Go Polar
```

**Variables:**

| Token | What it holds |
|---|---|
| `{{ event.preview_link }}` | |
| `{{ event.business_name }}` | |
| `{{ event.domain_name }}` | Their web address, or empty |
| `{{ event.domain_branch }}` | `own`, `new`, `locked`, or empty |

**Two conditional splits on `{{ event.domain_branch }}`.**

If it equals `new`, replace point 2 with:

```
2. We register {{ event.domain_name }} for you. Nothing for you to do here. If somebody has
   taken it since you asked, we will ring you and sort out another one.
```

If it equals `locked`, replace points 2 and 3 with:

```
2. We contact whoever is holding {{ event.domain_name }} and ask them to release it. We do this
   in writing so there is a record of it.

3. If they do not answer, there is a formal process with the company the address is registered
   with, and a dispute process after that. We will not put a date on this one, because it
   depends on somebody else replying. We will tell you where it is up to either way.

   We can put your website online at a temporary address in the meantime so it is not sitting
   there doing nothing. Say the word.
```

**Why one business day and not a fixed number of hours.** Somebody who presses go live at 9pm on
a Friday counts twenty four hours forward and lands on Saturday night. Nobody is ringing them
Saturday night, so the promise is broken before the first conversation has happened.

---

# Flow 5: Website Hosting Ending

**Build this before any customer cancels.** It ends with a business website going offline.

**Trigger:** `Website Hosting Ending`
**Timing:** immediately. The app decides the schedule, not Klaviyo
**Filter:** none

**One flow, one template, four stages.** The app fires this at **0, 30, 53 and 59 days** after a
cancellation and computes the wording each time. The template prints what it is given, so there
is nothing to split on and nothing to schedule.

**Subject:** `{{ event.headline }}`

**Preview text:** `Your website comes offline on {{ event.offline_on }}.`

**Body:**

```
Hi,

{{ event.body }}

Your website: {{ event.site_url }}

Chris
Go Polar
```

**Variables:**

| Token | What it holds |
|---|---|
| `{{ event.stage }}` | `0`, `30`, `53` or `59`. Days since they cancelled |
| `{{ event.urgency }}` | `low`, `medium` or `high`. Style the high one differently if you want |
| `{{ event.headline }}` | The subject line, written by the app |
| `{{ event.body }}` | The paragraph, written by the app |
| `{{ event.business_name }}` | |
| `{{ event.hostname }}` | Their address without the https |
| `{{ event.site_url }}` | With the https |
| `{{ event.offline_on }}` | The date, already written out for an Australian reader |
| `{{ event.days_left }}` | |

**What actually gets sent at each stage,** so you know what is going out:

**Stage 0.** *Your hosting has been cancelled*
> Your website for NAME is still online and will stay online until DATE. You cannot make changes
> to it any more, because that is part of the hosting. If you want to keep the site, start your
> hosting again and everything comes straight back, including your changes. Reply to this email if
> you would rather talk it through.

**Stage 30.** *Your website comes offline in 30 days*
> Just so you know where things are at. Your website for NAME is still online, and it comes down
> on DATE. Starting your hosting again puts everything back, and nothing has been deleted. If you
> want your files instead of the hosting, we can do that too, just ask.

**Stage 53.** *One week until your website comes offline*
> Your website for NAME comes down on DATE, which is a week away. After that, anyone typing your
> web address will not find you. If that is not what you want, start your hosting again and it
> stays up. Nothing has been deleted either way.

**Stage 59.** *Your website comes offline tomorrow*
> This is the last one. Your website for NAME comes down tomorrow, DATE. From then on your web
> address will not show anything. We have not deleted a thing, so it can still come back later,
> but it will be offline in the meantime. If this is a mistake, reply to this email today and we
> will sort it out.

**The stage 59 email is the last warning before a real business website stops answering.** If any
flow deserves a delivery check, it is this one.

---

# Flow 6: Website Link Requested

**Trigger:** `Website Link Requested`
**Timing:** immediately
**Filter:** none

**Subject:** `Your Go Polar link`

**Preview text:** `Here it is again.`

**Body:**

```
Hi,

Here is your link back into your website.

{{ event.builder_login_link }}

If you did not ask for this, you can ignore it.

Chris
Go Polar
```

**Variables:**

| Token | What it holds |
|---|---|
| `{{ event.builder_login_link }}` | A fresh signed link |
| `{{ event.reason }}` | Only present as `claim_on_live_site` when they matched their order number on a live site. Otherwise absent |

**Without this flow the "send my link again" button does nothing at all**, silently, and the
person pressing it has already lost their link once.

---

# Flow 7: Website Build Complete

**Trigger:** `Website Build Complete`
**Timing:** immediately
**Filter:** none. It only fires when a build passed its checks

**Subject:** `Your website is built`

**Preview text:** `Have a look and tell us what to change.`

**Body:**

```
Hi,

Your website is built. Have a look.

{{ event.preview_link }}

Open it on your phone as well. That is how most people will see it.

If anything is not right, type what you want changed in the box on that page and it gets done.
Ten rounds of changes are included, and one message is one change however much is in it.

Chris
Go Polar
```

**Variables:**

| Token | What it holds |
|---|---|
| `{{ event.preview_link }}` | Straight to their website |

The profile also carries their business name in `organization`.

---

# Flow 8: Website Files Ready

**Trigger:** `Website Files Ready`
**Timing:** immediately
**Filter:** none

**Subject:** `Your website files are ready`

**Preview text:** `Download link inside. It expires.`

**Body:**

```
Hi,

Your website files are packaged and ready.

{{ event.download_link }}

That link expires on {{ event.expires_at }}, so grab it before then. If you miss it, reply and
we will send another.

Inside you will find every page, all your images, and a file called PREVIEW.html you can
double click to see the site on your own computer.

Chris
Go Polar
```

**Add a conditional block when `{{ event.used_placeholder }}` is `true`:**

```
One thing to sort out. The contact form in these files is not connected to your inbox yet, so
enquiries sent through it will not reach you until it is. Whoever puts the site online needs to
put your own form key in. Ask us if you are not sure what that means.
```

**Variables:**

| Token | What it holds |
|---|---|
| `{{ event.download_link }}` | Signed, expires |
| `{{ event.expires_at }}` | Timestamp |
| `{{ event.used_placeholder }}` | `true` means the forms are not connected. The block above must show |
| `{{ event.business_name }}` | |

**The `used_placeholder` block is not optional.** If it is true and the email does not say so, the
customer puts a website online that quietly loses every enquiry.

---

# Flow 9: Website Is Live, and the post-live sequence

**Trigger:** `Website Is Live`
**Filter:** **set the flow to trigger once per profile, or filter on `{{ event.is_first_publish }}`
equals `true`.**

**This one matters more than the others.** The metric fires on every publish, including every
time a customer edits their live site. Without the filter, somebody who changes a photo gets the
whole seven email sequence again.

**Variables, available to every email below:**

| Token | What it holds |
|---|---|
| `{{ event.site_url }}` | `https://theiraddress.com.au` |
| `{{ event.hostname }}` | Without the https |
| `{{ event.business_name }}` | |
| `{{ event.pages }}` | How many pages went live |
| `{{ event.is_first_publish }}` | `true` only the first time |

**Seven emails over eight weeks: day 0, 3, 8, 15, then 29, 43, 57.**

The first four are free advice, in the fortnight when the site is new and they will actually act
on it. Then fourteen clear days before anything is sold, because they have just paid $220 plus
hosting and asking for more money in week one reads as a business that was only ever going to
keep asking. The paid ones go one at a time, cheapest first.

**Set anyone who replies to drop out of the sequence.**

---

### Email 1. It is live

**Timing:** immediately

**Subject:** `Your website is live`

**Preview text:** `{{ event.site_url }} is on the internet.`

**Body:**

```
Your website is live.

{{ event.site_url }}

Open it on your phone. That is how most people will see it.

One thing worth doing today: send that address to five people who already know you. Your
partner, your best customer, the bloke who sends you work. They will tell you if something
looks off, and it gets your site in front of people on day one.

You can still change anything on it. Ten changes a month are included and you make them
yourself.

Chris
Go Polar
```

---

### Email 2. Put it where people already look

**Timing:** 3 days after

**Subject:** `Two places to put your address`

**Preview text:** `Both free. Ten minutes.`

**Body:**

```
Your website only works if people can find it. Two places to put it, both free.

1. Your Google Business Profile

That is the listing with your name and the map pin that shows when somebody looks you up. If
you have one, sign in and put your address in the website field. If you do not have one, make
one. It is free and it is the single most useful thing you can set up.

Search for "Google Business Profile" and it will walk you through it.

2. Facebook and Instagram

Put your address in the bio, and in the about section of your Facebook page. People who find
you there have already decided they might use you. Give them somewhere to go.

Your address, ready to copy: {{ event.site_url }}

Chris
Go Polar
```

---

### Email 3. Put it where people already hold it

**Timing:** 8 days after

**Subject:** `Your van, your quotes, your signature`

**Preview text:** `Places your address should already be.`

**Body:**

```
The other half of this is the stuff people are already holding.

Your quotes and invoices. Put your address in the footer. Somebody deciding between you and
another bloke will look you up before they call, and a quote with a website behind it is a
different quote.

Your email signature. Two minutes in your phone settings. Every email you send from now on
carries it.

Your van. Next time it is getting new signage, or you are ordering stickers, put it on.

Your shirts, if you get them printed.

Anywhere your phone number already is, your address should be too.

{{ event.site_url }}

Chris
Go Polar
```

---

### Email 4. Reviews

**Timing:** 15 days after

**Subject:** `Ask three people for a review`

**Preview text:** `The bit most people skip.`

**Body:**

```
Reviews are the part most tradies never get around to. Worth doing.

Pick three customers from the last few months. Ones where the job went well and you got on
with them. Send them a message.

Something like this works:

"Hi Dave, glad the job worked out. If you have got a spare minute, would you mind leaving us
a Google review? Here is the link. No stress if not."

Then send them the link to your Google Business Profile.

Do three at a time, not thirty. Three is a text message you will actually send.

If you want any of those reviews on your website, reply with them and we will put them on for
you. That counts as one of your changes.

Chris
Go Polar
```

---

### Email 5. A proper email address

**Timing:** 29 days after

**Subject:** `An email address at your own name`

**Preview text:** `Optional. Here is what it is.`

**Body:**

```
Your website has been up a month. Hope it is doing its job.

One thing you can add if you want it: an email address at your own web address. Something like
enquiries@yourbusiness.com.au instead of a gmail one.

What it is: your email, exactly as you use it now, with your own name after the at sign. It
works on your phone and your computer the same way. Nothing about how you send and read email
changes.

Why people bother: a quote from a business address looks like a business. That is the whole
of it.

$14.95 a month inc GST. We set it up. If you want it, reply to this email and we will sort it.

If you do not, that is completely fine. Your website does not need it.

Chris
Go Polar
```

---

### Email 6. A page for each service

**Timing:** 43 days after

**Subject:** `A page for each of your services`

**Preview text:** `What it is, and when it is worth it.`

**Body:**

```
Something worth understanding about how search works.

Right now your website has one page covering everything you do. When somebody searches for one
specific job in one specific suburb, that page is competing with itself for every service on
it.

A page about one service, in the suburbs you actually work in, gives a search engine something
specific to match against. That is what a service page is. Its own address, its own words about
that one job, its own enquiry form.

This is not a guarantee of anything. It is a structure that gives you a chance of being matched
to a specific job in a specific place, which one page trying to cover everything does not.

$25 each, inc GST. We write it and put it up.

If it is worth it: tell us which services and we will do them.

If your work comes from word of mouth and always has, this probably is not for you, and I would
rather say that than sell it to you.

Chris
Go Polar
```

---

### Email 7. Ads

**Timing:** 57 days after

**Subject:** `Google Ads, and whether you need them`

**Preview text:** `The last one of these. Honest version.`

**Body:**

```
Last one of these from me.

Google Ads is paying to appear when somebody searches for what you do. You set what you are
willing to spend, you only pay when somebody clicks, and you can stop it any day you like.

What it is not: it is not the same as your website being found on its own. It runs while you
pay for it and it stops when you stop.

When it is worth a look: you have room for more work, you can answer your phone during the day,
and you have got a budget you would not miss if it went nowhere for the first while.

When it is not: you are already flat out, or the number you have in mind is small enough that
losing it would hurt.

We set them up and manage them. If you want to talk it through, reply and we will have a
conversation about whether it makes sense for you. If it does not, I will say so.

Either way, your website is yours and it keeps doing its job.

Chris
Go Polar
```

---

# Flow 10: Website Intake Abandoned

**Trigger:** `Website Intake Abandoned`
**Timing:** immediately. The app already waits 24 hours before firing
**Filter:** send once per profile

**Subject:** `Your website is waiting for you`

**Preview text:** `You are about half an hour from having it.`

**Body:**

```
Hi,

You paid for your website and got as far as the questions, then life got in the way. Happens
to everyone.

Pick it up here: {{ event.builder_login_link }}

It takes about half an hour in one sitting. Have your logo and a few job photos handy if you
have got them, and if you have not, it still works.

If something got in the way that we can help with, just reply.

Chris
Go Polar
```

**Variables:**

| Token | What it holds |
|---|---|
| `{{ event.builder_login_link }}` | **Despite the name this holds a preview link, not a login link.** It is correct and it works. Do not relabel it |

---

# Flow 11: Website Editing Stalled

**Trigger:** `Website Editing Stalled`
**Timing:** immediately. The app already waits 72 hours
**Filter:** send once per profile

**Subject:** `Anything you want changed?`

**Preview text:** `Your website is sitting there ready.`

**Body:**

```
Hi,

Your website has been sitting there for a few days. Nothing wrong with that, but if you have
been meaning to change something and have not got to it, now is a good time.

{{ event.preview_link }}

Type what you want changed in the box on that page. One message is one change however much is
in it, so put everything in at once.

If you are happy with it as it is, go live whenever you are ready.

Chris
Go Polar
```

**Variables:**

| Token | What it holds |
|---|---|
| `{{ event.preview_link }}` | |

---

# Flow 12: Website Build Purchased

**ALREADY BUILT AND WORKING. Do not rebuild it.**

Listed only so the set is complete and so the variables are recorded in one place.

**Trigger:** `Website Build Purchased`
**Timing:** immediately

| Token | What it holds |
|---|---|
| `{{ event.builder_login_link }}` | Signed one-click link into the builder |
| `{{ event.order_id }}` | Shopify order id |
| `{{ event.amount_ex_gst_cents }}` | Integer cents, **excluding GST** |
| `{{ event.recovered }}` | `true` only when the hourly sweep re-sent it. Absent otherwise |
| `{{ event.test }}` | `true` only from the test endpoint. Absent otherwise |

The profile also carries first name, last name and phone from the Shopify order.

---

# If you only do three things today

1. **`Website Login Code`.** Without it nobody can get back into their website.
2. **`Operator Alert`, splits A and E.** Somebody paying, and somebody's site going offline.
3. **`Website Hosting Ending`.** Four warnings before a business goes dark.

The rest can follow this week.
