/**
 * A bank card, rendered in the colours of the bank that issued it.
 *
 * One implementation, used by the merchant's panel and by the payment page. That is the
 * point: the card a merchant registers and the card a payer is asked to transfer to are the
 * same card, and if the two surfaces rendered it differently then a customer comparing the
 * screen against a screenshot in a support ticket would be looking at two designs.
 *
 * The theme is carried in custom properties on the root element (`--bc-grad`, `--bc-brand`,
 * `--bc-muted`) rather than in inline declarations on each child. Two reasons: the whole card
 * is one element to restyle if the palette ever changes, and the stylesheet owns the layout
 * while the module owns only the four values that differ per issuer.
 *
 * There is no label announcing the detection. The colours *are* the statement — a card in
 * Bank Mellat's red is recognised as Bank Mellat's red — and a caption saying so is the
 * interface talking about itself.
 */

import { escapeHtml } from '../core/http';
import { toEnglishDigits } from '../core/digits';
import { bankThemeFor } from '../core/banks';

export interface BankCardFaceInput {
  /**
   * The card number the theme is derived from. Pass the real number even when the card is
   * displayed masked: the issuer is a fact about the account, not about what is printed.
   */
  number: string | null | undefined;
  /**
   * What to print, when it differs from the number.
   *
   * The merchant's panel shows `6104-****-****-0000` on the card deliberately — it is a
   * screen someone may be standing behind — while the payment page shows all sixteen digits,
   * because the payer has to type them. The theme is the same either way.
   */
  display?: string | null;
  /**
   * The bank name to print.
   *
   * A merchant may type their own label for a bank we do not recognise a prefix for, and
   * that is what gets shown — the theme still applies if the prefix is known, because the
   * printed name is a fact about the account and the colours are a fact about the issuer.
   */
  bankName?: string | null;
  /** Free label the merchant chose, e.g. `کارت اصلی`. Shown as a pill. */
  title?: string | null;
  holderName?: string | null;
  size?: 'md' | 'sm';
  /** Markup placed in the card's footer — the copy control, on the payment page. */
  footer?: string;
  /** `button` when the whole card is the copy target, `div` when it is not. */
  interactive?: boolean;
  /** Copy value plus label, only meaningful with `interactive`. */
  copy?: { value: string; ariaLabel: string };
}

/**
 * The digits as printed, grouped four at a time.
 *
 * Grouped by *character*, not by digit, and that is the whole point: a masked number is
 * `6104********3456`, which carries no separators to split on and would otherwise print as
 * one unbroken block on a card face drawn to look like a real one. Chunking by character
 * gives `6104 **** **** 3456` for that and `6104 3378 9012 3456` for a real number, so the
 * masked and unmasked forms keep the same rhythm — which is what lets a merchant compare the
 * two at a glance.
 *
 * Existing separators are removed first, so a number that arrives already grouped does not
 * end up chunked twice.
 */
function printed(display: string | null | undefined, number: string | null | undefined): string {
  const cleaned = toEnglishDigits((display ?? number ?? '').trim()).replace(/[\s-]/g, '');
  if (cleaned.length === 0) return '';
  const groups: string[] = [];
  for (let index = 0; index < cleaned.length; index += 4) {
    groups.push(cleaned.slice(index, index + 4));
  }
  return groups.join(' ');
}

export function bankCardFace(input: BankCardFaceInput): string {
  const theme = bankThemeFor(input.number);
  const size = input.size ?? 'md';
  const name = (input.bankName ?? '').trim() || theme.name;
  const number = printed(input.display, input.number);
  // Only a genuinely short *number* is "partial". A masked number is missing four digits by
  // design, and dimming it would read as an error the merchant should fix.
  const complete =
    input.display !== undefined && input.display !== null
      ? true
      : (input.number ?? '').replace(/[^\d]/g, '').length === 16;

  const style =
    `--bc-grad:${theme.gradient};--bc-brand:${theme.brand};--bc-muted:${theme.muted}`;

  const top = `<span class="bankcard-top">
<span class="bankcard-bank">${escapeHtml(name)}</span>
<span class="bankcard-chip" aria-hidden="true"></span>
</span>`;

  const middle = `<span class="bankcard-mid">
${
    input.title
      ? `<span class="bankcard-title">${escapeHtml(input.title)}</span>`
      : ''
  }
<span class="bankcard-digits"${complete ? '' : ' data-partial="1"'}>${escapeHtml(number)}</span>
${
    input.holderName
      ? `<span class="bankcard-holder">به نام ${escapeHtml(input.holderName)}</span>`
      : ''
  }
</span>`;

  const bottom = `<span class="bankcard-foot">
${input.footer ?? ''}
<span class="bankcard-mark" aria-hidden="true">
<svg viewBox="0 0 24 8" width="20" height="7" fill="currentColor"><ellipse cx="6" cy="4" rx="5.5" ry="3.6" opacity=".85"/><ellipse cx="12" cy="4" rx="5.5" ry="3.6" opacity=".85"/><ellipse cx="18" cy="4" rx="5.5" ry="3.6" opacity=".85"/></svg>
<span>SHETAB</span>
</span>
</span>`;

  const inner = `<span class="bankcard-sheen" aria-hidden="true"></span>
<span class="bankcard-light" aria-hidden="true"></span>
<span class="bankcard-body">
${top}
${middle}
${bottom}
</span>`;

  const classes = `bankcard bankcard-${size}${input.interactive ? ' bankcard-tap' : ''}`;

  if (input.interactive) {
    const copy = input.copy ?? { value: input.number ?? '', ariaLabel: 'کپی شماره کارت' };
    return `<button class="${classes}" type="button" style="${style}"
  data-copy="${escapeHtml(copy.value)}" aria-label="${escapeHtml(copy.ariaLabel)}">
${inner}
</button>`;
  }

  return `<div class="${classes}" style="${style}">
${inner}
</div>`;
}

/**
 * A small card chip: the same theme, no digits.
 *
 * For list rows and tables where a full card face would dominate the row. Its accessible
 * name is the issuer, so a screen reader announces the bank rather than a decorative
 * element.
 */
export function bankCardChip(number: string | null | undefined, label?: string): string {
  const theme = bankThemeFor(number);
  const known = (number ?? '').replace(/[^\d]/g, '').length >= 6;
  const title = label ?? theme.name;
  return `<span class="bankchip" style="--bc-grad:${theme.gradient};--bc-brand:${theme.brand}"
  role="img" aria-label="${escapeHtml(title)}" title="${escapeHtml(title)}"><b>${escapeHtml(
    known ? theme.mark : '؟',
  )}</b></span>`;
}
