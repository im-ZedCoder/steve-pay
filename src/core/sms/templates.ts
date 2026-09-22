/**
 * Bank SMS templates.
 *
 * IMPORTANT, and deliberately stated in code rather than buried in a doc:
 * these templates are *calibrated starting points*, not a verified catalogue.
 * Iranian banks change SMS wording without notice, and the same bank words
 * messages differently per product (card-to-card, account-to-account, POS
 * settlement, salary). Treating any of these as authoritative would be a
 * mistake.
 *
 * The operational answer is the one the architecture already provides:
 *   - Every raw message is stored, and every parse is stored beside it.
 *   - `generic` is always tried last, so a format these templates do not know
 *     still produces a usable parse instead of being dropped.
 *   - /admin/sms lists recent messages with their parse result, which is exactly
 *     the screen an engineer needs to write the next template against real text.
 *   - Templates can be added at runtime from system settings, so calibrating a
 *     bank does not require a deploy.
 *
 * `required` is matched against normalised text, so a template names the bank by
 * the token the bank actually prints. Where a bank does not name itself, no
 * template matches and the generic parser carries the message — which is the
 * correct outcome, because guessing a bank from formatting alone is how you get a
 * confidently wrong parse.
 */

import type { BankTemplate } from './types';

export const BANK_TEMPLATES: readonly BankTemplate[] = [
  {
    id: 'mellat',
    bank: 'بانک ملت',
    required: ['ملت'],
    optional: ['واریز', 'شماره پیگیری', 'مانده', 'به حساب'],
    defaultCurrency: 'IRT',
    directionKeywords: { in: ['واریز', 'به حساب', 'افزایش'] },
  },
  {
    id: 'melli',
    bank: 'بانک ملی ایران',
    required: ['ملی'],
    optional: ['واریز', 'پیگیری', 'مانده', 'بستانکار'],
    defaultCurrency: 'IRT',
    directionKeywords: { in: ['واریز', 'بستانکار', 'افزایش'] },
  },
  {
    id: 'saderat',
    bank: 'بانک صادرات ایران',
    required: ['صادرات'],
    optional: ['واریز', 'پیگیری', 'مانده'],
    defaultCurrency: 'IRT',
  },
  {
    id: 'saman',
    bank: 'بانک سامان',
    required: ['سامان'],
    optional: ['واریز', 'پیگیری', 'مانده', 'اعتبار'],
    defaultCurrency: 'IRT',
  },
  {
    id: 'parsian',
    bank: 'بانک پارسیان',
    required: ['پارسیان'],
    optional: ['واریز', 'پیگیری', 'مانده'],
    defaultCurrency: 'IRT',
  },
  {
    id: 'pasargad',
    bank: 'بانک پاسارگاد',
    required: ['پاسارگاد'],
    optional: ['واریز', 'پیگیری', 'مانده', 'بستانکار'],
    defaultCurrency: 'IRT',
  },
  {
    id: 'tejarat',
    bank: 'بانک تجارت',
    required: ['تجارت'],
    optional: ['واریز', 'پیگیری', 'مانده'],
    defaultCurrency: 'IRT',
  },
  {
    id: 'maskan',
    bank: 'بانک مسکن',
    required: ['مسکن'],
    optional: ['واریز', 'پیگیری', 'مانده'],
    defaultCurrency: 'IRT',
  },
  {
    id: 'eghtesad-novin',
    bank: 'بانک اقتصاد نوین',
    required: ['اقتصاد نوین', 'اقتصاد'],
    optional: ['واریز', 'پیگیری', 'مانده'],
    defaultCurrency: 'IRT',
  },
  {
    id: 'sepah',
    bank: 'بانک سپه',
    required: ['سپه'],
    optional: ['واریز', 'پیگیری', 'مانده'],
    defaultCurrency: 'IRT',
  },
  {
    id: 'keshavarzi',
    bank: 'بانک کشاورزی',
    required: ['کشاورزی'],
    optional: ['واریز', 'پیگیری', 'مانده'],
    defaultCurrency: 'IRT',
  },
  {
    id: 'shahr',
    bank: 'بانک شهر',
    required: ['شهر'],
    optional: ['واریز', 'پیگیری', 'مانده'],
    defaultCurrency: 'IRT',
  },
  {
    id: 'refah',
    bank: 'بانک رفاه کارگران',
    required: ['رفاه'],
    optional: ['واریز', 'پیگیری', 'مانده'],
    defaultCurrency: 'IRT',
  },
  {
    id: 'sina',
    bank: 'بانک سینا',
    required: ['سینا'],
    optional: ['واریز', 'پیگیری', 'مانده'],
    defaultCurrency: 'IRT',
  },
];

