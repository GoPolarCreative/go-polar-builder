import type { BuildFacts, ContentPlan } from '../../shared/plan'
import { config, web3formsKey } from '../config'
import { createZip, type ZipEntry } from './zip'
import { inlineAssets } from './inline'
import { storage } from './storage'

/**
 * Discharge packaging. Brief s9.
 *
 * $300 ex GST, available from the go-live screen and at any time after launch, visible and not
 * hidden. What ships is the files only: not hosting, not DNS, not the edit tool, not support.
 *
 * The rule that matters most here is the Web3Forms key swap. The build ships with Go Polar's
 * key. Without a swap, a customer who has left keeps sending their enquiries into Go Polar's
 * account, which is both a privacy problem and a lost lead for them.
 */

export const PLACEHOLDER_KEY = 'YOUR-WEB3FORMS-ACCESS-KEY-GOES-HERE'

// Validation lives in one place, shared with the go-live flow, so the two paths cannot drift into
// one strict and one lenient version of the same rule. See DECISIONS.md D29.
export { UUID_RE, isValidWeb3FormsKey } from './web3forms'
import { applyFormsKey, isValidWeb3FormsKey } from './web3forms'

export interface DischargePackage {
  zip: Uint8Array
  blobKey: string
  files: string[]
  keySwapped: boolean
  usedPlaceholder: boolean
}

/**
 * Replace the Go Polar access key with the customer's own, or with a clearly commented
 * placeholder. Go Polar's key never leaves in an exported file either way, which is the point.
 */
export function swapWeb3FormsKey(
  html: string,
  goPolarKey: string,
  customerKey: string | null,
): { html: string; swapped: boolean; usedPlaceholder: boolean } {
  const replacement = customerKey && isValidWeb3FormsKey(customerKey) ? customerKey.trim() : PLACEHOLDER_KEY
  const usedPlaceholder = replacement === PLACEHOLDER_KEY

  // Same swap the go-live path uses, so a discharged file and a live site get their forms
  // switched over by identical code.
  let out = applyFormsKey(html, goPolarKey, replacement).html

  if (usedPlaceholder) {
    // A comment above every form, so whoever picks this up next cannot miss it.
    out = out.replace(
      /<form /g,
      `<!-- IMPORTANT: the form below will not send anywhere until you replace ${PLACEHOLDER_KEY} with your own free Web3Forms access key from https://web3forms.com. Until you do, enquiries from this form go nowhere. -->\n      <form `,
    )
  }

  return { html: out, swapped: out !== html || !usedPlaceholder, usedPlaceholder }
}

/**
 * SVG favicon built from the brand. DECISIONS.md D7: generating a PNG server side would mean
 * shipping an encoder for something SVG already does, and SVG favicons are supported everywhere
 * that matters now.
 */
export function generateFavicon(plan: ContentPlan): string {
  const initials = plan.brand.wordmarkText
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2)

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="12" fill="${plan.tokens.primary}"/>
  <text x="32" y="43" font-family="Barlow Condensed, Impact, sans-serif" font-size="34" font-weight="700"
        text-anchor="middle" fill="${plan.tokens.white}">${escapeXml(initials)}</text>
</svg>
`
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function readmeText(args: {
  businessName: string
  usedPlaceholder: boolean
  hasLogo: boolean
  /** Service page paths, if this build is a page set. */
  extraPages?: string[]
}): string {
  return `${args.businessName} website files
Packaged by Go Polar Creative

WHAT IS IN HERE

  index.html          Your home page. Plain HTML, no build step, no frameworks.
  assets/             Your logo and photos, already resized and compressed for the web.
  favicon.svg         The little icon that shows in a browser tab.
${
  args.extraPages && args.extraPages.length > 0
    ? `  services/           Your service pages, one folder each, every one with its own
                      index.html inside. Keep the folder names as they are: they are the
                      web addresses those pages live at.
  sitemap.xml         A list of your pages for search engines.
  robots.txt          Tells search engines where the sitemap is.
`
    : ''
}  PREVIEW.html        The same home page with every image embedded, so you can open it by
                      double clicking without a web server. Do not upload this one, it is
                      only for looking at.

HOW TO PUT IT ONLINE

  Upload everything in this package to any web host, keeping the folder structure exactly as
  it is. The pages link to each other using those folder names, so moving things around is
  what breaks them. Nothing needs to be compiled or installed. Any host that serves static
  files will do.

A NOTE ON THE IMAGES

  Your photos have been resized and saved in two formats, WebP and JPEG. The page offers both
  and each browser takes the one it supports, which keeps the site fast on a phone. Keep both
  sets of files together or some visitors will see missing images.

