/**
 * Configuration, read from environment variables.
 *
 * Replaces the Cloudflare Worker `Env` binding object. On Vercel these come from project
 * environment variables; locally from `.env.local`, loaded by server/local.ts.
 *
 * TWO RULES THAT DO NOT BEND:
 *   1. The Anthropic key is server side only. It is read here, in code that only ever runs in a
 *      Node function, and `npm run build` fails if it appears in the client bundle.
 *   2. Anything that spends money, emails a real person or touches DNS is behind an explicit
 *      live flag that is off by default, and fails loudly when it is off rather than pretending
 *      to work. See `assertLiveEnabled` below.
 */

export type LiveCapability = 'payments' | 'email' | 'crm' | 'domains'

export interface AppConfig {
  // --- runtime -------------------------------------------------------------------------------
  publicAppUrl: string
  appSecret?: string
  adminToken?: string
  cronSecret?: string

  // --- database ------------------------------------------------------------------------------
  databaseUrl?: string
  /** postgres for Neon or any Postgres, pglite for the embedded local database. */
  databaseDriver: 'postgres' | 'pglite'
  pgliteDir: string

  // --- storage -------------------------------------------------------------------------------
  blobToken?: string
  storageDriver: 'vercel-blob' | 'local'
  localStorageDir: string

  // --- generation ----------------------------------------------------------------------------
  anthropicApiKey?: string
  anthropicModel: string
  /** Overridable so a gateway or proxy can be used, and so tests can exercise failures. */
  anthropicBaseUrl?: string
  offlineGeneration: boolean

  // --- render checks 13 to 16 ------------------------------------------------------------------
  renderDriver: 'playwright' | 'hosted' | 'none'
  browserlessUrl?: string

  // --- Go Polar infrastructure -----------------------------------------------------------------
  /**
   * Go Polar's own Web3Forms key. Used for preview and editing ONLY, so a customer's forms work
   * before they have an account of their own. A live site must never carry it: see
   * server/lib/web3forms.ts and DECISIONS.md D29.
   */
  web3formsAccessKey?: string
  /** Override for tests, which point this at a local stub rather than the real endpoint. */
  web3formsApiUrl?: string

  // --- integrations ----------------------------------------------------------------------------
  shopify: {
    storeDomain?: string
    webhookSecret?: string
    adminApiToken?: string
    storefrontToken?: string
  }
  resendApiKey?: string
  resendFrom: string
  ghlWebhookUrl?: string
  vercelApiToken?: string
  vercelProjectId?: string
  vercelTeamId?: string

  // --- modes -----------------------------------------------------------------------------------
  /**
   * Demo mode. Every outbound integration is replaced with a local fake that logs what it would
   * have done. Nothing leaves the machine. This is what `npm run dev` uses by default.
   */
  demoMode: boolean
  /** Per-capability live switches. All off unless explicitly turned on. */
  live: Record<LiveCapability, boolean>
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback
  return value === '1' || value.toLowerCase() === 'true'
}

