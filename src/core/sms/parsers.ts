/**
 * Parser implementations and the parsing engine.
 *
 *   SmsParser (interface)
 *    ├── TemplateParser    one instance per BankTemplate — the whole bank library
 *    └── GenericParser     always last, no bank knowledge, best-effort
 *
 * The engine runs the applicable parsers, scores each result, and returns the
 * best one alongside every alternative so the manual review screen can show what
 * else the message could have meant. Nothing is thrown away: a message that
 * parses badly is the most valuable thing in the log when a bank changes format.
 */

import { normalizeSmsBody } from '../digits';
import { extractTestToken } from './types';
import type { BankTemplate, Currency, ParsedSms, SmsParseContext, SmsParser } from './types';
import {
  extractAmounts,
  extractBalanceToman,
  extractCards,
  extractDirection,
  extractOccurredAt,
  extractReference,
  extractUnitlessAmount,
  type AmountMatch,
} from './extract';
import { BANK_TEMPLATES } from './templates';

/** Minimum Toman a parse must reach before it is worth attempting to match. */
const MIN_PLAUSIBLE_TOMAN = 100;

// ---------------------------------------------------------------------------
// Amount normalisation
// ---------------------------------------------------------------------------

interface NormalisedAmount {
  amountToman: number;
  amountRial: number;
  currency: Currency;
  raw: string | null;
  warnings: string[];
}

/**
 * Converts a matched figure into both units.
 *
 * The Rial <-> Toman conversion is the single most dangerous operation in this
 * codebase, so the direction is always decided by the *unit word in the message*,
 * never by magnitude heuristics. A 10x error silently pays the wrong invoice, and
 * magnitude guessing ("that looks like Rial") is exactly how it happens.
 */
export function normaliseAmount(match: AmountMatch, defaultCurrency: Exclude<Currency, 'UNKNOWN'>): NormalisedAmount {
  const warnings: string[] = [];
  const currency: Currency = match.unit === 'UNKNOWN' ? defaultCurrency : match.unit;

  if (match.unit === 'UNKNOWN') warnings.push('SMS_AMOUNT_UNIT_INFERRED');

  if (currency === 'IRT') {
    return {
      amountToman: match.value,
      amountRial: match.value * 10,
      currency,
      raw: match.raw,
      warnings,
    };
  }

  // Rial. A Rial figure that is not a multiple of ten cannot be a whole number of
  // Toman, which usually means the text was misread (a decimal separator, or a
  // balance confused for an amount). Keep the exact Rial value and flag it rather
  // than rounding money away.
  if (match.value % 10 !== 0) warnings.push('SMS_RIAL_NOT_DIVISIBLE_BY_10');
  return {
    amountToman: Math.floor(match.value / 10),
    amountRial: match.value,
    currency,
    raw: match.raw,
    warnings,
  };
}

/**
 * Chooses which of several numbers in a message is the payment amount.
 *
 * Banks routinely include a post-transaction balance in the same message, and it
 * looks exactly like an amount. The disambiguation uses the fact that the balance
 * has its own label: any candidate equal to the labelled balance is demoted, and
 * among the rest the one nearest a money verb wins.
 */
