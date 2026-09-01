import type { BuildFacts, ContentPlan } from '../../../shared/plan.js'

/**
 * The tab icon and the share card.
 *
 * BOTH OF THESE WERE MISSING FROM THE BUILT WEBSITE and neither failed loudly, which is why they
 * survived a dress rehearsal.
 *
 * The favicon existed only inside the downloadable zip. Anyone looking at the live site, or the
 * preview during the ten rounds of edits, got the browser's default blank page icon. A tradie who
 * pins their own website to a phone home screen sees a grey square.
 *
 * The share card was worse than missing: the page declared
 * `<meta name="twitter:card" content="summary_large_image">` and then never said which image.
 * That is a positive claim that a big picture is available, so the site got a large blank card
 * wherever it was pasted - Facebook, LinkedIn, a text message to a customer. A page with no card
 * tags at all degrades to a tidy link. Declaring a card and withholding the image does not.
 *
 * WHAT GOES IN THE CARD IS A PHOTO, NOT THE LOGO, whenever there is one. The share image is
 * 1200x630-ish and lands in a feed next to other people's photos: a real picture of a finished
 * job is the thing worth showing, and a logo centred in a wide rectangle reads as a placeholder.
 * The logo is the fallback, not the preference.
 */

/** Above this the logo is a wide lockup. Same number the audit uses, for the same reason. */
const WIDE_LOCKUP_ASPECT = 3.2

/**
 * A crawler will not render WebP or SVG reliably, so a share image has to be a JPEG or a PNG.
 *
 * This is not a hypothetical. The site's photos ship WebP first with a JPEG fallback beside them,
 * and the logo is often an SVG. Handing either to Facebook produces the same blank card as
 * handing it nothing, except now it looks like it should have worked.
 */
function isCrawlerSafeImage(path: string): boolean {
  return /\.(jpe?g|png)$/i.test(path)
}

function absolute(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/**
 * Which file becomes the tab icon.
 *
 * CHRIS ASKED FOR "USE THE LOGO AUTOMATICALLY" AND THAT IS WHAT THIS DOES, with one exception
 * that is worth keeping. A favicon renders at 16 to 32 pixels. A wide lockup - a mark with the
 * business name set beside it - scaled into that box is an illegible smear, and the audit already
 * has a flag for exactly this shape (`logo_wide_lockup`, aspect >= 3.2) because the same problem
 * bites in the page header.
 *
 * So a squarish logo becomes the favicon, and a wide one falls back to the generated mark, which
 * is the business's initials on their brand colour and is legible at 16px. That is not ignoring
 * the instruction; a wide logo used here would satisfy the letter of it and give the customer a
 * worse tab icon than the alternative.
 */
export function faviconHref(facts: BuildFacts): { href: string; type: string } | null {
  const logo = facts.logo
  if (!logo) return null

  const aspect = logo.width && logo.height ? logo.width / logo.height : 1
  if (aspect >= WIDE_LOCKUP_ASPECT) return null

  if (/\.svg$/i.test(logo.path)) return { href: logo.path, type: 'image/svg+xml' }
  // A PNG fallback keeps transparency, which a WebP favicon also would, but PNG is the one every
  // browser and every home-screen shortcut handles without thinking about it.
  if (logo.fallback && /\.png$/i.test(logo.fallback)) return { href: logo.fallback, type: 'image/png' }
  if (/\.png$/i.test(logo.path)) return { href: logo.path, type: 'image/png' }
  if (/\.webp$/i.test(logo.path)) return { href: logo.path, type: 'image/webp' }
  return null
}

/**
 * The picture that shows when the site is pasted anywhere.
 *
 * First real photo, because that is what a person wants to look at. Falls back to a raster logo.
 * Returns null rather than guessing, and the caller drops the card tags entirely when it does.
 */
export function shareImageFor(facts: BuildFacts): { path: string; width: number; height: number } | null {
  const photo = facts.photos.find((p) => isCrawlerSafeImage(p.webJpeg))
  if (photo) return { path: photo.webJpeg, width: photo.width, height: photo.height }

  const logo = facts.logo
  if (logo) {
    if (logo.fallback && isCrawlerSafeImage(logo.fallback)) {
      return { path: logo.fallback, width: logo.width, height: logo.height }
    }
    if (isCrawlerSafeImage(logo.path)) {
      return { path: logo.path, width: logo.width, height: logo.height }
    }
  }
  return null
}

/**
 * Every icon and social tag for one page, as a block of HTML ready to drop into <head>.

 */
export function headMetaTags(
  plan: ContentPlan,
  facts: BuildFacts,
  /**
   * share overrides the image a link preview uses. Every service page pointed at photo one, so
   * pasting a link to the decking page showed somebody a drain. It is the page's own hero now.
   */
  opts: {
    esc: (s: string) => string
    share?: { path: string; width: number; height: number } | null
    /**
     * What to put in front of a relative asset path. Empty for the home page, `../../` for a
     * service page, which is two directories down and was asking for its favicon at
     * /services/<name>/favicon.svg.
     */
    assetPrefix?: string
  },
): { icons: string; social: string } {
  const { esc } = opts
  const at = opts.assetPrefix ?? ''
  const icon = faviconHref(facts)

  /*
   * The generated mark always ships as favicon.svg, so `icon` here is an upgrade rather than the
   * only option. Declaring both is deliberate: the browser takes the first it can render, and the
   * SVG is the one that stays sharp on a high-density screen.
   */
  const iconLines = [
    icon ? `<link rel="icon" type="${icon.type}" href="${esc(at + icon.href)}">` : '',
    `<link rel="icon" type="image/svg+xml" href="${at}favicon.svg">`,
    icon && icon.type !== 'image/svg+xml'
      ? `<link rel="apple-touch-icon" href="${esc(at + icon.href)}">`
      : '',
    `<meta name="apple-mobile-web-app-title" content="${esc(plan.brand.businessName)}">`,
  ].filter(Boolean)

  const share = opts.share !== undefined ? opts.share : shareImageFor(facts)
  const socialLines = share
    ? [
        `<meta property="og:image" content="${esc(absolute(facts.canonicalUrl, share.path))}">`,
        `<meta property="og:image:width" content="${share.width}">`,
        `<meta property="og:image:height" content="${share.height}">`,
        `<meta property="og:image:alt" content="${esc(plan.brand.businessName)}">`,
        `<meta name="twitter:card" content="summary_large_image">`,
        `<meta name="twitter:image" content="${esc(absolute(facts.canonicalUrl, share.path))}">`,
      ]
    : [
        /*
         * No crawler-safe image anywhere on this build. `summary` is the honest card: a title,
         * a description and a link, with no promise of a picture. This is the branch that stops
         * the blank rectangle, so do not "simplify" it back to an unconditional
         * summary_large_image.
         */
        `<meta name="twitter:card" content="summary">`,
      ]

  return { icons: iconLines.join('\n'), social: socialLines.join('\n') }
}
