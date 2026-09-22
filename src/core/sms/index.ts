/**
 * SMS parsing module.
 *
 * Public surface used by the SMS service and the transaction matcher. Importing
 * from here rather than from individual files keeps the internal split between
 * contracts, extraction, templates and parsers free to change.
 */

export type { ParsedSms, SmsParser, SmsParseContext, BankTemplate, Currency, Direction } from './types';
export { SMS_TEST_MARKERS, extractTestToken } from './types';

export {
  TemplateParser,
  GenericParser,
  buildParsers,
  parseSms,
  normaliseAmount,
  scoreConfidence,
  normalizeForParsing,
  MAX_SMS_LENGTH,
} from './parsers';
export type { ParseOutcome, ParseOptions } from './parsers';

export {
  extractAmounts,
  extractUnitlessAmount,
  extractReference,
  extractCards,
  extractSheba,
  extractBalanceToman,
  extractDirection,
  extractOccurredAt,
} from './extract';
export type { AmountMatch, DateExtraction } from './extract';

export { BANK_TEMPLATES, compileTemplate, compileTemplates } from './templates';
export type { RawBankTemplate } from './templates';

export { redactSmsForCustomer, redactSmsForWebhook } from './redact';
export type { RedactionResult } from './redact';
