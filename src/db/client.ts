/**
 * Database access helpers.
 *
 * A very thin layer over D1. There is no ORM: the schema is hand-written SQL with
 * constraints that matter (partial unique indexes, CHECKs, append-only triggers),
 * and an ORM would both hide those and fight them. What this module adds is:
 *
 *   - typed row retrieval without `as unknown as T` casts at every call site;
 *   - translation of driver errors into AppError so handlers never inspect a
 *     SQLite message string;
 *   - a single place that knows how a uniqueness violation looks, because
 *     "the insert collided" is a *normal* outcome in a payments system (the unique
 *     amount generator retries on it) and not an exception to be swallowed.
 */

import { AppError } from '../core/errors';

export interface DbClient {
  readonly db: D1Database;
}

/** First row or null. */
export async function first<T>(
  db: D1Database,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  try {
    const result = await db
      .prepare(sql)
      .bind(...params)
      .first<T>();
    return result ?? null;
  } catch (error) {
    throw translate(error, sql);
  }
}

/** All rows. */
export async function all<T>(
  db: D1Database,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  try {
    const result = await db
      .prepare(sql)
      .bind(...params)
      .all<T>();
    return result.results ?? [];
  } catch (error) {
    throw translate(error, sql);
  }
}

/** Single row expected. Throws NOT_FOUND when absent. */
export async function require_<T>(
  db: D1Database,
  sql: string,
  params: readonly unknown[] = [],
  code: 'NOT_FOUND' | 'INVOICE_NOT_FOUND' | 'WALLET_NOT_FOUND' | 'CARD_NOT_FOUND' | 'TICKET_NOT_FOUND' | 'WEBHOOK_NOT_FOUND' | 'TRANSACTION_NOT_FOUND' = 'NOT_FOUND',
): Promise<T> {
  const row = await first<T>(db, sql, params);
  if (row === null) throw new AppError(code);
  return row;
}

