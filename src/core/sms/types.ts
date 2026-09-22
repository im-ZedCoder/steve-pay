/**
 * SMS parsing contracts.
 *
 * The parser layer is an abstraction, not a switch statement over bank names
 * (§17). A bank's format is *data* — a `BankTemplate` — interpreted by one
 * `TemplateParser` implementation. Adding a bank is adding an object, and
 * calibrating a changed format is editing regexes without touching control flow.
 *
 * The raw message is never rewritten by the parser. Everything the parser
 * produces is stored *beside* the original text, which is what makes a parser bug
 * replayable against real history instead of a permanent loss of evidence.
 */

export type Currency = 'IRT' | 'IRR' | 'UNKNOWN';

export type Direction = 'IN' | 'OUT' | 'UNKNOWN';

export interface ParsedSms {
  /** Parser that produced this result, e.g. 'bank:mellat' or 'generic'. */
  parser: string;
  /** Persian bank name when the template identified one. */
  bank: string | null;
  /** 0-100. Drives whether the matcher may auto-confirm or must escalate. */
  confidence: number;

  amountToman: number | null;
  amountRial: number | null;
  /** The currency the message stated, before normalisation. */
  currency: Currency;
  /** The matched numeric fragment exactly as it appeared, for audit. */
  amountRaw: string | null;

  /** Bank reference / tracking number (شماره پیگیری). The strongest dedupe key. */
  reference: string | null;
  /** Card the money left (usually the customer's, often masked). */
  sourceCard: string | null;
  /** Card the money landed on. This is what identifies the merchant's card. */
  destinationCard: string | null;
  /** Account balance after the transaction, when the bank included it. */
  balanceToman: number | null;

  /** Absolute instant, from either a Jalali or Gregorian stamp. */
  occurredAt: string | null;
  direction: Direction;

  /** Non-fatal problems worth surfacing in the manual review screen. */
  warnings: string[];
  /** Everything the parser saw, for debugging and for re-scoring after a change. */
  extracted: Record<string, unknown>;
}

export interface SmsParseContext {
  /** Server-authoritative receipt time. Used when the message carries no stamp. */
  receivedAt: string;
  /** Forwarder-supplied sender id, when present. */
  sender?: string | null;
}

export interface SmsParser {
  /** Stable identifier recorded on the parse result. */
  readonly name: string;
  /** Human label for the admin console. */
  readonly label: string;
  /**
   * Cheap pre-filter. Returning false skips this parser entirely, which keeps a
   * message from being run through every bank's regexes.
   */
  applies(normalizedText: string): boolean;
  /** Returns null when the message does not contain a usable amount. */
  parse(normalizedText: string, context: SmsParseContext): ParsedSms | null;
}

/**
 * A bank's message shape, expressed as data.
 *
 * `required` substrings are matched against normalised text (ASCII digits, folded
 * Arabic/Persian letters), so a template does not have to anticipate every
 * orthographic variant a bank might send.
 */
export interface BankTemplate {
  id: string;
  /** Persian bank name shown in the UI. */
  bank: string;
  /** All of these must appear for the template to apply. */
  required: readonly string[];
  /** Presence raises confidence; absence does not disqualify. */
  optional?: readonly string[];
  /** Currency assumed when the message states none. */
  defaultCurrency: Exclude<Currency, 'UNKNOWN'>;
  /**
   * Optional bank-specific amount pattern. When absent, the generic amount
   * extractor is used, which is preferable for all but the strangest formats.
   */
  amountPattern?: RegExp;
  amountPatternGroup?: number;
  /** Optional override for the reference pattern. */
  referencePattern?: RegExp;
  /** Optional override for the destination-card pattern. */
  destinationCardPattern?: RegExp;
  /** Optional override for the balance pattern. */
  balancePattern?: RegExp;
  /** Keywords marking money in / money out. Merged with the global defaults. */
  directionKeywords?: { in?: readonly string[]; out?: readonly string[] };
}

/**
 * Test-token markers (§15). A message containing one of these is channelled into
 * the setup wizard and can never confirm an invoice, whatever else it says.
 */
export const SMS_TEST_MARKERS = ['STEVE_PAY_TEST', 'STEVE-PAY-TEST', 'SPTEST'] as const;

/** Extracts the test token from a message, or null. Tokens look like SP-ABCD-EFGH. */
export function extractTestToken(normalizedText: string): string | null {
  for (const marker of SMS_TEST_MARKERS) {
    const index = normalizedText.indexOf(marker);
    if (index >= 0) {
      const tail = normalizedText.slice(index + marker.length);
      const match = /[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(tail);
      return match ? match[0] : '';
    }
  }
  return null;
}
