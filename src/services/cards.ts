/**
 * Merchant bank cards (§9).
 *
 * A merchant's receiving cards are shown to customers, so the number is not a
 * secret — but it is still masked in every log line, every webhook payload and
 * every admin list. The only place the full number is rendered is the payment page
 * the merchant configured it for.
 *
 * `is_default` is guarded by a partial unique index, so the "which card do I use"
 * question always has at most one answer and two dashboard tabs cannot each set a
 * different default.
 */

import { AppError } from '../core/errors';
import { validateCardNumber, maskCardNumber, type CardRejection } from '../core/card';
import { sha256Hex } from '../core/crypto';
import { id as newId } from '../core/ids';
import { nowIso } from '../core/time';
import { all, first, run } from '../db/client';
import { isUniqueViolation } from '../db/client';
import { AuditService } from './audit';
import { SettingsService } from './settings';

export interface BankCardRow {
  id: string;
  merchant_user_id: string;
  number: string;
  number_hash: string;
  number_masked: string;
  title: string;
  bank_name: string | null;
  holder_name: string | null;
  is_active: number;
  is_default: number;
  display_order: number;
  success_count: number;
  failure_count: number;
  created_at: string;
  updated_at: string;
}

export interface BankCardView {
  id: string;
  title: string;
  bankName: string | null;
  holderName: string | null;
  /** Full number: only ever returned to the owning merchant and to the payment page. */
  number: string;
  masked: string;
  isActive: boolean;
  isDefault: boolean;
  displayOrder: number;
  successCount: number;
  failureCount: number;
  createdAt: string;
}

export class CardService {
  private readonly db: D1Database;
  private readonly audit: AuditService;
  private readonly settings: SettingsService;

  constructor(db: D1Database, audit: AuditService, settings: SettingsService) {
    this.db = db;
    this.audit = audit;
    this.settings = settings;
  }

  async list(merchantUserId: string): Promise<BankCardView[]> {
    const rows = await all<BankCardRow>(
      this.db,
      'SELECT * FROM bank_cards WHERE merchant_user_id = ? ORDER BY is_default DESC, display_order ASC, created_at ASC',
      [merchantUserId],
    );
    return rows.map(toView);
  }

  async listActive(merchantUserId: string): Promise<BankCardView[]> {
    const rows = await all<BankCardRow>(
      this.db,
      'SELECT * FROM bank_cards WHERE merchant_user_id = ? AND is_active = 1 ORDER BY is_default DESC, display_order ASC',
      [merchantUserId],
    );
    return rows.map(toView);
  }

  /**
   * The card an invoice should direct the customer to.
   *
   * Preference order: an explicitly requested card, then the merchant's default,
   * then the first active card by display order. Returns null when the merchant has
   * no usable card, which the invoice service turns into CARD_REQUIRED rather than
   * creating an invoice nobody can pay.
   */
  async resolveForInvoice(merchantUserId: string, requestedCardId?: string | null): Promise<BankCardRow | null> {
    if (requestedCardId) {
      const requested = await first<BankCardRow>(
        this.db,
        'SELECT * FROM bank_cards WHERE id = ? AND merchant_user_id = ? AND is_active = 1',
        [requestedCardId, merchantUserId],
      );
      if (requested) return requested;
      // Falling back silently would send the customer to a card the merchant did not
      // choose, so a named-but-unusable card is an error.
      throw new AppError('CARD_NOT_FOUND', { message: 'کارت انتخاب‌شده فعال نیست یا وجود ندارد.' });
    }

    const preferred = await first<BankCardRow>(
      this.db,
      `SELECT * FROM bank_cards WHERE merchant_user_id = ? AND is_active = 1
       ORDER BY is_default DESC, display_order ASC, created_at ASC LIMIT 1`,
      [merchantUserId],
    );
    return preferred;
  }

  async count(merchantUserId: string): Promise<number> {
    const row = await first<{ count: number }>(
      this.db,
      'SELECT COUNT(*) AS count FROM bank_cards WHERE merchant_user_id = ?',
      [merchantUserId],
    );
    return row?.count ?? 0;
  }

