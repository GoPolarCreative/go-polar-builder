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
    /*
     * sharp and PGlite are slow to start, and several suites start their own PGlite.
     *
     * Run those serially. Concurrently they each spend their setup fighting the others for the
     * same cores, blow the hook timeout, and fail as a group with 'Hook timed out' — which reads
     * like a broken test rather than a busy machine, and is different every run. One at a time is
     * a few seconds slower and always tells the truth.
     */
    testTimeout: 30_000,
    hookTimeout: 90_000,
    poolOptions: { forks: { singleFork: true } },
  },
})