/**
 * Compiles a template supplied as JSON — from system settings, or from a test.
 *
 * Regexes arrive as strings, which is why this exists: a template that arrives
 * through `JSON.parse` cannot carry a RegExp, and the admin console can therefore
 * add a bank without a deploy. The `g` and `y` flags are stripped because a
 * stateful RegExp reused across messages produces results that depend on how many
 * messages came before it — a genuinely nasty class of bug.
 */
export interface RawBankTemplate {
  id?: unknown;
  bank?: unknown;
  required?: unknown;
  optional?: unknown;
  defaultCurrency?: unknown;
  amountPattern?: unknown;
  amountPatternGroup?: unknown;
  referencePattern?: unknown;
  destinationCardPattern?: unknown;
  balancePattern?: unknown;
  directionKeywords?: unknown;
}

function toRegExp(value: unknown): RegExp | undefined {
  if (value instanceof RegExp) return new RegExp(value.source, value.flags.replace(/[gy]/g, ''));
  if (typeof value !== 'string' || value.length === 0) return undefined;
  // Accept both "/pattern/flags" and a bare pattern source.
  const slashed = /^\/(.+)\/([a-z]*)$/.exec(value);
  const source = slashed?.[1] ?? value;
  const flags = (slashed?.[2] ?? '').replace(/[gy]/g, '');
  try {
    return new RegExp(source, flags);
  } catch {
    return undefined;
  }
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return items.length > 0 ? items : undefined;
}

export function compileTemplate(raw: RawBankTemplate): BankTemplate | null {
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
  if (typeof raw.bank !== 'string' || raw.bank.length === 0) return null;
  const required = toStringArray(raw.required);
  if (!required || required.length === 0) return null;
  const defaultCurrency = raw.defaultCurrency === 'IRR' ? 'IRR' : 'IRT';

  const template: BankTemplate = {
    id: raw.id,
    bank: raw.bank,
    required,
    defaultCurrency,
  };
  const optional = toStringArray(raw.optional);
  if (optional) template.optional = optional;

  const amountPattern = toRegExp(raw.amountPattern);
  if (amountPattern) template.amountPattern = amountPattern;
  if (typeof raw.amountPatternGroup === 'number') template.amountPatternGroup = raw.amountPatternGroup;

  const referencePattern = toRegExp(raw.referencePattern);
  if (referencePattern) template.referencePattern = referencePattern;

  const destinationCardPattern = toRegExp(raw.destinationCardPattern);
  if (destinationCardPattern) template.destinationCardPattern = destinationCardPattern;

  const balancePattern = toRegExp(raw.balancePattern);
  if (balancePattern) template.balancePattern = balancePattern;

  if (raw.directionKeywords && typeof raw.directionKeywords === 'object') {
    const keywords = raw.directionKeywords as { in?: unknown; out?: unknown };
    const inWords = toStringArray(keywords.in);
    const outWords = toStringArray(keywords.out);
    if (inWords || outWords) {
      template.directionKeywords = {};
      if (inWords) template.directionKeywords.in = inWords;
      if (outWords) template.directionKeywords.out = outWords;
    }
  }

  return template;
}

/** Parses a JSON array of templates, dropping any entry that fails to compile. */
export function compileTemplates(json: string | null | undefined): BankTemplate[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    const compiled: BankTemplate[] = [];
    for (const entry of parsed) {
      if (entry && typeof entry === 'object') {
        const template = compileTemplate(entry as RawBankTemplate);
        if (template) compiled.push(template);
      }
    }
    return compiled;
  } catch {
    return [];
  }
}
