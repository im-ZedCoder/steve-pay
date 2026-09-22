/**
 * Idempotency keys (§38).
 *
 * `makePayment` is the endpoint where a duplicate is expensive: a client that retries
 * after a timeout must get the *original* invoice back, not a second one with a
 * different unique amount that the customer might also pay. Network retries are not
 * rare, they are the normal behaviour of every well-written HTTP client.
 *
 * The claim is a single `INSERT ... ON CONFLICT DO NOTHING RETURNING`. That one
 * statement is the whole concurrency story:
 *
 *   - it inserted  -> we own the key, proceed to create the invoice
 *   - no row back  -> someone else either finished it (replay their response) or is
 *                     still working on it (409, so the caller retries and gets the
 *                     finished response a moment later)
 *
 * A read-then-write would need a lock to be correct here, and D1 has no interactive
 * transactions to hold one with. Making the unique index the arbiter means the
 * database decides the winner and there is no window to lose.
 */

import { AppError } from '../core/errors';
import { nowIso, addMinutes } from '../core/time';
import { first, run, runReturning } from '../db/client';

/**
 * How long a key is remembered. Long enough to cover any realistic client retry
 * schedule (including our own webhook backoff, which spans about half a day) and short
 * enough that the table stays small.
 */
export const IDEMPOTENCY_TTL_MINUTES = 24 * 60;

export interface IdempotencyRow {
  id: number;
  merchant_user_id: string;
  idempotency_key: string;
  request_hash: string;
  endpoint: string;
  resource_type: string | null;
  resource_id: string | null;
  response_status: number | null;
  response_body: string | null;
  created_at: string;
  expires_at: string;
}

export type ClaimResult =
  /** The key was free; the caller may do the work and must call `finish` or `release`. */
  | { kind: 'claimed'; id: number }
  /** The key was already used and has a stored response. Return it verbatim. */
  | { kind: 'replay'; status: number; body: string; resourceId: string | null }
  /** The key is claimed but has no response yet: another request is mid-flight. */
  | { kind: 'in_flight' };

export interface FinishInput {
  status: number;
  /** Serialised response body, stored verbatim so a replay is byte-identical. */
  body: string;
  resourceType?: string | null;
  resourceId?: string | null;
}

export class IdempotencyService {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  /**
   * Attempts to take ownership of a key.
   *
   * `requestHash` is a digest of the request body. A key replayed with a *different*
   * body is a client bug, and answering it with the first request's result would hide
   * the mistake — the client believes it created the invoice it is now looking at. So
   * that case is a 409 rather than a replay.
   */
  async claim(input: {
    merchantUserId: string;
    key: string;
    endpoint: string;
    requestHash: string;
    ttlMinutes?: number;
  }): Promise<ClaimResult> {
    const now = nowIso();
    const expiresAt = addMinutes(now, input.ttlMinutes ?? IDEMPOTENCY_TTL_MINUTES);

    const inserted = await runReturning<{ id: number }>(
      this.db,
      `INSERT INTO idempotency_keys
         (merchant_user_id, idempotency_key, request_hash, endpoint, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(merchant_user_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [input.merchantUserId, input.key, input.requestHash, input.endpoint, now, expiresAt],
    );

    if (inserted) return { kind: 'claimed', id: inserted.id };

    const existing = await first<IdempotencyRow>(
      this.db,
      `SELECT * FROM idempotency_keys WHERE merchant_user_id = ? AND idempotency_key = ?`,
      [input.merchantUserId, input.key],
    );

    // The row disappeared between the insert conflict and this read. The only way that
    // happens is the pruner removing an expired row, which means the key is free again.
    // Treating it as claimed is the safe read: the caller proceeds and creates exactly
    // one invoice for this attempt.
    if (!existing) return { kind: 'claimed', id: 0 };

    if (existing.request_hash !== input.requestHash) {
      throw new AppError('IDEMPOTENCY_CONFLICT', {
        details: {
          reason: 'The same Idempotency-Key was already used with a different request body.',
        },
      });
    }

    if (existing.response_body !== null) {
      return {
        kind: 'replay',
        status: existing.response_status ?? 200,
        body: existing.response_body,
        resourceId: existing.resource_id,
      };
    }

    return { kind: 'in_flight' };
  }

  /** Stores the outcome so a later replay of the same key is served from here. */
  async finish(id: number, input: FinishInput): Promise<void> {
    if (id === 0) return;
    await run(
      this.db,
      `UPDATE idempotency_keys
       SET response_status = ?, response_body = ?, resource_type = ?, resource_id = ?
       WHERE id = ?`,
      [input.status, input.body, input.resourceType ?? null, input.resourceId ?? null, id],
    );
  }

  /**
   * Drops a claim whose work failed.
   *
   * Without this a failed `makePayment` would burn the key: the client's retry — the
   * whole point of sending the key — would come back as `in_flight` forever. Releasing
   * on failure means the retry does the work.
   */
  async release(id: number): Promise<void> {
    if (id === 0) return;
    await run(this.db, `DELETE FROM idempotency_keys WHERE id = ? AND response_body IS NULL`, [id]);
  }

  /** Removes expired keys. Called by the daily cron job. */
  async prune(now: string = nowIso()): Promise<number> {
    const result = await run(this.db, `DELETE FROM idempotency_keys WHERE expires_at < ?`, [now]);
    return result.changes;
  }
}
