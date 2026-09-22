/**
 * Cron jobs (§2, §12, §24, §45, §60).
 *
 * Three schedules, declared in wrangler.jsonc:
 *
 *   every 2 minutes   expire overdue invoices, sweep due webhook retries
 *   every 15 minutes  reconcile wallet balances against their ledger
 *   daily 03:00       roll up metrics, prune rate limits and old telemetry,
 *                     send the low-balance sweep, run a health audit
 *
 * Each job is independent and reports its own outcome. A failure in one must not
 * prevent the others from running, because "the metrics job threw" is not a reason
 * for invoices to stop expiring — and invoices that never expire hold their unique
 * amounts forever, which is a capacity incident.
 */

import type { Logger } from '../obs/logger';
import { AuditService } from '../services/audit';
import { AuthService } from '../services/auth';
import { InvoiceService } from '../services/invoices';
import { SettingsService } from '../services/settings';
import { WalletService } from '../services/wallet';
import { CardService } from '../services/cards';
import { WebhookService } from '../services/webhooks';
import { NotificationService } from '../services/notifications';
import { TelegramService } from '../services/telegram';
import { rateLimiterFor } from '../services/ratelimit';
import { detectVolumeAnomaly } from '../core/risk';
import { nowIso, addMinutes, tehranDayKey, lastDayKeys } from '../core/time';
import { all, first, run, scalar } from '../db/client';
import { resolveConfig, resolveSecrets, type Env } from '../env';

export interface ScheduledContext {
  cron: string;
  env: Env;
  ctx: ExecutionContext;
  logger: Logger;
}

interface JobResult {
  job: string;
  durationMs: number;
  ok: boolean;
  detail: Record<string, unknown>;
  error?: string;
}

export async function runScheduled(context: ScheduledContext): Promise<void> {
  const { cron, env } = context;
  const jobs = jobsFor(cron);
  const results: JobResult[] = [];

  for (const job of jobs) {
    const started = Date.now();
    try {
      const detail = await job.run(context);
      results.push({ job: job.name, durationMs: Date.now() - started, ok: true, detail });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.logger.error('cron.job_failed', { job: job.name, message });
      results.push({
        job: job.name,
        durationMs: Date.now() - started,
        ok: false,
        detail: {},
        error: message,
      });
    }
  }

  const failures = results.filter((result) => !result.ok);
  await run(
    env.DB,
    `INSERT INTO system_events (level, scope, message, metadata, duration_ms, created_at)
     VALUES (?, 'cron', ?, ?, ?, ?)`,
    [
      failures.length > 0 ? 'ERROR' : 'INFO',
      `cron ${cron}: ${results.length - failures.length}/${results.length} jobs ok`,
      JSON.stringify(results),
      results.reduce((total, result) => total + result.durationMs, 0),
      nowIso(),
    ],
  );

  context.logger.info('cron.completed', { cron, jobs: results.length, failures: failures.length });
}

interface Job {
  name: string;
  run: (context: ScheduledContext) => Promise<Record<string, unknown>>;
}

function jobsFor(cron: string): Job[] {
  // Every 2 minutes.
  if (cron.startsWith('*/2')) {
    return [expireInvoicesJob, webhookSweepJob];
  }
  // Every 15 minutes.
  if (cron.startsWith('*/15')) {
    return [walletReconcileJob, lowBalanceSweepJob];
  }
  // Daily.
  return [metricsRollupJob, cleanupJob, securityScanJob];
}

// ---------------------------------------------------------------------------

/**
 * Expires overdue invoices.
 *
 * The most operationally important job in the system: an invoice that is never
 * expired keeps its unique amount claimed by the partial unique index, and enough of
 * them exhausts the suffix space.
 */
