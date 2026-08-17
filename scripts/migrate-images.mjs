import { readFileSync, writeFileSync } from 'node:fs'

/**
 * One-off codemod: move the generated sites from single <img> tags pointing at whatever was
 * uploaded, to <picture> elements pointing at processed WebP with a JPEG fallback.
 *
 * Kept in the repo so the migration commit is legible.
 */

const changes = []

function edit(file, pairs) {
  let s = readFileSync(file, 'utf8')
  const before = s
  for (const [from, to] of pairs) {
    if (!s.includes(from)) {
      console.error(`  MISS ${file}\n    ${from.slice(0, 100).replace(/\n/g, ' | ')}`)
      continue
    }
    s = s.split(from).join(to)
  }
  if (s !== before) {
    writeFileSync(file, s)
    changes.push(file)
  }
}

// ---------------------------------------------------------------------------------------------
// offline.ts: the deterministic fixture site
// ---------------------------------------------------------------------------------------------

edit('server/lib/offline.ts', [
  [
    "const ICON_MENU =\n  '<line x1=\"3\" y1=\"6\" x2=\"21\" y2=\"6\"></line><line x1=\"3\" y1=\"12\" x2=\"21\" y2=\"12\"></line><line x1=\"3\" y1=\"18\" x2=\"21\" y2=\"18\"></line>'",
    `const ICON_MENU =
  '<line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="18" x2="21" y2="18"></line>'

/**
 * A responsive image. WebP first, JPEG fallback, both produced at upload.
 *
 * Every image on a generated site goes through here. A plain <img> pointing at an original phone
 * photo is the single biggest cost on these sites: whatever is referenced is downloaded by every
 * visitor on every visit, and Vercel bills the bandwidth. See DECISIONS.md D25.
 */
function picture(args: {
  webp: string
  jpeg: string
  alt: string
  width: number
  height: number
  className?: string
  eager?: boolean
  sizes?: string
}): string {
  const loading = args.eager ? 'eager" fetchpriority="high' : 'lazy" decoding="async'
  return \`<picture>
        <source type="image/webp" srcset="\${esc(args.webp)}"\${args.sizes ? \` sizes="\${esc(args.sizes)}"\` : ''}>
        <img src="\${esc(args.jpeg)}" alt="\${esc(args.alt)}" width="\${args.width}" height="\${args.height}" loading="\${loading}"\${args.className ? \` class="\${args.className}"\` : ''}>
      </picture>\``,
  ],
  [
    "  const heroPhoto = facts.photoPaths[0]?.path ?? null\n  const aboutPhoto = facts.photoPaths[1]?.path ?? null",
    '  const heroPhoto = facts.photos[0] ?? null\n  const aboutPhoto = facts.photos[1] ?? null',
  ],
  [
    "      heroPhoto\n        ? `<img src=\"${esc(heroPhoto)}\" alt=\"${esc(clean(plan.gallery.items[0]?.alt ?? `${plan.brand.businessName} at work in ${plan.meta.geoPlacename}`))}\" width=\"1600\" height=\"900\" fetchpriority=\"high\">`\n        : `<!-- CLIENT TO SUPPLY: a wide photo of the team or a finished job for the hero background. A gradient is used until then. -->`",
    "      heroPhoto\n        ? picture({\n            webp: heroPhoto.webWebp,\n            jpeg: heroPhoto.webJpeg,\n            alt: clean(plan.gallery.items[0]?.alt ?? `${plan.brand.businessName} at work in ${plan.meta.geoPlacename}`),\n            width: heroPhoto.width,\n            height: heroPhoto.height,\n            eager: true,\n            sizes: '100vw',\n          })\n        : `<!-- CLIENT TO SUPPLY: a wide photo of the team or a finished job for the hero background. A gradient is used until then. -->`",
  ],
  [
    "        aboutPhoto\n          ? `<img src=\"${esc(aboutPhoto)}\" alt=\"${esc(clean(plan.gallery.items[1]?.alt ?? `${plan.brand.businessName} on site`))}\" width=\"900\" height=\"700\" loading=\"lazy\">`\n          : `<!-- CLIENT TO SUPPLY: a photo of the owner or the team for the about section. A gradient panel is used until then. -->`",
    "        aboutPhoto\n          ? picture({\n              webp: aboutPhoto.webWebp,\n              jpeg: aboutPhoto.webJpeg,\n              alt: clean(plan.gallery.items[1]?.alt ?? `${plan.brand.businessName} on site`),\n              width: aboutPhoto.width,\n              height: aboutPhoto.height,\n              sizes: '(min-width: 768px) 50vw, 100vw',\n            })\n          : `<!-- CLIENT TO SUPPLY: a photo of the owner or the team for the about section. A gradient panel is used until then. -->`",
  ],
  [
    "        .map((item, i) => {\n          const path = facts.photoPaths.find((p) => p.assetId === item.assetId)?.path\n          if (!path) return ''\n          return `<figure class=\"gallery__item\"><img src=\"${esc(path)}\" alt=\"${esc(clean(item.alt))}\" width=\"800\" height=\"600\" loading=\"${i === 0 ? 'eager' : 'lazy'}\"></figure>`\n        })",
    "        .map((item, i) => {\n          const photo = facts.photos.find((p) => p.assetId === item.assetId)\n          if (!photo) return ''\n          // Thumbnails in the grid, not the full-width file. A gallery of 1920px images is how\n          // a page ends up at 6MB.\n          return `<figure class=\"gallery__item\">${picture({\n            webp: photo.thumbWebp,\n            jpeg: photo.thumbJpeg,\n            alt: clean(item.alt),\n            width: 800,\n            height: 600,\n            eager: i === 0,\n            sizes: '(min-width: 768px) 33vw, 50vw',\n          })}</figure>`\n        })",
  ],
  [
    "          plan.brand.logoTreatment !== 'css-logotype' && facts.logoPath\n            ? `<img class=\"site-footer__logo\" src=\"${esc(facts.logoPath)}\" alt=\"${esc(plan.brand.businessName)} logo\" width=\"240\" height=\"70\">`",
    "          plan.brand.logoTreatment !== 'css-logotype' && facts.logo\n            ? `<img class=\"site-footer__logo\" src=\"${esc(facts.logo.path)}\" alt=\"${esc(plan.brand.businessName)} logo\" width=\"240\" height=\"70\">`",
  ],
  [
    "  if (plan.brand.logoTreatment === 'image' && facts.logoPath) {\n    return `<a class=\"brand\" href=\"#top\"><img class=\"brand__logo\" src=\"${esc(facts.logoPath)}\" alt=\"${esc(plan.brand.businessName)} logo\" width=\"180\" height=\"46\"></a>`\n  }\n  if (plan.brand.logoTreatment === 'cropped-mark' && facts.logoPath) {\n    return `<a class=\"brand\" href=\"#top\"><img class=\"brand__logo\" src=\"${esc(facts.logoPath)}\" alt=\"${esc(plan.brand.businessName)} logo\" width=\"180\" height=\"46\"><span class=\"brand__name\">${name}</span></a>`\n  }",
    "  if (plan.brand.logoTreatment === 'image' && facts.logo) {\n    return `<a class=\"brand\" href=\"#top\"><img class=\"brand__logo\" src=\"${esc(facts.logo.path)}\" alt=\"${esc(plan.brand.businessName)} logo\" width=\"180\" height=\"46\"></a>`\n  }\n  if (plan.brand.logoTreatment === 'cropped-mark' && facts.logo) {\n    return `<a class=\"brand\" href=\"#top\"><img class=\"brand__logo\" src=\"${esc(facts.logo.path)}\" alt=\"${esc(plan.brand.businessName)} logo\" width=\"180\" height=\"46\"><span class=\"brand__name\">${name}</span></a>`\n  }",
  ],
  [
    '  if (facts.logoPath) business.image = `${url}${facts.logoPath}`',
    '  if (facts.logo) business.image = `${url}${facts.logo.path}`',
  ],
])

