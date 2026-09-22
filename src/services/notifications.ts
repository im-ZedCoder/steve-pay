/**
 * Notification centre (§35, §66).
 *
 * A broadcast is stored once and fanned out at read time, so sending to 5,000
 * merchants does not write 5,000 rows. That choice makes the read slightly more
 * expensive and the write enormously cheaper, which is the right trade for an
 * operation an admin performs on a whim.
 *
 * Cooldown deduplication lives here rather than in each caller: `tryClaim` inserts
 * a `notification_log` row whose dedupe key encodes the topic and a time bucket, and
 * a UNIQUE violation means "already sent, stay quiet". That is what stops the
 * low-balance warning firing on every invoice creation attempt.
 */

import { id as newId } from '../core/ids';
import { nowIso, addMinutes } from '../core/time';
import { all, first, run, isUniqueViolation } from '../db/client';
import { AuditService } from './audit';
import type { Role } from '../core/roles';

export type NotificationType =
  | 'INFO'
  | 'SUCCESS'
  | 'WARNING'
  | 'ERROR'
  | 'SYSTEM'
  | 'PAYMENT'
  | 'SECURITY';

export type NotificationPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

export type NotificationAudience = 'ALL_MERCHANTS' | 'ALL_ADMINS' | 'MERCHANT' | 'ADMIN_ROLE' | 'USER';

export interface NotificationRow {
  id: string;
  audience: NotificationAudience;
  target_user_id: string | null;
  target_role: string | null;
  title: string;
  body: string;
  type: NotificationType;
  priority: NotificationPriority;
  link: string | null;
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
  read_at?: string | null;
}

export interface NotificationView extends NotificationRow {
  read: boolean;
}

export class NotificationService {
  private readonly db: D1Database;
  private readonly audit: AuditService;

  constructor(db: D1Database, audit: AuditService) {
    this.db = db;
    this.audit = audit;
  }

