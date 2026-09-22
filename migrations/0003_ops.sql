-- =============================================================================
-- Steve Gate — migration 0003: operations (webhooks, notifications, tickets,
-- telemetry, rate limiting, rollups)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- webhook_endpoints — where a merchant wants to be told about payments.
-- The signing secret is sealed with AES-GCM using WEBHOOK_SECRET before it is
-- stored; the plaintext is shown once at creation and can be re-derived by the
-- merchant from the dashboard whenever they need to verify a signature.
-- -----------------------------------------------------------------------------
CREATE TABLE webhook_endpoints (
  id               TEXT PRIMARY KEY,
  merchant_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url              TEXT NOT NULL,
  secret_sealed    TEXT NOT NULL,                  -- AES-GCM(base64 iv || ciphertext)
  secret_hint      TEXT NOT NULL,                  -- whsec_…a1b2
  events           TEXT NOT NULL DEFAULT '["*"]',  -- JSON array of subscribed events
  description      TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  is_default       INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  total_deliveries INTEGER NOT NULL DEFAULT 0,
  total_failures   INTEGER NOT NULL DEFAULT 0,
  disabled_at      TEXT,
  disabled_reason  TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX ux_webhook_endpoints_url ON webhook_endpoints(merchant_user_id, url);
CREATE UNIQUE INDEX ux_webhook_endpoints_default ON webhook_endpoints(merchant_user_id)
  WHERE is_default = 1;
CREATE INDEX ix_webhook_endpoints_merchant ON webhook_endpoints(merchant_user_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- webhook_deliveries — one row per outbound event, carrying the retry schedule.
-- Payment confirmation never waits on this table: the delivery is recorded, the
-- confirmation commits, and the queue or cron does the talking afterwards.
-- -----------------------------------------------------------------------------
CREATE TABLE webhook_deliveries (
  id                  TEXT PRIMARY KEY,
  endpoint_id         TEXT REFERENCES webhook_endpoints(id) ON DELETE SET NULL,
  merchant_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event               TEXT NOT NULL,
  url                 TEXT NOT NULL,
  payload             TEXT NOT NULL,               -- exactly the bytes that were signed
  status              TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','DELIVERED','FAILED','DEAD','SKIPPED')),
  attempt_count       INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts        INTEGER NOT NULL DEFAULT 6,
  response_status     INTEGER,
  response_body_preview TEXT,                      -- first 512 chars, never a secret
  duration_ms         INTEGER,
  last_error          TEXT,
  next_retry_at       TEXT,
  last_attempt_at     TEXT,
  delivered_at        TEXT,
  is_test             INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0,1)),
  source_type         TEXT,                        -- invoice | test_run | admin
  source_id           TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
) STRICT;

CREATE INDEX ix_webhook_deliveries_due ON webhook_deliveries(status, next_retry_at);
CREATE INDEX ix_webhook_deliveries_merchant ON webhook_deliveries(merchant_user_id, created_at DESC);
CREATE INDEX ix_webhook_deliveries_status ON webhook_deliveries(status, created_at DESC);
CREATE INDEX ix_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, created_at DESC);
CREATE INDEX ix_webhook_deliveries_source ON webhook_deliveries(source_id) WHERE source_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- webhook_attempts — the per-attempt history behind a delivery, so the dashboard
-- can show "3 attempts: 500, 503, 200" rather than a single opaque status.
-- -----------------------------------------------------------------------------
CREATE TABLE webhook_attempts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id    TEXT NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  attempt        INTEGER NOT NULL,
  response_status INTEGER,
  response_body_preview TEXT,
  duration_ms    INTEGER,
  error          TEXT,
  request_headers TEXT,                            -- redacted; the signature itself is not stored
  created_at     TEXT NOT NULL
) STRICT;

CREATE INDEX ix_webhook_attempts_delivery ON webhook_attempts(delivery_id, attempt);

-- -----------------------------------------------------------------------------
-- notifications — the in-app notification centre. Deliberately two tables: a
-- broadcast is stored once and fanned out on read, so sending to 5,000 merchants
-- does not write 5,000 rows.
-- -----------------------------------------------------------------------------
CREATE TABLE notifications (
  id               TEXT PRIMARY KEY,
  audience         TEXT NOT NULL CHECK (audience IN ('ALL_MERCHANTS','ALL_ADMINS','MERCHANT','ADMIN_ROLE','USER')),
  target_user_id   TEXT REFERENCES users(id) ON DELETE CASCADE,
  target_role      TEXT,
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  type             TEXT NOT NULL DEFAULT 'INFO'
                     CHECK (type IN ('INFO','SUCCESS','WARNING','ERROR','SYSTEM','PAYMENT','SECURITY')),
  priority         TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  link             TEXT,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL,
  expires_at       TEXT
) STRICT;

