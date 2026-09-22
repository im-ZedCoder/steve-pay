/**
 * Worker environment.
 *
 * Bindings come from wrangler.jsonc; secrets come from `wrangler secret put` in
 * staging and production, and from `.dev.vars` locally.
 *
 * `resolveSecrets` is the important part of this module. A payments platform that
 * silently falls back to a development default for its session key in production
 * is a platform whose sessions anyone can forge. So: missing secrets are a hard
 * failure in production, and a loud, explicit development fallback everywhere
 * else — never a quiet one.
 */

import { AppError } from './core/errors';

export interface WebhookQueueMessage {
  deliveryId: string;
  merchantUserId: string;
  endpointId: string;
  attempt: number;
  /** Set by the cron sweeper so the consumer can distinguish a retry from a first try. */
  reason?: 'initial' | 'retry' | 'manual';
}

export interface Env {
  // --- bindings -------------------------------------------------------------
  DB: D1Database;
  /** Eventual-consistency cache only. Never used for correctness decisions. */
  CACHE: KVNamespace;
  /** Static bytes: CSS and self-hosted fonts. */
  ASSETS: Fetcher;
  /** Absent in local development when the queue is not running; delivery falls back to waitUntil. */
  WEBHOOK_QUEUE?: Queue<WebhookQueueMessage>;

  // --- non-secret vars (wrangler.jsonc `vars`) ------------------------------
  ENVIRONMENT?: string;
  BASE_URL?: string;
  GATEWAY_FEE_TOMAN?: string;
  UNIQUE_SUFFIX_DIGITS?: string;
  TURNSTILE_SITE_KEY?: string;

  // --- secrets --------------------------------------------------------------
  SESSION_SECRET?: string;
  API_KEY_PEPPER?: string;
  WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ADMIN_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_WEBHOOK_ENABLED?: string;
  TURNSTILE_SECRET?: string;
  SMS_IP_ALLOWLIST?: string;
  MAINTENANCE_MODE?: string;

  // --- injected by the test harness ----------------------------------------
  TEST_MIGRATIONS?: unknown;
  TEST_SEEDS?: unknown;
}

export type Environment = 'development' | 'staging' | 'production';

export interface RuntimeConfig {
  environment: Environment;
  isProduction: boolean;
  baseUrl: string;
  /** Default gateway fee from vars; the settings table can override it. */
  defaultGatewayFeeToman: number;
  defaultSuffixDigits: 3 | 4;
  turnstileSiteKey: string;
}

export interface ResolvedSecrets {
  sessionSecret: string;
  apiKeyPepper: string;
  webhookSecret: string;
  telegramBotToken: string | null;
  telegramAdminChatId: string | null;
  telegramWebhookSecret: string | null;
  telegramEnabled: boolean;
  turnstileSecret: string | null;
  /** True when any secret was replaced by a development placeholder. */
  usingDevelopmentFallbacks: boolean;
}

function environmentOf(env: Env): Environment {
  const raw = (env.ENVIRONMENT ?? 'development').toLowerCase();
  if (raw === 'production' || raw === 'prod') return 'production';
  if (raw === 'staging' || raw === 'stage') return 'staging';
  return 'development';
}

/**
 * Development placeholders.
 *
 * Fixed, obvious strings rather than random ones, so that a value copied out of a
 * local database into production keeps working — a random per-isolate default
 * would make local data undecryptable on the next restart and turn a security
 * guard into a support burden.
 */
const DEV_SESSION_SECRET = 'dev-only-session-secret-not-for-production';
const DEV_API_KEY_PEPPER = 'dev-only-api-key-pepper-not-for-production';
const DEV_WEBHOOK_SECRET = 'dev-only-webhook-secret-not-for-production';

