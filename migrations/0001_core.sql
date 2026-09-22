-- =============================================================================
-- Steve Gate — migration 0001: identity, access, settings, audit
-- =============================================================================
-- Conventions used across every migration:
--   * All money is INTEGER Toman. No REAL columns exist anywhere in this schema.
--   * All timestamps are TEXT, ISO-8601 UTC with a trailing Z, e.g.
--     '2026-09-22T09:14:03.512Z'. ISO text sorts lexicographically the same way
--     it sorts chronologically, which keeps range scans and LIMIT queries cheap.
--   * Tables holding money or identity are declared STRICT so SQLite refuses to
--     coerce '3.5' or 'abc' into an INTEGER column.
--   * Every user-supplied identifier is TEXT with a human-readable prefix
--     (usr_, inv_, pay_...) so an ID is self-describing in logs and support.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- users — merchants and admins share one authentication table.
-- Role decides the permission set (see src/core/roles.ts); status decides whether
-- the account can do anything at all. Registration lands in PENDING_APPROVAL and
-- only an admin can move it to ACTIVE.
-- -----------------------------------------------------------------------------
CREATE TABLE users (
  id                  TEXT PRIMARY KEY,
  mobile              TEXT NOT NULL,                       -- normalised to 09XXXXXXXXX
  email               TEXT,
  password_hash       TEXT NOT NULL,                       -- pbkdf2-sha256$<iter>$<salt>$<hash>
  role                TEXT NOT NULL DEFAULT 'MERCHANT'
                        CHECK (role IN ('MERCHANT','SUPER_ADMIN','ADMIN','SUPPORT','FINANCE','VIEWER')),
  status              TEXT NOT NULL DEFAULT 'PENDING_APPROVAL'
                        CHECK (status IN ('PENDING_APPROVAL','ACTIVE','REJECTED','SUSPENDED','BANNED')),
  display_name        TEXT,
  failed_login_count  INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until        TEXT,
  last_login_at       TEXT,
  last_login_ip       TEXT,
  password_changed_at TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  totp_secret         TEXT,                                -- sealed; 2FA is opt-in
  totp_enabled        INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0,1)),
  approved_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at         TEXT,
  status_reason       TEXT,                                -- why rejected/suspended/banned
  status_changed_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  status_changed_at   TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX ux_users_mobile ON users(mobile);
CREATE UNIQUE INDEX ux_users_email ON users(email) WHERE email IS NOT NULL;
CREATE INDEX ix_users_role_status ON users(role, status);
CREATE INDEX ix_users_status_created ON users(status, created_at DESC);

-- -----------------------------------------------------------------------------
-- merchant_profiles — commercial identity of a merchant account.
-- merchant_code is the short public reference (SP-1001) shown in the admin
-- console and in support conversations; it is never a secret.
-- -----------------------------------------------------------------------------
CREATE TABLE merchant_profiles (
  user_id              TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  merchant_code        TEXT NOT NULL,
  business_type        TEXT,
  business_description TEXT,
  telegram_username    TEXT,        -- as typed by the user, unverified
  telegram_user_id     TEXT,        -- set only after the ownership flow completes
  telegram_verified    INTEGER NOT NULL DEFAULT 0 CHECK (telegram_verified IN (0,1)),
  telegram_alerts      INTEGER NOT NULL DEFAULT 1 CHECK (telegram_alerts IN (0,1)),
  display_name         TEXT,        -- shown to the customer on the payment page
  logo_url             TEXT,
  support_contact      TEXT,
  support_url          TEXT,
  website_url          TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX ux_merchant_profiles_code ON merchant_profiles(merchant_code);
CREATE INDEX ix_merchant_profiles_telegram_user ON merchant_profiles(telegram_user_id)
  WHERE telegram_user_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- api_keys — a merchant may hold many keys across live and test environments.
-- The raw key is shown exactly once. What we persist is an HMAC of the whole key
-- (peppered) plus a short non-secret lookup_id so authentication stays a single
-- indexed read instead of a table scan over hashes.
--   wire format: sk_live_<lookup_id:16><secret:32>
-- -----------------------------------------------------------------------------
CREATE TABLE api_keys (
  id                TEXT PRIMARY KEY,
  merchant_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lookup_id         TEXT NOT NULL,
  key_hash          TEXT NOT NULL,                         -- HMAC-SHA256(pepper, fullKey)
  key_hint          TEXT NOT NULL,                         -- sk_live_a1b2…9f (display only)
  environment       TEXT NOT NULL DEFAULT 'live' CHECK (environment IN ('live','test')),
  label             TEXT,
  scopes            TEXT NOT NULL DEFAULT '["*"]',         -- JSON array
  ip_allowlist      TEXT,                                  -- JSON array of CIDRs, NULL = any
  last_used_at      TEXT,
  last_used_ip      TEXT,
  request_count     INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  revoked_at        TEXT,
  revoked_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  rotated_from      TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  expires_at        TEXT,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX ux_api_keys_lookup ON api_keys(lookup_id);
CREATE UNIQUE INDEX ux_api_keys_hash ON api_keys(key_hash);
CREATE INDEX ix_api_keys_merchant ON api_keys(merchant_user_id, environment, created_at DESC);
CREATE INDEX ix_api_keys_active ON api_keys(merchant_user_id) WHERE revoked_at IS NULL;

-- -----------------------------------------------------------------------------
-- sessions — cookie sessions. Only the SHA-256 of the session token is stored,
-- so a database leak cannot be replayed as a login.
-- -----------------------------------------------------------------------------
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,
  ip            TEXT,
  user_agent    TEXT,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  revoked_reason TEXT
) STRICT;

CREATE UNIQUE INDEX ux_sessions_token ON sessions(token_hash);
CREATE INDEX ix_sessions_user ON sessions(user_id, expires_at DESC);
CREATE INDEX ix_sessions_expiry ON sessions(expires_at);

-- -----------------------------------------------------------------------------
-- login_attempts — append-only login telemetry powering lockout and §67
-- security-event detection ("repeated failed API authentication", unusual logins).
-- -----------------------------------------------------------------------------
CREATE TABLE login_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier  TEXT,                     -- mobile or email that was tried
  user_id     TEXT,
  ip          TEXT,
  user_agent  TEXT,
  success     INTEGER NOT NULL CHECK (success IN (0,1)),
  reason      TEXT,
  created_at  TEXT NOT NULL
) STRICT;

