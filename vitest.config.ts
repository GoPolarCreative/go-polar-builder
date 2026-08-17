import { defineConfig } from 'vitest/config'

/**
 * Tests run in Node, the same runtime the API runs in on Vercel.
 *
 * Under Cloudflare these ran inside workerd because the verification checks used HTMLRewriter.
 * They now use a normal HTML parser, so there is nothing runtime-specific left to work around
 * and the tests run wherever Node does, including CI.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // sharp and PGlite are slow to start the first time.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
})