export function resolveSecrets(env: Env): ResolvedSecrets {
  const environment = environmentOf(env);
  const missing: string[] = [];
  let usedFallback = false;

  function require(name: string, value: string | undefined, fallback: string): string {
    if (value && value.length >= 16) return value;
    if (environment === 'production') {
      missing.push(name);
      return '';
    }
    usedFallback = true;
    return fallback;
  }

  const sessionSecret = require('SESSION_SECRET', env.SESSION_SECRET, DEV_SESSION_SECRET);
  const apiKeyPepper = require('API_KEY_PEPPER', env.API_KEY_PEPPER, DEV_API_KEY_PEPPER);
  const webhookSecret = require('WEBHOOK_SECRET', env.WEBHOOK_SECRET, DEV_WEBHOOK_SECRET);

  if (missing.length > 0) {
    // Fail closed and name the missing secrets. The error is deliberately not
    // "public": it must never render on a page.
    throw new AppError('INTERNAL_ERROR', {
      message: `Missing required secrets in production: ${missing.join(', ')}. Set them with \`wrangler secret put <NAME> --env production\`.`,
      details: { missing },
    });
  }

  const turnstileSecret = env.TURNSTILE_SECRET && env.TURNSTILE_SECRET.length > 0 ? env.TURNSTILE_SECRET : null;
  const telegramBotToken =
    env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_TOKEN.length > 0 ? env.TELEGRAM_BOT_TOKEN : null;
  const telegramAdminChatId =
    env.TELEGRAM_ADMIN_CHAT_ID && env.TELEGRAM_ADMIN_CHAT_ID.length > 0 ? env.TELEGRAM_ADMIN_CHAT_ID : null;

  return {
    sessionSecret,
    apiKeyPepper,
    webhookSecret,
    telegramBotToken,
    telegramAdminChatId,
    telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET ?? null,
    telegramEnabled: telegramBotToken !== null && (env.TELEGRAM_WEBHOOK_ENABLED ?? 'false') !== 'false',
    turnstileSecret,
    usingDevelopmentFallbacks: usedFallback,
  };
}

export function resolveConfig(env: Env): RuntimeConfig {
  const environment = environmentOf(env);
  const fee = Number(env.GATEWAY_FEE_TOMAN ?? '3000');
  const digits = Number(env.UNIQUE_SUFFIX_DIGITS ?? '4');

  return {
    environment,
    isProduction: environment === 'production',
    // A trailing slash would produce "https://host//pay/inv_..." in callbacks, so
    // it is stripped once here rather than at every concatenation site.
    baseUrl: (env.BASE_URL ?? 'http://localhost:8787').replace(/\/+$/, ''),
    defaultGatewayFeeToman: Number.isFinite(fee) && fee >= 0 ? Math.floor(fee) : 3000,
    defaultSuffixDigits: digits === 3 ? 3 : 4,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? '',
  };
}

/** Parses a comma-separated CIDR / IP allowlist. Empty means "no restriction". */
export function parseIpAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * IPv4 CIDR containment, plus exact matches for bare addresses (including IPv6,
 * which is compared as a string rather than parsed).
 *
 * Deliberately small: an allowlist is a defence-in-depth measure behind API key
 * authentication, not the primary control, and pulling in a CIDR library to
 * support exotic prefixes would be a poor trade.
 */
export function ipMatchesAllowlist(ip: string | null, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  if (!ip) return false;

  for (const entry of allowlist) {
    if (entry === ip) return true;
    const slash = entry.indexOf('/');
    if (slash < 0) continue;

    const network = entry.slice(0, slash);
    const prefixRaw = entry.slice(slash + 1);
    if (!network.includes('.') || !ip.includes('.')) continue; // IPv6 handled by exact match only

    const prefix = Number(prefixRaw);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) continue;

    const networkValue = ipv4ToInt(network);
    const ipValue = ipv4ToInt(ip);
    if (networkValue === null || ipValue === null) continue;

    if (prefix === 0) return true;
    // Comparing with >>> keeps the mask unsigned; a signed shift would break /1 and
    // /0 by filling with ones.
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    if ((networkValue & mask) >>> 0 === (ipValue & mask) >>> 0) return true;
  }
  return false;
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

/**
 * The client IP as Cloudflare reports it. `CF-Connecting-IP` is set by the edge
 * and cannot be spoofed by the client, which is why it is preferred over
 * X-Forwarded-For.
 */
export function clientIp(request: Request): string | null {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('x-real-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    null
  );
}