// ---------------------------------------------------------------------------------------------
// generate.ts: the photo inventory handed to the planning call
// ---------------------------------------------------------------------------------------------

edit('server/lib/generate.ts', [
  [
    "  const photoInventory = facts.photoPaths.map((p, i) => ({\n    assetId: p.assetId,\n    path: p.path,\n    note: describePhoto(usablePhotos[i]),\n  }))",
    "  const photoInventory = facts.photos.map((p, i) => ({\n    assetId: p.assetId,\n    path: p.webWebp,\n    note: describePhoto(usablePhotos[i]),\n  }))",
  ],
  [
    '  const validAssetIds = new Set(facts.photoPaths.map((p) => p.assetId))',
    '  const validAssetIds = new Set(facts.photos.map((p) => p.assetId))',
  ],
  ['  if (!facts.logoPath) out.brand.logoTreatment = \'css-logotype\'', "  if (!facts.logo) out.brand.logoTreatment = 'css-logotype'"],
])

// ---------------------------------------------------------------------------------------------
// offline plan: logo treatment decision
// ---------------------------------------------------------------------------------------------

edit('server/lib/offline.ts', [
  [
    "  const logoTreatment: ContentPlan['brand']['logoTreatment'] = !facts.logoPath",
    "  const logoTreatment: ContentPlan['brand']['logoTreatment'] = !facts.logo",
  ],
])

console.log(`${changes.length} file(s) rewritten: ${[...new Set(changes)].join(', ')}`)
