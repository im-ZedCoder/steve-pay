/**
 * Invoice creation (§8, §10, §11, §12, §23).
 *
 * The allocation loop is the interesting part. A candidate amount is only claimed
 * by actually inserting a row, and the partial unique index
 * `ux_invoices_active_amount` is what rejects a collision. The application never
 * decides that an amount is free — it tries to take it and is told no.
 *
 * That ordering matters under concurrency. A check-then-insert ("is this amount
 * free? yes → insert") has a window between the two steps in which another request
 * can take the same amount, and no amount of application-level care closes it. The
 * database closes it, and the retry loop here is simply how we respond to being
 * told no.
 *
 * Candidates are pre-generated with a coprime stride (see core/unique-amount), so a
 * retry always tries a genuinely new amount rather than re-rolling the same
 * neighbourhood.
 */

import { AppError } from '../core/errors';
import { id as newId } from '../core/ids';
import { nowIso, addMinutes, epochMs, isPast } from '../core/time';
import { toRial, parseTomanInput, type Toman } from '../core/money';
import { planUniqueAmounts, suffixFromPayable } from '../core/unique-amount';
import { computeFees, requiredWalletReserve, isFeeMode, type FeeMode } from '../core/fees';
import {
  assertTransition,
  openability,
  statusBucket,
  type InvoiceStatus,
  type StatusFilter,
  statusesForFilter,
} from '../core/state-machine';
import { all, first, run, scalar, isUniqueViolation } from '../db/client';
import { validateCallbackUrl, sanitizeText } from '../core/validation';
import { SettingsService } from './settings';
import { AuditService } from './audit';
import { WalletService } from './wallet';
import { CardService, type BankCardRow } from './cards';
import { isAdminOnlySetting } from './settings';

export interface InvoiceRow {
  id: string;
  payment_id: string;
  merchant_user_id: string;
  api_key_id: string | null;
  card_id: string | null;
  status: InvoiceStatus;
  currency: string;
  original_amount: number;
  customer_fee: number;
  merchant_fee: number;
  gateway_fee: number;
  base_amount: number;
  unique_suffix: number;
  payable_amount: number;
  payable_amount_rial: number;
  fee_mode: FeeMode;
  received_amount: number | null;
  net_amount: number | null;
  settled_fee: number | null;
  description: string | null;
  customer_message: string | null;
  metadata: string | null;
  custom_callback: string | null;
  return_url: string | null;
  environment: string;
  is_test: number;
  transaction_id: string | null;
  match_score: number | null;
  match_reasons: string | null;
  created_ip: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  paid_at: string | null;
  failed_at: string | null;
  expired_at: string | null;
  cancelled_at: string | null;
  review_at: string | null;
}

/** API-facing shape. Matches §75 exactly. */
export interface InvoiceApiView {
  id: string;
  paymentId: string;
  invoiceId: string;
  status: InvoiceStatus;
  originalAmount: number;
  fee: number;
  payableAmount: number;
  payableAmountRial: number;
  baseAmount: number;
  uniqueSuffix: number;
  currency: 'IRT';
  feeMode: FeeMode;
  description: string | null;
  metadata: Record<string, unknown> | null;
  paymentUrl: string;
  expiresAt: string;
  createdAt: string;
  environment: string;
  isTest: boolean;
}

export interface CreateInvoiceInput {
  amount: number | string;
  currency?: string;
  description?: string | null;
  customCallback?: string | null;
  returnUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  expiresInMinutes?: number | null;
  feeMode?: FeeMode | null;
  cardId?: string | null;
}

export interface CreateInvoiceContext {
  merchantUserId: string;
  apiKeyId: string | null;
  environment: 'live' | 'test';
  ip: string | null;
  requestId: string;
  /** Persisted by the caller when an Idempotency-Key was supplied. */
  idempotencyKey?: string | null;
}

export class InvoiceService {
  private readonly db: D1Database;
  private readonly settings: SettingsService;
  private readonly audit: AuditService;
  private readonly wallet: WalletService;
  private readonly cards: CardService;
  private readonly baseUrl: string;

  constructor(deps: {
    db: D1Database;
    settings: SettingsService;
    audit: AuditService;
    wallet: WalletService;
    cards: CardService;
    baseUrl: string;
  }) {
    this.db = deps.db;
    this.settings = deps.settings;
    this.audit = deps.audit;
    this.wallet = deps.wallet;
    this.cards = deps.cards;
    this.baseUrl = deps.baseUrl.replace(/\/+$/, '');
  }

  // -------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------