/** Scalar count / sum helper. Returns 0 when the query yields NULL. */
export async function scalar(
  db: D1Database,
  sql: string,
  params: readonly unknown[] = [],
): Promise<number> {
  const row = await first<Record<string, unknown>>(db, sql, params);
  if (!row) return 0;
  const value = Object.values(row)[0];
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export interface RunResult {
  changes: number;
  lastRowId: number | null;
}

export async function run(
  db: D1Database,
  sql: string,
  params: readonly unknown[] = [],
): Promise<RunResult> {
  const statement = db.prepare(sql).bind(...params);
  // D1 exposes `meta.changes` on the write result; `run()` is right for writes
  // because it does not try to materialise a result set.
  const result = await safeExecute(statement, sql);
  return { changes: result.meta?.changes ?? 0, lastRowId: result.meta?.last_row_id ?? null };
}

/**
 * Conditional write returning whether it took effect.
 *
 * This is how every guarded money operation is expressed: a single UPDATE with the
 * precondition in its WHERE clause, so the check and the write cannot be separated
 * by another request. `run(...).changes === 0` means "the precondition was not
 * met", which is a normal branch, not a failure.
 */
export async function runConditional(
  db: D1Database,
  sql: string,
  params: readonly unknown[] = [],
): Promise<boolean> {
  const result = await run(db, sql, params);
  return result.changes > 0;
}

/** Statement that returns rows from a write — `INSERT ... RETURNING`. */
export async function runReturning<T>(
  db: D1Database,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await all<T>(db, sql, params);
  return rows[0] ?? null;
}

async function safeExecute(statement: D1PreparedStatement, sql: string): Promise<D1Result> {
  try {
    return await statement.run();
  } catch (error) {
    throw translate(error, sql);
  }
}

/**
 * Batched write. D1 executes a batch as one transaction and rolls the whole batch
 * back if any statement fails, which is what lets multi-table invariants be written
 * without an interactive transaction.
 */
export async function batch(db: D1Database, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  if (statements.length === 0) return [];
  try {
    return await db.batch(statements);
  } catch (error) {
    throw translate(error, 'batch');
  }
}

const UNIQUE_VIOLATION = 'UNIQUE constraint failed';

/**
 * True when the error is a uniqueness violation, optionally for a specific index or
 * column set. The optional `hint` is a substring such as 'invoices.payable_amount'.
 */
export function isUniqueViolation(error: unknown, hint?: string): boolean {
  const message = errorMessage(error);
  if (!message.includes(UNIQUE_VIOLATION)) return false;
  return hint ? message.includes(hint) : true;
}

export function isForeignKeyViolation(error: unknown): boolean {
  return errorMessage(error).includes('FOREIGN KEY constraint failed');
}

export function isCheckViolation(error: unknown, hint?: string): boolean {
  const message = errorMessage(error);
  if (!message.includes('CHECK constraint failed')) return false;
  return hint ? message.includes(hint) : true;
}

/** True when an append-only trigger rejected a write to a protected table. */
export function isAppendOnlyViolation(error: unknown): boolean {
  return errorMessage(error).includes('append-only');
}

const MAX_CAUSE_DEPTH = 5;

/**
 * Flattens an error and its `cause` chain into one searchable string.
 *
 * This is load-bearing, not defensive. `translate()` wraps a driver error in an
 * `AppError('DATABASE_ERROR')` whose own message is a generic Persian sentence, and keeps
 * the original SQLite text in `cause`. So the constraint text that identifies a unique,
 * CHECK or foreign-key failure lives one level *down*, and inspecting only the outermost
 * message makes every `isUniqueViolation` check return false.
 *
 * That failure mode is silent and expensive. The callers of these predicates are the
 * system's safety branches:
 *
 *   invoices.ts   retry the unique-amount allocation with a fresh suffix
 *   confirm.ts    recognise an already-used bank reference as a duplicate transaction
 *   wallet.ts     refuse to charge the same fee twice
 *   sms.ts        recognise a re-forwarded bank SMS
 *   cards.ts      report a duplicate card rather than a database error
 *
 * Walk the chain instead, so the predicate answers the question the caller is actually
 * asking. The chain is bounded because a self-referential `cause` would otherwise loop
 * forever on the error path, which is the worst place to hang.
 */
function errorMessage(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== null && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
      continue;
    }
    parts.push(typeof current === 'string' ? current : String(current));
    break;
  }

  return parts.join(' | ');
}

/**
 * Converts a driver error into something the rest of the system understands.
 *
 * Constraint violations are preserved as AppErrors that name the table involved,
 * because the caller frequently needs to branch on them (retry with a new amount,
 * report a duplicate). Everything else becomes DATABASE_ERROR with the original
 * message retained in `cause` for the log but absent from the API response.
 */
function translate(error: unknown, sql: string): AppError {
  if (error instanceof AppError) return error;
  const message = errorMessage(error);
  const statement = sql.replace(/\s+/g, ' ').slice(0, 120);

  if (message.includes(UNIQUE_VIOLATION)) {
    return new AppError('DATABASE_ERROR', {
      message: 'این رکورد از قبل وجود دارد.',
      details: { kind: 'UNIQUE', statement },
      cause: error,
    });
  }
  if (message.includes('CHECK constraint failed')) {
    return new AppError('DATABASE_ERROR', {
      message: 'مقدار ارسالی با قواعد پایگاه داده سازگار نیست.',
      details: { kind: 'CHECK', statement },
      cause: error,
    });
  }
  if (message.includes('FOREIGN KEY constraint failed')) {
    return new AppError('DATABASE_ERROR', {
      message: 'ارجاع به رکورد ناموجود.',
      details: { kind: 'FOREIGN_KEY', statement },
      cause: error,
    });
  }
  return new AppError('DATABASE_ERROR', { details: { statement }, cause: error });
}

/**
 * Splits a list into chunks for an `IN (?, ?, ...)` clause. D1 caps bound
 * parameters per statement, and an unbounded IN list is an easy way to hit it.
 */
export function chunk<T>(items: readonly T[], size = 50): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** Builds a `?, ?, ?` placeholder list. */
export function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}