CREATE INDEX ix_notifications_audience ON notifications(audience, created_at DESC);
CREATE INDEX ix_notifications_target ON notifications(target_user_id, created_at DESC);
CREATE INDEX ix_notifications_created ON notifications(created_at DESC);

CREATE TABLE notification_reads (
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at         TEXT NOT NULL,
  PRIMARY KEY (notification_id, user_id)
) STRICT;

CREATE INDEX ix_notification_reads_user ON notification_reads(user_id, read_at DESC);

-- -----------------------------------------------------------------------------
-- notification_log — outbound delivery dedupe and cooldown (§66). Sending the
-- same low-balance warning on every invoice creation is the failure mode this
-- table exists to prevent: dedupe_key encodes the topic, the merchant, and the
-- cooldown bucket, and a UNIQUE violation means "already sent, stay quiet".
-- -----------------------------------------------------------------------------
CREATE TABLE notification_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_user_id TEXT,
  channel          TEXT NOT NULL CHECK (channel IN ('TELEGRAM','DASHBOARD','EMAIL')),
  topic            TEXT NOT NULL,
  dedupe_key       TEXT NOT NULL,
  severity         TEXT NOT NULL DEFAULT 'INFO',
  payload          TEXT,
  succeeded        INTEGER NOT NULL DEFAULT 1 CHECK (succeeded IN (0,1)),
  error            TEXT,
  sent_at          TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX ux_notification_log_dedupe ON notification_log(dedupe_key);
CREATE INDEX ix_notification_log_merchant ON notification_log(merchant_user_id, sent_at DESC);
CREATE INDEX ix_notification_log_topic ON notification_log(topic, sent_at DESC);

