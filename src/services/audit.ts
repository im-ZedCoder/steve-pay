/**
 * Audit logging (§36).
 *
 * Everything sensitive writes here. The table rejects UPDATE and DELETE at the
 * database level, so this service only ever appends — "append-only" is a property
 * of the schema, not a convention this file follows carefully.
 *
 * Two design decisions worth stating:
 *
 *   1. Audit writes never throw. An audit insert failing must not fail a payment
 *      confirmation — the money movement is the primary effect and the audit row is
 *      the record of it. Failures are logged loudly at CRITICAL into
 *      `system_events`, which is what the admin health page surfaces.
 *
 *   2. Field values are redacted before they are stored. An audit log is a long-
 *      lived, widely-readable table, and a password or API key that lands in it is
 *      permanent.
 */

import { run } from '../db/client';
import { nowIso } from '../core/time';
import { redact } from '../obs/logger';
import { AppError } from '../core/errors';

export type AuditEvent =
  // authentication
  | 'auth.register'
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'auth.logout_all'
  | 'auth.password_changed'
  | 'auth.password_reset'
  | 'auth.account_locked'
  | 'auth.two_factor_enabled'
  | 'auth.two_factor_disabled'
  // merchant lifecycle
  | 'merchant.approved'
  | 'merchant.rejected'
  | 'merchant.suspended'
  | 'merchant.banned'
  | 'merchant.reactivated'
  | 'merchant.reset'
  | 'merchant.profile_updated'
  | 'merchant.settings_updated'
  | 'merchant.telegram_linked'
  | 'merchant.telegram_unlinked'
  // api keys
  | 'api_key.created'
  | 'api_key.rotated'
  | 'api_key.revoked'
  | 'api_key.scopes_updated'
  // cards
  | 'card.created'
  | 'card.updated'
  | 'card.deleted'
  | 'card.default_changed'
  // invoices and payments
  | 'invoice.created'
  | 'invoice.expired'
  | 'invoice.cancelled'
  | 'invoice.status_changed'
  | 'invoice.creation_failed'
  | 'payment.matched'
  | 'payment.confirmed'
  | 'payment.failed'
  | 'payment.manual_review'
  | 'payment.manual_confirmed'
  | 'payment.manual_rejected'
  | 'payment.refunded'
  | 'payment.duplicate_detected'
  // wallet
  | 'wallet.credited'
  | 'wallet.debited'
  | 'wallet.adjusted'
  | 'wallet.deposit_requested'
  // webhooks
  | 'webhook.created'
  | 'webhook.updated'
  | 'webhook.deleted'
  | 'webhook.retry_requested'
  | 'webhook.disabled'
  // platform
  | 'settings.updated'
  | 'notification.sent'
  | 'ticket.created'
  | 'ticket.replied'
  | 'ticket.status_changed'
  | 'ticket.assigned'
  | 'sms.received'
  | 'sms.parse_failed'
  | 'sms.test_verified'
  | 'test_run.completed'
  | 'security.event'
  | 'cron.completed'
  | 'admin.permission_changed';