const expireInvoicesJob: Job = {
  name: 'expire-invoices',
  async run({ env }) {
    const settings = new SettingsService(env.DB);
    const audit = new AuditService(env.DB);
    const wallet = new WalletService(env.DB);
    const invoices = new InvoiceService({
      db: env.DB,
      settings,
      audit,
      wallet,
      cards: new CardService(env.DB, audit, settings),
      baseUrl: resolveConfig(env).baseUrl,
    });

    const result = await invoices.expireDue(300);
    const overdue = await invoices.overdueCount();
    return { ...result, stillOverdue: overdue };
  },
};

/** Retries webhooks whose backoff has elapsed. */
const webhookSweepJob: Job = {
  name: 'webhook-sweep',
  async run({ env, logger }) {
    const secrets = resolveSecrets(env);
    const config = resolveConfig(env);
    const audit = new AuditService(env.DB);
    const settings = new SettingsService(env.DB);
    const webhooks = new WebhookService({
      db: env.DB,
      rootSecret: secrets.webhookSecret,
      audit,
      settings,
      queue: null,
      logger,
      baseUrl: config.baseUrl,
    });

    const due = await webhooks.dueDeliveries(25);
    let delivered = 0;
    let failed = 0;

    for (const delivery of due) {
      const result = await webhooks.attemptDelivery(delivery.id);
      if (result.ok) delivered += 1;
      else failed += 1;
    }

    return { attempted: due.length, delivered, failed };
  },
};

/**
 * Verifies that every wallet's stored balance equals the sum of its ledger (§22).
 *
 * If these ever disagree, something wrote to `wallets` without going through the
 * ledger, which is a financial-integrity incident and must be visible rather than
 * discovered during a reconciliation months later.
 */
const walletReconcileJob: Job = {
  name: 'wallet-reconcile',
  async run({ env, logger }) {
    const wallet = new WalletService(env.DB);
    const merchants = await all<{ merchant_user_id: string }>(
      env.DB,
      'SELECT merchant_user_id FROM wallets ORDER BY merchant_user_id LIMIT 500',
    );

    const mismatches: Array<{ merchantUserId: string; stored: number; ledger: number }> = [];
    for (const merchant of merchants) {
      const check = await wallet.reconcile(merchant.merchant_user_id);
      if (!check.agrees || !check.reservedAgrees) {
        mismatches.push({
          merchantUserId: merchant.merchant_user_id,
          stored: check.storedBalance,
          ledger: check.ledgerBalance,
        });
        logger.error('cron.wallet_mismatch', {
          merchantUserId: merchant.merchant_user_id,
          stored: check.storedBalance,
          ledger: check.ledgerBalance,
          storedReserved: check.storedReserved,
          ledgerReserved: check.ledgerReserved,
        });
      }
    }

    return { checked: merchants.length, mismatches: mismatches.length, details: mismatches.slice(0, 10) };
  },
};

/**
 * Warns merchants whose wallet is nearly empty (§24).
 *
 * The Telegram service deduplicates through `notification_log`, so this job can run
 * as often as it likes without producing duplicate messages.
 */
const lowBalanceSweepJob: Job = {
  name: 'low-balance-sweep',
  async run({ env, logger }) {
    const settings = new SettingsService(env.DB);
    const audit = new AuditService(env.DB);
    const notifications = new NotificationService(env.DB, audit);
    const secrets = resolveSecrets(env);
    const config = resolveConfig(env);
    const telegram = new TelegramService(
      {
        botToken: secrets.telegramBotToken,
        adminChatId: secrets.telegramAdminChatId,
        enabled: secrets.telegramEnabled,
        webhookSecret: secrets.telegramWebhookSecret,
      },
      notifications,
      logger,
    );

    if (!telegram.available) return { skipped: true, reason: 'TELEGRAM_NOT_CONFIGURED' };

    const threshold = await settings.int('wallet.low_balance_threshold_toman');
    const cooldown = await settings.int('wallet.notification_cooldown_minutes');
    const globalFee = await settings.int('gateway.fee_toman');

    const rows = await all<{
      merchant_user_id: string;
      balance: number;
      telegram_user_id: string;
      gateway_fee: string | null;
    }>(
      env.DB,
      `SELECT w.merchant_user_id, w.balance, mp.telegram_user_id,
              (SELECT value FROM merchant_settings ms
                WHERE ms.merchant_user_id = w.merchant_user_id AND ms.key = 'invoices.gateway_fee') AS gateway_fee
       FROM wallets w
       JOIN merchant_profiles mp ON mp.user_id = w.merchant_user_id
       JOIN users u ON u.id = w.merchant_user_id
       WHERE u.status = 'ACTIVE' AND mp.telegram_verified = 1 AND mp.telegram_alerts = 1
         AND w.balance < ? AND w.balance >= 0`,
      [threshold],
    );

    let sent = 0;
    for (const row of rows) {
      const fee = row.gateway_fee !== null && Number.isFinite(Number(row.gateway_fee)) ? Number(row.gateway_fee) : globalFee;
      const result = await telegram.notifyLowBalance({
        merchantUserId: row.merchant_user_id,
        chatId: row.telegram_user_id,
        balance: row.balance,
        feePerInvoice: fee,
        threshold,
        cooldownMinutes: cooldown,
      });
      if (result.ok) sent += 1;
    }

    void config;
    return { candidates: rows.length, sent };
  },
};

