import { rmSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

/**
 * Wipe the local D1 and R2 state and re-apply the schema.
 * Local only: it deletes the miniflare state directory, nothing remote.
 */

const STATE = '.wrangler/state'

if (existsSync(STATE)) {
  rmSync(STATE, { recursive: true, force: true })
  console.log(`Removed ${STATE}`)
} else {
  console.log(`${STATE} does not exist, nothing to remove`)
}

console.log('Applying schema...')
execSync('npx wrangler d1 execute go-polar-builder --local --file=./db/schema.sql --yes', {
  stdio: 'inherit',
})
console.log('Local database reset.')
