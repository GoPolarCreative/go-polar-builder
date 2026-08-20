/**
 * Add explicit .js extensions to relative imports in the server-side source.
 *
 *   node scripts/add-import-extensions.mjs [--check]
 *
 * WHY. package.json says "type": "module", and Vercel compiles api/index.ts and everything it
 * imports file by file rather than bundling them. Under real ESM, Node will not resolve an
 * extensionless relative import, so the deployed function died on its very first line with
 *
 *   ERR_MODULE_NOT_FOUND: Cannot find module '/var/task/server/index'
 *
 * Locally this never showed up, because tsconfig uses "moduleResolution": "bundler", where
 * extensionless imports are legal. So `tsc -b` passed, every test passed, and the only place it
 * could fail was production.
 *
 * The fix is the standard ESM one: write the extension the runtime will actually look for. TypeScript
 * resolves './foo.js' to './foo.ts' under both bundler and nodenext resolution, and Vite and vitest
 * do the same, so the source keeps working everywhere it already worked.
 *
 * This resolves each specifier against the filesystem rather than appending blindly, so a directory
 * import becomes '/index.js' and anything it cannot resolve is reported instead of guessed at.
 *
 * --check exits non-zero if anything would change, for use in CI.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

const ROOTS = ['api', 'server', 'shared', 'db']
const CHECK_ONLY = process.argv.includes('--check')

/** Every .ts file under the roots, excluding declaration files. */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full)
  }
  return out
}

/**
 * What the runtime will need to see for this specifier.
 *
 * Returns null when it is already explicit, or when nothing on disk matches — the second case is
 * reported rather than rewritten, because a guess here becomes a crash in production.
 */
function resolveSpecifier(fromFile, spec) {
  if (/\.(js|mjs|cjs|json|css|svg|png|jpg|webp)$/.test(spec)) return null

  const base = resolve(dirname(fromFile), spec)

  if (existsSync(`${base}.ts`) || existsSync(`${base}.tsx`)) return `${spec}.js`
  if (existsSync(join(base, 'index.ts')) || existsSync(join(base, 'index.tsx'))) {
    return `${spec.replace(/\/$/, '')}/index.js`
  }
  return { unresolved: true }
}

const files = ROOTS.filter(existsSync).flatMap(walk)

let changedFiles = 0
let changedImports = 0
const unresolved = []

// from '...', import('...'), export ... from '...'. Only relative specifiers.
const PATTERN = /(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.\.?\/[^'"]*)\2/g

for (const file of files) {
  const source = readFileSync(file, 'utf8')
  let touched = 0

  const next = source.replace(PATTERN, (whole, lead, quote, spec) => {
    const result = resolveSpecifier(file, spec)
    if (result === null) return whole
    if (typeof result === 'object') {
      unresolved.push(`${file}: ${spec}`)
      return whole
    }
    touched++
    return `${lead}${quote}${result}${quote}`
  })

  if (touched > 0) {
    changedFiles++
    changedImports += touched
    if (!CHECK_ONLY) writeFileSync(file, next)
  }
}

if (unresolved.length > 0) {
  console.error(`Could not resolve ${unresolved.length} import(s). Left untouched:`)
  for (const entry of unresolved) console.error(`  ${entry}`)
}

console.log(
  CHECK_ONLY
    ? `${changedImports} import(s) in ${changedFiles} file(s) are missing an extension.`
    : `Rewrote ${changedImports} import(s) across ${changedFiles} file(s).`,
)

if (CHECK_ONLY && changedImports > 0) process.exit(1)
if (unresolved.length > 0) process.exit(1)