/**
 * Nightly rollups into metrics_daily (§31, §64).
 *
 * Written as an upsert from the source tables rather than an increment, so a re-run
 * after a failure produces the correct figure instead of doubling it.
 */
const metricsRollupJob: Job = {
  name: 'metrics-rollup',
  async run({ env }) {
    const days = lastDayKeys(3).slice(0, 2);
    let written = 0;

    for (const day of days) {
      const start = `${day}T00:00:00.000Z`;
      const end = `${day}T23:59:59.999Z`;

      const rows = await all<{
        merchant_user_id: string;
        invoices_created: number;
        payments_paid: number;
        payments_expired: number;
        payments_failed: number;
        manual_review: number;
        volume_toman: number;
        fees_toman: number;
        customer_fees: number;
        merchant_fees: number;
      }>(
        env.DB,
        `SELECT merchant_user_id,
                COUNT(*) AS invoices_created,
                SUM(CASE WHEN paid_at IS NOT NULL THEN 1 ELSE 0 END) AS payments_paid,
                SUM(CASE WHEN expired_at IS NOT NULL THEN 1 ELSE 0 END) AS payments_expired,
                SUM(CASE WHEN failed_at IS NOT NULL THEN 1 ELSE 0 END) AS payments_failed,
                SUM(CASE WHEN review_at IS NOT NULL THEN 1 ELSE 0 END) AS manual_review,
                COALESCE(SUM(CASE WHEN status = 'PAID' THEN payable_amount ELSE 0 END), 0) AS volume_toman,
                COALESCE(SUM(CASE WHEN status = 'PAID' THEN gateway_fee ELSE 0 END), 0) AS fees_toman,
                COALESCE(SUM(CASE WHEN status = 'PAID' THEN customer_fee ELSE 0 END), 0) AS customer_fees,
                COALESCE(SUM(CASE WHEN status = 'PAID' THEN merchant_fee ELSE 0 END), 0) AS merchant_fees
         FROM invoices WHERE created_at >= ? AND created_at <= ?
         GROUP BY merchant_user_id`,
        [`${day} 00:00:00`, `${day} 23:59:59`],
      );

      for (const row of rows) {
        await run(
          env.DB,
          `INSERT INTO metrics_daily (
             day, merchant_user_id, invoices_created, payments_paid, payments_expired, payments_failed,
             manual_review, volume_toman, fees_toman, customer_fees, merchant_fees, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(day, merchant_user_id) DO UPDATE SET
             invoices_created = excluded.invoices_created,
             payments_paid = excluded.payments_paid,
             payments_expired = excluded.payments_expired,
             payments_failed = excluded.payments_failed,
             manual_review = excluded.manual_review,
             volume_toman = excluded.volume_toman,
             fees_toman = excluded.fees_toman,
             customer_fees = excluded.customer_fees,
             merchant_fees = excluded.merchant_fees,
             updated_at = excluded.updated_at`,
          [
            day,
            row.merchant_user_id,
            row.invoices_created,
            row.payments_paid,
            row.payments_expired,
            row.payments_failed,
            row.manual_review,
            row.volume_toman,
            row.fees_toman,
            row.customer_fees,
            row.merchant_fees,
            nowIso(),
          ],
        );
        written += 1;
      }

      // Platform-wide row, so the admin revenue chart does not have to aggregate
      // every merchant row on every page load.
      const platform = await first<Record<string, number>>(
        env.DB,
        `SELECT COUNT(*) AS invoices_created,
                COALESCE(SUM(CASE WHEN status = 'PAID' THEN payable_amount ELSE 0 END), 0) AS volume_toman,
                COALESCE(SUM(CASE WHEN status = 'PAID' THEN gateway_fee ELSE 0 END), 0) AS fees_toman
         FROM invoices WHERE created_at >= ? AND created_at <= ?`,
        [`${day} 00:00:00`, `${day} 23:59:59`],
      );

      if (platform) {
        await run(
          env.DB,
          `INSERT INTO metrics_daily (day, merchant_user_id, invoices_created, volume_toman, fees_toman, updated_at)
           VALUES (?, '__ALL__', ?, ?, ?, ?)
           ON CONFLICT(day, merchant_user_id) DO UPDATE SET
             invoices_created = excluded.invoices_created,
             volume_toman = excluded.volume_toman,
             fees_toman = excluded.fees_toman,
             updated_at = excluded.updated_at`,
          [
            day,
            platform['invoices_created'] ?? 0,
            platform['volume_toman'] ?? 0,
            platform['fees_toman'] ?? 0,
            nowIso(),
          ],
        );
        written += 1;
      }

      void start;
      void end;
    }

    return { days: days.length, rowsWritten: written };
  },
};

