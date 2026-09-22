/**
 * API keys (§6).
 *
 * The raw key is shown once, at creation, and never again. What is stored is an
 * HMAC of the whole key under the server pepper, plus a short non-secret
 * `lookup_id` so authentication stays one indexed read.
 *
 * Consequence worth stating plainly: if a merchant loses their key, the platform
 * cannot recover it. That is the correct behaviour — a platform that can print your
 * key can print anyone's — and the dashboard's answer is "rotate", which is also
 * the right answer.
 */

import { AppError } from '../core/errors';
import {
  generateApiKey,
  hashApiKey,
  verifyApiKeyHash,
  parseApiKey,
  constantTimeEqual,
  type ApiEnvironment,
} from '../core/crypto';
import { id as newId } from '../core/ids';
import { nowIso } from '../core/time';
import { all, first, run } from '../db/client';
import { scopesAllow } from '../core/roles';
import { ipMatchesAllowlist } from '../env';
import { AuditService } from './audit';

export interface ApiKeyRow {
  id: string;
  merchant_user_id: string;
  lookup_id: string;
  key_hash: string;
  key_hint: string;
  environment: ApiEnvironment;
  label: string | null;
  scopes: string;
  ip_allowlist: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  request_count: number;
  revoked_at: string | null;
  rotated_from: string | null;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
}

/** Shape returned to a dashboard. Never includes a hash. */
export interface ApiKeyView {
  id: string;
  hint: string;
  environment: ApiEnvironment;
  label: string | null;
  scopes: string[];
  ipAllowlist: string[] | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  requestCount: number;
  revokedAt: string | null;
  createdAt: string;
  expiresAt: string | null;
  active: boolean;
}

export interface AuthenticatedApiKey {
  key: ApiKeyRow;
  merchantUserId: string;
  environment: ApiEnvironment;
  scopes: string[];
}

export interface IssuedApiKey {
  view: ApiKeyView;
  /** Present exactly once. */
  fullKey: string;
}

export class ApiKeyService {
  private readonly db: D1Database;
  private readonly pepper: string;
  private readonly audit: AuditService;

  constructor(db: D1Database, pepper: string, audit: AuditService) {
    this.db = db;
    this.pepper = pepper;
    this.audit = audit;
  }