CREATE INDEX ix_login_attempts_identifier ON login_attempts(identifier, created_at DESC);
CREATE INDEX ix_login_attempts_ip ON login_attempts(ip, created_at DESC);
CREATE INDEX ix_login_attempts_created ON login_attempts(created_at DESC);

-- -----------------------------------------------------------------------------
-- system_settings — platform configuration. Values are TEXT plus a declared type
-- so the admin console can render the right control, and financial keys are
-- validated on write (see src/services/settings.ts).
-- -----------------------------------------------------------------------------
CREATE TABLE system_settings (
  key          TEXT PRIMARY KEY,
  value        TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'string' CHECK (type IN ('string','int','bool','json','csv')),
  category     TEXT NOT NULL DEFAULT 'general',
  label        TEXT,
  description  TEXT,
  is_secret    INTEGER NOT NULL DEFAULT 0 CHECK (is_secret IN (0,1)),
  updated_at   TEXT NOT NULL,
  updated_by   TEXT REFERENCES users(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX ix_system_settings_category ON system_settings(category);

-- -----------------------------------------------------------------------------
-- merchant_settings — per-merchant preferences. Kept separate from
-- system_settings so the admin console can never accidentally write one
-- merchant's fee mode into the platform defaults.
-- -----------------------------------------------------------------------------
CREATE TABLE merchant_settings (
  merchant_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key              TEXT NOT NULL,
  value            TEXT NOT NULL,
  type             TEXT NOT NULL DEFAULT 'string' CHECK (type IN ('string','int','bool','json','csv')),
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (merchant_user_id, key)
) STRICT;

-- -----------------------------------------------------------------------------
-- audit_logs — append-only. Triggers below make the table physically reject
-- UPDATE and DELETE, which is what "append-only from the application
-- perspective" has to mean if it is going to survive a buggy migration or a
-- compromised admin session.
-- -----------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  event            TEXT NOT NULL,
  severity         TEXT NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  actor_user_id    TEXT,
  actor_role       TEXT,
  actor_ip         TEXT,
  actor_user_agent TEXT,
  merchant_user_id TEXT,
  target_type      TEXT,
  target_id        TEXT,
  request_id       TEXT,
  metadata         TEXT,                       -- JSON object, secrets already stripped
  created_at       TEXT NOT NULL
) STRICT;

CREATE INDEX ix_audit_logs_created ON audit_logs(created_at DESC);
CREATE INDEX ix_audit_logs_event ON audit_logs(event, created_at DESC);
CREATE INDEX ix_audit_logs_actor ON audit_logs(actor_user_id, created_at DESC);
CREATE INDEX ix_audit_logs_merchant ON audit_logs(merchant_user_id, created_at DESC);
CREATE INDEX ix_audit_logs_request ON audit_logs(request_id) WHERE request_id IS NOT NULL;

CREATE TRIGGER trg_audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER trg_audit_logs_no_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;

-- -----------------------------------------------------------------------------
-- sequences — atomic counters. SQLite has no sequences, so ticket numbers and
-- merchant codes come from a single-row UPSERT with RETURNING, which is atomic
-- under concurrency without an explicit transaction.
-- -----------------------------------------------------------------------------
CREATE TABLE sequences (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
) STRICT;

-- -----------------------------------------------------------------------------
-- system_events — structured operational log for cron runs, queue failures and
-- health probes. Distinct from audit_logs: this is telemetry, and it is allowed
-- to be pruned, whereas audit_logs is not.
-- -----------------------------------------------------------------------------
CREATE TABLE system_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  level      TEXT NOT NULL DEFAULT 'INFO' CHECK (level IN ('DEBUG','INFO','WARNING','ERROR','CRITICAL')),
  scope      TEXT NOT NULL,                    -- cron:expire-invoices, queue:webhooks, health:db, ...
  message    TEXT NOT NULL,
  metadata   TEXT,
  request_id TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX ix_system_events_scope ON system_events(scope, created_at DESC);
CREATE INDEX ix_system_events_level ON system_events(level, created_at DESC);
CREATE INDEX ix_system_events_created ON system_events(created_at DESC);
