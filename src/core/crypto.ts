/**
 * Cryptographic primitives.
 *
 * Everything here runs on WebCrypto, which is native in the Workers runtime.
 *
 * Rules this module exists to enforce:
 *   - Passwords are PBKDF2-SHA256, never reversible, never logged.
 *   - API keys are stored as an HMAC of the full key under a server-side pepper.
 *     A database dump without the pepper does not yield usable keys, which is why
 *     the pepper is a separate secret rather than a column.
 *   - Webhook secrets are sealed with AES-GCM before storage, so a read-only
 *     database compromise does not hand an attacker the ability to forge
 *     callbacks to merchants.
 *   - All comparisons of secrets are constant-time.
 */

const TEXT_ENCODER = new TextEncoder();

/**
 * PBKDF2 work factor.
 *
 * Capped at 100,000 by the runtime, not by preference. WebCrypto in the Workers runtime
 * refuses a higher count outright:
 *
 *   NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported
 *
 * and it refuses *before* deriving anything. That distinction is the whole reason this
 * comment is long: the ceiling does not show up as a slow login, it shows up as a thrown
 * error, so a value above it locks out every account at once. This constant was 210,000 —
 * taken from OWASP's guidance, and a number the local test pool accepts happily, because
 * the pool runs a different build of the same runtime than the network does. Every login in
 * production failed for it, merchant and admin alike.
 *
 * `tests/pure-domain.test.ts` pins the ceiling so the next raise fails in CI rather than on
 * the sign-in page. Because PBKDF2 is capped here, the rest of the defence has to carry more
 * weight: a per-number login rate limit, an account lockout after repeated failures, and
 * short admin session lifetimes.
 *
 * The stored format records the iteration count, so a hash written today keeps verifying if
 * the runtime ever raises its ceiling.
 */
export const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH = 'SHA-256';
const SALT_BYTES = 16;
const DERIVED_BITS = 256;

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const withPadding = padded + '='.repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(withPadding);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Uniformly-random base62 string. Rejection sampling avoids modulo bias. */
export function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    const buffer = new Uint8Array(length * 2);
    crypto.getRandomValues(buffer);
    for (const byte of buffer) {
      // 256 is not a multiple of 62; discard the top of the range instead of
      // folding it in, which would bias the first eight characters.
      if (byte >= 248) continue;
      out += BASE62[byte % 62] ?? '0';
      if (out.length === length) break;
    }
  }
  return out;
}

export function randomBytes(length: number): Uint8Array {
  const buffer = new Uint8Array(length);
  crypto.getRandomValues(buffer);
  return buffer;
}

export function randomToken(byteLength = 32): string {
  return toBase64Url(randomBytes(byteLength));
}

/** Alias kept for readability at call sites that are not dealing with tokens. */
export function randomBase64UrlSafe(byteLength = 32): string {
  return randomToken(byteLength);
}

/** A short human-quotable code (support flows, test tokens). Easily transcribed. */
export function randomCode(segments = 2, segmentLength = 4): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
  const parts: string[] = [];
  for (let segment = 0; segment < segments; segment += 1) {
    const bytes = randomBytes(segmentLength);
    let part = '';
    for (const byte of bytes) part += alphabet[byte % alphabet.length] ?? 'A';
    parts.push(part);
  }
  return parts.join('-');
}

// ---------------------------------------------------------------------------
// Digests and MACs
// ---------------------------------------------------------------------------

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === 'string' ? TEXT_ENCODER.encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}

export async function hmacSha256(keyInput: string | Uint8Array, message: string): Promise<Uint8Array> {
  const keyBytes = typeof keyInput === 'string' ? TEXT_ENCODER.encode(keyInput) : keyInput;
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, TEXT_ENCODER.encode(message));
  return new Uint8Array(signature);
}

export async function hmacSha256Hex(keyInput: string | Uint8Array, message: string): Promise<string> {
  return toHex(await hmacSha256(keyInput, message));
}

