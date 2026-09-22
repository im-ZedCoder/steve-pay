-- =============================================================================
-- Steve Pay — seed data
-- =============================================================================
-- Platform settings only. No admin account is seeded on purpose: a default
-- credentialed admin is the single most common way a production deployment gets
-- taken over. Create the first SUPER_ADMIN with:
--
--     npm run admin:create -- --mobile 09xxxxxxxxx --role SUPER_ADMIN
--
-- The script generates a random password, prints it once, and writes the row via
-- wrangler d1 execute.
-- =============================================================================

INSERT INTO system_settings (key, value, type, category, label, description, is_secret, updated_at)
VALUES
  ('gateway.fee_toman', '3000', 'int', 'fees',
   'Default gateway fee',
   'Fee in Toman applied to every invoice that does not have a per-merchant override.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('gateway.fee_mode_default', 'CUSTOMER', 'string', 'fees',
   'Default fee mode',
   'CUSTOMER adds the fee to the payable amount; MERCHANT deducts it from the wallet on settlement.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('gateway.percentage_fee_basis_points', '0', 'int', 'fees',
   'Percentage fee (basis points)',
   'Reserved for dynamic pricing. 0 disables percentage fees; the architecture is already in place.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('unique_amount.suffix_digits', '4', 'int', 'payments',
   'Unique suffix length',
   '3 or 4. Four digits keeps collisions rare until roughly 9,000 live invoices.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('unique_amount.max_attempts', '12', 'int', 'payments',
   'Suffix collision retries',
   'How many distinct suffixes to try before failing with AMOUNT_SPACE_EXHAUSTED.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('invoices.expiry_minutes_min', '15', 'int', 'payments',
   'Minimum invoice lifetime (minutes)', 'Lower bound enforced on merchant configuration.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('invoices.expiry_minutes_max', '60', 'int', 'payments',
   'Maximum invoice lifetime (minutes)', 'Upper bound enforced on merchant configuration.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('invoices.expiry_minutes_default', '30', 'int', 'payments',
   'Default invoice lifetime (minutes)', 'Used when a merchant has not chosen one.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('invoices.min_amount_toman', '1000', 'int', 'payments',
   'Minimum invoice amount (Toman)', 'Amounts below this cannot be given a unique 3-4 digit suffix safely.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('invoices.max_amount_toman', '500000000', 'int', 'payments',
   'Maximum invoice amount (Toman)', 'Ceiling on a single invoice.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('wallet.low_balance_threshold_toman', '10000', 'int', 'wallet',
   'Low balance warning threshold',
   'Below this, the merchant is warned in Telegram. The warning states how many more invoices their balance covers, computed from the live fee.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('wallet.notification_cooldown_minutes', '360', 'int', 'wallet',
   'Low balance cooldown (minutes)',
   'Minimum gap between two low-balance warnings for the same merchant.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('wallet.auto_disable_invoice_creation', 'true', 'bool', 'wallet',
   'Block invoices when the wallet cannot cover the fee',
   'When true, a MERCHANT-fee-mode merchant with insufficient balance cannot create invoices.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('security.session_ttl_hours', '168', 'int', 'security',
   'Session lifetime (hours)', 'Seven days; revoked early on password change or explicit logout.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('security.max_failed_logins', '8', 'int', 'security',
   'Failed logins before lockout', 'Counter resets on a successful login.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('security.lockout_minutes', '15', 'int', 'security',
   'Lockout duration (minutes)', 'Applied after the failed-login threshold is crossed.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('security.admin_session_ttl_hours', '12', 'int', 'security',
   'Admin session lifetime (hours)', 'Admins get a much shorter session than merchants.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('rate_limit.make_payment_per_minute', '60', 'int', 'rate_limits',
   'makePayment per minute', 'Per API key.', 0, '2026-01-01T00:00:00.000Z'),

  ('rate_limit.sms_per_minute', '120', 'int', 'rate_limits',
   'SMS webhook per minute', 'Per API key. Real forwarders burst after network downtime.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('rate_limit.api_per_minute', '300', 'int', 'rate_limits',
   'General API per minute', 'Per API key, across all read endpoints.', 0, '2026-01-01T00:00:00.000Z'),

  ('rate_limit.login_per_15_minutes', '10', 'int', 'rate_limits',
   'Login attempts per 15 minutes', 'Per IP address.', 0, '2026-01-01T00:00:00.000Z'),

  ('rate_limit.register_per_hour', '5', 'int', 'rate_limits',
   'Registrations per hour', 'Per IP address.', 0, '2026-01-01T00:00:00.000Z'),

  ('rate_limit.public_invoice_per_minute', '120', 'int', 'rate_limits',
   'Public invoice views per minute', 'Per IP address.', 0, '2026-01-01T00:00:00.000Z'),

  ('webhooks.max_attempts', '6', 'int', 'webhooks',
   'Maximum delivery attempts',
   'Six attempts follow the 1m/5m/30m/2h/12h backoff schedule.', 0, '2026-01-01T00:00:00.000Z'),

  ('webhooks.timeout_seconds', '10', 'int', 'webhooks',
   'Per-attempt timeout (seconds)', 'Cloudflare subrequest limits are the hard ceiling.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('webhooks.disable_after_consecutive_failures', '25', 'int', 'webhooks',
   'Auto-disable endpoint after N failures',
   'A permanently broken URL is disabled rather than retried forever, and the merchant is told.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('matching.time_window_minutes_before', '10', 'int', 'matching',
   'Accept an SMS this many minutes before invoice creation',
   'Bank clocks drift. Statements are stamped by the bank, not by us.', 0, '2026-01-01T00:00:00.000Z'),

  ('matching.time_window_minutes_after', '90', 'int', 'matching',
   'Accept an SMS this many minutes after expiry',
   'A payment made at 09:58 that is SMSed at 10:02 is still that payment. Outside this window the payment goes to manual review.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('matching.require_card_match', 'false', 'bool', 'matching',
   'Require the destination card to match',
   'When true, an SMS that names a different card than the invoice is routed to manual review.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('matching.min_confidence_auto_confirm', '70', 'int', 'matching',
   'Minimum parser confidence for automatic confirmation',
   'Below this the payment is reviewed by a human rather than settled automatically.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('matching.auto_confirm_enabled', 'true', 'bool', 'matching',
   'Automatic confirmation',
   'Turning this off routes every match to manual review. Useful during bank format changes.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('maintenance.invoice_creation_disabled', 'false', 'bool', 'maintenance',
   'Maintenance mode: refuse new invoices',
   'Existing invoices keep working; new makePayment calls return MAINTENANCE_MODE.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('maintenance.message', 'سرویس در حال به‌روزرسانی است. چند دقیقه دیگر دوباره تلاش کنید.', 'string', 'maintenance',
   'Maintenance message', 'Shown to merchants whose API call is refused during maintenance.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('platform.name', 'Steve Pay', 'string', 'general', 'Platform name', 'Shown in the UI and in notifications.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('platform.iran_timezone', 'Asia/Tehran', 'string', 'general', 'Reporting timezone',
   'All daily rollups and "today" figures use this zone.', 0, '2026-01-01T00:00:00.000Z'),

  ('platform.registration_enabled', 'true', 'bool', 'general',
   'Allow new merchant registrations', 'Close this to stop accepting signups entirely.', 0,
   '2026-01-01T00:00:00.000Z'),

  ('platform.turnstile_required', 'false', 'bool', 'security',
   'Require Turnstile on public forms',
   'Enable once TURNSTILE_SECRET is configured, otherwise public forms fail closed.', 0,
   '2026-01-01T00:00:00.000Z')
ON CONFLICT(key) DO NOTHING;

-- Durable counter used for merchant codes and ticket numbers.
INSERT INTO sequences (name, value) VALUES ('ticket_number', 1000)
ON CONFLICT(name) DO NOTHING;

INSERT INTO sequences (name, value) VALUES ('merchant_code', 1000)
ON CONFLICT(name) DO NOTHING;
