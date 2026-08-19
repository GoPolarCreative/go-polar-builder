import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

/**
 * Postgres schema. Mirrors section 10 of the build brief.
 *
 * Migrated from the original SQLite/D1 schema with real types rather than text everywhere:
 * timestamps are timestamptz, money is integer cents, flags are boolean, JSON payloads are jsonb
 * so they can be queried, and the status columns are Postgres enums so an invalid state cannot
 * be written at all.
 *
 * Money is ALWAYS whole cents, ex GST, matching how Shopify is configured (prices entered
 * exclusive of tax, GST added at checkout).
 */

export const jobStatus = pgEnum('job_status', [
  'paid',
  'intake',
  'generating',
  'preview',
  'editing',
  'go_live_pending',
  'live',
  'discharged',
  'abandoned',
])

export const orderKind = pgEnum('order_kind', ['build', 'hosting', 'domain', 'email', 'edit', 'discharge'])
export const assetKind = pgEnum('asset_kind', ['logo', 'photo'])
export const domainBranch = pgEnum('domain_branch', ['own', 'new', 'locked'])
export const goliveStatus = pgEnum('golive_status', ['selecting', 'awaiting_payment', 'paid', 'queued', 'live'])
export const dischargeStatus = pgEnum('discharge_status', [
  'requested',
  'awaiting_payment',
  'paid',
  'prepared',
  'released',
  'expired',
])

// ---------------------------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    phone: text('phone'),
    name: text('name'),
    shopifyCustomerId: text('shopify_customer_id'),
    ghlContactId: text('ghl_contact_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Users are matched on email by the Shopify webhook, so this has to be unique and always
    // stored lower-cased and trimmed.
    uniqueIndex('users_email_idx').on(t.email),
    index('users_shopify_customer_idx').on(t.shopifyCustomerId),
  ],
)

/** One job = one website = one $220 inc GST build token. */
export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    status: jobStatus('status').notNull().default('paid'),
    trade: text('trade'),
    businessName: text('business_name'),
    editsUsed: integer('edits_used').notNull().default(0),
    editsAllowed: integer('edits_allowed').notNull().default(10),
    currentVersion: integer('current_version').notNull().default(0),
    // Set when verification fails twice and Chris has to look at it (brief s6).
    held: boolean('held').notNull().default(false),
    heldReason: text('held_reason'),
    /**
     * The customer's own Web3Forms access key, collected in the go-live flow. Only ever written
     * after a real test submission through Web3Forms came back successful, so a value here means
     * the key is known to work, not merely known to be a UUID. See DECISIONS.md D29.
     */
    customerWeb3formsKey: text('customer_web3forms_key'),
    web3formsVerifiedAt: timestamp('web3forms_verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('jobs_user_idx').on(t.userId), index('jobs_status_idx').on(t.status)],
)

