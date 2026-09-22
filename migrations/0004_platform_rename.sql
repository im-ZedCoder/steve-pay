-- =============================================================================
-- Steve Gate — migration 0004: the platform's own name, and the Telegram settings
-- =============================================================================
-- Two things the seed cannot do, because the seed only ever inserts and only ever runs on an
-- empty database (`ON CONFLICT(key) DO NOTHING`):
--
--   1. Rename the platform on databases created before the rename. The stored value is what
--      an operator reads beside `platform.name`, so leaving it saying the old name makes the
--      settings screen contradict the product.
--   2. Add the settings the admin console writes for the Telegram bot. They have code
--      defaults, so nothing breaks without these rows — but a setting with no row is invisible
--      to a listing that reads the table, and the operator would have no way to see that the
--      bot is switched off.
--
-- Both statements are idempotent and backward compatible, which is what makes this safe to
-- apply ahead of the deployment that reads it: the UPDATE is guarded by the old value, and
-- the INSERT does nothing where the row already exists.
-- =============================================================================

UPDATE system_settings
   SET value = 'Steve Gate',
       updated_at = '2026-09-22T00:00:00.000Z'
 WHERE key = 'platform.name'
   AND value = 'Steve Pay';

INSERT INTO system_settings (key, value, type, category, label, description, is_secret, updated_at)
VALUES
  ('telegram.enabled', 'false', 'bool', 'telegram',
   'Send Telegram notifications',
   'Off means every notification is skipped silently; the features that would send one keep working.',
   0, '2026-09-22T00:00:00.000Z'),

  ('telegram.bot_token', '', 'string', 'telegram',
   'Bot token',
   'From @BotFather, stored encrypted. Leave empty to keep the current token.', 1,
   '2026-09-22T00:00:00.000Z'),

  ('telegram.admin_chat_id', '', 'string', 'telegram',
   'Admin chat id',
   'Where platform alerts go. Send the bot a message and read the id from getUpdates.', 0,
   '2026-09-22T00:00:00.000Z')
ON CONFLICT(key) DO NOTHING;
