import { handle } from 'hono/vercel'
import api from '../server/index'

/**
 * The Vercel entry point.
 *
 * Every /api/* request lands here (see the rewrite in vercel.json) and is handled by the same
 * Hono app that runs locally behind @hono/node-server. One app, two adapters, no divergence.
 *
 * Node runtime, not Edge: generation is long running and needs the timeout headroom, sharp needs
 * native bindings, and Playwright needs a filesystem.
 */
export const config = { runtime: 'nodejs' }

export default handle(api)