export type AuditSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface AuditActor {
  userId: string | null;
  role: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface AuditInput {
  event: AuditEvent;
  actor?: Partial<AuditActor>;
  merchantUserId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  requestId?: string | null;
  severity?: AuditSeverity;
  /** Metadata is redacted before storage. Never put a secret here. */
  metadata?: Record<string, unknown>;
}

export class AuditService {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  /** Appends one audit row. Never throws. */
  async record(input: AuditInput): Promise<void> {
    try {
      await run(
        this.db,
        `INSERT INTO audit_logs (
           event, severity, actor_user_id, actor_role, actor_ip, actor_user_agent,
           merchant_user_id, target_type, target_id, request_id, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.event,
          input.severity ?? 'INFO',
          input.actor?.userId ?? null,
          input.actor?.role ?? null,
          input.actor?.ip ?? null,
          truncate(input.actor?.userAgent ?? null, 300),
          input.merchantUserId ?? null,
          input.targetType ?? null,
          input.targetId ?? null,
          input.requestId ?? null,
          input.metadata ? JSON.stringify(redact(input.metadata)) : null,
          nowIso(),
        ],
      );
    } catch (error) {
      await this.recordFailure(input, error);
    }
  }

  /**
   * Appends many rows in one batch. Used when a single operation produces several
   * audit facts (a manual confirmation changes a payment, a wallet and a
   * transaction) and they should land together.
   */
  async recordMany(inputs: AuditInput[]): Promise<void> {
    if (inputs.length === 0) return;
    const statements = inputs.map((input) =>
      this.db
        .prepare(
          `INSERT INTO audit_logs (
             event, severity, actor_user_id, actor_role, actor_ip, actor_user_agent,
             merchant_user_id, target_type, target_id, request_id, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.event,
          input.severity ?? 'INFO',
          input.actor?.userId ?? null,
          input.actor?.role ?? null,
          input.actor?.ip ?? null,
          truncate(input.actor?.userAgent ?? null, 300),
          input.merchantUserId ?? null,
          input.targetType ?? null,
          input.targetId ?? null,
          input.requestId ?? null,
          input.metadata ? JSON.stringify(redact(input.metadata)) : null,
          nowIso(),
        ),
    );

    try {
      await this.db.batch(statements);
    } catch (error) {
      for (const input of inputs) await this.recordFailure(input, error);
    }
  }

  /**
   * A failed audit write is itself an auditable fact. It is recorded in
   * system_events rather than audit_logs, because audit_logs is exactly the table
   * that just failed.
   */
  private async recordFailure(input: AuditInput, error: unknown): Promise<void> {
    const message = error instanceof AppError ? error.message : error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        level: 'critical',
        scope: 'audit',
        message: 'audit write failed',
        event: input.event,
        error: message,
      }),
    );
    try {
      await run(
        this.db,
        `INSERT INTO system_events (level, scope, message, metadata, created_at)
         VALUES ('CRITICAL', 'audit', ?, ?, ?)`,
        [
          `audit write failed for ${input.event}`,
          JSON.stringify({ error: message, targetId: input.targetId ?? null }),
          nowIso(),
        ],
      );
    } catch {
      // Both sinks are down. The console line above is the last resort.
    }
  }

  /** Paginated read for the admin audit screen. Filters are all optional. */
  async list(filters: {
    event?: string;
    actorUserId?: string;
    merchantUserId?: string;
    severity?: AuditSeverity;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): Promise<Array<Record<string, unknown>>> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters.event) {
      clauses.push('event = ?');
      params.push(filters.event);
    }
    if (filters.actorUserId) {
      clauses.push('actor_user_id = ?');
      params.push(filters.actorUserId);
    }
    if (filters.merchantUserId) {
      clauses.push('merchant_user_id = ?');
      params.push(filters.merchantUserId);
    }
    if (filters.severity) {
      clauses.push('severity = ?');
      params.push(filters.severity);
    }
    if (filters.from) {
      clauses.push('created_at >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      clauses.push('created_at < ?');
      params.push(filters.to);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);

    const result = await this.db
      .prepare(
        `SELECT id, event, severity, actor_user_id, actor_role, actor_ip, merchant_user_id,
                target_type, target_id, request_id, metadata, created_at
         FROM audit_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...params, limit, offset)
      .all<Record<string, unknown>>();

    return result.results ?? [];
  }

  /** Distinct event names, for the filter dropdown. */
  async eventTypes(): Promise<string[]> {
    const result = await this.db
      .prepare('SELECT DISTINCT event FROM audit_logs ORDER BY event')
      .all<{ event: string }>();
    return (result.results ?? []).map((row) => row.event);
  }
}

function truncate(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length > max ? value.slice(0, max) : value;
}

export function auditFor(db: D1Database): AuditService {
  return new AuditService(db);
}