function choosePrimaryAmount(text: string, amounts: AmountMatch[], balanceToman: number | null): AmountMatch | null {
  if (amounts.length === 0) return null;
  if (amounts.length === 1) return amounts[0] ?? null;

  const balanceIndex = text.search(/(?:مانده|موجودی|balance)/i);
  const moneyVerbIndex = text.search(/(?:مبلغ|واریز|واريز|انتقال|افزایش|بستانکار|deposit|credit)/i);

  const scored = amounts.map((amount, index) => {
    let score = 0;
    // An explicit unit is the strongest signal available.
    if (amount.unit !== 'UNKNOWN') score += 30;
    // Demote anything that equals the labelled balance.
    if (balanceToman !== null && amount.value === balanceToman) score -= 40;
    // Prefer the candidate closest to a money verb.
    if (moneyVerbIndex >= 0) score += Math.max(0, 20 - Math.abs(index - moneyVerbIndex) / 4);
    void balanceIndex;
    return { amount, score, index };
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored[0]?.amount ?? null;
}

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

interface ConfidenceInput {
  templateSpecificity: number; // 0 for generic, higher for a matched bank template
  hasExplicitUnit: boolean;
  hasReference: boolean;
  hasDestinationCard: boolean;
  hasOccurredAt: boolean;
  hasBalance: boolean;
  direction: ParsedSms['direction'];
  warnings: readonly string[];
}

/**
 * Confidence drives the auto-confirm decision (§54): below
 * `matching.min_confidence_auto_confirm` a match goes to a human instead of
 * settling automatically. It is a blunt instrument on purpose — the value of
 * having a number is that it can be tuned from settings without a deploy, and the
 * reasons are recorded alongside it so the tuning is informed.
 */
export function scoreConfidence(input: ConfidenceInput): number {
  let score = input.templateSpecificity;

  if (input.hasExplicitUnit) score += 22;
  else score += 6; // unit inferred from the bank default

  if (input.hasReference) score += 18;
  if (input.hasDestinationCard) score += 14;
  if (input.hasOccurredAt) score += 6;
  if (input.hasBalance) score += 4;
  if (input.direction === 'IN') score += 10;
  if (input.direction === 'OUT') score -= 30; // a withdrawal is not a payment

  // Each warning is a real uncertainty; accumulate them.
  score -= input.warnings.length * 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ---------------------------------------------------------------------------
// TemplateParser
// ---------------------------------------------------------------------------

/**
 * Interprets one BankTemplate. The only parser that knows about a specific bank,
 * and it knows it as data.
 */
export class TemplateParser implements SmsParser {
  readonly name: string;
  readonly label: string;
  private readonly template: BankTemplate;

  constructor(template: BankTemplate) {
    this.template = template;
    this.name = `bank:${template.id}`;
    this.label = template.bank;
  }

  applies(normalizedText: string): boolean {
    return this.template.required.every((keyword) => normalizedText.includes(keyword));
  }

  parse(normalizedText: string, context: SmsParseContext): ParsedSms | null {
    const warnings: string[] = [];

    // Bank-specific amount pattern first: a template author added it because the
    // generic extractor does not handle that bank's shape.
    let amounts = extractAmounts(normalizedText);
    if (this.template.amountPattern) {
      const override = this.template.amountPattern.exec(normalizedText);
      const group = this.template.amountPatternGroup ?? 1;
      const captured = override?.[group];
      if (captured) {
        amounts = [{ value: Number(captured.replace(/,/g, '')), unit: 'UNKNOWN', raw: captured }, ...amounts];
      }
    }

    const balanceToman = extractBalanceToman(normalizedText, this.template.balancePattern);
    const primary = choosePrimaryAmount(normalizedText, amounts, balanceToman) ?? extractUnitlessAmount(normalizedText);
    if (!primary) return null;

    const amount = normaliseAmount(primary, this.template.defaultCurrency);
    warnings.push(...amount.warnings);

    if (!Number.isFinite(amount.amountToman) || amount.amountToman <= 0) return null;

    const reference = extractReference(normalizedText, this.template.referencePattern);
    const cards = extractCards(normalizedText);
    const destinationCard = this.pickDestinationCard(normalizedText, cards);
    const sourceCard = cards.find((card) => card !== destinationCard) ?? null;
    const occurred = extractOccurredAt(normalizedText, context.receivedAt);
    warnings.push(...occurred.warnings);
    const direction = extractDirection(normalizedText, this.template.directionKeywords);

    if (amount.amountToman < MIN_PLAUSIBLE_TOMAN) warnings.push('SMS_AMOUNT_IMPLAUSIBLY_SMALL');
    if (!reference) warnings.push('SMS_NO_REFERENCE_NUMBER');

    const confidence = scoreConfidence({
      // A bank template that matched its own name is inherently more trustworthy
      // than a generic parse, but only modestly: naming itself does not prove the
      // message is a genuine bank notification.
      templateSpecificity: 34,
      hasExplicitUnit: primary.unit !== 'UNKNOWN',
      hasReference: reference !== null,
      hasDestinationCard: destinationCard !== null,
      hasOccurredAt: !occurred.fromReceiptTime,
      hasBalance: balanceToman !== null,
      direction,
      warnings,
    });

    return {
      parser: this.name,
      bank: this.template.bank,
      confidence,
      amountToman: amount.amountToman,
      amountRial: amount.amountRial,
      currency: amount.currency,
      amountRaw: amount.raw,
      reference,
      sourceCard,
      destinationCard,
      balanceToman,
      occurredAt: occurred.iso,
      direction,
      warnings,
      extracted: {
        templateId: this.template.id,
        candidateAmounts: amounts.map((candidate) => candidate.raw),
        cards,
        balanceToman,
        occurredFromReceiptTime: occurred.fromReceiptTime,
        optionalHits: (this.template.optional ?? []).filter((keyword) => normalizedText.includes(keyword)),
      },
    };
  }

  /**
   * Picks the card the money landed on. A destination override from the template
   * wins; otherwise the card that appears nearest a receiving keyword does, and
   * failing that the *last* card in the message — receipts conventionally list the
   * source first and the destination second.
   */
  private pickDestinationCard(normalizedText: string, cards: string[]): string | null {
    if (cards.length === 0) return null;

    if (this.template.destinationCardPattern) {
      const match = this.template.destinationCardPattern.exec(normalizedText);
      const captured = match?.[1] ?? match?.[0];
      if (captured) {
        const cleaned = captured.replace(/[^0-9*]/g, '');
        if (cleaned.length >= 8) return cleaned;
      }
    }

    const keywordIndex = normalizedText.search(/(?:به کارت|به حساب|واریز به|destination|دریافت کننده)/);
    if (keywordIndex >= 0) {
      const tail = normalizedText.slice(keywordIndex);
      const inTail = extractCards(tail);
      const first = inTail[0];
      if (first) return first;
    }

    return cards[cards.length - 1] ?? null;
  }
}

// ---------------------------------------------------------------------------
// GenericParser
// ---------------------------------------------------------------------------

/**
 * The fallback that keeps an unknown bank format from being a data loss event.
 *
 * It has no bank knowledge, so it scores lower than any matched template, and it
 * refuses to guess a card that is not clearly present. What it does do is extract
 * an amount and whatever reference number it can find, which is usually enough for
 * a match with a human confirming it.
 */
export class GenericParser implements SmsParser {
  readonly name = 'generic';
  readonly label = 'عمومی';

  applies(): boolean {
    return true;
  }

  parse(normalizedText: string, context: SmsParseContext): ParsedSms | null {
    const warnings: string[] = ['SMS_UNKNOWN_FORMAT'];

    const amounts = extractAmounts(normalizedText);
    const balanceToman = extractBalanceToman(normalizedText);
    const primary = choosePrimaryAmount(normalizedText, amounts, balanceToman) ?? extractUnitlessAmount(normalizedText);
    if (!primary) return null;

    // With no bank default available, an unqualified number is ambiguous between
    // Toman and Rial. Assuming Toman matches Iranian consumer SMS convention, and
    // the warning is what lets a reviewer correct it.
    const amount = normaliseAmount(primary, 'IRT');
    warnings.push(...amount.warnings);

    if (!Number.isFinite(amount.amountToman) || amount.amountToman <= 0) return null;

    const reference = extractReference(normalizedText);
    const cards = extractCards(normalizedText);
    const destinationCard = cards.length > 0 ? (cards[cards.length - 1] ?? null) : null;
    const sourceCard = cards.length > 1 ? (cards[0] ?? null) : null;
    const occurred = extractOccurredAt(normalizedText, context.receivedAt);
    warnings.push(...occurred.warnings);
    const direction = extractDirection(normalizedText);

    if (amount.amountToman < MIN_PLAUSIBLE_TOMAN) warnings.push('SMS_AMOUNT_IMPLAUSIBLY_SMALL');
    if (!reference) warnings.push('SMS_NO_REFERENCE_NUMBER');

    const confidence = scoreConfidence({
      templateSpecificity: 12,
      hasExplicitUnit: primary.unit !== 'UNKNOWN',
      hasReference: reference !== null,
      hasDestinationCard: destinationCard !== null,
      hasOccurredAt: !occurred.fromReceiptTime,
      hasBalance: balanceToman !== null,
      direction,
      warnings,
    });

    return {
      parser: this.name,
      bank: null,
      confidence,
      amountToman: amount.amountToman,
      amountRial: amount.amountRial,
      currency: amount.currency,
      amountRaw: amount.raw,
      reference,
      sourceCard,
      destinationCard,
      balanceToman,
      occurredAt: occurred.iso,
      direction,
      warnings,
      extracted: {
        candidateAmounts: amounts.map((candidate) => candidate.raw),
        cards,
        balanceToman,
        occurredFromReceiptTime: occurred.fromReceiptTime,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface ParseOutcome {
  /** Best parse, by confidence then by parser specificity. */
  best: ParsedSms;
  /** Every parse produced, best first. Persisted for the review screen. */
  alternatives: ParsedSms[];
  /** Test token when the message carried one (§15). Never confirms an invoice. */
  testToken: string | null;
}

export interface ParseOptions {
  /** Extra templates from system settings, appended after the built-ins. */
  extraTemplates?: readonly BankTemplate[];
  /** Replace the built-in library entirely. Used by tests for isolation. */
  templates?: readonly BankTemplate[];
}

/** Builds the parser list. Templates are instantiated once per call; they are stateless. */
export function buildParsers(options: ParseOptions = {}): SmsParser[] {
  const templates = options.templates ?? [...BANK_TEMPLATES, ...(options.extraTemplates ?? [])];
  const parsers: SmsParser[] = templates.map((template) => new TemplateParser(template));
  // Generic is always last: it is the safety net, never the first choice.
  parsers.push(new GenericParser());
  return parsers;
}

/**
 * Runs the pipeline for one message.
 *
 * Returns null only when *no* parser found a usable amount — a message with no
 * money in it (a login alert, a promotional SMS) is not an error, it is simply not
 * a payment, and the caller records it as IGNORED rather than FAILED.
 */
export function parseSms(
  rawMessage: string,
  context: SmsParseContext,
  options: ParseOptions = {},
): ParseOutcome | null {
  const normalized = normalizeSmsBody(rawMessage);
  const testToken = extractTestToken(normalized);

  const results: ParsedSms[] = [];
  for (const parser of buildParsers(options)) {
    if (!parser.applies(normalized)) continue;
    try {
      const parsed = parser.parse(normalized, context);
      if (parsed) results.push(parsed);
    } catch {
      // A malformed template must not take down the whole pipeline. The message
      // still gets a chance with the remaining parsers, including the generic one.
      continue;
    }
  }

  if (results.length === 0) return null;

  // Sort by confidence, then prefer the more specific parser, then prefer an
  // explicit direction reading.
  results.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    const aGeneric = a.parser === 'generic' ? 1 : 0;
    const bGeneric = b.parser === 'generic' ? 1 : 0;
    return aGeneric - bGeneric;
  });

  const best = results[0];
  if (!best) return null;

  return { best, alternatives: results, testToken };
}

/** Convenience for callers that only need the text normalised the same way. */
export function normalizeForParsing(rawMessage: string): string {
  return normalizeSmsBody(rawMessage);
}

/** Exposed so the API can reject oversized bodies before parsing anything. */
export const MAX_SMS_LENGTH = 2000;