/** Prunes telemetry that is allowed to expire, plus rate-limit windows. */
const cleanupJob: Job = {
  name: 'cleanup',
  async run({ env }) {
    const limiter = rateLimiterFor(env.DB);
    const auth = new AuthService(env.DB, new SettingsService(env.DB), new AuditService(env.DB));
    const notifications = new NotificationService(env.DB, new AuditService(env.DB));

    const [rateWindows, sessions, loginAttempts, notificationLog, systemEvents, expiredIdempotency] =
      await Promise.all([
        limiter.prune(),
        auth.pruneSessions(),
        auth.pruneLoginAttempts(),
        notifications.pruneLog(90),
        run(env.DB, 'DELETE FROM system_events WHERE created_at < ?', [addMinutes(nowIso(), -60 * 24 * 30)]),
        run(env.DB, 'DELETE FROM idempotency_keys WHERE expires_at < ?', [nowIso()]),
      ]);

    return {
      rateWindows,
      sessions,
      loginAttempts,
      notificationLog,
      systemEvents: systemEvents.changes,
      expiredIdempotency: expiredIdempotency.changes,
    };
  },
};

/**
 * Detects the security events in §67 and raises admin alerts.
 *
 * Reads from telemetry that already exists rather than instrumenting new counters:
 * repeated failed API authentication, unusual SMS volume, and repeated callback
 * failures are all visible in tables the system already writes.
 */
