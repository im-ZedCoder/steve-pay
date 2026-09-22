/**
 * Merchant profiles and lifecycle (§4, §28, §29, §46).
 *
 * Approval is a real gate. A merchant in PENDING_APPROVAL has no API key, no
 * ability to create an invoice, and no dashboard access beyond the status page.
 * Approval is what issues credentials, and every transition is audited.
 */

import { AppError } from '../core/errors';
import type { ApiKeyService, IssuedApiKey } from './api-keys';
import { nowIso } from '../core/time';
import { all, first, run, scalar } from '../db/client';
import { AuditService } from './audit';
import { WalletService } from './wallet';
import { resetUserPassword } from './auth';
import type { Role } from '../core/roles';

export interface MerchantProfileRow {
  user_id: string;
  merchant_code: string;
  business_type: string | null;
  business_description: string | null;
  telegram_username: string | null;
  telegram_user_id: string | null;
  telegram_verified: number;
  telegram_alerts: number;
  display_name: string | null;
  logo_url: string | null;
  support_contact: string | null;
  support_url: string | null;
  website_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface MerchantSummary {
  userId: string;
  merchantCode: string;
  mobile: string;
  role: Role;
  status: string;
  displayName: string | null;
  businessType: string | null;
  telegramUsername: string | null;
  telegramVerified: boolean;
  createdAt: string;
  approvedAt: string | null;
  walletBalance: number;
  invoiceCount: number;
  totalVolume: number;
  lastLoginAt: string | null;
}

export type MerchantAction = 'APPROVE' | 'REJECT' | 'SUSPEND' | 'BAN' | 'REACTIVATE' | 'RESET';

export interface SetupProgress {
  percent: number;
  steps: Array<{
    key: string;
    title: string;
    done: boolean;
    /** Optional text the wizard shows for the next action. */
    detail?: string;
  }>;
  ready: boolean;
}

export class MerchantService {
  private readonly db: D1Database;
  private readonly audit: AuditService;
  private readonly wallet: WalletService;

  private readonly apiKeys: ApiKeyService;

  constructor(db: D1Database, audit: AuditService, wallet: WalletService, apiKeys: ApiKeyService) {
    this.db = db;
    this.audit = audit;
    this.wallet = wallet;
    this.apiKeys = apiKeys;
  }

  async profile(merchantUserId: string): Promise<MerchantProfileRow | null> {
    return first<MerchantProfileRow>(this.db, 'SELECT * FROM merchant_profiles WHERE user_id = ?', [merchantUserId]);
  }

  async updateProfile(
    merchantUserId: string,
    patch: {
      displayName?: string | null;
      logoUrl?: string | null;
      supportContact?: string | null;
      supportUrl?: string | null;
      websiteUrl?: string | null;
      businessDescription?: string | null;
      telegramUsername?: string | null;
      telegramAlerts?: boolean;
    },
    actor: { userId: string | null; role: string | null; ip: string | null },
    requestId?: string,
  ): Promise<void> {
    const current = await this.profile(merchantUserId);
    if (!current) throw new AppError('NOT_FOUND', { message: 'پروفایل پذیرنده پیدا نشد.' });

    const timestamp = nowIso();
    await run(
      this.db,
      `UPDATE merchant_profiles SET
         display_name = ?, logo_url = ?, support_contact = ?, support_url = ?, website_url = ?,
         business_description = ?, telegram_username = ?, telegram_alerts = ?, updated_at = ?
       WHERE user_id = ?`,
      [
        patch.displayName === undefined ? current.display_name : patch.displayName,
        patch.logoUrl === undefined ? current.logo_url : patch.logoUrl,
        patch.supportContact === undefined ? current.support_contact : patch.supportContact,
        patch.supportUrl === undefined ? current.support_url : patch.supportUrl,
        patch.websiteUrl === undefined ? current.website_url : patch.websiteUrl,
        patch.businessDescription === undefined ? current.business_description : patch.businessDescription,
        patch.telegramUsername === undefined ? current.telegram_username : patch.telegramUsername,
        patch.telegramAlerts === undefined ? current.telegram_alerts : patch.telegramAlerts ? 1 : 0,
        timestamp,
        merchantUserId,
      ],
    );

    // Changing the Telegram username invalidates the ownership verification: the new
    // handle has not been proven to belong to this merchant.
    if (patch.telegramUsername !== undefined && patch.telegramUsername !== current.telegram_username) {
      await run(
        this.db,
        'UPDATE merchant_profiles SET telegram_verified = 0, telegram_user_id = NULL WHERE user_id = ?',
        [merchantUserId],
      );
    }

    await this.audit.record({
      event: 'merchant.profile_updated',
      actor,
      merchantUserId,
      targetType: 'merchant',
      targetId: merchantUserId,
      requestId: requestId ?? null,
      metadata: { fields: Object.keys(patch) },
    });
  }

