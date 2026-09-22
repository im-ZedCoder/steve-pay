/**
 * SMS ingestion (§14, §15, §17, §18, §19, §52).
 *
 * The pipeline, in order:
 *
 *   authenticate (route) -> size check -> dedupe -> parse -> persist -> match ->
 *   risk -> confirm or review
 *
 * Two things about the ordering matter:
 *
 *   - Dedupe comes before parsing. A forwarder that resends after a network blip is
 *     the normal case, not the exception, and rejecting the duplicate before any
 *     parsing work is both cheaper and safer.
 *
 *   - The duplicate check is an INSERT, not a SELECT-then-INSERT. The unique index
 *     on (merchant, message hash) is what decides; the application only reacts. A
 *     read-then-write would leave a window for two concurrent deliveries of the same
 *     message to both proceed.
 *
 * Nothing here trusts the client. The forwarder's `receivedAt` is stored as a hint
 * but the server's own clock is authoritative, and the parsed amount is never taken
 * from a client-supplied field.
 */

import { AppError } from '../core/errors';
import { id as newId } from '../core/ids';
import { nowIso, epochMs } from '../core/time';
import { sha256Hex } from '../core/crypto';
import { all, first, run, isUniqueViolation, scalar } from '../db/client';
import { parseSms, redactSmsForCustomer, MAX_SMS_LENGTH, type ParseOutcome, type ParsedSms } from '../core/sms';
import { compositeFingerprint, decideMatch, type MatchDecision, type MatchCandidate } from '../core/matching';
import { assessRisk, type RiskAssessment } from '../core/risk';
import { SettingsService } from './settings';
import { AuditService } from './audit';
import { InvoiceService, type InvoiceRow } from './invoices';
import { confirmPayment, type ConfirmResult } from './confirm';
import { TelegramService } from './telegram';
import type { Logger } from '../obs/logger';

export interface SmsIngestInput {
  merchantUserId: string;
  apiKeyId: string | null;
  message: string;
  sender?: string | null;
  deviceId?: string | null;
  clientReceivedAt?: string | null;
  sourceIp: string | null;
  requestId: string;
  environment: 'live' | 'test';
  /**
   * Scheme and host of the forwarder's request.
   *
   * The ingestion path has no session and no browser, so this is the only way a
   * notification triggered from here can carry a link back into the panel.
   */
  origin?: string;
}

export type SmsOutcome =
  | 'CONFIRMED'
  | 'MANUAL_REVIEW'
  | 'DUPLICATE'
  | 'DUPLICATE_TRANSACTION'
  | 'NOT_A_PAYMENT'
  | 'UNPARSEABLE'
  | 'TEST_VERIFIED'
  | 'TEST_TOKEN_INVALID'
  | 'NO_MATCH'
  | 'IGNORED_TEST';

export interface SmsIngestResult {
  outcome: SmsOutcome;
  smsMessageId: string | null;
  invoiceId: string | null;
  transactionId: string | null;
  /** Human-readable explanation, safe to show a merchant in the SMS log. */
  detail: string;
  parse: {
    parser: string;
    bank: string | null;
    confidence: number;
    amountToman: number | null;
    reference: string | null;
    direction: string;
    warnings: string[];
  } | null;
  match: { type: string; score: number; reasons: string[] } | null;
  risk: { score: number; level: string; signals: string[] } | null;
}

export class SmsService {
  private readonly db: D1Database;
  private readonly settings: SettingsService;
  private readonly audit: AuditService;
  private readonly invoices: InvoiceService;
  private readonly telegram: TelegramService;
  private readonly logger: Logger;

  constructor(deps: {
    db: D1Database;
    settings: SettingsService;
    audit: AuditService;
    invoices: InvoiceService;
    telegram: TelegramService;
    logger: Logger;
  }) {
    this.db = deps.db;
    this.settings = deps.settings;
    this.audit = deps.audit;
    this.invoices = deps.invoices;
    this.telegram = deps.telegram;
    this.logger = deps.logger;
  }