/** Build links emailed after payment. Only the hash is stored. */
export const tokens = pgTable(
  'tokens',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    firstUsedAt: timestamp('first_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('tokens_hash_idx').on(t.tokenHash), index('tokens_job_idx').on(t.jobId)],
)

/** Every Shopify order line that matters to a job. */
export const orders = pgTable(
  'orders',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').references(() => jobs.id),
    shopifyOrderId: text('shopify_order_id').notNull(),
    shopifyCustomerId: text('shopify_customer_id'),
    productHandle: text('product_handle').notNull(),
    amountExGst: integer('amount_ex_gst').notNull(),
    kind: orderKind('kind').notNull(),
    status: text('status').notNull().default('paid'),
    raw: jsonb('raw'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotency. Replaying an order does nothing twice, which matters because Shopify retries
    // and because the hourly sweep deliberately re-examines recent orders.
    uniqueIndex('orders_line_idx').on(t.shopifyOrderId, t.productHandle),
    index('orders_job_idx').on(t.jobId),
  ],
)

export const intake = pgTable('intake', {
  jobId: text('job_id')
    .primaryKey()
    .references(() => jobs.id),
  payload: jsonb('payload').notNull(),
  auditFlags: jsonb('audit_flags'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Logo and photos.
 *
 * `originalKey` is the untouched upload, kept for rebuilds. `variants` holds the processed
 * derivatives that actually ship: a web-sized and a thumbnail, each as WebP and JPEG. Every
 * variant records its byte size, because those bytes are what a visitor downloads on every
 * visit to every generated site, forever, and Vercel charges for them. See DECISIONS.md D25.
 */
export const assets = pgTable(
  'assets',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id),
    kind: assetKind('kind').notNull(),
    filename: text('filename'),
    contentType: text('content_type'),
    originalKey: text('original_key').notNull(),
    originalBytes: integer('original_bytes'),
    width: integer('width'),
    height: integer('height'),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Client-computed image signals used by the gap audit. */
    stats: jsonb('stats'),
    /** Array of { role, format, key, bytes, width, height }. */
    variants: jsonb('variants'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('assets_job_idx').on(t.jobId, t.kind, t.sortOrder)],
)

/** Output of generation call 1. The editable source of truth. */
export const plans = pgTable(
  'plans',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id),
    version: integer('version').notNull(),
    plan: jsonb('plan').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('plans_job_version_idx').on(t.jobId, t.version)],
)

/** Output of generation call 2 plus its verification result. */
export const builds = pgTable(
  'builds',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id),
    version: integer('version').notNull(),
    blobKey: text('blob_key').notNull(),
    bytes: integer('bytes'),
    /** HTML plus every referenced asset. Verification check 17 lives on this number. */
    pageWeightBytes: integer('page_weight_bytes'),
    checks: jsonb('checks'),
    passed: boolean('passed').notNull().default(false),
    repairPasses: integer('repair_passes').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('builds_job_version_idx').on(t.jobId, t.version)],
)

/**
 * One row per submitted change request. One edit = one submitted request however many changes it
 * contains. Rollbacks are recorded with prompt null and counted false.
 */
export const edits = pgTable(
  'edits',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id),
    versionFrom: integer('version_from').notNull(),
    versionTo: integer('version_to').notNull(),
    prompt: text('prompt'),
    diffSummary: text('diff_summary'),
    counted: boolean('counted').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('edits_job_idx').on(t.jobId, t.createdAt)],
)

export const domains = pgTable(
  'domains',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id),
    name: text('name').notNull(),
    branch: domainBranch('branch').notNull(),
    whois: jsonb('whois'),
    mx: jsonb('mx'),
    status: text('status').notNull().default('queued'),
    /** Set once the domain is attached to the Vercel project. */
    vercelDomainId: text('vercel_domain_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('domains_job_idx').on(t.jobId)],
)

export const golive = pgTable('golive', {
  jobId: text('job_id')
    .primaryKey()
    .references(() => jobs.id),
  hosting: boolean('hosting').notNull().default(true),
  emailAddon: boolean('email_addon').notNull().default(false),
  domainAddon: boolean('domain_addon').notNull().default(false),
  checkoutUrl: text('checkout_url'),
  checkoutCreatedAt: timestamp('checkout_created_at', { withTimezone: true }),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  status: goliveStatus('status').notNull().default('selecting'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const discharges = pgTable(
  'discharges',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id),
    status: dischargeStatus('status').notNull().default('requested'),
    customerWeb3formsKey: text('customer_web3forms_key'),
    version: integer('version'),
    blobKey: text('blob_key'),
    fileCount: integer('file_count'),
    bytes: integer('bytes'),
    usedPlaceholder: boolean('used_placeholder'),
    checkoutUrl: text('checkout_url'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    preparedAt: timestamp('prepared_at', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('discharges_job_idx').on(t.jobId, t.createdAt)],
)

/**
 * A live client website served by this app. Brief s2: hosting is $30/month.
 * The generated site is stored in Blob and served by hostname. See DECISIONS.md D24.
 */
export const sites = pgTable(
  'sites',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id),
    hostname: text('hostname').notNull(),
    version: integer('version').notNull(),
    live: boolean('live').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('sites_hostname_idx').on(t.hostname), index('sites_job_idx').on(t.jobId)],
)

/** Append-only audit trail, and the GHL webhook feed. */
export const events = pgTable(
  'events',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').references(() => jobs.id),
    type: text('type').notNull(),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('events_job_idx').on(t.jobId, t.createdAt), index('events_type_idx').on(t.type, t.createdAt)],
)
