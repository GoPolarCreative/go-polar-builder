# Shopify order confirmation, what to paste, and where

Two things need changing on the Shopify side after the dress rehearsal. **Neither can be done
through the API.** I checked the Admin GraphQL schema directly: there is no mutation for
notification templates, and `checkoutBranding` is not available on this store (Basic plan, not
Plus). These are admin-UI jobs, so the useful thing I can do is write the exact copy and tell you
where it goes.

---

## 1. Order confirmation email

**Where:** Shopify admin → **Settings → Notifications → Customer notifications → Order
confirmation → Edit code**.

### Why one template, not two

You asked for either a separate template per product or generic wording. Shopify gives you
**one** order confirmation template for the whole store, you cannot add a second one that fires
on a different product. But the template is Liquid, so it can branch on what was actually bought.
That is better than generic wording: the tradie who bought a DIY build gets instructions written
for them, and everyone else gets a clean generic confirmation, out of one template.

### The block to paste

Paste this **immediately after the opening `{% capture email_title %}...{% endcapture %}` block**,
or anywhere above the order summary table, near the top is the point, because the whole job of
this block is to be seen before they close the tab.

```liquid
{%- assign is_diy_build = false -%}
{%- for line in line_items -%}
  {%- if line.product.handle == 'diy-website-build' -%}
    {%- assign is_diy_build = true -%}
  {%- endif -%}
{%- endfor -%}

{% if is_diy_build %}
  <table class="row" style="margin-top:24px;">
    <tr>
      <td class="customer-info__item"
          style="background:#EAF4FC;border-left:4px solid #5BB8F5;padding:20px 22px;border-radius:6px;">
        <h3 style="margin:0 0 8px;font-size:18px;color:#0B1F3A;">
          Your next step is in your inbox
        </h3>
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#1B3A5A;">
          We have just sent you a second email with your build link and your order number.
          <strong>That is the one you need to start your website</strong>. This one is only your receipt.
        </p>
        <p style="margin:0;font-size:15px;line-height:1.6;color:#1B3A5A;">
          It should land within a minute or two. If you cannot see it, check your junk or
          promotions folder, or just reply to this email and we will sort it out.
        </p>
        <p style="margin:12px 0 0;font-size:14px;line-height:1.6;color:#3C5B7A;">
          Your order number is <strong>{{ order_name }}</strong>. Keep it handy. You sign in with
          your email address and that number.
        </p>
      </td>
    </tr>
  </table>
{% endif %}
```

### The wording that needs replacing

Anywhere the current template says something about the **$500 website**, replace it with
wording that is true of every product on the store. The safest generic sentence, which works for
a $220 build, a hosting subscription, an ads retainer and the $500 deposit alike:

> Thanks for your order. Everything you have bought is listed below, and we will be in touch with
> the next steps.

Do **not** leave a price or a product name in the generic part of the template. That is exactly
how it ended up saying "$500 website" to somebody who paid $220.

### Check it before you trust it

Shopify has a **Preview** button on that editor, but it uses a fake order that will not contain
`diy-website-build`, so the blue block will not appear in the preview. To actually test it:

1. Save the template.
2. Open a real DIY build order in **Orders**.
3. **More actions → Resend order confirmation** to your own address.

If the blue block does not show on a real DIY order, the handle in the `{% if %}` is wrong , 
it must be exactly `diy-website-build`.

---

## 2. The thank-you page

**Where:** Shopify admin → **Settings → Checkout**, then look for **Order status page →
Additional scripts**.

**Be aware this may not exist on your store.** Shopify has been removing that box as stores move
to checkout extensibility. If it is there, paste this into it:

```html
<div style="margin:20px 0;padding:20px 22px;background:#EAF4FC;border-left:4px solid #5BB8F5;border-radius:6px;font-family:inherit;">
  <h3 style="margin:0 0 8px;font-size:18px;color:#0B1F3A;">Check your email to start your website</h3>
  <p style="margin:0;font-size:15px;line-height:1.6;color:#1B3A5A;">
    We have emailed you a link and your order number. That email is what you need to begin.
    This page is just your receipt. If it has not arrived in a couple of minutes, have a look in
    your junk or promotions folder.
  </p>
</div>
```

**If that box is gone**, customising the thank-you page on a Basic plan needs a checkout UI
extension, which means an app. Before paying for one, consider that it may not be worth it: the
blue block in the email above does the same job, and Klaviyo already sends the build link
separately. The thank-you page is a nice-to-have; the email is the one that actually carries them
into the build.

---

## What I could not do from here, and why

- **No API for notification templates.** I searched the Admin GraphQL `Mutation` type for anything
  matching `notification` or `template`. The only hits were `giftCardSendNotificationToCustomer`
  and `giftCardSendNotificationToRecipient`. There is nothing that reads or writes an email
  template.
- **No `checkoutBranding` mutation** on this store's API scope, and checkout branding would not
  cover the thank-you page copy anyway.
- **Theme writes to the live theme are blocked** by the tooling now that the theme is published.
  Duplicate to a draft, edit that, and publish it from the Shopify admin.