  async ingest(input: SmsIngestInput): Promise<SmsIngestResult> {
    const serverReceivedAt = nowIso();

    if (input.message.length > MAX_SMS_LENGTH) {
      throw new AppError('SMS_TOO_LARGE', { details: { maxLength: MAX_SMS_LENGTH, length: input.message.length } });
    }
    if (input.message.trim().length === 0) {
      throw new AppError('SMS_INVALID_PAYLOAD', { message: 'متن پیامک خالی است.' });
    }

    // Parse first so the test-token check and the duplicate hash both have what they
    // need, but withhold any side effect until the message is stored.
    const parseOutcome = parseSms(input.message, {
      receivedAt: serverReceivedAt,
      sender: input.sender ?? null,
    });

    const messageHash = await sha256Hex(`${input.merchantUserId}:${input.message.trim()}`);

    const smsMessageId = newId('sms');
    const isTestMessage = parseOutcome?.testToken !== null && parseOutcome?.testToken !== undefined;

    // Claim the message. A unique violation means this exact body has been received
    // for this merchant before.
    try {
      await run(
        this.db,
        `INSERT INTO sms_messages (
           id, merchant_user_id, api_key_id, raw_message, message_hash, sender, device_id,
           client_received_at, server_received_at, source_ip, message_length, parse_status,
           parser_used, is_test, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
        [
          smsMessageId,
          input.merchantUserId,
          input.apiKeyId,
          input.message,
          messageHash,
          input.sender ?? null,
          input.deviceId ?? null,
          input.clientReceivedAt ?? null,
          serverReceivedAt,
          input.sourceIp,
          input.message.length,
          parseOutcome?.best.parser ?? null,
          isTestMessage ? 1 : 0,
          serverReceivedAt,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error, 'sms_messages')) {
        const existing = await first<{ id: string; parse_status: string }>(
          this.db,
          'SELECT id, parse_status FROM sms_messages WHERE merchant_user_id = ? AND message_hash = ?',
          [input.merchantUserId, messageHash],
        );
        await this.audit.record({
          event: 'sms.received',
          merchantUserId: input.merchantUserId,
          targetType: 'sms_message',
          targetId: existing?.id ?? null,
          requestId: input.requestId,
          severity: 'WARNING',
          metadata: { outcome: 'DUPLICATE', messageHash },
        });
        return {
          outcome: 'DUPLICATE',
          smsMessageId: existing?.id ?? null,
          invoiceId: null,
          transactionId: null,
          detail: 'این پیامک قبلاً دریافت و پردازش شده است.',
          parse: null,
          match: null,
          risk: null,
        };
      }
      throw error;
    }

    // --- test token path (§15) ----------------------------------------------
    // A test message can never confirm an invoice. It routes to the setup wizard
    // and stops.
    if (isTestMessage && parseOutcome) {
      return this.handleTestToken(input, parseOutcome, smsMessageId, serverReceivedAt);
    }

    if (!parseOutcome) {
      await run(
        this.db,
        `UPDATE sms_messages SET parse_status = 'IGNORED', processed_at = ? WHERE id = ?`,
        [serverReceivedAt, smsMessageId],
      );
      return {
        outcome: 'NOT_A_PAYMENT',
        smsMessageId,
        invoiceId: null,
        transactionId: null,
        detail: 'این پیامک شامل مبلغ قابل استخراج نیست و به‌عنوان پرداخت ثبت نشد.',
        parse: null,
        match: null,
        risk: null,
      };
    }

    const parsed = parseOutcome.best;

    // Persist the parse beside the raw message so a parser fix can be replayed.
    await run(
      this.db,
      `INSERT INTO sms_parser_results (
         id, sms_message_id, merchant_user_id, parser, bank, confidence, amount_raw,
         amount_toman, amount_rial, currency, reference, source_card, destination_card,
         balance_toman, occurred_at, direction, warnings, extracted, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId('pr'),
        smsMessageId,
        input.merchantUserId,
        parsed.parser,
        parsed.bank,
        parsed.confidence,
        parsed.amountRaw,
        parsed.amountToman,
        parsed.amountRial,
        parsed.currency,
        parsed.reference,
        parsed.sourceCard,
        parsed.destinationCard,
        parsed.balanceToman,
        parsed.occurredAt,
        parsed.direction,
        JSON.stringify(parsed.warnings),
        JSON.stringify(parsed.extracted),
        serverReceivedAt,
      ],
    );

    await run(
      this.db,
      `UPDATE sms_messages SET parse_status = 'PARSED', parser_used = ?, processed_at = ? WHERE id = ?`,
      [parsed.parser, serverReceivedAt, smsMessageId],
    );

    // --- duplicate bank transaction ----------------------------------------
    const duplicate = await this.findDuplicateTransaction(input.merchantUserId, parsed.reference, {
      direction: parsed.direction,
      amountToman: parsed.amountToman,
      destinationCard: parsed.destinationCard,
      occurredAt: parsed.occurredAt,
      receivedAt: serverReceivedAt,
    });

    if (duplicate) {
      await this.audit.record({
        event: 'payment.duplicate_detected',
        merchantUserId: input.merchantUserId,
        targetType: 'sms_message',
        targetId: smsMessageId,
        requestId: input.requestId,
        severity: 'WARNING',
        metadata: { reason: duplicate.reason, transactionId: duplicate.transactionId, reference: parsed.reference },
      });
      return {
        outcome: 'DUPLICATE_TRANSACTION',
        smsMessageId,
        invoiceId: duplicate.invoiceId,
        transactionId: duplicate.transactionId,
        detail: 'این تراکنش بانکی قبلاً ثبت و تسویه شده است.',
        parse: summarizeParse(parsed),
        match: null,
        risk: null,
      };
    }

    // --- matching ----------------------------------------------------------
    const candidates = await this.invoices.matchCandidates(input.merchantUserId);
    const matchConfig = await this.matchConfig(input.merchantUserId);
    const decision = decideMatch({
      parsed,
      candidates: candidates.map(toCandidate),
      config: matchConfig,
      now: serverReceivedAt,
      isTestMessage: false,
      duplicateOf: null,
    });

    // --- risk --------------------------------------------------------------
    const risk = await this.assessRisk(input.merchantUserId, parsed, decision, smsMessageId, serverReceivedAt);

    await this.recordMatchOutcome(input, smsMessageId, decision, risk);

    if (decision.type === 'IGNORED' || decision.type === 'NO_MATCH') {
      return {
        outcome: decision.type === 'IGNORED' ? 'NOT_A_PAYMENT' : 'NO_MATCH',
        smsMessageId,
        invoiceId: null,
        transactionId: null,
        detail: decision.reasons.map((reason) => reason.detail).join(' '),
        parse: summarizeParse(parsed),
        match: summarizeMatch(decision),
        risk: summarizeRisk(risk),
      };
    }

    if (decision.type === 'DUPLICATE') {
      return {
        outcome: 'DUPLICATE_TRANSACTION',
        smsMessageId,
        invoiceId: decision.invoiceId,
        transactionId: null,
        detail: 'این پرداخت قبلاً ثبت شده است.',
        parse: summarizeParse(parsed),
        match: summarizeMatch(decision),
        risk: summarizeRisk(risk),
      };
    }

    const invoice = decision.invoiceId ? await this.invoices.getById(decision.invoiceId) : null;
    if (!invoice) {
      return {
        outcome: 'NO_MATCH',
        smsMessageId,
        invoiceId: null,
        transactionId: null,
        detail: 'فاکتور متناظر پیدا نشد.',
        parse: summarizeParse(parsed),
        match: summarizeMatch(decision),
        risk: summarizeRisk(risk),
      };
    }

    // A test-environment SMS never settles a live invoice, and vice versa.
    if (invoice.is_test === 1 && input.environment !== 'test') {
      return {
        outcome: 'IGNORED_TEST',
        smsMessageId,
        invoiceId: invoice.id,
        transactionId: null,
        detail: 'این فاکتور آزمایشی است و با کلید اصلی پردازش نمی‌شود.',
        parse: summarizeParse(parsed),
        match: summarizeMatch(decision),
        risk: summarizeRisk(risk),
      };
    }

    const needsReview =
      decision.type === 'MANUAL_REVIEW' ||
      risk.requiresReview ||
      (await this.settings.bool('matching.auto_confirm_enabled')) === false;

    if (needsReview) {
      const reasons = [
        ...decision.reasons.filter((reason) => reason.blocking).map((reason) => reason.detail),
        ...risk.signals.filter((signal) => signal.level !== 'LOW').map((signal) => signal.detail),
      ];
      await this.invoices.markForReview(invoice.id, reasons, risk.score || decision.score, input.requestId);

      const chatId = await this.verifiedChatId(input.merchantUserId);
      if (chatId) {
        await this.telegram.notifySuspiciousPayment({
          merchantUserId: input.merchantUserId,
          chatId,
          payableAmount: invoice.payable_amount,
          invoiceId: invoice.id,
          reasons,
          // The SMS webhook has no session and no browser: the origin comes from the
          // forwarder's own request, which the caller passes in.
          origin: input.origin ?? '',
        });
      }

      return {
        outcome: 'MANUAL_REVIEW',
        smsMessageId,
        invoiceId: invoice.id,
        transactionId: null,
        detail: reasons.join(' ') || 'این پرداخت نیاز به بررسی دستی دارد.',
        parse: summarizeParse(parsed),
        match: summarizeMatch(decision),
        risk: summarizeRisk(risk),
      };
    }

    // --- confirmation ------------------------------------------------------
    const confirmResult = await confirmPayment({
      db: this.db,
      settings: this.settings,
      audit: this.audit,
      invoices: this.invoices,
      invoice,
      parsed,
      smsMessageId,
      receivedAt: serverReceivedAt,
      matchScore: decision.score,
      matchReasons: decision.reasons.map((reason) => reason.detail),
      confirmation: 'AUTOMATIC',
      requestId: input.requestId,
    });

    return {
      outcome: confirmResult.confirmed ? 'CONFIRMED' : confirmResult.outcome === 'ALREADY_PAID' ? 'DUPLICATE_TRANSACTION' : 'MANUAL_REVIEW',
      smsMessageId,
      invoiceId: invoice.id,
      transactionId: confirmResult.transactionId,
      detail: confirmResult.detail,
      parse: summarizeParse(parsed),
      match: summarizeMatch(decision),
      risk: summarizeRisk(risk),
    };
  }

  // -------------------------------------------------------------------------
  // Test token (§15)
  // -------------------------------------------------------------------------

  private async handleTestToken(
    input: SmsIngestInput,
    outcome: ParseOutcome,
    smsMessageId: string,
    receivedAt: string,
  ): Promise<SmsIngestResult> {
    const token = outcome.testToken ?? '';
    await run(this.db, `UPDATE sms_messages SET parse_status = 'TEST', processed_at = ? WHERE id = ?`, [
      receivedAt,
      smsMessageId,
    ]);

    const tokenHash = await sha256Hex(`sms-test:${token}:${input.merchantUserId}`);
    const row = await first<{ id: string; expires_at: string; verified_at: string | null }>(
      this.db,
      `SELECT id, expires_at, verified_at FROM sms_test_tokens
       WHERE merchant_user_id = ? AND token_hash = ? ORDER BY created_at DESC LIMIT 1`,
      [input.merchantUserId, tokenHash],
    );

    if (!row) {
      await this.audit.record({
        event: 'sms.parse_failed',
        merchantUserId: input.merchantUserId,
        targetType: 'sms_message',
        targetId: smsMessageId,
        requestId: input.requestId,
        severity: 'WARNING',
        metadata: { reason: 'TEST_TOKEN_INVALID', token },
      });
      return {
        outcome: 'TEST_TOKEN_INVALID',
        smsMessageId,
        invoiceId: null,
        transactionId: null,
        detail: 'توکن آزمایشی نامعتبر یا منقضی است. از پنل، توکن تازه بسازید.',
        parse: summarizeParse(outcome.best),
        match: null,
        risk: null,
      };
    }

    if (epochMs(row.expires_at) < epochMs(receivedAt)) {
      return {
        outcome: 'TEST_TOKEN_INVALID',
        smsMessageId,
        invoiceId: null,
        transactionId: null,
        detail: 'مهلت این توکن آزمایشی گذشته است. توکن تازه بسازید.',
        parse: summarizeParse(outcome.best),
        match: null,
        risk: null,
      };
    }

    await run(this.db, 'UPDATE sms_test_tokens SET verified_at = ? WHERE id = ?', [receivedAt, row.id]);
    await this.audit.record({
      event: 'sms.test_verified',
      merchantUserId: input.merchantUserId,
      targetType: 'sms_test_token',
      targetId: row.id,
      requestId: input.requestId,
      metadata: { token },
    });

    const chatId = await this.verifiedChatId(input.merchantUserId);
    if (chatId) await this.telegram.notifySmsTestVerified(chatId, token);

    return {
      outcome: 'TEST_VERIFIED',
      smsMessageId,
      invoiceId: null,
      transactionId: null,
      detail: 'فورواردر پیامک متصل است. هیچ تراکنش واقعی ثبت نشد.',
      parse: summarizeParse(outcome.best),
      match: null,
      risk: null,
    };
  }

  /** Issues a test token for the setup wizard. */
  async issueTestToken(merchantUserId: string): Promise<{ token: string; message: string; expiresAt: string }> {
    const { randomCode } = await import('../core/crypto');
    const token = `SP-${randomCode(1, 4)}-${randomCode(1, 4)}`;
    const tokenHash = await sha256Hex(`sms-test:${token}:${merchantUserId}`);
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();

    await run(
      this.db,
      `INSERT INTO sms_test_tokens (id, merchant_user_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [newId('evt'), merchantUserId, tokenHash, expiresAt, nowIso()],
    );

    // A realistic-looking bank message so the merchant can paste something that
    // exercises the real forwarder path.
    const message = `STEVE_PAY_TEST ${token}\nمبلغ 1,000 تومان به حساب 6104****0000 واریز شد. شماره پیگیری 00000000`;

    await this.audit.record({
      event: 'sms.test_verified',
      merchantUserId,
      targetType: 'sms_test_token',
      targetId: token.slice(0, 12),
      metadata: { issued: true, expiresAt },
    });

    return { token, message, expiresAt };
  }

  async testTokenStatus(merchantUserId: string): Promise<{ connected: boolean; verifiedAt: string | null; token: string | null }> {
    const row = await first<{ verified_at: string | null; created_at: string }>(
      this.db,
      `SELECT verified_at, created_at FROM sms_test_tokens
       WHERE merchant_user_id = ? ORDER BY created_at DESC LIMIT 1`,
      [merchantUserId],
    );
    const recentSms = await scalar(
      this.db,
      `SELECT COUNT(*) AS count FROM sms_messages
       WHERE merchant_user_id = ? AND parse_status NOT IN ('DUPLICATE') AND server_received_at > ?`,
      [merchantUserId, new Date(Date.now() - 24 * 60 * 60_000).toISOString()],
    );
    return {
      // Either the wizard token came back, or real messages are arriving — both
      // mean the pipeline works, and a merchant whose forwarder was already
      // configured should not be told it is disconnected.
      connected: row?.verified_at !== null && row?.verified_at !== undefined ? true : recentSms > 0,
      verifiedAt: row?.verified_at ?? null,
      token: null,
    };
  }

  // -------------------------------------------------------------------------
  // Duplicate detection (§18, §72)
  // -------------------------------------------------------------------------

  private async findDuplicateTransaction(
    merchantUserId: string,
    reference: string | null,
    fingerprintInput: { direction: string; amountToman: number | null; destinationCard: string | null; occurredAt: string | null; receivedAt: string },
  ): Promise<{ transactionId: string; invoiceId: string; reason: string } | null> {
    if (reference) {
      const existing = await first<{ id: string; invoice_id: string }>(
        this.db,
        `SELECT id, invoice_id FROM transactions WHERE bank_reference = ? AND status = 'CONFIRMED' LIMIT 1`,
        [reference],
      );
      if (existing) {
        return { transactionId: existing.id, invoiceId: existing.invoice_id, reason: 'BANK_REFERENCE_REUSED' };
      }
    }

    const fingerprint = compositeFingerprint({
      direction: fingerprintInput.direction,
      amountToman: fingerprintInput.amountToman ?? 0,
      destinationCard: fingerprintInput.destinationCard,
      occurredAt: fingerprintInput.occurredAt,
      receivedAt: fingerprintInput.receivedAt,
    });

    const claimed = await first<{ transaction_id: string | null }>(
      this.db,
      'SELECT transaction_id FROM transaction_fingerprints WHERE merchant_user_id = ? AND fingerprint = ?',
      [merchantUserId, fingerprint],
    );
    if (claimed?.transaction_id) {
      const txn = await first<{ invoice_id: string }>(
        this.db,
        'SELECT invoice_id FROM transactions WHERE id = ?',
        [claimed.transaction_id],
      );
      return {
        transactionId: claimed.transaction_id,
        invoiceId: txn?.invoice_id ?? '',
        reason: 'FINGERPRINT_ALREADY_CLAIMED',
      };
    }

    return null;
  }

  private async assessRisk(
    merchantUserId: string,
    parsed: ParseOutcome['best'],
    decision: MatchDecision,
    smsMessageId: string,
    receivedAt: string,
  ): Promise<RiskAssessment> {
    const recentSmsCount = await scalar(
      this.db,
      'SELECT COUNT(*) AS count FROM sms_messages WHERE merchant_user_id = ? AND server_received_at > ?',
      [merchantUserId, new Date(epochMs(receivedAt) - 10 * 60_000).toISOString()],
    );

    const referenceSeen = parsed.reference
      ? (await scalar(
          this.db,
          `SELECT COUNT(*) AS count FROM transactions WHERE bank_reference = ? AND status = 'CONFIRMED'`,
          [parsed.reference],
        )) > 0
      : false;

    const unknownSender = parsed.destinationCard === null && parsed.reference === null;

    const similarAmountCount = parsed.amountToman
      ? await this.invoices.similarAmountCount(merchantUserId, parsed.amountToman)
      : 0;

    void smsMessageId;

    return assessRisk({
      parsed,
      now: receivedAt,
      timestampInFuture: parsed.warnings.includes('SMS_TIMESTAMP_IN_FUTURE'),
      duplicateMessage: false, // already rejected earlier by the message hash
      duplicateReference: referenceSeen,
      duplicateFingerprint: false, // already rejected earlier by the fingerprint check
      unsupportedFormat: parsed.parser === 'generic',
      matchedExpiredInvoice: decision.reasons.some((reason) => reason.code === 'INVOICE_EXPIRED_LATE_PAYMENT'),
      matchedPaidInvoice: decision.reasons.some((reason) => reason.code === 'INVOICE_ALREADY_PAID'),
      cardMismatch: decision.reasons.some((reason) => reason.code === 'CARD_MISMATCH'),
      similarAmountCount,
      recentSmsCount,
      unknownDevice: false,
      unknownSender,
    });
  }

  private async recordMatchOutcome(
    input: SmsIngestInput,
    smsMessageId: string,
    decision: MatchDecision,
    risk: RiskAssessment,
  ): Promise<void> {
    if (decision.type === 'NO_MATCH' || decision.type === 'IGNORED') {
      await run(
        this.db,
        `INSERT INTO system_events (level, scope, message, metadata, created_at) VALUES (?, 'sms.match', ?, ?, ?)`,
        [
          'INFO',
          `no match: ${decision.reasons.map((reason) => reason.code).join(',')}`,
          JSON.stringify({
            merchantUserId: input.merchantUserId,
            smsMessageId,
            amount: decision.nearMisses.length > 0 ? decision.nearMisses[0]?.payableAmount : null,
            nearMisses: decision.nearMisses.length,
          }),
          nowIso(),
        ],
      );
    }

    await this.audit.record({
      event:
        decision.type === 'MATCH'
          ? 'payment.matched'
          : decision.type === 'MANUAL_REVIEW'
            ? 'payment.manual_review'
            : 'sms.received',
      merchantUserId: input.merchantUserId,
      targetType: 'sms_message',
      targetId: smsMessageId,
      requestId: input.requestId,
      severity: risk.level === 'HIGH' ? 'CRITICAL' : risk.level === 'MEDIUM' ? 'WARNING' : 'INFO',
      metadata: {
        decision: decision.type,
        score: decision.score,
        reasons: decision.reasons.map((reason) => reason.code),
        riskScore: risk.score,
        riskSignals: risk.signals.map((signal) => signal.code),
      },
    });
  }

  async matchConfig(merchantUserId: string): Promise<{
    timeWindowMinutesBefore: number;
    timeWindowMinutesAfter: number;
    requireCardMatch: boolean;
    minConfidenceAutoConfirm: number;
    autoConfirmEnabled: boolean;
  }> {
    return {
      timeWindowMinutesBefore: await this.settings.int('matching.time_window_minutes_before'),
      timeWindowMinutesAfter: await this.settings.int('matching.time_window_minutes_after'),
      requireCardMatch: await this.settings.merchantBool(merchantUserId, 'matching.require_card_match'),
      minConfidenceAutoConfirm: await this.settings.int('matching.min_confidence_auto_confirm'),
      autoConfirmEnabled: await this.settings.bool('matching.auto_confirm_enabled'),
    };
  }

  private async verifiedChatId(merchantUserId: string): Promise<string | null> {
    const row = await first<{ telegram_user_id: string | null; telegram_verified: number; telegram_alerts: number }>(
      this.db,
      'SELECT telegram_user_id, telegram_verified, telegram_alerts FROM merchant_profiles WHERE user_id = ?',
      [merchantUserId],
    );
    if (!row || row.telegram_verified !== 1 || row.telegram_alerts !== 1) return null;
    return row.telegram_user_id;
  }

  // -------------------------------------------------------------------------
  // Reads for the dashboard (§ dashboard logs, /admin/sms)
  // -------------------------------------------------------------------------

  /**
   * The bank message that confirmed an invoice, redacted for a public audience (§50).
   *
   * The payment success page shows the customer the bank's own words, which is the most
   * convincing possible answer to "did my money actually arrive?" — and it is only safe
   * because the redaction is applied here, in the layer that owns the raw message, rather
   * than at the point of rendering.
   *
   * The raw text is never returned. `redactSmsForCustomer` strips the balance sentence
   * outright and masks the card numbers, while keeping the two figures the payer is
   * checking: the amount and the bank reference. Those come from the caller, which
   * already holds the invoice and transaction, so this method needs no second lookup to
   * know what must survive redaction.
   */
  async publicConfirmationMessage(
    invoiceId: string,
    keep: { amountToman: number; amountRial: number; reference: string | null },
  ): Promise<string | null> {
    const row = await first<{ raw_message: string }>(
      this.db,
      `SELECT s.raw_message
         FROM transactions t
         JOIN sms_messages s ON s.id = t.sms_message_id
        WHERE t.invoice_id = ? AND t.status = 'CONFIRMED'
        ORDER BY t.confirmed_at ASC
        LIMIT 1`,
      [invoiceId],
    );

    if (!row) return null;

    const redacted = redactSmsForCustomer(row.raw_message, {
      amountToman: keep.amountToman,
      amountRial: keep.amountRial,
      reference: keep.reference,
    });

    return redacted.text;
  }

  /**
   * The SMS evidence behind an invoice, for the manual review screen (§54).
   *
   * A payment that could not be auto-confirmed has no transaction row, so the link from
   * invoice back to the message that triggered the review does not exist in the schema.
   * It is recovered by matching on the one thing that made the payment a candidate in the
   * first place: the exact payable amount. That is the same signal the matcher used, and
   * the amount is unique among live invoices, so this cannot pick up a different payment.
   *
   * The raw message is returned, not a redacted one. An operator deciding whether to release
   * someone's money needs the evidence verbatim — this is the one surface where redaction
   * would defeat the purpose — and the caller is behind a staff permission, not a public page.
   */
  async reviewContext(invoice: InvoiceRow): Promise<{
    smsMessageId: string;
    rawMessage: string;
    receivedAt: string;
    parsed: ParsedSms;
    matchedAt: string | null;
  } | null> {
    const row = await first<{
      id: string;
      raw_message: string;
      server_received_at: string;
      parser: string;
      bank: string | null;
      confidence: number;
      amount_raw: string | null;
      amount_toman: number | null;
      amount_rial: number | null;
      currency: string | null;
      reference: string | null;
      source_card: string | null;
      destination_card: string | null;
      balance_toman: number | null;
      occurred_at: string | null;
      direction: string | null;
      warnings: string | null;
      extracted: string | null;
    }>(
      this.db,
      `SELECT s.id, s.raw_message, s.server_received_at,
              p.parser, p.bank, p.confidence, p.amount_raw, p.amount_toman, p.amount_rial,
              p.currency, p.reference, p.source_card, p.destination_card, p.balance_toman,
              p.occurred_at, p.direction, p.warnings, p.extracted
         FROM sms_parser_results p
         JOIN sms_messages s ON s.id = p.sms_message_id
        WHERE p.merchant_user_id = ? AND p.amount_toman = ?
        ORDER BY s.server_received_at DESC
        LIMIT 1`,
      [invoice.merchant_user_id, invoice.payable_amount],
    );

    if (!row) return null;

    // Rebuilt from the stored parse rather than re-parsed, so the operator sees exactly
    // what the matcher saw — including the confidence and the warnings that caused the
    // escalation. Re-parsing would answer a different question.
    const parsed: ParsedSms = {
      parser: row.parser,
      bank: row.bank,
      confidence: row.confidence,
      amountToman: row.amount_toman,
      amountRial: row.amount_rial,
      currency: (row.currency ?? 'UNKNOWN') as ParsedSms['currency'],
      amountRaw: row.amount_raw,
      reference: row.reference,
      sourceCard: row.source_card,
      destinationCard: row.destination_card,
      balanceToman: row.balance_toman,
      occurredAt: row.occurred_at,
      direction: (row.direction ?? 'UNKNOWN') as ParsedSms['direction'],
      warnings: parseJsonArray(row.warnings),
      extracted: parseJsonObject(row.extracted),
    };

    return {
      smsMessageId: row.id,
      rawMessage: row.raw_message,
      receivedAt: row.server_received_at,
      parsed,
      matchedAt: invoice.review_at,
    };
  }

  async list(
    filters: { merchantUserId?: string; parseStatus?: string; limit?: number; offset?: number; search?: string },
  ): Promise<Array<Record<string, unknown>>> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters.merchantUserId) {
      clauses.push('m.merchant_user_id = ?');
      params.push(filters.merchantUserId);
    }
    if (filters.parseStatus) {
      clauses.push('m.parse_status = ?');
      params.push(filters.parseStatus);
    }
    if (filters.search) {
      clauses.push('m.raw_message LIKE ?');
      params.push(`%${filters.search}%`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);

    return all<Record<string, unknown>>(
      this.db,
      `SELECT m.id, m.merchant_user_id, m.raw_message, m.sender, m.parse_status, m.server_received_at,
              m.is_test, m.duplicate_of, m.created_at,
              p.parser, p.bank, p.confidence, p.amount_toman, p.amount_rial, p.reference,
              p.destination_card, p.occurred_at, p.direction, p.warnings,
              (SELECT id FROM transactions t WHERE t.sms_message_id = m.id LIMIT 1) AS transaction_id,
              (SELECT invoice_id FROM transactions t WHERE t.sms_message_id = m.id LIMIT 1) AS invoice_id
       FROM sms_messages m
       LEFT JOIN sms_parser_results p ON p.sms_message_id = m.id
       ${where} ORDER BY m.server_received_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
  }

  async counts(merchantUserId?: string): Promise<Record<string, number>> {
    const row = merchantUserId
      ? await first<Record<string, number>>(
          this.db,
          `SELECT
             COUNT(*) AS total,
             SUM(CASE WHEN parse_status = 'PARSED' THEN 1 ELSE 0 END) AS parsed,
             SUM(CASE WHEN parse_status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN parse_status = 'IGNORED' THEN 1 ELSE 0 END) AS ignored,
             SUM(CASE WHEN parse_status = 'TEST' THEN 1 ELSE 0 END) AS test
           FROM sms_messages WHERE merchant_user_id = ?`,
          [merchantUserId],
        )
      : await first<Record<string, number>>(
          this.db,
          `SELECT
             COUNT(*) AS total,
             SUM(CASE WHEN parse_status = 'PARSED' THEN 1 ELSE 0 END) AS parsed,
             SUM(CASE WHEN parse_status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN parse_status = 'IGNORED' THEN 1 ELSE 0 END) AS ignored,
             SUM(CASE WHEN parse_status = 'TEST' THEN 1 ELSE 0 END) AS test
           FROM sms_messages`,
        );

    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(row ?? {})) out[key] = Number(value ?? 0);
    return out;
  }
}

function toCandidate(row: InvoiceRow): MatchCandidate {
  return {
    invoiceId: row.id,
    merchantUserId: row.merchant_user_id,
    status: row.status,
    payableAmount: row.payable_amount,
    baseAmount: row.base_amount,
    cardId: row.card_id,
    cardNumber: null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    isTest: row.is_test === 1,
  };
}

function summarizeParse(parsed: ParseOutcome['best']): SmsIngestResult['parse'] {
  return {
    parser: parsed.parser,
    bank: parsed.bank,
    confidence: parsed.confidence,
    amountToman: parsed.amountToman,
    reference: parsed.reference,
    direction: parsed.direction,
    warnings: parsed.warnings,
  };
}

function summarizeMatch(decision: MatchDecision): SmsIngestResult['match'] {
  return {
    type: decision.type,
    score: decision.score,
    reasons: decision.reasons.map((reason) => reason.detail),
  };
}

function summarizeRisk(risk: RiskAssessment): SmsIngestResult['risk'] {
  return {
    score: risk.score,
    level: risk.level,
    signals: risk.signals.map((signal) => signal.detail),
  };
}

void confirmPayment;
export type { ConfirmResult };

/**
 * Reads a JSON array out of a TEXT column.
 *
 * A malformed value yields an empty array rather than throwing. These columns are written
 * by this service and read on an operator's screen, and the failure that matters there is
 * a page that will not render, not a list that is quietly short.
 */
function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