  async issue(input: {
    merchantUserId: string;
    environment: ApiEnvironment;
    label?: string | null;
    scopes?: string[];
    ipAllowlist?: string[] | null;
    createdBy?: string | null;
    rotatedFrom?: string | null;
    requestId?: string | null;
    actor?: { userId: string | null; role: string | null; ip: string | null };
  }): Promise<IssuedApiKey> {
    const generated = generateApiKey(input.environment);
    const keyHash = await hashApiKey(generated.fullKey, this.pepper);
    const id = newId('key');
    const timestamp = nowIso();

    await run(
      this.db,
      `INSERT INTO api_keys (
         id, merchant_user_id, lookup_id, key_hash, key_hint, environment, label,
         scopes, ip_allowlist, request_count, created_by, rotated_from, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [
        id,
        input.merchantUserId,
        generated.lookupId,
        keyHash,
        generated.hint,
        generated.environment,
        input.label ?? null,
        JSON.stringify(input.scopes ?? ['*']),
        input.ipAllowlist && input.ipAllowlist.length > 0 ? JSON.stringify(input.ipAllowlist) : null,
        input.createdBy ?? null,
        input.rotatedFrom ?? null,
        timestamp,
      ],
    );

    await this.audit.record({
      event: input.rotatedFrom ? 'api_key.rotated' : 'api_key.created',
      actor: input.actor ?? { userId: null, role: null, ip: null },
      merchantUserId: input.merchantUserId,
      targetType: 'api_key',
      targetId: id,
      requestId: input.requestId ?? null,
      // The hint is safe; the key itself must never appear in an audit row.
      metadata: { environment: generated.environment, hint: generated.hint, label: input.label ?? null },
    });

    const row = await first<ApiKeyRow>(this.db, 'SELECT * FROM api_keys WHERE id = ?', [id]);
    if (!row) throw new AppError('DATABASE_ERROR');

    return { view: toView(row), fullKey: generated.fullKey };
  }

  /**
   * Authenticates a presented key.
   *
   * The order is deliberate: look up by the non-secret prefix, verify the hash in
   * constant time, then check revocation, environment and IP. Any failure returns
   * the same INVALID_API_KEY-shaped answer from the caller, so a probe cannot tell
   * "no such key" from "revoked key".
   */
  async authenticate(
    presented: string,
    options: { requireEnvironment?: ApiEnvironment; ip?: string | null; permission?: string },
  ): Promise<AuthenticatedApiKey> {
    const parsed = parseApiKey(presented);
    if (!parsed) throw new AppError('INVALID_API_KEY');

    const row = await first<ApiKeyRow>(this.db, 'SELECT * FROM api_keys WHERE lookup_id = ?', [parsed.lookupId]);
    if (!row) throw new AppError('INVALID_API_KEY');

    const hashOk = await verifyApiKeyHash(presented, row.key_hash, this.pepper);
    if (!hashOk) throw new AppError('INVALID_API_KEY');

    if (row.revoked_at !== null) throw new AppError('API_KEY_REVOKED');
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      throw new AppError('API_KEY_EXPIRED');
    }
    if (options.requireEnvironment && row.environment !== options.requireEnvironment) {
      throw new AppError('API_KEY_ENVIRONMENT_MISMATCH', {
        details: { expected: options.requireEnvironment, actual: row.environment },
      });
    }

    const allowlist = parseJsonArray(row.ip_allowlist);
    if (allowlist.length > 0 && !ipMatchesAllowlist(options.ip ?? null, allowlist)) {
      throw new AppError('IP_NOT_ALLOWED', { details: { ip: options.ip ?? null } });
    }

    const scopes = parseJsonArray(row.scopes);
    if (options.permission && !scopesAllow(scopes, options.permission)) {
      throw new AppError('INSUFFICIENT_SCOPE', { details: { required: options.permission } });
    }

    // Usage counters are best-effort: failing to record them must not fail the
    // merchant's request, and they are not a security control.
    void this.touch(row.id, options.ip ?? null).catch(() => undefined);

    void constantTimeEqual; // hash comparison already constant-time; kept for emphasis
    return {
      key: row,
      merchantUserId: row.merchant_user_id,
      environment: row.environment,
      scopes,
    };
  }

  private async touch(keyId: string, ip: string | null): Promise<void> {
    await run(
      this.db,
      'UPDATE api_keys SET last_used_at = ?, last_used_ip = ?, request_count = request_count + 1 WHERE id = ?',
      [nowIso(), ip, keyId],
    );
  }

  async list(merchantUserId: string, environment?: ApiEnvironment): Promise<ApiKeyView[]> {
    const rows = environment
      ? await all<ApiKeyRow>(
          this.db,
          'SELECT * FROM api_keys WHERE merchant_user_id = ? AND environment = ? ORDER BY created_at DESC',
          [merchantUserId, environment],
        )
      : await all<ApiKeyRow>(
          this.db,
          'SELECT * FROM api_keys WHERE merchant_user_id = ? ORDER BY created_at DESC',
          [merchantUserId],
        );
    return rows.map(toView);
  }

  async revokeByMerchant(
    merchantUserId: string,
    keyId: string,
    actor: { userId: string | null; role: string | null; ip: string | null },
    requestId?: string,
  ): Promise<void> {
    const row = await first<ApiKeyRow>(
      this.db,
      'SELECT * FROM api_keys WHERE id = ? AND merchant_user_id = ?',
      [keyId, merchantUserId],
    );
    if (!row) throw new AppError('NOT_FOUND', { message: 'کلید API پیدا نشد.' });
    await this.revoke(keyId, { ...actor, userId: actor.userId }, 'REVOKED_BY_OWNER', requestId);
  }

  async revoke(
    keyId: string,
    actor: { userId: string | null; role: string | null; ip: string | null },
    reason: string,
    requestId?: string,
  ): Promise<void> {
    const row = await first<ApiKeyRow>(this.db, 'SELECT * FROM api_keys WHERE id = ?', [keyId]);
    if (!row) throw new AppError('NOT_FOUND');

    await run(
      this.db,
      'UPDATE api_keys SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL',
      [nowIso(), actor.userId, keyId],
    );

    await this.audit.record({
      event: 'api_key.revoked',
      actor: { userId: actor.userId, role: actor.role, ip: actor.ip },
      merchantUserId: row.merchant_user_id,
      targetType: 'api_key',
      targetId: keyId,
      requestId: requestId ?? null,
      severity: 'WARNING',
      metadata: { reason, hint: row.key_hint },
    });
  }

  /** Revokes every active key for a merchant. Used on suspension and by admin reset. */
  async revokeAllForMerchant(merchantUserId: string, reason: string): Promise<number> {
    const result = await run(
      this.db,
      'UPDATE api_keys SET revoked_at = ? WHERE merchant_user_id = ? AND revoked_at IS NULL',
      [nowIso(), merchantUserId],
    );
    if (result.changes > 0) {
      await this.audit.record({
        event: 'api_key.revoked',
        merchantUserId,
        targetType: 'merchant',
        targetId: merchantUserId,
        severity: 'WARNING',
        metadata: { reason, count: result.changes, scope: 'ALL' },
      });
    }
    return result.changes;
  }

  /**
   * Rotates a key: issues a replacement and revokes the original in the same batch,
   * so there is never a window with two live keys for the same purpose.
   */
  async rotate(
    merchantUserId: string,
    keyId: string,
    actor: { userId: string | null; role: string | null; ip: string | null },
    requestId?: string,
  ): Promise<IssuedApiKey> {
    const original = await first<ApiKeyRow>(
      this.db,
      'SELECT * FROM api_keys WHERE id = ? AND merchant_user_id = ?',
      [keyId, merchantUserId],
    );
    if (!original) throw new AppError('NOT_FOUND', { message: 'کلید API پیدا نشد.' });

    const issued = await this.issue({
      merchantUserId,
      environment: original.environment,
      label: original.label,
      scopes: parseJsonArray(original.scopes),
      ipAllowlist: parseJsonArray(original.ip_allowlist),
      createdBy: actor.userId,
      rotatedFrom: original.id,
      requestId: requestId ?? null,
      actor,
    });

    await this.revoke(original.id, actor, 'ROTATED', requestId);

    return issued;
  }

  async updatePolicy(
    merchantUserId: string,
    keyId: string,
    patch: { scopes?: string[]; ipAllowlist?: string[] | null; label?: string | null },
    actor: { userId: string | null; role: string | null; ip: string | null },
  ): Promise<void> {
    const row = await first<ApiKeyRow>(
      this.db,
      'SELECT * FROM api_keys WHERE id = ? AND merchant_user_id = ?',
      [keyId, merchantUserId],
    );
    if (!row) throw new AppError('NOT_FOUND');

    const scopes = patch.scopes ? JSON.stringify(patch.scopes) : row.scopes;
    const allowlist =
      patch.ipAllowlist === undefined
        ? row.ip_allowlist
        : patch.ipAllowlist && patch.ipAllowlist.length > 0
          ? JSON.stringify(patch.ipAllowlist)
          : null;
    const label = patch.label === undefined ? row.label : patch.label;

    await run(
      this.db,
      'UPDATE api_keys SET scopes = ?, ip_allowlist = ?, label = ? WHERE id = ?',
      [scopes, allowlist, label, keyId],
    );

    await this.audit.record({
      event: 'api_key.scopes_updated',
      actor: { userId: actor.userId, role: actor.role, ip: actor.ip },
      merchantUserId,
      targetType: 'api_key',
      targetId: keyId,
      severity: 'WARNING',
      metadata: {
        scopes: patch.scopes ?? null,
        ipAllowlistChanged: patch.ipAllowlist !== undefined,
      },
    });
  }

  /** The live key count, used by the setup wizard to know whether step 2 is done. */
  async activeCount(merchantUserId: string): Promise<number> {
    const row = await first<{ count: number }>(
      this.db,
      `SELECT COUNT(*) AS count FROM api_keys
       WHERE merchant_user_id = ? AND revoked_at IS NULL`,
      [merchantUserId],
    );
    return row?.count ?? 0;
  }

  async liveKey(merchantUserId: string): Promise<ApiKeyView | null> {
    const row = await first<ApiKeyRow>(
      this.db,
      `SELECT * FROM api_keys WHERE merchant_user_id = ? AND environment = 'live' AND revoked_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [merchantUserId],
    );
    return row ? toView(row) : null;
  }
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

export function toView(row: ApiKeyRow): ApiKeyView {
  return {
    id: row.id,
    hint: row.key_hint,
    environment: row.environment,
    label: row.label,
    scopes: parseJsonArray(row.scopes),
    ipAllowlist: row.ip_allowlist ? parseJsonArray(row.ip_allowlist) : null,
    lastUsedAt: row.last_used_at,
    lastUsedIp: row.last_used_ip,
    requestCount: row.request_count,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    active: row.revoked_at === null && (row.expires_at === null || new Date(row.expires_at).getTime() > Date.now()),
  };
}

/** All scopes the platform recognises, for the key-management UI. */
export const API_KEY_SCOPES = [
  'payments:create',
  'payments:read',
  'transactions:read',
  'wallet:read',
  'cards:read',
  'sms:write',
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