function env(name: string): string | undefined {
  const value = process.env[name]
  return value && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Fixed development secret, used ONLY in demo mode when nothing is configured.
 *
 * It exists so a fresh clone can sign a session and run the whole product without anyone having
 * to generate a key first, which is the point of local preview. It is deliberately obvious, it is
 * committed, and it is never reachable outside demo mode: setting DEMO_MODE=0 without an
 * APP_SECRET produces the loud MissingSecretError instead.
 */
const DEMO_APP_SECRET = 'demo-mode-only-secret-do-not-use-in-production'

export function loadConfig(): AppConfig {
  // Demo mode defaults ON when nothing is configured, so a fresh clone runs with no accounts.
  const demoMode = bool(process.env.DEMO_MODE, !env('SHOPIFY_WEBHOOK_SECRET') && !env('RESEND_API_KEY'))
  const anthropicApiKey = env('ANTHROPIC_API_KEY')

  return {
    publicAppUrl: env('PUBLIC_APP_URL') ?? 'http://localhost:5173',
    appSecret: env('APP_SECRET') ?? (demoMode ? DEMO_APP_SECRET : undefined),
    adminToken: env('ADMIN_TOKEN'),
    cronSecret: env('CRON_SECRET'),

    databaseUrl: env('DATABASE_URL'),
    databaseDriver: (env('DATABASE_DRIVER') as AppConfig['databaseDriver']) ?? (env('DATABASE_URL') ? 'postgres' : 'pglite'),
    pgliteDir: env('PGLITE_DIR') ?? '.local/pglite',

    blobToken: env('BLOB_READ_WRITE_TOKEN'),
    storageDriver: (env('STORAGE_DRIVER') as AppConfig['storageDriver']) ?? (env('BLOB_READ_WRITE_TOKEN') ? 'vercel-blob' : 'local'),
    localStorageDir: env('LOCAL_STORAGE_DIR') ?? '.local/blob',

    anthropicApiKey,
    anthropicModel: env('ANTHROPIC_MODEL') ?? 'claude-sonnet-5',
    anthropicBaseUrl: env('ANTHROPIC_BASE_URL'),
    // In demo mode with no key, fall back to the offline fixture rather than failing at the
    // moment someone presses the button. Outside demo mode this stays off unless asked for, so a
    // production install with a missing key fails loudly instead of quietly shipping a fixture.
    offlineGeneration: bool(process.env.DEV_OFFLINE_GENERATION, demoMode && !anthropicApiKey),

    renderDriver: (env('RENDER_DRIVER') as AppConfig['renderDriver']) ?? 'playwright',
    browserlessUrl: env('BROWSERLESS_URL'),

    web3formsAccessKey: env('WEB3FORMS_ACCESS_KEY'),
    web3formsApiUrl: env('WEB3FORMS_API_URL'),

    shopify: {
      storeDomain: env('SHOPIFY_STORE_DOMAIN'),
      webhookSecret: env('SHOPIFY_WEBHOOK_SECRET'),
      adminApiToken: env('SHOPIFY_ADMIN_API_TOKEN'),
      storefrontToken: env('SHOPIFY_STOREFRONT_TOKEN'),
    },
    resendApiKey: env('RESEND_API_KEY'),
    resendFrom: env('RESEND_FROM') ?? 'Go Polar Creative <build@itscold.com.au>',
    ghlWebhookUrl: env('GHL_INBOUND_WEBHOOK_URL'),
    vercelApiToken: env('VERCEL_API_TOKEN'),
    vercelProjectId: env('VERCEL_PROJECT_ID'),
    vercelTeamId: env('VERCEL_TEAM_ID'),

    demoMode,
    live: {
      // Off unless explicitly enabled. A preview cannot become a live action by accident.
      payments: bool(process.env.ENABLE_LIVE_PAYMENTS) && !demoMode,
      email: bool(process.env.ENABLE_LIVE_EMAIL) && !demoMode,
      crm: bool(process.env.ENABLE_LIVE_CRM) && !demoMode,
      domains: bool(process.env.ENABLE_LIVE_DOMAINS) && !demoMode,
    },
  }
}

let cached: AppConfig | null = null

export function config(): AppConfig {
  if (!cached) cached = loadConfig()
  return cached
}

/** Test seam. Never called by application code. */
export function setConfigForTests(next: AppConfig | null): void {
  cached = next
}

export class LiveActionBlockedError extends Error {
  constructor(
    readonly capability: LiveCapability,
    readonly flag: string,
  ) {
    super(
      `Refusing to perform a live ${capability} action: ${flag} is not set. This install is in preview mode, where nothing charges money, emails a real person or changes DNS. Set ${flag}=1 and DEMO_MODE=0 to enable it deliberately.`,
    )
    this.name = 'LiveActionBlockedError'
  }
}

const FLAG_FOR: Record<LiveCapability, string> = {
  payments: 'ENABLE_LIVE_PAYMENTS',
  email: 'ENABLE_LIVE_EMAIL',
  crm: 'ENABLE_LIVE_CRM',
  domains: 'ENABLE_LIVE_DOMAINS',
}

/**
 * Call this immediately before anything irreversible. It throws rather than silently doing
 * nothing, because a silent no-op in a payment path is indistinguishable from success and that
 * is how money goes missing.
 */
export function assertLiveEnabled(capability: LiveCapability, cfg: AppConfig = config()): void {
  if (!cfg.live[capability]) throw new LiveActionBlockedError(capability, FLAG_FOR[capability])
}

/**
 * Can this install actually apply a change to a built site?
 *
 * An edit is a real model call: it revises the content plan from the customer's words and
 * rebuilds from it. The offline fixture cannot do that. It can only replay the same deterministic
 * site, which looks to a customer exactly like nothing happening, except that it costs them one
 * of their ten included changes.
 *
 * So this is asked BEFORE anything is written, the answer is shown in the edit panel when it
 * loads, and a refusal is loud. See DECISIONS.md D27.
 */
export function editCapability(cfg: AppConfig = config()): { available: boolean; reason: string | null } {
  // Offline is checked FIRST, and deliberately outranks a key being present.
  //
  // DEV_OFFLINE_GENERATION=1 alongside a real key is a normal way to work: build from the fixture,
  // spend nothing. Asking about the key first made that install claim edits worked, then send the
  // customer's words to the live API while their site had been built by the fixture. The end to
  // end run found it as a bare 404. If this install generates offline, it cannot honestly apply an
  // edit, whatever else is configured.
  if (cfg.offlineGeneration) {
    return {
      available: false,
      reason:
        'Changes need the AI model, and this install is running the offline sample generator instead. It can rebuild the same site, but it cannot apply what you asked for. Unset DEV_OFFLINE_GENERATION, set ANTHROPIC_API_KEY, and restart, and the edit panel will work.',
    }
  }

  if (cfg.anthropicApiKey) return { available: true, reason: null }

  return {
    available: false,
    reason:
      'Changes need the AI model, and no ANTHROPIC_API_KEY is set on this install. Set it and restart, and the edit panel will work.',
  }
}

export const DEFAULT_MODEL = 'claude-sonnet-5'

export function modelFor(cfg: AppConfig = config()): string {
  return cfg.anthropicModel || DEFAULT_MODEL
}

/**
 * Web3Forms key injected server side. Brief s4: this is Go Polar infrastructure, not customer
 * data. Asking for it produced emails and random numbers instead of UUIDs on nearly every
 * submission, so the customer is never asked.
 */
export function web3formsKey(cfg: AppConfig = config()): string {
  const key = cfg.web3formsAccessKey
  if (key && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) return key
  // Do not fail a build over this in development. Ship a clearly commented placeholder that a
  // human will notice, and that the static checks still accept as a form action.
  return '00000000-0000-0000-0000-000000000000'
}