/** Constant-time comparison. Never use `===` on a secret. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

export function constantTimeEqualHex(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length) return false;
  return constantTimeEqual(fromHex(aHex), fromHex(bHex));
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

async function derivePassword(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', TEXT_ENCODER.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: PBKDF2_HASH },
    key,
    DERIVED_BITS,
  );
  return new Uint8Array(bits);
}

/**
 * Stored format: `pbkdf2-sha256$<iterations>$<salt>$<derived>`, both base64url.
 * Self-describing so the work factor can be raised later without invalidating
 * existing passwords.
 */
export async function hashPassword(
  password: string,
  options: { iterations?: number } = {},
): Promise<string> {
  const iterations = options.iterations ?? PBKDF2_ITERATIONS;
  const salt = randomBytes(SALT_BYTES);
  const derived = await derivePassword(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${toBase64Url(salt)}$${toBase64Url(derived)}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
  options: { iterations?: number } = {},
): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4) return false;
  const [scheme, iterationsRaw, saltRaw, expectedRaw] = parts as [string, string, string, string];
  if (scheme !== 'pbkdf2-sha256') return false;
  const iterations = Number(iterationsRaw);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromBase64Url(saltRaw);
    expected = fromBase64Url(expectedRaw);
  } catch {
    return false;
  }

  // `options.iterations` lets tests run a cheap work factor without weakening
  // production hashes, which always use the stored count.
  const derived = await derivePassword(password, salt, options.iterations ?? iterations);
  return constantTimeEqual(derived, expected);
}

/** True when a stored hash was produced with a weaker work factor than the current target. */
export function passwordNeedsRehash(stored: string, target = PBKDF2_ITERATIONS): boolean {
  const parts = stored.split('$');
  if (parts.length !== 4) return true;
  return Number(parts[1]) < target;
}

// ---------------------------------------------------------------------------
// Key derivation and sealing
// ---------------------------------------------------------------------------

/** HKDF-SHA256, used to derive purpose-specific keys from a root secret. */
export async function deriveKeyBytes(
  rootSecret: string,
  info: string,
  byteLength = 32,
): Promise<Uint8Array> {
  const rootKey = await crypto.subtle.importKey(
    'raw',
    TEXT_ENCODER.encode(rootSecret),
    'HKDF',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: TEXT_ENCODER.encode('steve-pay/v1'),
      info: TEXT_ENCODER.encode(info),
    },
    rootKey,
    byteLength * 8,
  );
  return new Uint8Array(bits);
}

/**
 * AES-256-GCM seal. Output is base64url(iv || ciphertext || tag).
 *
 * `info` scopes the derived key so a secret sealed for one purpose cannot be
 * unsealed as another.
 */
export async function seal(plaintext: string, rootSecret: string, info = 'seal'): Promise<string> {
  const keyBytes = await deriveKeyBytes(rootSecret, info, 32);
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    TEXT_ENCODER.encode(plaintext),
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return toBase64Url(combined);
}

/** Inverse of seal. Returns null on tampering rather than throwing, so callers
 *  can treat an unreadable secret as "rotate it" instead of crashing a request. */
