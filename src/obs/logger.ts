/**
 * Structured logging (§45).
 *
 * Cloudflare captures stdout as structured logs, so everything is emitted as a
 * single JSON line. Two rules matter more than the format:
 *
 *   1. Secrets never reach a log line. `redact` runs over every field, and the
 *      field *names* that carry sensitive values are known in one place rather
 *      than trusted to each caller's discipline.
 *   2. Every log line carries the request id, so a support conversation can go
 *      from "my API call failed" to the exact log entry (§44).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Derives a logger carrying extra fields — used to attach merchant/route context. */
  child(fields: LogFields): Logger;
}

/**
 * Field names whose values are never logged. Matched case-insensitively on a
 * substring basis, so `apiKey`, `x-api-key` and `api_key_hash` are all covered.
 */
const SENSITIVE_KEY_PATTERNS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'session',
  'pepper',
  'signature',
  'card_number',
  'cardnumber',
  'cvv',
  'cvc',
  'pin',
  'ssn',
  'national_id',
  'melli_code',
];

const REDACTED = '[redacted]';

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Deep redaction. Cycles are broken rather than throwing: a logger that can crash
 * a request is worse than a logger with a gap in it.
 */
export function redact(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    // A PAN appearing inside a free-text field would otherwise sail straight
    // through. Mask anything 13-19 digits that looks like a card.
    return value.replace(/\b(\d{4})(\d{6,11})(\d{4})\b/g, (_match, first: string, _middle: string, last: string) =>
      `${first}${'*'.repeat(6)}${last}`,
    );
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (typeof value === 'function') return '[function]';
  if (depth > 6) return '[depth]';

  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    return value.slice(0, 50).map((item) => redact(item, seen, depth + 1));
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redact(item, seen, depth + 1);
    }
    return out;
  }
  return String(value);
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Base fields on every line: requestId, environment, route. */
  base?: LogFields;
  /** Injected so tests can capture output instead of writing to stdout. */
  sink?: (line: string) => void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const base = options.base ?? {};
  const sink = options.sink ?? ((line: string) => console.log(line));

  function emit(entryLevel: LogLevel, message: string, fields: LogFields, extra: LogFields): void {
    if (LEVEL_ORDER[entryLevel] < LEVEL_ORDER[level]) return;
    const payload = {
      level: entryLevel,
      time: new Date().toISOString(),
      message,
      ...(redact({ ...base, ...extra, ...fields }) as Record<string, unknown>),
    };
    try {
      sink(JSON.stringify(payload));
    } catch {
      // Serialisation must never take down the request that was being logged.
      sink(JSON.stringify({ level: 'error', message: 'log serialisation failed' }));
    }
  }

  function make(extra: LogFields): Logger {
    return {
      debug: (message, fields) => emit('debug', message, fields ?? {}, extra),
      info: (message, fields) => emit('info', message, fields ?? {}, extra),
      warn: (message, fields) => emit('warn', message, fields ?? {}, extra),
      error: (message, fields) => emit('error', message, fields ?? {}, extra),
      child: (fields) => make({ ...extra, ...fields }),
    };
  }

  return make({});
}

/**
 * Serialises an unknown thrown value into log-safe fields.
 *
 * Note that the stack is included for unexpected errors but never for AppError,
 * which carries a deliberate message instead. The stack goes to the log only; the
 * API response never includes it (§43).
 */
export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    const fields: LogFields = { errorName: error.name, errorMessage: error.message };
    if (error.stack) fields['stack'] = error.stack.split('\n').slice(0, 12).join('\n');
    if ('code' in error) fields['errorCode'] = (error as { code?: unknown }).code;
    if ('status' in error) fields['errorStatus'] = (error as { status?: unknown }).status;
    return fields;
  }
  return { errorName: 'UnknownError', errorMessage: String(error) };
}