  async linkTelegram(
    merchantUserId: string,
    input: { telegramUserId: string; username?: string | null },
  ): Promise<void> {
    await run(
      this.db,
      `UPDATE merchant_profiles SET telegram_user_id = ?, telegram_verified = 1, updated_at = ?
       WHERE user_id = ?`,
      [input.telegramUserId, nowIso(), merchantUserId],
    );
    await this.audit.record({
      event: 'merchant.telegram_linked',
      merchantUserId,
      targetType: 'merchant',
      targetId: merchantUserId,
      metadata: { telegramUserId: input.telegramUserId },
    });
  }

  // -------------------------------------------------------------------------
  // Admin lifecycle actions (§29)
  // -------------------------------------------------------------------------

  async applyAction(
    merchantUserId: string,
    action: MerchantAction,
    input: { reason?: string | null },
    actor: { userId: string; role: string; ip: string | null },
    requestId?: string,
  ): Promise<{
    status: string;
    rolesRevoked?: number;
    apiKeysRevoked?: number;
    temporaryPassword?: string;
    /**
     * Present only on the approval that created a key. The raw secret exists in this
     * return value and nowhere else — the database holds only its hash, so this is the
     * single moment it can be shown, and the operator is told so.
     */
    initialApiKey?: IssuedApiKey;
  }> {
    const user = await first<{ id: string; role: Role; status: string; mobile: string }>(
      this.db,
      'SELECT id, role, status, mobile FROM users WHERE id = ?',
      [merchantUserId],
    );
    if (!user) throw new AppError('NOT_FOUND', { message: 'پذیرنده پیدا نشد.' });

    const timestamp = nowIso();
    const reason = input.reason ?? null;

    const setStatus = async (status: string): Promise<void> => {
      await run(
        this.db,
        `UPDATE users SET status = ?, status_reason = ?, status_changed_by = ?, status_changed_at = ?, updated_at = ?
         WHERE id = ?`,
        [status, reason, actor.userId, timestamp, timestamp, merchantUserId],
      );
    };

    let apiKeysRevoked = 0;
    let temporaryPassword: string | undefined;

    switch (action) {
      case 'APPROVE': {
        if (user.status === 'ACTIVE') return { status: 'ACTIVE' };
        await setStatus('ACTIVE');
        await run(
          this.db,
          'UPDATE users SET approved_by = ?, approved_at = ? WHERE id = ?',
          [actor.userId, timestamp, merchantUserId],
        );
        await this.wallet.ensure(merchantUserId);
        await this.audit.record({
          event: 'merchant.approved',
          actor,
          merchantUserId,
          targetType: 'merchant',
          targetId: merchantUserId,
          requestId: requestId ?? null,
        });

        // Approval is where credentials come from (§4). Issuing here rather than asking an
        // operator to do it as a second step means a merchant cannot end up active with no
        // way to call the API — the state the previous version could reach.
        //
        // Guarded on "has no live key" rather than on "was just approved", so the two
        // paths that need it are both covered and neither duplicates work: approving a
        // previously rejected merchant, and approving one whose key was revoked during a
        // suspension. Re-approving an already-provisioned merchant is a no-op.
        const liveKeys = await scalar(
          this.db,
          'SELECT COUNT(*) AS count FROM api_keys WHERE merchant_user_id = ? AND revoked_at IS NULL',
          [merchantUserId],
        );
        if (liveKeys === 0) {
          const issued = await this.apiKeys.issue({
            merchantUserId,
            environment: 'live',
            label: 'کلید اصلی',
            createdBy: actor.userId,
            requestId: requestId ?? null,
            actor,
          });
          return { status: 'ACTIVE', initialApiKey: issued };
        }

        return { status: 'ACTIVE' };
      }
      case 'REJECT': {
        await setStatus('REJECTED');
        await this.audit.record({
          event: 'merchant.rejected',
          actor,
          merchantUserId,
          targetType: 'merchant',
          targetId: merchantUserId,
          requestId: requestId ?? null,
          severity: 'WARNING',
          metadata: { reason },
        });
        return { status: 'REJECTED' };
      }
      case 'SUSPEND': {
        await setStatus('SUSPENDED');
        // A suspended merchant must not be able to keep creating invoices, so live
        // API keys are revoked rather than merely checked at request time.
        apiKeysRevoked = await this.revokeKeys(merchantUserId, 'MERCHANT_SUSPENDED');
        await this.audit.record({
          event: 'merchant.suspended',
          actor,
          merchantUserId,
          targetType: 'merchant',
          targetId: merchantUserId,
          requestId: requestId ?? null,
          severity: 'CRITICAL',
          metadata: { reason, apiKeysRevoked },
        });
        return { status: 'SUSPENDED', apiKeysRevoked };
      }
      case 'BAN': {
        await setStatus('BANNED');
        apiKeysRevoked = await this.revokeKeys(merchantUserId, 'MERCHANT_BANNED');
        await run(
          this.db,
          'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL',
          [timestamp, 'MERCHANT_BANNED', merchantUserId],
        );
        // An in-flight invoice for a banned merchant is a liability: the money may
        // arrive at a card the platform can no longer reconcile against.
        const cancelled = await run(
          this.db,
          `UPDATE invoices SET status = 'CANCELLED', cancelled_at = ?, updated_at = ?
           WHERE merchant_user_id = ? AND status IN ('CREATED','PENDING')`,
          [timestamp, timestamp, merchantUserId],
        );
        await this.audit.record({
          event: 'merchant.banned',
          actor,
          merchantUserId,
          targetType: 'merchant',
          targetId: merchantUserId,
          requestId: requestId ?? null,
          severity: 'CRITICAL',
          metadata: { reason, apiKeysRevoked, invoicesCancelled: cancelled.changes },
        });
        return { status: 'BANNED', apiKeysRevoked };
      }
      case 'REACTIVATE': {
        await setStatus('ACTIVE');
        await this.audit.record({
          event: 'merchant.reactivated',
          actor,
          merchantUserId,
          targetType: 'merchant',
          targetId: merchantUserId,
          requestId: requestId ?? null,
          severity: 'WARNING',
          metadata: { reason },
        });
        return { status: 'ACTIVE' };
      }
      case 'RESET': {
        temporaryPassword = await resetUserPassword(
          { db: this.db, audit: this.audit },
          merchantUserId,
          { userId: actor.userId, role: actor.role, ip: actor.ip },
          requestId,
        );
        await this.audit.record({
          event: 'merchant.reset',
          actor,
          merchantUserId,
          targetType: 'merchant',
          targetId: merchantUserId,
          requestId: requestId ?? null,
          severity: 'CRITICAL',
          metadata: { reason },
        });
        return { status: user.status, temporaryPassword };
      }
      default: {
        const exhaustive: never = action;
        throw new AppError('INVALID_REQUEST', { details: { action: exhaustive } });
      }
    }
  }

