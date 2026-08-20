import api from '../server/index.js'

/**
 * The Vercel entry point.
 *
 * Every request lands here (see the rewrites in vercel.json) and is handled by the same Hono app
 * that runs locally behind @hono/node-server. One app, two adapters, no divergence.
 *
 * WHY NOT `export default handle(api)`. That is what the hono/vercel adapter gives you, and it is
 * what this file used to do. Vercel now treats a bare default export as the old Node signature,
 * `(req, res) => void`, so it handed our handler an IncomingMessage where Hono expected a Web
 * Request. Every request died on `this.raw.headers.get is not a function`, and the return value
 * was discarded, so the platform's own warning was the only clue:
 *
 *   "default export returned a Response. The default-export signature is (req, res) => void —
 *    returns are ignored. You likely meant the Web fetch-style API."
 *
 * Exporting named HTTP methods opts into the Web-standard signature, where the argument really is
 * a Request and returning a Response is correct. `api.fetch` is the same function the local server
 * and every test already call, so there is exactly one code path being exercised everywhere.
 *
 * Node runtime, not Edge: generation is long running and needs the timeout headroom, sharp needs
 * native bindings, and Playwright needs a filesystem.
 */
export const config = { runtime: 'nodejs' }

type FetchHandler = (request: Request) => Response | Promise<Response>

const handler: FetchHandler = (request) => api.fetch(request)

export const GET = handler
export const POST = handler
export const PUT = handler
export const PATCH = handler
export const DELETE = handler
export const HEAD = handler
export const OPTIONS = handler