${
  args.usedPlaceholder
    ? `READ THIS PART, IT MATTERS

  The enquiry forms on your website will NOT send anywhere until you fix one thing.

  Open index.html, search for:

      YOUR-WEB3FORMS-ACCESS-KEY-GOES-HERE

  Replace every one of those with your own access key. You can get one free in about a
  minute at https://web3forms.com by entering the email address you want enquiries sent
  to. There are two forms on every page, so check each HTML file in this package.

  Until you do this, anyone who fills in your form will think they have contacted you and
  nobody will receive it.
`
    : `YOUR ENQUIRY FORMS

  The forms are already pointed at your own Web3Forms account, so enquiries come straight
  to you. Nothing further to do.
`
}
${args.hasLogo ? '' : `A NOTE ON YOUR LOGO\n\n  No logo artwork was supplied, so your business name is set in type instead. If you get\n  real artwork later, drop it into the assets folder and point the header at it.\n`}
WHAT IS NOT INCLUDED

  This package is the files only. It does not include hosting, domain setup, the website
  builder, or ongoing support. The footer credit stays on the files.

Questions: https://www.itscold.com.au
`
}

/**
 * Build the discharge package.
 *
 * Contents per brief s9: index.html, assets/, favicon, and a standalone PREVIEW copy with images
 * inlined. The README is added because a customer opening a zip with no instructions is how the
 * Web3Forms key never gets swapped.
 */
export async function buildDischargePackage(args: {
  jobId: string
  html: string
  plan: ContentPlan
  facts: BuildFacts
  customerWeb3FormsKey: string | null
  /**
   * The rest of the page set: service pages, and the sitemap and robots files when there is more
   * than one page. The home page is passed separately as `html` because it is the one that has
   * been through the repair loop.
   */
  extraPages?: Array<{ path: string; html: string }>
  extraFiles?: Array<{ path: string; content: string }>
}): Promise<DischargePackage> {
  const store = storage()
  const encoder = new TextEncoder()
  const entries: ZipEntry[] = []
  const files: string[] = []

  const goPolar = web3formsKey(config())
  const swap = swapWeb3FormsKey(args.html, goPolar, args.customerWeb3FormsKey)

  entries.push({ path: 'index.html', data: encoder.encode(swap.html) })
  files.push('index.html')

  // Every other page of the set, each with the same key swap applied. A service page still
  // pointing at the Go Polar account would send that page's enquiries to us after handover.
  for (const page of args.extraPages ?? []) {
    const pageSwap = swapWeb3FormsKey(page.html, goPolar, args.customerWeb3FormsKey)
    entries.push({ path: page.path, data: encoder.encode(pageSwap.html) })
    files.push(page.path)
  }

  for (const file of args.extraFiles ?? []) {
    entries.push({ path: file.path, data: encoder.encode(file.content) })
    files.push(file.path)
  }

  // Every processed asset, under the exact relative path index.html already references.
  // Originals are deliberately not shipped: they are ten times the size and nothing points at
  // them. A rebuild uses them, a customer does not.
  for (const [path, meta] of Object.entries(args.facts.assetManifest)) {
    const bytes = await store.get(meta.key)
    if (!bytes) continue // a missing asset is reported by verification, not silently fatal here
    entries.push({ path, data: bytes })
    files.push(path)
  }

  // Favicon: the logo when it is an SVG, otherwise generated from the brand.
  if (args.facts.logo?.path.endsWith('.svg')) {
    const meta = args.facts.assetManifest[args.facts.logo.path]
    const bytes = meta ? await store.get(meta.key) : null
    if (bytes) {
      entries.push({ path: 'favicon.svg', data: bytes })
      files.push('favicon.svg')
    }
  } else {
    entries.push({ path: 'favicon.svg', data: encoder.encode(generateFavicon(args.plan)) })
    files.push('favicon.svg')
  }

  // Standalone preview with images inlined, so it opens by double clicking.
  const inlined = await inlineAssets(swap.html, args.facts)
  entries.push({ path: 'PREVIEW.html', data: encoder.encode(inlined.html) })
  files.push('PREVIEW.html')

  entries.push({
    path: 'READ-ME-FIRST.txt',
    data: encoder.encode(
      readmeText({
        businessName: args.facts.businessName,
        usedPlaceholder: swap.usedPlaceholder,
        hasLogo: Boolean(args.facts.logo),
        extraPages: (args.extraPages ?? []).map((p) => p.path),
      }),
    ),
  })
  files.push('READ-ME-FIRST.txt')

  const zip = createZip(entries)
  const blobKey = `jobs/${args.jobId}/discharge/${args.facts.businessName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}-website-files.zip`

  await store.put(blobKey, zip, 'application/zip')

  return { zip, blobKey, files, keySwapped: !swap.usedPlaceholder, usedPlaceholder: swap.usedPlaceholder }
}