  private async revokeKeys(merchantUserId: string, reason: string): Promise<number> {
    const result = await run(
      this.db,
      'UPDATE api_keys SET revoked_at = ? WHERE merchant_user_id = ? AND revoked_at IS NULL',
      [nowIso(), merchantUserId],
    );
    void reason;
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // Admin listing
  // -------------------------------------------------------------------------

  async list(filters: {
    status?: string;
    role?: Role;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<MerchantSummary[]> {
    const clauses: string[] = ["u.role = 'MERCHANT'"];
    const params: unknown[] = [];

    if (filters.status) {
      clauses.push('u.status = ?');
      params.push(filters.status);
    }
    if (filters.search) {
      clauses.push('(u.mobile LIKE ? OR mp.merchant_code LIKE ? OR mp.display_name LIKE ?)');
      const pattern = `%${filters.search}%`;
      params.push(pattern, pattern, pattern);
    }

    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);

    const rows = await all<{
      user_id: string;
      merchant_code: string;
      mobile: string;
      role: Role;
      status: string;
      display_name: string | null;
      business_type: string | null;
      telegram_username: string | null;
      telegram_verified: number;
      created_at: string;
      approved_at: string | null;
      last_login_at: string | null;
      wallet_balance: number | null;
      invoice_count: number | null;
    }>(
      this.db,
      `SELECT
         u.id AS user_id, COALESCE(mp.merchant_code, '—') AS merchant_code, u.mobile, u.role, u.status,
         mp.display_name, mp.business_type, mp.telegram_username, COALESCE(mp.telegram_verified, 0) AS telegram_verified,
         u.created_at, u.approved_at, u.last_login_at,
         (SELECT balance FROM wallets w WHERE w.merchant_user_id = u.id) AS wallet_balance,
         (SELECT COUNT(*) FROM invoices i WHERE i.merchant_user_id = u.id) AS invoice_count
       FROM users u
       LEFT JOIN merchant_profiles mp ON mp.user_id = u.id
       WHERE ${clauses.join(' AND ')}
       ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return rows.map((row) => ({
      userId: row.user_id,
      merchantCode: row.merchant_code,
      mobile: row.mobile,
      role: row.role,
      status: row.status,
      displayName: row.display_name,
      businessType: row.business_type,
      telegramUsername: row.telegram_username,
      telegramVerified: row.telegram_verified === 1,
      createdAt: row.created_at,
      approvedAt: row.approved_at,
      lastLoginAt: row.last_login_at,
      walletBalance: row.wallet_balance ?? 0,
      invoiceCount: row.invoice_count ?? 0,
      totalVolume: 0,
    }));
  }

  async statusCounts(): Promise<Record<string, number>> {
    const rows = await all<{ status: string; count: number }>(
      this.db,
      `SELECT status, COUNT(*) AS count FROM users WHERE role = 'MERCHANT' GROUP BY status`,
    );
    const out: Record<string, number> = {
      PENDING_APPROVAL: 0,
      ACTIVE: 0,
      REJECTED: 0,
      SUSPENDED: 0,
      BANNED: 0,
    };
    for (const row of rows) out[row.status] = row.count;
    return out;
  }

  async detail(merchantUserId: string): Promise<Record<string, unknown> | null> {
    const user = await first<Record<string, unknown>>(
      this.db,
      `SELECT u.id, u.mobile, u.email, u.role, u.status, u.status_reason, u.created_at, u.approved_at,
              u.last_login_at, u.last_login_ip, u.must_change_password,
              mp.merchant_code, mp.business_type, mp.business_description, mp.display_name, mp.logo_url,
              mp.support_contact, mp.telegram_username, mp.telegram_verified, mp.telegram_alerts
       FROM users u LEFT JOIN merchant_profiles mp ON mp.user_id = u.id
       WHERE u.id = ?`,
      [merchantUserId],
    );
    if (!user) return null;

    const [wallet, counts] = await Promise.all([
      this.wallet.snapshot(merchantUserId),
      this.invoiceCounts(merchantUserId),
    ]);

    return { ...user, wallet, invoiceCounts: counts };
  }

  async invoiceCounts(merchantUserId: string): Promise<Record<string, number>> {
    const rows = await all<{ status: string; count: number }>(
      this.db,
      'SELECT status, COUNT(*) AS count FROM invoices WHERE merchant_user_id = ? GROUP BY status',
      [merchantUserId],
    );
    const out: Record<string, number> = {};
    for (const row of rows) out[row.status] = row.count;
    return out;
  }

  async activeMerchantIds(): Promise<string[]> {
    const rows = await all<{ id: string }>(
      this.db,
      `SELECT id FROM users WHERE role = 'MERCHANT' AND status = 'ACTIVE'`,
    );
    return rows.map((row) => row.id);
  }

  async telegramRecipients(): Promise<Array<{ userId: string; chatId: string }>> {
    const rows = await all<{ user_id: string; telegram_user_id: string }>(
      this.db,
      `SELECT mp.user_id, mp.telegram_user_id
       FROM merchant_profiles mp JOIN users u ON u.id = mp.user_id
       WHERE mp.telegram_verified = 1 AND mp.telegram_alerts = 1 AND mp.telegram_user_id IS NOT NULL
         AND u.status = 'ACTIVE'`,
    );
    return rows.map((row) => ({ userId: row.user_id, chatId: row.telegram_user_id }));
  }

  /**
   * The gate every machine request passes through (§40).
   *
   * An API key outlives the account state it was issued under: suspending a merchant
   * must stop their `makePayment` calls immediately, not merely hide their dashboard.
   * Checking the account status on each request — rather than only inside the login
   * flow — is what makes suspension real.
   *
   * The thrown code is specific so a merchant can tell "you were suspended" from "your
   * account was never approved", which are very different conversations.
   */
  async assertUsable(userId: string): Promise<void> {
    const row = await first<{ status: string; role: string }>(
      this.db,
      'SELECT status, role FROM users WHERE id = ?',
      [userId],
    );

    // A key that authenticates but resolves to no user is a broken invariant, not a
    // pending account. Treat it as unauthenticated so nothing downstream assumes a user.
    if (!row) throw new AppError('UNAUTHENTICATED', { message: 'این کلید API به حساب معتبری متصل نیست.' });
    if (row.status === 'ACTIVE' || row.role !== 'MERCHANT') return;

    switch (row.status) {
      case 'PENDING_APPROVAL':
        throw new AppError('ACCOUNT_PENDING_APPROVAL');
      case 'REJECTED':
        throw new AppError('ACCOUNT_REJECTED');
      case 'SUSPENDED':
        throw new AppError('ACCOUNT_SUSPENDED');
      case 'BANNED':
        throw new AppError('ACCOUNT_BANNED');
      default:
        throw new AppError('FORBIDDEN');
    }
  }

  async pendingCount(): Promise<number> {
    return scalar(this.db, `SELECT COUNT(*) AS count FROM users WHERE role = 'MERCHANT' AND status = 'PENDING_APPROVAL'`);
  }

  // -------------------------------------------------------------------------
  // Setup wizard (§46)
  // -------------------------------------------------------------------------

  /**
   * Computes wizard progress from real state rather than from a stored flag, so a
   * merchant who deactivates their only card sees their setup drop below 100%
   * instead of remaining "ready" while being unable to take a payment.
   */
  async setupProgress(merchantUserId: string): Promise<SetupProgress> {
    const [user, , activeCards, activeKeys, hasCallback, smsVerified, testRun, wallet] = await Promise.all([
      first<{ status: string }>(this.db, 'SELECT status FROM users WHERE id = ?', [merchantUserId]),
      this.profile(merchantUserId),
      scalar(this.db, 'SELECT COUNT(*) AS count FROM bank_cards WHERE merchant_user_id = ? AND is_active = 1', [merchantUserId]),
      scalar(this.db, 'SELECT COUNT(*) AS count FROM api_keys WHERE merchant_user_id = ? AND revoked_at IS NULL', [merchantUserId]),
      scalar(
        this.db,
        'SELECT COUNT(*) AS count FROM webhook_endpoints WHERE merchant_user_id = ? AND is_active = 1',
        [merchantUserId],
      ),
      scalar(
        this.db,
        `SELECT COUNT(*) AS count FROM sms_test_tokens WHERE merchant_user_id = ? AND verified_at IS NOT NULL`,
        [merchantUserId],
      ),
      first<{ status: string }>(
        this.db,
        'SELECT status FROM test_runs WHERE merchant_user_id = ? ORDER BY created_at DESC LIMIT 1',
        [merchantUserId],
      ),
      this.wallet.snapshot(merchantUserId),
    ]);

    const feeMode = await first<{ value: string }>(
      this.db,
      `SELECT value FROM merchant_settings WHERE merchant_user_id = ? AND key = 'invoices.fee_mode'`,
      [merchantUserId],
    );

    const steps = [
      { key: 'account', title: 'وضعیت حساب', done: user?.status === 'ACTIVE' },
      { key: 'api_key', title: 'کلید API', done: activeKeys > 0 },
      { key: 'card', title: 'کارت بانکی', done: activeCards > 0 },
      {
        key: 'settings',
        title: 'تنظیمات پرداخت',
        done: Boolean(feeMode?.value),
        detail: feeMode?.value ? undefined : 'حالت کارمزد و مدت اعتبار فاکتور را انتخاب کنید.',
      },
      { key: 'callback', title: 'آدرس بازگشت', done: hasCallback > 0 },
      {
        key: 'sms',
        title: 'فورواردر پیامک',
        done: smsVerified > 0,
        detail: smsVerified > 0 ? undefined : 'توکن آزمایشی را در برنامه فورواردر تنظیم کنید.',
      },
      { key: 'pipeline', title: 'آزمون کامل مسیر پرداخت', done: testRun?.status === 'PASSED' },
    ];

    const doneCount = steps.filter((step) => step.done).length;
    // The wallet check is part of readiness but not a wizard step, because it is
    // only required in MERCHANT fee mode.
    const walletOk = feeMode?.value === 'MERCHANT' ? wallet.availableBalance > 0 : true;

    return {
      percent: Math.round((doneCount / steps.length) * 100),
      steps,
      ready: doneCount === steps.length && walletOk,
    };
  }
}
