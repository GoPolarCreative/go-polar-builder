import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Brief s14: "Anthropic key in Worker secrets only. If it appears in any client bundle, that is
 * a build failure."
 *
 * This walks the built client output and fails the build if any secret-shaped string made it in.
 * Run after `npm run build`:  node scripts/check-bundle.mjs
 */

const DIST = 'dist'

const FORBIDDEN = [
  { name: 'Anthropic API key', pattern: /sk-ant-[A-Za-z0-9_-]{8,}/ },
  { name: 'Shopify admin token', pattern: /shpat_[A-Za-z0-9]{8,}/ },
  { name: 'Shopify webhook secret var', pattern: /SHOPIFY_WEBHOOK_SECRET\s*[:=]\s*["'][^"']+["']/ },
  { name: 'Resend API key', pattern: /re_[A-Za-z0-9]{16,}/ },
  { name: 'Anthropic API host', pattern: /api\.anthropic\.com/ },
  { name: 'x-api-key header', pattern: /x-api-key/i },
]

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

let files
try {
  files = walk(DIST)
} catch {
  console.error(`${DIST} not found. Run "npm run build" first.`)
  process.exit(1)
}

const failures = []
for (const file of files) {
  if (!/\.(js|mjs|css|html|json|map)$/.test(file)) continue
  const text = readFileSync(file, 'utf8')
  for (const rule of FORBIDDEN) {
    const match = text.match(rule.pattern)
    if (match) failures.push(`${file}: ${rule.name} (${match[0].slice(0, 24)})`)
  }
}

if (failures.length > 0) {
  console.error('BUILD FAILURE: secrets or server-only code found in the client bundle:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}

console.log(`Client bundle clean. Scanned ${files.length} file(s) in ${DIST}.`)