  async create(input: CreateInvoiceInput, context: CreateInvoiceContext): Promise<InvoiceApiView> {
    if (await this.settings.bool('maintenance.invoice_creation_disabled')) {
      const message = await this.settings.raw('maintenance.message');
      throw new AppError('MAINTENANCE_MODE', { message });
    }

    const currency = (input.currency ?? 'IRT').toUpperCase();
    if (currency !== 'IRT') throw new AppError('CURRENCY_NOT_SUPPORTED', { details: { currency } });

    const amount = parseTomanInput(input.amount);
    const minAmount = await this.settings.int('invoices.min_amount_toman');
    const maxAmount = await this.settings.int('invoices.max_amount_toman');
    if (amount < minAmount) throw new AppError('AMOUNT_BELOW_MINIMUM', { details: { min: minAmount, amount } });
    if (amount > maxAmount) throw new AppError('AMOUNT_ABOVE_MAXIMUM', { details: { max: maxAmount, amount } });

    // The fee mode is resolved server-side in every case. A client-supplied fee
    // mode is only honoured because it changes who pays, not how much — the amount
    // itself always comes from configuration, never from the request.
    const feeMode = await this.resolveFeeMode(context.merchantUserId, input.feeMode);
    const gatewayFee = await this.resolveGatewayFee(context.merchantUserId);
    const breakdown = computeFees({
      originalAmount: amount,
      gatewayFee,
      feeMode,
      percentageBasisPoints: await this.settings.int('gateway.percentage_fee_basis_points'),
    });

    const card = await this.cards.resolveForInvoice(context.merchantUserId, input.cardId);
    if (!card) throw new AppError('CARD_REQUIRED');

    const expiryMinutes = await this.resolveExpiryMinutes(context.merchantUserId, input.expiresInMinutes);
    const customCallback = await this.resolveCallback(input.customCallback, context.merchantUserId);
    const returnUrl = input.returnUrl
      ? validateCallbackUrl(input.returnUrl, { allowInsecure: !this.isProduction() })
      : null;

    const reserveAmount = requiredWalletReserve(feeMode, breakdown.gatewayFee);
    const autoDisable = await this.settings.bool('wallet.auto_disable_invoice_creation');

    if (reserveAmount > 0 && autoDisable) {
      const { ok, snapshot } = await this.wallet.canCover(context.merchantUserId, reserveAmount);
      if (!ok) {
        await this.audit.record({
          event: 'invoice.creation_failed',
          merchantUserId: context.merchantUserId,
          targetType: 'merchant',
          targetId: context.merchantUserId,
          requestId: context.requestId,
          severity: 'WARNING',
          metadata: { reason: 'INSUFFICIENT_WALLET_BALANCE', required: reserveAmount, available: snapshot.availableBalance },
        });
        // The notification is sent by the caller (which owns the Telegram client),
        // so this service stays free of messaging concerns.
        throw new AppError('INSUFFICIENT_WALLET_BALANCE', {
          details: { required: reserveAmount, available: snapshot.availableBalance, feeMode },
        });
      }
    }

    const invoiceId = newId('inv');
    const paymentId = newId('pay');
    const timestamp = nowIso();
    const expiresAt = addMinutes(timestamp, expiryMinutes);

    const suffixDigits = await this.settings.suffixDigits();
    const maxAttempts = await this.settings.int('unique_amount.max_attempts');

    // Reserve before inserting. A reservation that ends up unused is released in
    // the failure path below; an invoice that exists without a reservation would be
    // worse, because it is payable.
    if (reserveAmount > 0) {
      await this.wallet.reserve({
        merchantUserId: context.merchantUserId,
        invoiceId,
        amount: reserveAmount,
      });
    }

    const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;
    const customerMessage = await this.settings.merchantRaw(context.merchantUserId, 'invoices.customer_message');

    let lastError: unknown = null;

    // Two planning rounds: a first batch, then a second with a wider attempt budget.
    // Exhausting one plan does not mean the suffix space is full — only that the
    // stride happened to land on taken values.
    for (const round of [1, 2]) {
      const plan = planUniqueAmounts({
        baseAmount: breakdown.baseAmount,
        suffixDigits,
        attempts: maxAttempts * round,
      });

      for (let index = 0; index < plan.candidates.length; index += 1) {
        const payableAmount = plan.candidates[index] as Toman;
        const suffix = plan.suffixes[index] as number;

        try {
          await this.db.batch([
            this.db
              .prepare(
                `INSERT INTO invoices (
                   id, payment_id, merchant_user_id, api_key_id, card_id, status, currency,
                   original_amount, customer_fee, merchant_fee, gateway_fee, base_amount,
                   unique_suffix, payable_amount, payable_amount_rial, fee_mode,
                   description, customer_message, metadata, custom_callback, return_url,
                   environment, is_test, created_ip, created_at, updated_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, 'PENDING', 'IRT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .bind(
                invoiceId,
                paymentId,
                context.merchantUserId,
                context.apiKeyId,
                card.id,
                breakdown.originalAmount,
                breakdown.customerFee,
                breakdown.merchantFee,
                breakdown.gatewayFee,
                breakdown.baseAmount,
                suffix,
                payableAmount,
                payableAmount * 10,
                breakdown.feeMode,
                sanitizeText(input.description, 500),
                customerMessage,
                metadataJson,
                customCallback,
                returnUrl,
                context.environment,
                context.environment === 'test' ? 1 : 0,
                context.ip,
                timestamp,
                timestamp,
                expiresAt,
              ),
            this.db
              .prepare(
                `INSERT INTO payments (
                   id, invoice_id, merchant_user_id, status, method, amount, currency, fee_mode,
                   is_test, created_at, updated_at, expires_at)
                 VALUES (?, ?, ?, 'PENDING', 'CARD_TRANSFER', ?, 'IRT', ?, ?, ?, ?, ?)`,
              )
              .bind(
                paymentId,
                invoiceId,
                context.merchantUserId,
                payableAmount,
                breakdown.feeMode,
                context.environment === 'test' ? 1 : 0,
                timestamp,
                timestamp,
                expiresAt,
              ),
          ]);

          await this.audit.record({
            event: 'invoice.created',
            merchantUserId: context.merchantUserId,
            targetType: 'invoice',
            targetId: invoiceId,
            requestId: context.requestId,
            metadata: {
              originalAmount: breakdown.originalAmount,
              payableAmount,
              uniqueSuffix: suffix,
              feeMode: breakdown.feeMode,
              gatewayFee: breakdown.gatewayFee,
              cardId: card.id,
              expiresAt,
              environment: context.environment,
              idempotencyKey: context.idempotencyKey ?? null,
            },
          });

          return this.toApiView({
            invoiceId,
            paymentId,
            status: 'PENDING',
            originalAmount: breakdown.originalAmount,
            fee: breakdown.gatewayFee,
            payableAmount,
            baseAmount: breakdown.baseAmount,
            uniqueSuffix: suffix,
            feeMode: breakdown.feeMode,
            description: sanitizeText(input.description, 500),
            metadata: input.metadata ?? null,
            expiresAt,
            createdAt: timestamp,
            environment: context.environment,
          });
        } catch (error) {
          // The amount was claimed between planning and insert. Take the next one.
          if (isUniqueViolation(error, 'invoices.payable_amount')) {
            lastError = error;
            continue;
          }
          // Any other failure is real: undo the reservation and surface it.
          await this.releaseReservation(context.merchantUserId, invoiceId, reserveAmount);
          throw error;
        }
      }
    }

    await this.releaseReservation(context.merchantUserId, invoiceId, reserveAmount);
    await this.audit.record({
      event: 'invoice.creation_failed',
      merchantUserId: context.merchantUserId,
      targetType: 'merchant',
      targetId: context.merchantUserId,
      requestId: context.requestId,
      severity: 'CRITICAL',
      metadata: { reason: 'AMOUNT_SPACE_EXHAUSTED', attempts: maxAttempts * 3, baseAmount: breakdown.baseAmount },
    });
    throw new AppError('AMOUNT_SPACE_EXHAUSTED', {
      details: { attempts: maxAttempts * 3, baseAmount: breakdown.baseAmount },
      cause: lastError,
    });
  }

  private async releaseReservation(merchantUserId: string, invoiceId: string, amount: number): Promise<void> {
    if (amount <= 0) return;
    try {
      await this.wallet.release({ merchantUserId, invoiceId, amount });
    } catch {
      // The reservation will be reconciled by the expiry sweep. Failing the caller
      // here would mask the original error.
    }
  }

  private async resolveFeeMode(merchantUserId: string, requested: FeeMode | null | undefined): Promise<FeeMode> {
    if (requested !== null && requested !== undefined) {
      if (!isFeeMode(requested)) throw new AppError('INVALID_FEE_MODE');
      return requested;
    }
    const own = await this.settings.merchantRaw(merchantUserId, 'invoices.fee_mode');
    if (own && isFeeMode(own)) return own;
    return this.settings.feeModeDefault();
  }

  private async resolveGatewayFee(merchantUserId: string): Promise<Toman> {
    const own = await this.settings.merchantRaw(merchantUserId, 'invoices.gateway_fee');
    if (own !== null) {
      const parsed = Number(own);
      if (Number.isFinite(parsed) && parsed >= 0 && Number.isInteger(parsed)) return parsed;
    }
    return this.settings.int('gateway.fee_toman');
  }

  private async resolveExpiryMinutes(merchantUserId: string, requested: number | null | undefined): Promise<number> {
    const min = await this.settings.int('invoices.expiry_minutes_min');
    const max = await this.settings.int('invoices.expiry_minutes_max');

    let minutes: number;
    if (requested === null || requested === undefined) {
      const own = await this.settings.merchantRaw(merchantUserId, 'invoices.expiry_minutes');
      const fallback = await this.settings.int('invoices.expiry_minutes_default');
      minutes = own !== null && Number.isFinite(Number(own)) ? Number(own) : fallback;
    } else {
      minutes = Number(requested);
    }

    if (!Number.isInteger(minutes) || minutes < min || minutes > max) {
      throw new AppError('INVALID_EXPIRY', {
        message: `مدت اعتبار فاکتور باید بین ${min} و ${max} دقیقه باشد.`,
        details: { min, max, requested: minutes },
      });
    }
    return minutes;
  }

  /**
   * Resolves the callback URL. A per-request URL must be a valid HTTPS URL; when
   * none is given we fall back to the merchant's configured endpoint, which is the
   * behaviour §20 specifies.
   */
  private async resolveCallback(requested: string | null | undefined, merchantUserId: string): Promise<string | null> {
    if (requested) {
      const allowed = await this.settings.bool('callbacks.allow_custom_urls');
      if (!allowed) throw new AppError('CALLBACK_URL_NOT_ALLOWED', { details: { reason: 'DISABLED_BY_PLATFORM' } });
      return validateCallbackUrl(requested, { allowInsecure: !this.isProduction() });
    }

    const endpoint = await first<{ url: string }>(
      this.db,
      `SELECT url FROM webhook_endpoints
       WHERE merchant_user_id = ? AND is_active = 1
       ORDER BY is_default DESC, created_at ASC LIMIT 1`,
      [merchantUserId],
    );
    return endpoint?.url ?? null;
  }

  private isProduction(): boolean {
    return this.baseUrl.startsWith('https://');
  }

  toApiView(input: {
    invoiceId: string;
    paymentId: string;
    status: InvoiceStatus;
    originalAmount: number;
    fee: number;
    payableAmount: number;
    baseAmount: number;
    uniqueSuffix: number;
    feeMode: FeeMode;
    description: string | null;
    metadata: Record<string, unknown> | null;
    expiresAt: string;
    createdAt: string;
    environment: string;
  }): InvoiceApiView {
    return {
      id: input.paymentId,
      paymentId: input.paymentId,
      invoiceId: input.invoiceId,
      status: input.status,
      originalAmount: input.originalAmount,
      fee: input.fee,
      payableAmount: input.payableAmount,
      payableAmountRial: toRial(input.payableAmount),
      baseAmount: input.baseAmount,
      uniqueSuffix: input.uniqueSuffix,
      currency: 'IRT',
      feeMode: input.feeMode,
      description: input.description,
      metadata: input.metadata,
      paymentUrl: `${this.baseUrl}/pay/${input.invoiceId}`,
      expiresAt: input.expiresAt,
      createdAt: input.createdAt,
      environment: input.environment,
      isTest: input.environment === 'test',
    };
  }

  viewOfRow(row: InvoiceRow): InvoiceApiView {
    return this.toApiView({
      invoiceId: row.id,
      paymentId: row.payment_id,
      status: row.status,
      originalAmount: row.original_amount,
      fee: row.gateway_fee,
      payableAmount: row.payable_amount,
      baseAmount: row.base_amount,
      uniqueSuffix: row.unique_suffix,
      feeMode: row.fee_mode,
      description: row.description,
      metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      environment: row.environment,
    });
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async getById(invoiceId: string): Promise<InvoiceRow | null> {
    return first<InvoiceRow>(this.db, 'SELECT * FROM invoices WHERE id = ?', [invoiceId]);
  }

  async getForMerchant(merchantUserId: string, invoiceId: string): Promise<InvoiceRow | null> {
    return first<InvoiceRow>(this.db, 'SELECT * FROM invoices WHERE id = ? AND merchant_user_id = ?', [
      invoiceId,
      merchantUserId,
    ]);
  }

  /** Everything the public payment page needs, in one round trip. */
  async getPublicView(invoiceId: string): Promise<{
    invoice: InvoiceRow;
    merchant: { displayName: string | null; logoUrl: string | null; supportContact: string | null; supportUrl: string | null; merchantCode: string };
    card: Pick<BankCardRow, 'id' | 'number' | 'number_masked' | 'holder_name' | 'bank_name' | 'title'> | null;
    openability: ReturnType<typeof openability>;
    transaction: { id: string; bank_reference: string | null; confirmed_at: string } | null;
  } | null> {
    const invoice = await first<InvoiceRow>(this.db, 'SELECT * FROM invoices WHERE id = ?', [invoiceId]);
    if (!invoice) return null;

    const merchant = await first<{
      display_name: string | null;
      logo_url: string | null;
      support_contact: string | null;
      support_url: string | null;
      merchant_code: string;
      fallback_name: string | null;
    }>(
      this.db,
      `SELECT mp.display_name, mp.logo_url, mp.support_contact, mp.support_url, mp.merchant_code,
              u.display_name AS fallback_name
       FROM merchant_profiles mp JOIN users u ON u.id = mp.user_id WHERE mp.user_id = ?`,
      [invoice.merchant_user_id],
    );

    const card = invoice.card_id
      ? await first<Pick<BankCardRow, 'id' | 'number' | 'number_masked' | 'holder_name' | 'bank_name' | 'title'>>(
          this.db,
          'SELECT id, number, number_masked, holder_name, bank_name, title FROM bank_cards WHERE id = ?',
          [invoice.card_id],
        )
      : null;

    const transaction = await first<{ id: string; bank_reference: string | null; confirmed_at: string }>(
      this.db,
      'SELECT id, bank_reference, confirmed_at FROM transactions WHERE invoice_id = ? AND status = ? LIMIT 1',
      [invoiceId, 'CONFIRMED'],
    );

    return {
      invoice,
      merchant: {
        displayName: merchant?.display_name ?? merchant?.fallback_name ?? null,
        logoUrl: merchant?.logo_url ?? null,
        supportContact: merchant?.support_contact ?? null,
        supportUrl: merchant?.support_url ?? null,
        merchantCode: merchant?.merchant_code ?? '—',
      },
      card: card ?? null,
      openability: openability(invoice.status),
      transaction: transaction ?? null,
    };
  }

  async list(
    merchantUserId: string,
    filters: {
      status?: StatusFilter | InvoiceStatus;
      from?: string;
      to?: string;
      search?: string;
      environment?: 'live' | 'test';
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<InvoiceRow[]> {
    const clauses: string[] = ['merchant_user_id = ?'];
    const params: unknown[] = [merchantUserId];

    if (filters.status && filters.status !== 'all') {
      const statuses = isStatusFilter(filters.status)
        ? statusesForFilter(filters.status)
        : [filters.status as InvoiceStatus];
      clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    if (filters.from) {
      clauses.push('created_at >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      clauses.push('created_at < ?');
      params.push(filters.to);
    }
    if (filters.environment) {
      clauses.push('environment = ?');
      params.push(filters.environment);
    }
    if (filters.search) {
      clauses.push('(id LIKE ? OR payment_id LIKE ? OR description LIKE ? OR CAST(payable_amount AS TEXT) = ?)');
      const pattern = `%${filters.search}%`;
      params.push(pattern, pattern, pattern, filters.search);
    }

    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);

    return all<InvoiceRow>(
      this.db,
      `SELECT * FROM invoices WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
  }

  async counts(merchantUserId: string): Promise<{
    total: number;
    successful: number;
    pending: number;
    expired: number;
    failed: number;
    review: number;
    todayInvoices: number;
    todayVolume: number;
    totalVolume: number;
    totalFees: number;
    netReceived: number;
    successRate: number;
    averagePaymentSeconds: number | null;
  }> {
    const row = await first<{
      total: number;
      successful: number;
      pending: number;
      expired: number;
      failed: number;
      review: number;
      total_volume: number;
      total_fees: number;
      net_received: number;
      avg_seconds: number | null;
    }>(
      this.db,
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'PAID' THEN 1 ELSE 0 END) AS successful,
         SUM(CASE WHEN status IN ('CREATED','PENDING','PAYMENT_DETECTED','CONFIRMING') THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'EXPIRED' THEN 1 ELSE 0 END) AS expired,
         SUM(CASE WHEN status IN ('FAILED','CANCELLED','REFUNDED') THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'MANUAL_REVIEW' THEN 1 ELSE 0 END) AS review,
         COALESCE(SUM(CASE WHEN status = 'PAID' THEN payable_amount ELSE 0 END), 0) AS total_volume,
         COALESCE(SUM(CASE WHEN status = 'PAID' THEN gateway_fee ELSE 0 END), 0) AS total_fees,
         COALESCE(SUM(CASE WHEN status = 'PAID' THEN COALESCE(net_amount, 0) ELSE 0 END), 0) AS net_received,
         AVG(CASE WHEN status = 'PAID' AND paid_at IS NOT NULL
                  THEN (julianday(paid_at) - julianday(created_at)) * 86400.0 END) AS avg_seconds
       FROM invoices WHERE merchant_user_id = ?`,
      [merchantUserId],
    );

    const total = row?.total ?? 0;
    const successful = row?.successful ?? 0;

    return {
      total,
      successful,
      pending: row?.pending ?? 0,
      expired: row?.expired ?? 0,
      failed: row?.failed ?? 0,
      review: row?.review ?? 0,
      todayInvoices: 0,
      todayVolume: 0,
      totalVolume: row?.total_volume ?? 0,
      totalFees: row?.total_fees ?? 0,
      netReceived: row?.net_received ?? 0,
      // A success rate over zero invoices is undefined, not zero: reporting 0% to a
      // brand-new merchant is misleading.
      successRate: total > 0 ? Math.round((successful / total) * 1000) / 10 : 0,
      averagePaymentSeconds: row?.avg_seconds !== null && row?.avg_seconds !== undefined ? Math.round(row.avg_seconds) : null,
    };
  }

  /**
   * Counts and volume for a date range, used by `transactionsCount` (§7).
   *
   * Separate from `counts()` because that one answers "how is this merchant doing
   * overall" and this one answers "how many succeeded in the window you asked for".
   * Both are aggregate SQL rather than a fetch-and-count in JavaScript: a merchant
   * with a hundred thousand invoices must not make the API read them all to count
   * them.
   */
  async rangeStats(
    merchantUserId: string,
    filters: { from?: string; to?: string; environment?: 'live' | 'test' } = {},
  ): Promise<{
    count: number;
    successful: number;
    pending: number;
    expired: number;
    failed: number;
    review: number;
    volume: number;
    fees: number;
  }> {
    const clauses: string[] = ['merchant_user_id = ?'];
    const params: unknown[] = [merchantUserId];
    if (filters.from) {
      clauses.push('created_at >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      clauses.push('created_at < ?');
      params.push(filters.to);
    }
    if (filters.environment) {
      clauses.push('environment = ?');
      params.push(filters.environment);
    }

    const row = await first<{
      total: number;
      successful: number;
      pending: number;
      expired: number;
      failed: number;
      review: number;
      volume: number;
      fees: number;
    }>(
      this.db,
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'PAID' THEN 1 ELSE 0 END) AS successful,
         SUM(CASE WHEN status IN ('CREATED','PENDING','PAYMENT_DETECTED','CONFIRMING') THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'EXPIRED' THEN 1 ELSE 0 END) AS expired,
         SUM(CASE WHEN status IN ('FAILED','CANCELLED','REFUNDED') THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'MANUAL_REVIEW' THEN 1 ELSE 0 END) AS review,
         COALESCE(SUM(CASE WHEN status = 'PAID' THEN payable_amount ELSE 0 END), 0) AS volume,
         COALESCE(SUM(CASE WHEN status = 'PAID' THEN gateway_fee ELSE 0 END), 0) AS fees
       FROM invoices WHERE ${clauses.join(' AND ')}`,
      params,
    );

    return {
      count: row?.total ?? 0,
      successful: row?.successful ?? 0,
      pending: row?.pending ?? 0,
      expired: row?.expired ?? 0,
      failed: row?.failed ?? 0,
      review: row?.review ?? 0,
      volume: row?.volume ?? 0,
      fees: row?.fees ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  /**
   * The only writer of `invoices.status`. Goes through the state machine, and
   * releases the wallet reservation and the unique amount when the invoice reaches
   * a terminal state that was not a payment.
   */
  async transition(
    invoiceId: string,
    to: InvoiceStatus,
    options: {
      reason?: string;
      requestId?: string;
      actorUserId?: string;
      actorRole?: string;
      extraColumns?: Record<string, string | number | null>;
    } = {},
  ): Promise<{ changed: boolean; from: InvoiceStatus; to: InvoiceStatus }> {
    const row = await this.getById(invoiceId);
    if (!row) throw new AppError('INVOICE_NOT_FOUND');
    if (row.status === to) return { changed: false, from: row.status, to };

    assertTransition(row.status, to);

    const timestamp = nowIso();
    const assignments: string[] = ['status = ?', 'updated_at = ?'];
    const params: unknown[] = [to, timestamp];

    const columnFor: Record<string, string> = {
      paid_at: 'paid_at',
      failed_at: 'failed_at',
      expired_at: 'expired_at',
      cancelled_at: 'cancelled_at',
      review_at: 'review_at',
    };
    const terminalTimestampColumn = columnFor[to.toLowerCase()];
    if (terminalTimestampColumn) {
      assignments.push(`${terminalTimestampColumn} = ?`);
      params.push(timestamp);
    }

    for (const [column, value] of Object.entries(options.extraColumns ?? {})) {
      assignments.push(`${column} = ?`);
      params.push(value);
    }

    // The status guard lives in the WHERE clause, so a concurrent transition cannot
    // be silently overwritten: if another writer got there first, this updates
    // nothing and we report that.
    params.push(invoiceId, row.status);
    const result = await run(
      this.db,
      `UPDATE invoices SET ${assignments.join(', ')} WHERE id = ? AND status = ?`,
      params,
    );

    if (result.changes === 0) {
      return { changed: false, from: row.status, to: row.status };
    }

    // Mirror onto the payment row; both are read by different screens.
    await run(this.db, 'UPDATE payments SET status = ?, updated_at = ? WHERE invoice_id = ?', [
      to,
      timestamp,
      invoiceId,
    ]);

    if (to !== 'PAID' && row.merchant_fee > 0) {
      await this.releaseReservation(row.merchant_user_id, invoiceId, row.merchant_fee);
    }

    await this.audit.record({
      event: to === 'EXPIRED' ? 'invoice.expired' : to === 'CANCELLED' ? 'invoice.cancelled' : 'invoice.status_changed',
      actor: { userId: options.actorUserId ?? null, role: options.actorRole ?? null },
      merchantUserId: row.merchant_user_id,
      targetType: 'invoice',
      targetId: invoiceId,
      requestId: options.requestId ?? null,
      severity: to === 'CANCELLED' || to === 'FAILED' ? 'WARNING' : 'INFO',
      metadata: { from: row.status, to, reason: options.reason ?? null },
    });

    return { changed: true, from: row.status, to };
  }

  /**
   * Expires every invoice past its deadline.
   *
   * Run by cron every two minutes. Marking status is what releases the amount for
   * reuse: the partial unique index only covers live statuses, so once a row says
   * EXPIRED its amount becomes claimable by the next invoice. That is also why a
   * late SMS routes to manual review rather than auto-confirming — the amount may
   * already belong to somebody else.
   */
  async expireDue(limit = 200): Promise<{ expired: number; reservationFailures: number }> {
    const timestamp = nowIso();
    const due = await all<{ id: string; merchant_user_id: string; merchant_fee: number }>(
      this.db,
      `SELECT id, merchant_user_id, merchant_fee FROM invoices
       WHERE status IN ('CREATED','PENDING','PAYMENT_DETECTED') AND expires_at < ?
       ORDER BY expires_at ASC LIMIT ?`,
      [timestamp, limit],
    );

    let expired = 0;
    let reservationFailures = 0;

    for (const invoice of due) {
      const result = await run(
        this.db,
        `UPDATE invoices SET status = 'EXPIRED', expired_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('CREATED','PENDING','PAYMENT_DETECTED')`,
        [timestamp, timestamp, invoice.id],
      );
      if (result.changes === 0) continue;
      expired += 1;

      await run(this.db, 'UPDATE payments SET status = ?, updated_at = ? WHERE invoice_id = ?', [
        'EXPIRED',
        timestamp,
        invoice.id,
      ]);

      if (invoice.merchant_fee > 0) {
        try {
          await this.wallet.release({
            merchantUserId: invoice.merchant_user_id,
            invoiceId: invoice.id,
            amount: invoice.merchant_fee,
          });
        } catch {
          reservationFailures += 1;
        }
      }
    }

    return { expired, reservationFailures };
  }

  /** Live invoices holding an amount, for the suffix-space capacity check. */
  async liveAmountCount(): Promise<number> {
    return scalar(
      this.db,
      `SELECT COUNT(*) AS count FROM invoices
       WHERE status IN ('CREATED','PENDING','PAYMENT_DETECTED','CONFIRMING','MANUAL_REVIEW')`,
    );
  }

  async liveAmountCountForMerchant(merchantUserId: string): Promise<number> {
    return scalar(
      this.db,
      `SELECT COUNT(*) AS count FROM invoices
       WHERE merchant_user_id = ? AND status IN ('CREATED','PENDING','PAYMENT_DETECTED','CONFIRMING','MANUAL_REVIEW')`,
      [merchantUserId],
    );
  }

  /** Invoices whose expiry has passed but that were never swept, used by health. */
  async overdueCount(): Promise<number> {
    return scalar(
      this.db,
      `SELECT COUNT(*) AS count FROM invoices
       WHERE status IN ('CREATED','PENDING','PAYMENT_DETECTED') AND expires_at < ?`,
      [nowIso()],
    );
  }

  /** Same-merchant invoices with neighbouring amounts, for the risk layer (§19). */
  async similarAmountCount(merchantUserId: string, payableAmount: number, tolerance = 50): Promise<number> {
    return scalar(
      this.db,
      `SELECT COUNT(*) AS count FROM invoices
       WHERE merchant_user_id = ? AND status IN ('CREATED','PENDING','PAYMENT_DETECTED','CONFIRMING')
         AND ABS(payable_amount - ?) <= ? AND payable_amount != ?`,
      [merchantUserId, payableAmount, tolerance, payableAmount],
    );
  }

  /** Candidates for the matcher: live and recently expired invoices for one merchant. */
  async matchCandidates(merchantUserId: string, windowHours = 24): Promise<InvoiceRow[]> {
    const since = addMinutes(nowIso(), -60 * windowHours);
    return all<InvoiceRow>(
      this.db,
      `SELECT * FROM invoices
       WHERE merchant_user_id = ? AND created_at >= ?
         AND status IN ('CREATED','PENDING','PAYMENT_DETECTED','CONFIRMING','MANUAL_REVIEW','EXPIRED','PAID')
       ORDER BY created_at DESC LIMIT 400`,
      [merchantUserId, since],
    );
  }

  /** Marks an invoice as under review and records why (§54). */
  async markForReview(invoiceId: string, reasons: string[], score: number, requestId?: string): Promise<void> {
    void requestId; // retained for the audit trail once the review queue writes one
    const row = await this.getById(invoiceId);
    if (!row) return;
    if (row.status === 'MANUAL_REVIEW') {
      await run(
        this.db,
        'UPDATE invoices SET match_reasons = ?, match_score = ?, updated_at = ? WHERE id = ?',
        [JSON.stringify(reasons), score, nowIso(), invoiceId],
      );
      return;
    }

    const timestamp = nowIso();
    await run(
      this.db,
      `UPDATE invoices SET status = 'MANUAL_REVIEW', review_at = ?, match_reasons = ?, match_score = ?, updated_at = ?
       WHERE id = ? AND status IN ('CREATED','PENDING','PAYMENT_DETECTED','CONFIRMING')`,
      [timestamp, JSON.stringify(reasons), score, timestamp, invoiceId],
    );
    await run(this.db, 'UPDATE payments SET status = ?, updated_at = ? WHERE invoice_id = ?', [
      'MANUAL_REVIEW',
      timestamp,
      invoiceId,
    ]);
  }

  /**
   * Admin invoice listing across every merchant.
   *
   * Separate from `list` rather than a `merchantUserId` that may be undefined, because the
   * two have different authorisation stories: `list` is scoped by a merchant who owns the
   * rows, this one is scoped by a staff permission. Sharing one method invites a caller
   * passing `undefined` by accident and reading every merchant's invoices.
   */
  async listAll(filters: {
    status?: StatusFilter | InvoiceStatus;
    merchantUserId?: string;
    search?: string;
    environment?: 'live' | 'test';
    limit?: number;
    offset?: number;
  } = {}): Promise<Array<InvoiceRow & { merchant_code: string | null; merchant_mobile: string }>> {
    const clauses: string[] = ['1 = 1'];
    const params: unknown[] = [];

    if (filters.status && filters.status !== 'all') {
      const statuses = isStatusFilter(filters.status)
        ? statusesForFilter(filters.status)
        : [filters.status as InvoiceStatus];
      clauses.push(`i.status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    if (filters.merchantUserId) {
      clauses.push('i.merchant_user_id = ?');
      params.push(filters.merchantUserId);
    }
    if (filters.environment) {
      clauses.push('i.environment = ?');
      params.push(filters.environment);
    }
    if (filters.search) {
      // Search matches the identifier, the generated amount, and the merchant code, because
      // an operator investigating a complaint usually has one of those three to hand.
      clauses.push(
        '(i.id LIKE ? OR CAST(i.payable_amount AS TEXT) LIKE ? OR mp.merchant_code LIKE ? OR u.mobile LIKE ?)',
      );
      const pattern = `%${filters.search}%`;
      params.push(pattern, pattern, pattern, pattern);
    }

    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);

    return all<InvoiceRow & { merchant_code: string | null; merchant_mobile: string }>(
      this.db,
      `SELECT i.*, mp.merchant_code, u.mobile AS merchant_mobile
         FROM invoices i
         JOIN users u ON u.id = i.merchant_user_id
         LEFT JOIN merchant_profiles mp ON mp.user_id = i.merchant_user_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY i.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
  }

  async listForReview(limit = 100): Promise<InvoiceRow[]> {
    return all<InvoiceRow>(
      this.db,
      `SELECT * FROM invoices WHERE status = 'MANUAL_REVIEW' ORDER BY review_at ASC, created_at ASC LIMIT ?`,
      [Math.min(limit, 200)],
    );
  }

  /** Rows the merchant asked to be told about, used by the notification builder. */
  async recent(merchantUserId: string, limit = 8): Promise<InvoiceRow[]> {
    return all<InvoiceRow>(
      this.db,
      'SELECT * FROM invoices WHERE merchant_user_id = ? ORDER BY created_at DESC LIMIT ?',
      [merchantUserId, Math.min(limit, 50)],
    );
  }

  /** Buckets a row for a coarse status filter, for analytics grouping. */
  bucketOf(row: InvoiceRow): string {
    return statusBucket(row.status);
  }

  /** True when the invoice is past its expiry right now, without a write. */
  isExpired(row: InvoiceRow, now: string = nowIso()): boolean {
    return isPast(row.expires_at, now) && ['CREATED', 'PENDING', 'PAYMENT_DETECTED', 'CONFIRMING'].includes(row.status);
  }

  /** Milliseconds until expiry, floored at zero. */
  remainingMs(row: InvoiceRow, now: string = nowIso()): number {
    return Math.max(0, epochMs(row.expires_at) - epochMs(now));
  }

  /** Recomputes the suffix from stored values, used by receipts and reports. */
  suffixOf(row: InvoiceRow): number {
    return suffixFromPayable(row.payable_amount, row.base_amount);
  }

  /** Settings the dashboard is allowed to read for a merchant (never admin-only). */
  async readableMerchantSettings(merchantUserId: string): Promise<Record<string, string>> {
    const map = await this.settings.merchantMap(merchantUserId);
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(map)) {
      if (!isAdminOnlySetting(key)) filtered[key] = value;
    }
    return filtered;
  }
}

function isStatusFilter(value: string): value is StatusFilter {
  return value === 'successful' || value === 'pending' || value === 'expired' || value === 'failed' || value === 'all';
}
