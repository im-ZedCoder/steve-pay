/**
 * Operational reporting (§28, §31, §32).
 *
 * Read-only aggregates. Nothing here mutates anything, and every number is derived from
 * the tables that already exist rather than from a rollup that could drift — the volumes
 * are small enough that a `GROUP BY` stays indexed and cheap, and a rollup table would be
 * one more thing that can silently disagree with the ledger. If the volume ever justifies
 * pre-aggregation, the cron rollups are the place to add it.
 *
 * Money is summed from `wallet_ledger`, never from invoices. The ledger is the record of
 * what actually moved; invoices record what was *intended*. When the two disagree, the
 * ledger is right and the revenue figure should say so.
 *
 * "Today" is always a Tehran day (§ time.ts). An operator in Tehran reading a dashboard at
 * 00:30 must not see yesterday's numbers, which is exactly what a UTC boundary would show.
 */

import type { Toman } from '../core/money';
import { all, first } from '../db/client';
import { startOfTehranDay, tehranDayKey, lastDayKeys } from '../core/time';

export interface AdminOverview {
  merchants: {
    pending: number;
    active: number;
    suspended: number;
    banned: number;
    rejected: number;
    total: number;
  };
  invoices: {
    today: number;
    pending: number;
    paidToday: number;
    expired: number;
    manualReview: number;
  };
  money: {
    /** Gateway fees actually collected, all time. */
    feesTotal: Toman;
    feesToday: Toman;
    /** Value of confirmed payments, all time. */
    volumeTotal: Toman;
    volumeToday: Toman;
    /** Net credit from merchants topping up, all time. */
    depositsTotal: Toman;
    /** Sum of every merchant wallet balance — the platform's liability. */
    walletsHeld: Toman;
  };
  webhooks: {
    failed: number;
    pending: number;
  };
  sms: {
    last24h: number;
    unparsed: number;
    /** Messages that matched an amount but were refused by the risk layer. */
    escalated: number;
  };
}

export class ReportingService {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  /**
   * Everything the admin landing page shows, in one pass.
   *
   * Deliberately one method rather than a dozen: the overview page needs all of it, and
   * a dozen separate awaits would be a dozen serialised round-trips to D1. The queries
   * are independent, so they are issued together.
   */
  async adminOverview(): Promise<AdminOverview> {
    const dayStart = startOfTehranDay(new Date());

    const [
      merchantStatus,
      invoiceCounts,
      feesTotal,
      feesToday,
      volume,
      volumeToday,
      deposits,
      walletsHeld,
      webhooks,
      sms,
    ] = await Promise.all([
      all<{ status: string; count: number }>(
        this.db,
        "SELECT status, COUNT(*) AS count FROM users WHERE role = 'MERCHANT' GROUP BY status",
      ),
      first<{
        today: number;
        pending: number;
        paid_today: number;
        expired: number;
        manual_review: number;
      }>(
        this.db,
        `SELECT
           (SELECT COUNT(*) FROM invoices WHERE created_at >= ?) AS today,
           (SELECT COUNT(*) FROM invoices WHERE status IN ('CREATED','PENDING','PAYMENT_DETECTED','CONFIRMING')) AS pending,
           (SELECT COUNT(*) FROM invoices WHERE status = 'PAID' AND paid_at >= ?) AS paid_today,
           (SELECT COUNT(*) FROM invoices WHERE status = 'EXPIRED') AS expired,
           (SELECT COUNT(*) FROM invoices WHERE status = 'MANUAL_REVIEW') AS manual_review`,
        [dayStart, dayStart],
      ),
      first<{ total: number }>(
        this.db,
        "SELECT COALESCE(SUM(amount), 0) AS total FROM wallet_ledger WHERE type = 'PAYMENT_FEE'",
      ),
      first<{ total: number }>(
        this.db,
        "SELECT COALESCE(SUM(amount), 0) AS total FROM wallet_ledger WHERE type = 'PAYMENT_FEE' AND created_at >= ?",
        [dayStart],
      ),
      first<{ total: number }>(
        this.db,
        "SELECT COALESCE(SUM(net_amount), 0) AS total FROM transactions WHERE status = 'CONFIRMED'",
      ),
      first<{ total: number }>(
        this.db,
        "SELECT COALESCE(SUM(net_amount), 0) AS total FROM transactions WHERE status = 'CONFIRMED' AND confirmed_at >= ?",
        [dayStart],
      ),
      first<{ total: number }>(
        this.db,
        "SELECT COALESCE(SUM(amount), 0) AS total FROM wallet_ledger WHERE type = 'DEPOSIT'",
      ),
      first<{ total: number }>(this.db, 'SELECT COALESCE(SUM(balance), 0) AS total FROM wallets'),
      first<{ failed: number; pending: number }>(
        this.db,
        `SELECT
           (SELECT COUNT(*) FROM webhook_deliveries WHERE status = 'FAILED') AS failed,
           (SELECT COUNT(*) FROM webhook_deliveries WHERE status = 'PENDING') AS pending`,
      ),
      first<{ last24h: number; unparsed: number; escalated: number }>(
        this.db,
        `SELECT
           (SELECT COUNT(*) FROM sms_messages WHERE server_received_at >= ?) AS last24h,
           (SELECT COUNT(*) FROM sms_messages WHERE parse_status = 'UNPARSED') AS unparsed,
           (SELECT COUNT(*) FROM invoices WHERE status = 'MANUAL_REVIEW') AS escalated`,
        [new Date(Date.now() - 86_400_000).toISOString()],
      ),
    ]);

    const merchants = { pending: 0, active: 0, suspended: 0, banned: 0, rejected: 0, total: 0 };
    for (const row of merchantStatus) {
      const key = row.status.toLowerCase() as keyof typeof merchants;
      if (key in merchants) merchants[key] = row.count;
      merchants.total += row.count;
    }

    return {
      merchants,
      invoices: {
        today: invoiceCounts?.today ?? 0,
        pending: invoiceCounts?.pending ?? 0,
        paidToday: invoiceCounts?.paid_today ?? 0,
        expired: invoiceCounts?.expired ?? 0,
        manualReview: invoiceCounts?.manual_review ?? 0,
      },
      money: {
        feesTotal: feesTotal?.total ?? 0,
        feesToday: feesToday?.total ?? 0,
        volumeTotal: volume?.total ?? 0,
        volumeToday: volumeToday?.total ?? 0,
        depositsTotal: deposits?.total ?? 0,
        walletsHeld: walletsHeld?.total ?? 0,
      },
      webhooks: { failed: webhooks?.failed ?? 0, pending: webhooks?.pending ?? 0 },
      sms: {
        last24h: sms?.last24h ?? 0,
        unparsed: sms?.unparsed ?? 0,
        escalated: sms?.escalated ?? 0,
      },
    };
  }

