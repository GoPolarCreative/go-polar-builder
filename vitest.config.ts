import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

/**
 * Tests run inside workerd, not Node.
 *
 * The verification checks use HTMLRewriter, and there is no honest way to test them outside the
 * runtime they run in: a jsdom stand-in would be testing the stand-in. The pool is configured
 * directly rather than from wrangler.jsonc so unit tests do not drag in the assets binding or a
 * D1 database they never touch.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2025-08-01',
        compatibilityFlags: ['nodejs_compat'],
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
})
