/**
 * Identifiers.
 *
 * Every row gets a prefixed ULID: `inv_01J8ZC4K9WQ7YB3M5NPT6XR2VD`.
 *
 * Why ULID rather than a UUID or an autoincrement:
 *   - Lexicographically sortable by creation time, so `ORDER BY id` is a
 *     meaningful ordering and B-tree inserts stay sequential rather than
 *     scattering across the index the way random UUIDv4 does.
 *   - 26 Crockford base32 characters, URL-safe and case-insensitive, so an
 *     invoice id survives being pasted into a chat message or a support ticket.
 *   - The prefix means a support engineer can tell what an id refers to, and it
 *     makes an id belonging to the wrong table obvious at a glance instead of
 *     silently resolving to the wrong record.
 *
 * Timestamps use Date.now(); the generator is monotonic within an isolate so two
 * ids created in the same millisecond still sort in creation order.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U
const TIME_CHARS = 10;
const RANDOM_BYTES = 10;

export type IdPrefix =
  | 'usr'
  | 'ses'
  | 'key'
  | 'inv'
  | 'pay'
  | 'txn'
  | 'sms'
  | 'pr'
  | 'wl'
  | 'wh'
  | 'whd'
  | 'ntf'
  | 'tkt'
  | 'tmsg'
  | 'tr'
  | 'card'
  | 'evt'
  | 'req'
  | 'job';

let lastTimestamp = 0;
// Mutated in place by `crypto.getRandomValues` and by the monotonic increment, so
// it must never be rebound — a rebind would break the continuity that makes two ids
// in the same millisecond sort in creation order.
const lastRandom = new Uint8Array(RANDOM_BYTES);

function encodeTime(timestamp: number): string {
  let remaining = timestamp;
  let out = '';
  for (let index = 0; index < TIME_CHARS; index += 1) {
    out = (ENCODING[remaining % 32] ?? '0') + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

/** Encodes 10 bytes (80 bits) into exactly 16 base32 characters. */
function encodeRandom(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let available = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    available += 8;
    while (available >= 5) {
      available -= 5;
      out += ENCODING[(buffer >>> available) & 31] ?? '0';
    }
    buffer &= (1 << available) - 1;
  }
  return out;
}

/** Big-endian increment so repeated calls in one millisecond stay monotonic. */
function incrementRandom(bytes: Uint8Array): boolean {
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    const next = (bytes[index] ?? 0) + 1;
    if (next <= 0xff) {
      bytes[index] = next;
      return true;
    }
    bytes[index] = 0;
  }
  return false; // fully wrapped
}

/**
 * Generates a bare ULID (no prefix). Kept exported so tests can pin the format.
 * `now` is injectable; production callers should let it default.
 */
export function ulid(now: number = Date.now()): string {
  if (now > lastTimestamp) {
    lastTimestamp = now;
    crypto.getRandomValues(lastRandom);
  } else {
    // Same millisecond, or a clock that moved backwards. Keeping the previous
    // timestamp and bumping the randomness preserves strict monotonicity, which
    // matters because two ids in the same millisecond must still sort by
    // creation order.
    if (!incrementRandom(lastRandom)) {
      lastTimestamp += 1;
      crypto.getRandomValues(lastRandom);
    }
    now = lastTimestamp;
  }
  return encodeTime(now) + encodeRandom(lastRandom);
}

/** `id('inv')` -> `inv_01J8ZC4K9WQ7YB3M5NPT6XR2VD`. */
export function id(prefix: IdPrefix, now?: number): string {
  return `${prefix}_${ulid(now)}`;
}

/** Extracts the prefix from an id, or null when it is not a Steve Pay id. */
export function prefixOf(value: string): string | null {
  const separator = value.indexOf('_');
  if (separator <= 0) return null;
  const prefix = value.slice(0, separator);
  return /^[a-z]{2,5}$/.test(prefix) ? prefix : null;
}

/** True when an id looks well-formed and carries the expected prefix. */
export function hasPrefix(value: string, prefix: IdPrefix): boolean {
  const expected = `${prefix}_`;
  if (!value.startsWith(expected)) return false;
  const body = value.slice(expected.length);
  return body.length === 26 && /^[0-9A-HJKMNP-TV-Z]+$/.test(body);
}

/**
 * Extracts the creation instant from a ULID id. Used by the admin console to show
 * when a record was made without loading it, and by reconciliation jobs that need
 * to bucket rows by age cheaply.
 */
export function timestampFromId(value: string): Date | null {
  const separator = value.indexOf('_');
  const body = separator >= 0 ? value.slice(separator + 1) : value;
  if (body.length < TIME_CHARS) return null;
  let timestamp = 0;
  for (let index = 0; index < TIME_CHARS; index += 1) {
    const charIndex = ENCODING.indexOf(body[index] ?? '');
    if (charIndex < 0) return null;
    timestamp = timestamp * 32 + charIndex;
  }
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Turns a seed into a deterministic id. Used by the test-pipeline runner so a
 * re-run produces the same ids and can therefore be cleaned up idempotently.
 */
export function deterministicId(prefix: IdPrefix, seed: string, now: number): string {
  // Small non-cryptographic hash suffices: this is for reproducible fixtures, not
  // for anything an attacker benefits from predicting.
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const bytes = new Uint8Array(RANDOM_BYTES);
  let state = hash >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    bytes[index] = state & 0xff;
  }
  return `${prefix}_${encodeTime(now)}${encodeRandom(bytes)}`;
}

/** Request id used in logs, error bodies and audit rows (§44). */
export function requestId(): string {
  return id('req');
}