export async function unseal(
  sealed: string,
  rootSecret: string,
  info = 'seal',
): Promise<string | null> {
  try {
    const combined = fromBase64Url(sealed);
    if (combined.length <= 12) return null;
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const keyBytes = await deriveKeyBytes(rootSecret, info, 32);
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export type ApiEnvironment = 'live' | 'test';

export interface GeneratedApiKey {
  /** The only time this value exists in plaintext. Shown once, then discarded. */
  fullKey: string;
  /** Non-secret lookup component, indexed in the database. */
  lookupId: string;
  /** Masked form for lists and logs: `sk_live_a1b2c3d4…9f0g`. */
  hint: string;
  environment: ApiEnvironment;
}

const API_KEY_ENVIRONMENTS: readonly ApiEnvironment[] = ['live', 'test'];

/**
 * Wire format: `sk_<env>_<lookupId:12><secret:32>`.
 *
 * The lookupId is stored in the clear so authentication is one indexed read
 * instead of a scan-and-compare over every stored hash. The secret never is: only
 * HMAC(pepper, fullKey) is persisted, compared in constant time.
 */
export function generateApiKey(environment: ApiEnvironment): GeneratedApiKey {
  const env: ApiEnvironment = API_KEY_ENVIRONMENTS.includes(environment) ? environment : 'live';
  const lookupId = randomBase62(12);
  const secret = randomBase62(32);
  const fullKey = `sk_${env}_${lookupId}${secret}`;
  return {
    fullKey,
    lookupId,
    hint: `sk_${env}_${lookupId.slice(0, 6)}…${secret.slice(-4)}`,
    environment: env,
  };
}

export interface ParsedApiKey {
  environment: ApiEnvironment;
  lookupId: string;
  secret: string;
}

/**
 * Splits a presented key. Returns null for anything malformed so the caller can
 * answer a generic INVALID_API_KEY without revealing which part was wrong.
 */
export function parseApiKey(presented: string): ParsedApiKey | null {
  const trimmed = presented.trim();
  if (!trimmed.startsWith('sk_')) return null;
  const parts = trimmed.split('_');
  if (parts.length !== 3) return null;
  const [, environmentRaw, tail] = parts as [string, string, string];
  if (environmentRaw !== 'live' && environmentRaw !== 'test') return null;
  if (tail.length < 20) return null;
  const lookupId = tail.slice(0, 12);
  const secret = tail.slice(12);
  if (!/^[0-9A-Za-z]{12}$/.test(lookupId) || secret.length < 16) return null;
  return { environment: environmentRaw, lookupId, secret };
}

/** HMAC of the whole presented key under the server pepper. */
export async function hashApiKey(fullKey: string, pepper: string): Promise<string> {
  return hmacSha256Hex(pepper, `apikey:${fullKey}`);
}

export async function verifyApiKeyHash(
  fullKey: string,
  storedHash: string,
  pepper: string,
): Promise<boolean> {
  const computed = await hashApiKey(fullKey, pepper);
  return constantTimeEqualHex(computed, storedHash);
}

export function apiKeyHint(fullKey: string): string {
  const parsed = parseApiKey(fullKey);
  if (!parsed) return 'sk_…';
  return `sk_${parsed.environment}_${parsed.lookupId.slice(0, 6)}…${parsed.secret.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Webhook signing (§20, §21)
// ---------------------------------------------------------------------------

export function generateWebhookSecret(): string {
  return `whsec_${randomBase62(40)}`;
}

export interface WebhookSignatureInput {
  secret: string;
  timestamp: string;
  deliveryId: string;
  /** The exact body bytes that were sent. Re-serialising the JSON will produce a
   *  different string and a failing signature, so the raw text must be reused. */
  body: string;
}

/**
 * Signature over `timestamp.deliveryId.body`.
 *
 * Binding all three means a captured request cannot be replayed with a different
 * body, and cannot be replayed at a later time even if the body is identical —
 * the receiver rejects a timestamp outside its tolerance window. The receiver
 * must compute the signature over the *raw bytes it received*, not over a
 * re-serialisation of the parsed JSON.
 */
export async function signWebhook(input: WebhookSignatureInput): Promise<string> {
  const payload = `${input.timestamp}.${input.deliveryId}.${input.body}`;
  const signature = await hmacSha256Hex(input.secret, payload);
  return `v1=${signature}`;
}

export async function verifyWebhookSignature(
  input: WebhookSignatureInput,
  headerSignature: string,
): Promise<boolean> {
  const expected = await signWebhook(input);
  if (expected.length !== headerSignature.length) return false;
  return constantTimeEqualHex(expected.slice(3), headerSignature.replace(/^v1=/, ''));
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Session cookie value. 32 bytes of entropy; only its SHA-256 is stored. */
export function generateSessionToken(): string {
  return randomToken(32);
}

export async function hashSessionToken(token: string): Promise<string> {
  return sha256Hex(`session:${token}`);
}
