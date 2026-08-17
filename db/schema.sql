-- Go Polar Website Builder - D1 schema
-- Mirrors section 10 of the build brief. Applied with:
--   npm run db:migrate:local
--   npm run db:migrate:remote
--
-- Conventions:
--   ids are text (uuid or prefixed uuid), created_at/updated_at are ISO 8601 UTC strings
--   money is stored in whole cents, ex GST, to avoid float drift

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL,
  phone               TEXT,
  name                TEXT,
  shopify_customer_id TEXT,
  ghl_contact_id      TEXT,
  created_at          TEXT NOT NULL
);
-- Users are matched on email by the Shopify webhook, so this has to be unique
-- and always stored lower-cased and trimmed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_shopify_customer ON users(shopify_customer_id);

-- ---------------------------------------------------------------------------
-- jobs
-- One job = one website = one $200 build token.
-- status: paid -> intake -> generating -> preview -> editing -> go_live_pending
--         -> live -> discharged | abandoned
-- held: set when verification fails twice and Chris has to look at it (brief s6).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id),
  status              TEXT NOT NULL DEFAULT 'paid',
  trade               TEXT,
  business_name       TEXT,
  edits_used          INTEGER NOT NULL DEFAULT 0,
  edits_allowed       INTEGER NOT NULL DEFAULT 10,
  current_version     INTEGER NOT NULL DEFAULT 0,
  held                INTEGER NOT NULL DEFAULT 0,
  held_reason         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK (status IN ('paid','intake','generating','preview','editing',
                    'go_live_pending','live','discharged','abandoned'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

-- ---------------------------------------------------------------------------
-- tokens - build links emailed after payment (Phase 6)
-- Only the hash is stored. The raw token exists in the customer's email only.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tokens (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES jobs(id),
  token_hash    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  first_used_at TEXT,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_hash ON tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_tokens_job ON tokens(job_id);

-- ---------------------------------------------------------------------------
-- orders - every Shopify order line that matters to a job
-- kind: build | hosting | domain | email | edit | discharge
-- amount_ex_gst is cents, ex GST, matching how Shopify is configured
-- (prices entered exclusive of tax, GST added at checkout).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id                TEXT PRIMARY KEY,
  job_id            TEXT REFERENCES jobs(id),
  shopify_order_id  TEXT NOT NULL,
  shopify_customer_id TEXT,
  product_handle    TEXT NOT NULL,
  amount_ex_gst     INTEGER NOT NULL,
  kind              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'paid',
  raw_json          TEXT,
  created_at        TEXT NOT NULL,
  CHECK (kind IN ('build','hosting','domain','email','edit','discharge'))
);
-- Reconciliation (brief s3a) polls Shopify for paid orders with no matching row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_shopify_line
  ON orders(shopify_order_id, product_handle);
CREATE INDEX IF NOT EXISTS idx_orders_job ON orders(job_id);

-- ---------------------------------------------------------------------------
-- intake - one row per job, the submitted wizard payload plus the gap audit
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intake (
  job_id           TEXT PRIMARY KEY REFERENCES jobs(id),
  payload_json     TEXT NOT NULL,
  audit_flags_json TEXT,
  submitted_at     TEXT,
  updated_at       TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- assets - logo and photos in R2
-- sort_order drives gallery order (drag to reorder in the wizard).
-- "order" is avoided as a column name because it is a SQL keyword.
-- stats_json holds the client-computed image signals the gap audit uses
-- (dominant colours, flat-colour ratio, transparency, photographic score).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assets (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs(id),
  r2_key      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  filename    TEXT,
  content_type TEXT,
  bytes       INTEGER,
  width       INTEGER,
  height      INTEGER,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  stats_json  TEXT,
  created_at  TEXT NOT NULL,
  CHECK (kind IN ('logo','photo'))
);
CREATE INDEX IF NOT EXISTS idx_assets_job ON assets(job_id, kind, sort_order);

-- ---------------------------------------------------------------------------
-- plans - output of generation call 1. The editable source of truth.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plans (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL REFERENCES jobs(id),
  version    INTEGER NOT NULL,
  plan_json  TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_job_version ON plans(job_id, version);

-- ---------------------------------------------------------------------------
-- builds - output of generation call 2 plus its verification result
-- r2_key points at the stored index.html. checks_json is the full check report.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS builds (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES jobs(id),
  version       INTEGER NOT NULL,
  r2_key        TEXT NOT NULL,
  bytes         INTEGER,
  checks_json   TEXT,
  passed        INTEGER NOT NULL DEFAULT 0,
  repair_passes INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_builds_job_version ON builds(job_id, version);

-- ---------------------------------------------------------------------------
-- edits - one row per submitted change request (Phase 4)
-- One edit = one submitted request however many changes it contains.
-- Rollbacks are recorded here with prompt = null and do not count against the 10.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS edits (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES jobs(id),
  version_from  INTEGER NOT NULL,
  version_to    INTEGER NOT NULL,
  prompt        TEXT,
  diff_summary  TEXT,
  counted       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edits_job ON edits(job_id, created_at);

-- ---------------------------------------------------------------------------
-- domains - Phase 5. branch: own | new | locked
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS domains (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL REFERENCES jobs(id),
  name       TEXT NOT NULL,
  branch     TEXT NOT NULL,
  whois_json TEXT,
  mx_json    TEXT,
  status     TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL,
  CHECK (branch IN ('own','new','locked'))
);
CREATE INDEX IF NOT EXISTS idx_domains_job ON domains(job_id);

-- ---------------------------------------------------------------------------
-- golive - Phase 5 screen 1. What they chose, and whether it has been paid.
-- The job does not advance until the orders/paid webhook confirms (brief s3a).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS golive (
  job_id            TEXT PRIMARY KEY REFERENCES jobs(id),
  hosting           INTEGER NOT NULL DEFAULT 1,
  email_addon       INTEGER NOT NULL DEFAULT 0,
  domain_addon      INTEGER NOT NULL DEFAULT 0,
  checkout_url      TEXT,
  checkout_created_at TEXT,
  paid_at           TEXT,
  status            TEXT NOT NULL DEFAULT 'selecting',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK (status IN ('selecting','awaiting_payment','paid','queued','live'))
);

-- ---------------------------------------------------------------------------
-- discharges - Phase 5, brief s9. One row per discharge request.
-- The automation prepares the package, a human releases it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS discharges (
  id                    TEXT PRIMARY KEY,
  job_id                TEXT NOT NULL REFERENCES jobs(id),
  status                TEXT NOT NULL DEFAULT 'requested',
  customer_web3forms_key TEXT,
  version               INTEGER,
  r2_key                TEXT,
  file_count            INTEGER,
  bytes                 INTEGER,
  used_placeholder      INTEGER,
  checkout_url          TEXT,
  paid_at               TEXT,
  prepared_at           TEXT,
  released_at           TEXT,
  expires_at            TEXT,
  created_at            TEXT NOT NULL,
  CHECK (status IN ('requested','awaiting_payment','paid','prepared','released','expired'))
);
CREATE INDEX IF NOT EXISTS idx_discharges_job ON discharges(job_id, created_at);

-- ---------------------------------------------------------------------------
-- events - append-only audit trail, also the GHL webhook feed
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  job_id       TEXT REFERENCES jobs(id),
  type         TEXT NOT NULL,
  payload_json TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, created_at);