const securityScanJob: Job = {
  name: 'security-scan',
  async run({ env, logger }) {
    const alerts: Array<{ kind: string; detail: string; merchantUserId: string | null }> = [];

    // Repeated failed API authentication: many 401s from one IP in an hour.
    const failedLogins = await all<{ ip: string; count: number }>(
      env.DB,
      `SELECT ip, COUNT(*) AS count FROM login_attempts
       WHERE success = 0 AND created_at > ? AND ip IS NOT NULL
       GROUP BY ip HAVING COUNT(*) >= 25 ORDER BY count DESC LIMIT 10`,
      [addMinutes(nowIso(), -60)],
    );
    for (const row of failedLogins) {
      alerts.push({ kind: 'REPEATED_FAILED_LOGIN', detail: `IP ${row.ip}: ${row.count} failed attempts`, merchantUserId: null });
    }

    // Unusual SMS volume per merchant in the last hour.
    const smsVolume = await all<{ merchant_user_id: string; count: number }>(
      env.DB,
      `SELECT merchant_user_id, COUNT(*) AS count FROM sms_messages
       WHERE server_received_at > ? GROUP BY merchant_user_id HAVING COUNT(*) >= 200 ORDER BY count DESC LIMIT 10`,
      [addMinutes(nowIso(), -60)],
    );
    for (const row of smsVolume) {
      const anomaly = detectVolumeAnomaly([{ at: nowIso(), count: row.count }], 40);
      if (anomaly.anomalous) {
        alerts.push({
          kind: 'SMS_VOLUME_SPIKE',
          detail: `${row.count} SMS in an hour (threshold ${anomaly.threshold})`,
          merchantUserId: row.merchant_user_id,
        });
      }
    }

    // Endpoints failing repeatedly, which is either a merchant outage or a
    // merchant endpoint being used as a probe.
    const callbackFailures = await all<{ merchant_user_id: string; count: number }>(
      env.DB,
      `SELECT merchant_user_id, COUNT(*) AS count FROM webhook_deliveries
       WHERE status IN ('FAILED','DEAD') AND created_at > ?
       GROUP BY merchant_user_id HAVING COUNT(*) >= 50 ORDER BY count DESC LIMIT 10`,
      [addMinutes(nowIso(), -60 * 24)],
    );
    for (const row of callbackFailures) {
      alerts.push({
        kind: 'CALLBACK_FAILURE_STORM',
        detail: `${row.count} failed deliveries in 24h`,
        merchantUserId: row.merchant_user_id,
      });
    }

    if (alerts.length > 0) {
      const audit = new AuditService(env.DB);
      for (const alert of alerts) {
        await audit.record({
          event: 'security.event',
          merchantUserId: alert.merchantUserId,
          targetType: 'security',
          targetId: alert.kind,
          severity: 'CRITICAL',
          metadata: { detail: alert.detail },
        });
      }
      logger.warn('cron.security_alerts', { count: alerts.length, kinds: alerts.map((alert) => alert.kind) });
    }

    return { alerts: alerts.length, kinds: [...new Set(alerts.map((alert) => alert.kind))] };
  },
};

/** Manual trigger for the admin console, so an operator does not have to wait for cron. */
export async function runJobNow(
  name: string,
  context: ScheduledContext,
): Promise<Record<string, unknown> | null> {
  const job = [
    expireInvoicesJob,
    webhookSweepJob,
    walletReconcileJob,
    lowBalanceSweepJob,
    metricsRollupJob,
    cleanupJob,
    securityScanJob,
  ].find((candidate) => candidate.name === name);
  if (!job) return null;
  return job.run(context);
}

/** Queue depth and cron freshness, for the admin health page (§45). */
export async function cronHealth(env: Env): Promise<Record<string, unknown>> {
  const lastRun = await first<{ created_at: string; message: string; level: string }>(
    env.DB,
    `SELECT created_at, message, level FROM system_events WHERE scope = 'cron' ORDER BY id DESC LIMIT 1`,
  );
  const stuckDeliveries = await scalar(
    env.DB,
    `SELECT COUNT(*) AS count FROM webhook_deliveries WHERE status = 'PENDING' AND next_retry_at <= ?`,
    [addMinutes(nowIso(), -30)],
  );

  return {
    lastRunAt: lastRun?.created_at ?? null,
    lastRunMessage: lastRun?.message ?? null,
    lastRunLevel: lastRun?.level ?? null,
    // A cron that has not run in twenty minutes is a misconfigured schedule, and
    // that is worth showing rather than leaving as an invisible gap.
    stale: lastRun ? Date.now() - new Date(lastRun.created_at).getTime() > 20 * 60_000 : true,
    stuckDeliveries,
    today: tehranDayKey(nowIso()),
  };
}