  async send(input: {
    audience: NotificationAudience;
    targetUserId?: string | null;
    targetRole?: Role | null;
    title: string;
    body: string;
    type?: NotificationType;
    priority?: NotificationPriority;
    link?: string | null;
    createdBy?: string | null;
    expiresAt?: string | null;
    requestId?: string;
  }): Promise<string> {
    const id = newId('ntf');
    await run(
      this.db,
      `INSERT INTO notifications (
         id, audience, target_user_id, target_role, title, body, type, priority, link, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.audience,
        input.targetUserId ?? null,
        input.targetRole ?? null,
        input.title,
        input.body,
        input.type ?? 'INFO',
        input.priority ?? 'NORMAL',
        input.link ?? null,
        input.createdBy ?? null,
        nowIso(),
        input.expiresAt ?? null,
      ],
    );

    if (input.audience !== 'ALL_MERCHANTS' && input.audience !== 'ALL_ADMINS') {
      await this.audit.record({
        event: 'notification.sent',
        actor: { userId: input.createdBy ?? null },
        merchantUserId: input.audience === 'MERCHANT' ? (input.targetUserId ?? null) : null,
        targetType: 'notification',
        targetId: id,
        requestId: input.requestId ?? null,
        metadata: { audience: input.audience, title: input.title, type: input.type ?? 'INFO' },
      });
    }

    return id;
  }

  /**
   * The notification feed for a user: their own targeted rows plus any broadcast
   * addressed to their audience, with the read flag joined in.
   */
  async feed(
    userId: string,
    role: Role,
    options: { limit?: number; unreadOnly?: boolean } = {},
  ): Promise<NotificationView[]> {
    const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
    const rows = await all<NotificationRow & { read_at: string | null }>(
      this.db,
      `SELECT n.*, r.read_at
       FROM notifications n
       LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ?
       WHERE (n.expires_at IS NULL OR n.expires_at > ?)
         AND (
           (n.audience = 'MERCHANT' OR n.audience = 'USER') AND n.target_user_id = ?
           OR n.audience = 'ALL_MERCHANTS' AND ?
           OR n.audience = 'ALL_ADMINS' AND ?
           OR n.audience = 'ADMIN_ROLE' AND n.target_role = ?
         )
       ORDER BY n.created_at DESC LIMIT ?`,
      [userId, nowIso(), userId, role === 'MERCHANT' ? 1 : 0, role === 'MERCHANT' ? 0 : 1, role, limit],
    );

    return rows
      .map((row) => ({ ...row, read: row.read_at !== null }))
      .filter((row) => (options.unreadOnly ? !row.read : true));
  }

  async unreadCount(userId: string, role: Role): Promise<number> {
    const row = await first<{ count: number }>(
      this.db,
      `SELECT COUNT(*) AS count
       FROM notifications n
       LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ?
       WHERE r.read_at IS NULL
         AND (n.expires_at IS NULL OR n.expires_at > ?)
         AND (
           (n.audience = 'MERCHANT' OR n.audience = 'USER') AND n.target_user_id = ?
           OR n.audience = 'ALL_MERCHANTS' AND ?
           OR n.audience = 'ALL_ADMINS' AND ?
           OR n.audience = 'ADMIN_ROLE' AND n.target_role = ?
         )`,
      [userId, nowIso(), userId, role === 'MERCHANT' ? 1 : 0, role === 'MERCHANT' ? 0 : 1, role],
    );
    return row?.count ?? 0;
  }

  async markRead(userId: string, notificationId: string): Promise<void> {
    await run(
      this.db,
      `INSERT INTO notification_reads (notification_id, user_id, read_at) VALUES (?, ?, ?)
       ON CONFLICT(notification_id, user_id) DO NOTHING`,
      [notificationId, userId, nowIso()],
    );
  }

  async markAllRead(userId: string, role: Role): Promise<number> {
    const feed = await this.feed(userId, role, { limit: 100, unreadOnly: true });
    for (const item of feed) {
      await this.markRead(userId, item.id);
    }
    return feed.length;
  }

  async history(limit = 100): Promise<NotificationRow[]> {
    return all<NotificationRow>(
      this.db,
      'SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?',
      [Math.min(limit, 200)],
    );
  }

  // -------------------------------------------------------------------------
  // Cooldown / dedupe (§66)
  // -------------------------------------------------------------------------

  /**
   * Claims the right to send one notification of a given topic.
   *
   * Returns false when an identical notification is already inside its cooldown
   * window. The claim is a row insert rather than a read-then-write, so two
   * concurrent invoice creations cannot both decide they are the first to warn.
   */
  async tryClaim(input: {
    merchantUserId: string | null;
    channel: 'TELEGRAM' | 'DASHBOARD' | 'EMAIL';
    topic: string;
    /**
     * Buckets the cooldown window. The same topic in the next bucket is a new
     * notification; anything inside the current bucket is suppressed.
     */
    windowMinutes: number;
    severity?: string;
    payload?: Record<string, unknown>;
  }): Promise<{ claimed: boolean; dedupeKey: string }> {
    const bucketMs = Math.max(1, input.windowMinutes) * 60_000;
    const bucket = Math.floor(Date.now() / bucketMs);
    const dedupeKey = `${input.topic}:${input.merchantUserId ?? 'platform'}:${input.channel}:${bucket}`;

    try {
      await run(
        this.db,
        `INSERT INTO notification_log (
           merchant_user_id, channel, topic, dedupe_key, severity, payload, succeeded, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        [
          input.merchantUserId,
          input.channel,
          input.topic,
          dedupeKey,
          input.severity ?? 'INFO',
          input.payload ? JSON.stringify(input.payload) : null,
          nowIso(),
        ],
      );
      return { claimed: true, dedupeKey };
    } catch (error) {
      if (isUniqueViolation(error, 'notification_log.dedupe_key')) {
        return { claimed: false, dedupeKey };
      }
      throw error;
    }
  }

  /** Marks the claim as failed so the topic becomes retryable sooner. */
  async markClaimFailed(dedupeKey: string, error: string): Promise<void> {
    await run(
      this.db,
      'UPDATE notification_log SET succeeded = 0, error = ? WHERE dedupe_key = ?',
      [error.slice(0, 500), dedupeKey],
    );
  }

  async recentClaims(merchantUserId: string, limit = 20): Promise<Array<Record<string, unknown>>> {
    return all<Record<string, unknown>>(
      this.db,
      'SELECT * FROM notification_log WHERE merchant_user_id = ? ORDER BY sent_at DESC LIMIT ?',
      [merchantUserId, Math.min(limit, 100)],
    );
  }

  async pruneLog(days = 90): Promise<number> {
    const result = await run(this.db, 'DELETE FROM notification_log WHERE sent_at < ?', [
      addMinutes(nowIso(), -60 * 24 * days),
    ]);
    return result.changes;
  }
}
