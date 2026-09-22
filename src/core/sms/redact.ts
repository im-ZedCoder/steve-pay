/**
 * Redaction for showing a bank message to someone who is not the merchant.
 *
 * The success page and the customer's invoice status page display the bank's own
 * message as proof that the confirmation came from the bank rather than from a
 * button press. That is a deliberate design decision (§ design signature), and it
 * is only defensible with redaction, because a raw bank SMS contains things a
 * payer should not see:
 *
 *   - the merchant's post-transaction account balance, which is none of the
 *     customer's business and is commercially sensitive;
 *   - full account and شبا (IBAN) numbers;
 *   - the merchant's other card numbers, when a bank lists several;
 *   - any national ID or phone number the bank echoes back.
 *
 * The merchant always sees the raw message in their own dashboard. Only the
 * customer-facing and webhook-facing renderings are redacted, and the redaction is
 * a transformation of the text, never a rewrite of the stored row.
 */

import type { ParsedSms } from './types';

export interface RedactionResult {
  /** Safe to render to a third party. */
  text: string;
  /** Field names that were altered, so the UI can be honest about it. */
  redacted: string[];
}

/**
 * Replaces 10+ digit runs that are not the amount or the reference with a masked
 * form. Card numbers keep their first four and last four; anything longer loses
 * everything but the last four.
 */
function redactLongNumbers(text: string, keep: readonly string[]): { text: string; redacted: string[] } {
  const redacted: string[] = [];
  const result = text.replace(/\d[\d\s-]{8,}\d/g, (match) => {
    const digits = match.replace(/[^\d]/g, '');
    if (digits.length < 10) return match;
    // Never touch the figures the customer legitimately needs to verify.
    if (keep.some((value) => value.length > 0 && digits.includes(value))) return match;
    if (match.includes('*') || match.includes('•')) return match;
    if (digits.length === 16) {
      redacted.push('card');
      return `${digits.slice(0, 4)}-****-****-${digits.slice(-4)}`;
    }
    redacted.push('number');
    return `****${digits.slice(-4)}`;
  });
  return { text: result, redacted };
}

/**
 * Removes the balance sentence entirely rather than masking it. A masked balance
 * still tells a customer roughly how much money the merchant has, and the number
 * serves no purpose on a payment receipt.
 */
function stripBalanceSentence(text: string): { text: string; redacted: boolean } {
  const pattern = /[^\n.!؟]*?(?:مانده|موجودی|balance)[^\n.!؟]*[.!؟]?/gi;
  if (!pattern.test(text)) return { text, redacted: false };
  pattern.lastIndex = 0;
  const stripped = text.replace(pattern, '').replace(/\s{2,}/g, ' ').trim();
  return { text: stripped, redacted: true };
}

/** Masks a شبا (IBAN) leaving only the bank code and the last four digits. */
function redactSheba(text: string): { text: string; redacted: boolean } {
  const pattern = /\bIR\s?\d{2}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\b/g;
  if (!pattern.test(text)) return { text, redacted: false };
  pattern.lastIndex = 0;
  return {
    text: text.replace(pattern, (match) => {
      const digits = match.replace(/[^\d]/g, '');
      return `IR${digits.slice(0, 2)}-****-****-****-****-${digits.slice(-4)}`;
    }),
    redacted: true,
  };
}

/**
 * Produces the customer-safe rendering of a bank message.
 *
 * `keep` should contain the payable amount and the bank reference: those are the
 * two values on the page a payer is checking, and masking them would defeat the
 * purpose of showing the message at all.
 */
export function redactSmsForCustomer(
  rawMessage: string,
  parsed: Pick<ParsedSms, 'amountToman' | 'amountRial' | 'reference'>,
): RedactionResult {
  const keep = [
    parsed.reference ?? '',
    String(parsed.amountToman ?? ''),
    String(parsed.amountRial ?? ''),
  ].filter((value) => value.length > 0);

  const redactedFields: string[] = [];

  const sheba = redactSheba(rawMessage);
  if (sheba.redacted) redactedFields.push('sheba');
  let text = sheba.text;

  const balance = stripBalanceSentence(text);
  if (balance.redacted) redactedFields.push('balance');
  text = balance.text;

  const numbers = redactLongNumbers(text, keep);
  redactedFields.push(...numbers.redacted);
  text = numbers.text;

  // Collapse the whitespace left behind by removed sentences so the receipt does
  // not render with conspicuous gaps where something was taken out.
  text = text.replace(/[ \t]{2,}/g, ' ').replace(/\n{2,}/g, '\n').trim();

  return { text, redacted: [...new Set(redactedFields)] };
}

/**
 * Redaction applied to any SMS echoed into a webhook payload. Webhooks go to a
 * URL the merchant controls, but they are frequently logged by proxies and
 * third-party services, so the same discipline applies as for a public page.
 */
export function redactSmsForWebhook(
  parsed: Pick<ParsedSms, 'sourceCard' | 'destinationCard'> & { rawMessage?: string },
): { sourceCard: string | null; destinationCard: string | null } {
  const mask = (card: string | null | undefined): string | null => {
    if (!card) return null;
    if (card.includes('*')) return card;
    if (card.length === 16) return `${card.slice(0, 4)}****${card.slice(-4)}`;
    return card.length > 4 ? `****${card.slice(-4)}` : card;
  };
  return {
    sourceCard: mask(parsed.sourceCard),
    destinationCard: mask(parsed.destinationCard),
  };
}