  async create(
    merchantUserId: string,
    input: {
      number: string;
      title: string;
      bankName?: string | null;
      holderName?: string | null;
      isDefault?: boolean;
      displayOrder?: number;
    },
    actor: { userId: string | null; role: string | null; ip: string | null },
    requestId?: string,
  ): Promise<BankCardView> {
    const maxCards = await this.settings.int('cards.max_per_merchant');
    if ((await this.count(merchantUserId)) >= maxCards) {
      throw new AppError('CARD_LIMIT_REACHED', { details: { max: maxCards } });
    }

    const enforceLuhn = await this.settings.bool('cards.enforce_luhn');
    const validation = validateCardNumber(input.number, { enforceLuhn });
    if (!validation.ok) {
      throw new AppError('CARD_INVALID', {
        message: rejectionMessage(validation.reason),
        details: { reason: validation.reason },
      });
    }

    const numberHash = await sha256Hex(`${merchantUserId}:${validation.number}`);
    const id = newId('card');
    const timestamp = nowIso();
    const existingCount = await this.count(merchantUserId);
    // The first card a merchant adds is automatically their default; otherwise a
    // merchant with cards but no default would be unable to issue invoices.
    const shouldBeDefault = input.isDefault === true || existingCount === 0;

    try {
      await this.db.batch([
        ...(shouldBeDefault
          ? [
              this.db
                .prepare('UPDATE bank_cards SET is_default = 0, updated_at = ? WHERE merchant_user_id = ? AND is_default = 1')
                .bind(timestamp, merchantUserId),
            ]
          : []),
        this.db
          .prepare(
            `INSERT INTO bank_cards (
               id, merchant_user_id, number, number_hash, number_masked, title, bank_name, holder_name,
               is_active, is_default, display_order, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
          )
          .bind(
            id,
            merchantUserId,
            validation.number,
            numberHash,
            maskCardNumber(validation.number),
            input.title,
            input.bankName ?? validation.issuer?.bank ?? null,
            input.holderName ?? null,
            shouldBeDefault ? 1 : 0,
            input.displayOrder ?? existingCount,
            timestamp,
            timestamp,
          ),
      ]);
    } catch (error) {
      if (isUniqueViolation(error, 'bank_cards')) {
        throw new AppError('CARD_DUPLICATE');
      }
      throw error;
    }

    await this.audit.record({
      event: 'card.created',
      actor,
      merchantUserId,
      targetType: 'bank_card',
      targetId: id,
      requestId: requestId ?? null,
      // Masked, never the full number.
      metadata: { masked: maskCardNumber(validation.number), bank: validation.issuer?.bank ?? null, isDefault: shouldBeDefault },
    });

    const row = await first<BankCardRow>(this.db, 'SELECT * FROM bank_cards WHERE id = ?', [id]);
    if (!row) throw new AppError('DATABASE_ERROR');
    return toView(row);
  }

  async update(
    merchantUserId: string,
    cardId: string,
    patch: {
      title?: string;
      bankName?: string | null;
      holderName?: string | null;
      isActive?: boolean;
      isDefault?: boolean;
      displayOrder?: number;
    },
    actor: { userId: string | null; role: string | null; ip: string | null },
    requestId?: string,
  ): Promise<BankCardView> {
    const row = await first<BankCardRow>(
      this.db,
      'SELECT * FROM bank_cards WHERE id = ? AND merchant_user_id = ?',
      [cardId, merchantUserId],
    );
    if (!row) throw new AppError('CARD_NOT_FOUND');

    const timestamp = nowIso();
    const statements: D1PreparedStatement[] = [];

    if (patch.isDefault === true) {
      statements.push(
        this.db
          .prepare('UPDATE bank_cards SET is_default = 0, updated_at = ? WHERE merchant_user_id = ? AND is_default = 1')
          .bind(timestamp, merchantUserId),
      );
    }

    statements.push(
      this.db
        .prepare(
          `UPDATE bank_cards SET
             title = ?, bank_name = ?, holder_name = ?, is_active = ?, is_default = ?, display_order = ?, updated_at = ?
           WHERE id = ? AND merchant_user_id = ?`,
        )
        .bind(
          patch.title ?? row.title,
          patch.bankName === undefined ? row.bank_name : patch.bankName,
          patch.holderName === undefined ? row.holder_name : patch.holderName,
          patch.isActive === undefined ? row.is_active : patch.isActive ? 1 : 0,
          patch.isDefault === undefined ? row.is_default : patch.isDefault ? 1 : 0,
          patch.displayOrder ?? row.display_order,
          timestamp,
          cardId,
          merchantUserId,
        ),
    );

    await this.db.batch(statements);

    // Deactivating the only active card would leave the merchant unable to take
    // payments; the dashboard surfaces this as a warning rather than blocking the
    // change, because a merchant may legitimately be pausing.
    const stillActive = await this.listActive(merchantUserId);
    if (stillActive.length > 0 && !stillActive.some((card) => card.isDefault)) {
      await run(
        this.db,
        'UPDATE bank_cards SET is_default = 1, updated_at = ? WHERE id = ?',
        [timestamp, stillActive[0]!.id],
      );
    }

    await this.audit.record({
      event: patch.isDefault ? 'card.default_changed' : 'card.updated',
      actor,
      merchantUserId,
      targetType: 'bank_card',
      targetId: cardId,
      requestId: requestId ?? null,
      metadata: { masked: row.number_masked, patch: { ...patch, number: undefined } },
    });

    const updated = await first<BankCardRow>(this.db, 'SELECT * FROM bank_cards WHERE id = ?', [cardId]);
    if (!updated) throw new AppError('DATABASE_ERROR');
    return toView(updated);
  }

  /**
   * Deletes a card only when no invoice references it. Invoices keep a foreign key
   * to their card so a historical receipt can still say where the money went, and
   * cascading that delete would erase an audit trail.
   */
  async remove(
    merchantUserId: string,
    cardId: string,
    actor: { userId: string | null; role: string | null; ip: string | null },
    requestId?: string,
  ): Promise<{ deleted: boolean; deactivatedInstead: boolean }> {
    const row = await first<BankCardRow>(
      this.db,
      'SELECT * FROM bank_cards WHERE id = ? AND merchant_user_id = ?',
      [cardId, merchantUserId],
    );
    if (!row) throw new AppError('CARD_NOT_FOUND');

    const referenced = await first<{ count: number }>(
      this.db,
      'SELECT COUNT(*) AS count FROM invoices WHERE card_id = ?',
      [cardId],
    );

    if ((referenced?.count ?? 0) > 0) {
      await this.update(merchantUserId, cardId, { isActive: false, isDefault: false }, actor, requestId);
      return { deleted: false, deactivatedInstead: true };
    }

    await run(this.db, 'DELETE FROM bank_cards WHERE id = ? AND merchant_user_id = ?', [cardId, merchantUserId]);

    if (row.is_default === 1) {
      const remaining = await this.listActive(merchantUserId);
      const next = remaining[0];
      if (next) {
        await run(this.db, 'UPDATE bank_cards SET is_default = 1, updated_at = ? WHERE id = ?', [nowIso(), next.id]);
      }
    }

    await this.audit.record({
      event: 'card.deleted',
      actor,
      merchantUserId,
      targetType: 'bank_card',
      targetId: cardId,
      requestId: requestId ?? null,
      severity: 'WARNING',
      metadata: { masked: row.number_masked },
    });

    return { deleted: true, deactivatedInstead: false };
  }

  async setDefault(
    merchantUserId: string,
    cardId: string,
    actor: { userId: string | null; role: string | null; ip: string | null },
  ): Promise<void> {
    await this.update(merchantUserId, cardId, { isDefault: true, isActive: true }, actor);
  }
}

function rejectionMessage(reason: CardRejection | undefined): string {
  switch (reason) {
    case 'EMPTY':
      return 'شماره کارت را وارد کنید.';
    case 'NOT_DIGITS':
      return 'شماره کارت باید فقط شامل رقم باشد.';
    case 'WRONG_LENGTH':
      return 'شماره کارت باید ۱۶ رقم باشد.';
    case 'NOT_SHETAB':
      return 'این شماره در بازه کارت‌های شتاب نیست.';
    case 'CHECKSUM_FAILED':
      return 'رقم کنترلی شماره کارت درست نیست. شماره را دوباره بررسی کنید.';
    default:
      return 'شماره کارت معتبر نیست.';
  }
}

export function toView(row: BankCardRow): BankCardView {
  return {
    id: row.id,
    title: row.title,
    bankName: row.bank_name,
    holderName: row.holder_name,
    number: row.number,
    masked: row.number_masked,
    isActive: row.is_active === 1,
    isDefault: row.is_default === 1,
    displayOrder: row.display_order,
    successCount: row.success_count,
    failureCount: row.failure_count,
    createdAt: row.created_at,
  };
}
