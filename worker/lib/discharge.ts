import type { Env } from '../env'
import { web3formsKey } from '../env'
import type { AssetRecord } from '../../shared/types'
import type { BuildFacts, ContentPlan } from '../../shared/plan'
import { createZip, type ZipEntry } from './zip'
import { inlineAssets } from './inline'

/**
 * Discharge packaging. Brief s9.
 *
 * $300 ex GST, available from the go-live screen and at any time after launch, visible and not
 * hidden. What ships is the files only: not hosting, not DNS, not the edit tool, not support.
 *
 * The one rule that matters most here is the Web3Forms key swap. The build ships with Go Polar's
 * key. Without a swap, a customer who has left keeps sending their enquiries into Go Polar's
 * account, which is both a privacy problem and a lost lead for them.
 */

export const PLACEHOLDER_KEY = 'YOUR-WEB3FORMS-ACCESS-KEY-GOES-HERE'

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidWeb3FormsKey(value: string): boolean {
  return UUID_RE.test(value.trim())
}

export interface DischargePackage {
  zip: Uint8Array
  r2Key: string
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

  let out = html.split(goPolarKey).join(replacement)

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
 * SVG favicon built from the brand. DECISIONS.md D7: a Worker cannot encode a PNG without
 * shipping a codec, and when there is no logo file this is the honest way to produce one.
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
}): string {
  return `${args.businessName} website files
Packaged by Go Polar Creative

WHAT IS IN HERE

  index.html          Your website. One file, no build step, no frameworks.
  assets/             Your logo and photos, referenced by index.html.
  favicon.svg         The little icon that shows in a browser tab.
  PREVIEW.html        The same site with every image embedded, so you can open it by
                      double clicking without a web server. Do not upload this one, it is
                      only for looking at.

HOW TO PUT IT ONLINE

  Upload index.html, the assets folder and favicon.svg to any web host, keeping them in the
  same structure. Nothing needs to be compiled or installed. Any host that serves static
  files will do.

${
  args.usedPlaceholder
    ? `READ THIS PART, IT MATTERS

  The enquiry forms on your website will NOT send anywhere until you fix one thing.

  Open index.html, search for:

      YOUR-WEB3FORMS-ACCESS-KEY-GOES-HERE

  Replace every one of those with your own access key. You can get one free in about a
  minute at https://web3forms.com by entering the email address you want enquiries sent
  to. There are two forms on the page, so there are two places to change.

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
 * base64 inlined. The README is added because a customer opening a zip with no instructions is
 * how the Web3Forms key never gets swapped.
 */
export async function buildDischargePackage(
  env: Env,
  args: {
    jobId: string
    html: string
    plan: ContentPlan
    facts: BuildFacts
    assets: AssetRecord[]
    customerWeb3FormsKey: string | null
  },
): Promise<DischargePackage> {
  const encoder = new TextEncoder()
  const entries: ZipEntry[] = []
  const files: string[] = []

  const swap = swapWeb3FormsKey(args.html, web3formsKey(env), args.customerWeb3FormsKey)

  entries.push({ path: 'index.html', data: encoder.encode(swap.html) })
  files.push('index.html')

  // Assets under the same relative paths index.html already references.
  const logo = args.assets.find((a) => a.kind === 'logo')
  const wanted: Array<{ path: string; asset: AssetRecord }> = []
  if (args.facts.logoPath && logo) wanted.push({ path: args.facts.logoPath, asset: logo })
  for (const p of args.facts.photoPaths) {
    const asset = args.assets.find((a) => a.id === p.assetId)
    if (asset) wanted.push({ path: p.path, asset })
  }

  for (const item of wanted) {
    const object = await env.BUCKET.get(item.asset.r2_key)
    if (!object) continue // a missing asset is reported by verification, not silently fatal here
    entries.push({ path: item.path, data: new Uint8Array(await object.arrayBuffer()) })
    files.push(item.path)
  }

  // Favicon: the logo if there is one, otherwise generated from the brand.
  if (logo && (logo.content_type ?? '').includes('svg')) {
    const object = await env.BUCKET.get(logo.r2_key)
    if (object) {
      entries.push({ path: 'favicon.svg', data: new Uint8Array(await object.arrayBuffer()) })
      files.push('favicon.svg')
    }
  } else {
    entries.push({ path: 'favicon.svg', data: encoder.encode(generateFavicon(args.plan)) })
    files.push('favicon.svg')
    if (logo) {
      const object = await env.BUCKET.get(logo.r2_key)
      if (object) {
        entries.push({ path: 'favicon.png', data: new Uint8Array(await object.arrayBuffer()) })
        files.push('favicon.png')
      }
    }
  }

  // Standalone preview with images inlined, so it opens by double clicking.
  const inlined = await inlineAssets(env, swap.html, args.facts, args.assets)
  entries.push({ path: 'PREVIEW.html', data: encoder.encode(inlined.html) })
  files.push('PREVIEW.html')

  entries.push({
    path: 'READ-ME-FIRST.txt',
    data: encoder.encode(
      readmeText({
        businessName: args.facts.businessName,
        usedPlaceholder: swap.usedPlaceholder,
        hasLogo: Boolean(args.facts.logoPath),
      }),
    ),
  })
  files.push('READ-ME-FIRST.txt')

  const zip = createZip(entries)
  const r2Key = `jobs/${args.jobId}/discharge/${args.facts.businessName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}-website-files.zip`

  await env.BUCKET.put(r2Key, zip, {
    httpMetadata: { contentType: 'application/zip' },
    customMetadata: { jobId: args.jobId, files: String(files.length) },
  })

  return {
    zip,
    r2Key,
    files,
    keySwapped: !swap.usedPlaceholder,
    usedPlaceholder: swap.usedPlaceholder,
  }
}