-- -----------------------------------------------------------------------------
-- tickets / ticket_messages — support conversation. ticket_number is a small
-- human-readable counter because "ticket 4821" is what people say out loud.
--
-- Attachments are stored as external URLs (R2 or the merchant's own host) rather
-- than blobs: D1 row size limits make in-database attachments a bad idea, and
-- nothing in the support flow needs the bytes to live here.
-- -----------------------------------------------------------------------------
CREATE TABLE tickets (
  id                TEXT PRIMARY KEY,
  ticket_number     INTEGER NOT NULL,
  merchant_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject           TEXT NOT NULL,
  category          TEXT NOT NULL DEFAULT 'GENERAL'
                      CHECK (category IN ('GENERAL','PAYMENT','SMS','API','WALLET','CALLBACK','ACCOUNT','OTHER')),
  priority          TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  status            TEXT NOT NULL DEFAULT 'OPEN'
                      CHECK (status IN ('OPEN','IN_PROGRESS','WAITING_FOR_USER','WAITING_FOR_ADMIN','RESOLVED','CLOSED')),
  assigned_to       TEXT REFERENCES users(id) ON DELETE SET NULL,
  related_invoice_id TEXT,
  message_count     INTEGER NOT NULL DEFAULT 0,
  unread_for_merchant INTEGER NOT NULL DEFAULT 0,
  unread_for_admin  INTEGER NOT NULL DEFAULT 0,
  last_message_at   TEXT NOT NULL,
  last_message_by   TEXT,
  closed_at         TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX ux_tickets_number ON tickets(ticket_number);
CREATE INDEX ix_tickets_merchant ON tickets(merchant_user_id, last_message_at DESC);
CREATE INDEX ix_tickets_status ON tickets(status, last_message_at DESC);
CREATE INDEX ix_tickets_assigned ON tickets(assigned_to, status);

CREATE TABLE ticket_messages (
  id              TEXT PRIMARY KEY,
  ticket_id       TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_role     TEXT NOT NULL CHECK (author_role IN ('MERCHANT','ADMIN','SYSTEM')),
  body            TEXT NOT NULL,
  attachment_url  TEXT,
  attachment_name TEXT,
  attachment_size INTEGER,
  created_at      TEXT NOT NULL
) STRICT;

CREATE INDEX ix_ticket_messages_ticket ON ticket_messages(ticket_id, created_at);

-- -----------------------------------------------------------------------------
-- sms_test_tokens — the SMS setup wizard (§15). A token is issued, printed into a
-- fake bank message on the setup screen, and considered verified when a forwarder
-- actually delivers it. A test token can never confirm an invoice.
-- -----------------------------------------------------------------------------
CREATE TABLE sms_test_tokens (
  id               TEXT PRIMARY KEY,
  merchant_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash       TEXT NOT NULL,
  verified_at      TEXT,
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX ux_sms_test_tokens_hash ON sms_test_tokens(token_hash);
CREATE INDEX ix_sms_test_tokens_merchant ON sms_test_tokens(merchant_user_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- test_runs — the full pipeline test (§16). Every step is recorded so the
-- dashboard can show exactly which stage failed, and so the run can be replayed
-- or cleaned up. Rows here never touch wallets or real invoices.
-- -----------------------------------------------------------------------------
CREATE TABLE test_runs (
  id                 TEXT PRIMARY KEY,
  merchant_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'RUNNING'
                       CHECK (status IN ('RUNNING','PASSED','FAILED')),
  current_step       TEXT,
  steps              TEXT NOT NULL DEFAULT '[]',   -- JSON array of {name,status,detail,durationMs}
  related_invoice_id TEXT,
  related_sms_id     TEXT,
  related_delivery_id TEXT,
  error              TEXT,
  started_at         TEXT NOT NULL,
  finished_at        TEXT,
  created_at         TEXT NOT NULL
) STRICT;

CREATE INDEX ix_test_runs_merchant ON test_runs(merchant_user_id, created_at DESC);
CREATE INDEX ix_test_runs_status ON test_runs(status, created_at DESC);

-- -----------------------------------------------------------------------------
-- rate_limits — fixed-window counters. The window is part of the primary key, so
-- incrementing is a single UPSERT … RETURNING: one round trip, atomic, and no
-- race between "read the count" and "write the count".
--
-- This lives in D1 rather than KV on purpose. KV is eventually consistent, which
-- means a burst of requests can each observe a stale count and the limit leaks.
-- -----------------------------------------------------------------------------
CREATE TABLE rate_limits (
  bucket_key   TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  window_end   TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 1 CHECK (count >= 0),
  blocked_count INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL
) STRICT;

CREATE INDEX ix_rate_limits_window ON rate_limits(window_end);

-- -----------------------------------------------------------------------------
-- api_usage_daily — per-merchant, per-endpoint API statistics for §73
-- (requests/minute, error rate) aggregated to a day so the dashboard never scans
-- the request stream.
-- -----------------------------------------------------------------------------
CREATE TABLE api_usage_daily (
  day              TEXT NOT NULL,                  -- 'YYYY-MM-DD' in Asia/Tehran terms
  merchant_user_id TEXT NOT NULL,
  endpoint         TEXT NOT NULL,
  requests         INTEGER NOT NULL DEFAULT 0,
  errors           INTEGER NOT NULL DEFAULT 0,
  total_ms         INTEGER NOT NULL DEFAULT 0,
  max_ms           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, merchant_user_id, endpoint)
) STRICT;

CREATE INDEX ix_api_usage_daily_merchant ON api_usage_daily(merchant_user_id, day DESC);

-- -----------------------------------------------------------------------------
-- metrics_daily — nightly rollups so the admin revenue and analytics screens are
-- a handful of indexed reads instead of a scan over every invoice ever issued.
-- day is stored as a Tehran calendar day, because that is the day the merchant
-- and the admin both mean when they say "today".
-- -----------------------------------------------------------------------------
CREATE TABLE metrics_daily (
  day                TEXT NOT NULL,
  merchant_user_id   TEXT NOT NULL,                -- '__ALL__' for the platform row
  invoices_created   INTEGER NOT NULL DEFAULT 0,
  payments_paid      INTEGER NOT NULL DEFAULT 0,
  payments_expired   INTEGER NOT NULL DEFAULT 0,
  payments_failed    INTEGER NOT NULL DEFAULT 0,
  manual_review      INTEGER NOT NULL DEFAULT 0,
  volume_toman       INTEGER NOT NULL DEFAULT 0,
  fees_toman         INTEGER NOT NULL DEFAULT 0,
  customer_fees      INTEGER NOT NULL DEFAULT 0,
  merchant_fees      INTEGER NOT NULL DEFAULT 0,
  wallet_deposits    INTEGER NOT NULL DEFAULT 0,
  manual_adjustments INTEGER NOT NULL DEFAULT 0,
  sms_received       INTEGER NOT NULL DEFAULT 0,
  sms_matched        INTEGER NOT NULL DEFAULT 0,
  sms_failed         INTEGER NOT NULL DEFAULT 0,
  callbacks_delivered INTEGER NOT NULL DEFAULT 0,
  callbacks_failed   INTEGER NOT NULL DEFAULT 0,
  time_to_payment_sum INTEGER NOT NULL DEFAULT 0,
  time_to_payment_count INTEGER NOT NULL DEFAULT 0,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (day, merchant_user_id)
) STRICT;

CREATE INDEX ix_metrics_daily_day ON metrics_daily(day DESC);
CREATE INDEX ix_metrics_daily_merchant ON metrics_daily(merchant_user_id, day DESC);

-- -----------------------------------------------------------------------------
-- admin_permissions — granular overrides on top of the role matrix in
-- src/core/roles.ts. A grant row adds a permission; a deny row (granted = 0)
-- removes one. Role defaults live in code so they are reviewable and testable;
-- this table exists for the exceptions real operations always has.
-- -----------------------------------------------------------------------------
CREATE TABLE admin_permissions (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  granted    INTEGER NOT NULL CHECK (granted IN (0,1)),
  granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, permission)
) STRICT;