  /**
   * Daily fee revenue for the last `days` Tehran days.
   *
   * Days with no revenue are filled with zero rather than omitted, because a chart that
   * silently drops empty days compresses a quiet week into a busy-looking line. The day
   * keys are the source of truth for the sequence; the query only supplies values.
   */
  async feesByDay(days = 14): Promise<Array<{ day: string; amount: Toman; count: number }>> {
    const keys = lastDayKeys(days);
    const from = startOfTehranDay(`${keys[0]}T00:00:00Z`);

    // The rows are fetched unaggregated and bucketed in JS. Grouping in SQL would group by
    // the UTC date, which disagrees with the Tehran keys for three and a half hours every
    // evening — and that window is exactly when a merchant is most likely to be comparing
    // today's revenue against their own ledger.
    const buckets = new Map<string, { amount: number; count: number }>();
    for (const key of keys) buckets.set(key, { amount: 0, count: 0 });

    const detailed = await all<{ created_at: string; amount: number }>(
      this.db,
      "SELECT created_at, amount FROM wallet_ledger WHERE type = 'PAYMENT_FEE' AND created_at >= ?",
      [from],
    );
    for (const row of detailed) {
      const key = tehranDayKey(row.created_at);
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.amount += row.amount;
        bucket.count += 1;
      }
    }

    return keys.map((day) => ({
      day,
      amount: buckets.get(day)?.amount ?? 0,
      count: buckets.get(day)?.count ?? 0,
    }));
  }

  /**
   * Per-merchant revenue, for the reports table (§31).
   *
   * `LEFT JOIN` from merchants outward so an approved merchant with no traffic appears with
   * zeros. An operator asking "who is quiet?" needs that row; an inner join hides exactly
   * the accounts worth looking at.
   */
  async revenueByMerchant(limit = 50): Promise<
    Array<{ userId: string; merchantCode: string; displayName: string | null; fees: Toman; paidCount: number; volume: Toman }>
  > {
    const rows = await all<{
      user_id: string;
      merchant_code: string | null;
      display_name: string | null;
      fees: number | null;
      paid_count: number | null;
      volume: number | null;
    }>(
      this.db,
      `SELECT u.id AS user_id, mp.merchant_code, mp.display_name,
              (SELECT COALESCE(SUM(l.amount), 0) FROM wallet_ledger l
                WHERE l.merchant_user_id = u.id AND l.type = 'PAYMENT_FEE') AS fees,
              (SELECT COUNT(*) FROM transactions t
                WHERE t.merchant_user_id = u.id AND t.status = 'CONFIRMED') AS paid_count,
              (SELECT COALESCE(SUM(t.net_amount), 0) FROM transactions t
                WHERE t.merchant_user_id = u.id AND t.status = 'CONFIRMED') AS volume
         FROM users u
         LEFT JOIN merchant_profiles mp ON mp.user_id = u.id
        WHERE u.role = 'MERCHANT' AND u.status = 'ACTIVE'
        ORDER BY fees DESC
        LIMIT ?`,
      [Math.min(Math.max(limit, 1), 200)],
    );

    return rows.map((row) => ({
      userId: row.user_id,
      merchantCode: row.merchant_code ?? '—',
      displayName: row.display_name,
      fees: row.fees ?? 0,
      paidCount: row.paid_count ?? 0,
      volume: row.volume ?? 0,
    }));
  }
}
