/**
 * Fee engine.
 *
 * All integer arithmetic. A single function decides how an invoice's money is
 * split, and every other module reads its output rather than recomputing.
 *
 * The split, and who ends up with the unique suffix, is a real commercial
 * decision that has to be explicit in a payment gateway, so it is stated here and
 * mirrored in the database fields and in ARCHITECTURE.md:
 *
 *   CUSTOMER pays the fee
 *     customer transfers   original + fee + suffix
 *     merchant receives    original                (their invoice value, exactly)
 *     platform receives    fee + suffix
 *
 *   MERCHANT pays the fee
 *     customer transfers   original + suffix       (straight to the merchant's card)
 *     merchant receives    original + suffix at the bank, minus `fee` debited
 *                          from their Steve Gate wallet
 *     platform receives    fee
 *
 * So the merchant's net is `original_amount` in CUSTOMER mode and
 * `original_amount + suffix - fee` in MERCHANT mode. `computeSettlement`
 * expresses exactly that, and `fees.suffix_remainder_belongs_to` lets a
 * deployment hand the suffix to the merchant instead if that is the deal.
 */

import type { Toman } from './money';
import { assertToman } from './money';
import { AppError } from './errors';

export type FeeMode = 'CUSTOMER' | 'MERCHANT';

export const FEE_MODES: readonly FeeMode[] = ['CUSTOMER', 'MERCHANT'];

/** Who keeps the unique suffix once the fee has been taken. */
export type SuffixRemainderOwner = 'PLATFORM' | 'MERCHANT';

export interface FeeConfiguration {
  /** Flat gateway fee in Toman. */
  gatewayFee: Toman;
  /** Percentage component in basis points (1 bp = 0.01%). Reserved; 0 in the MVP. */
  percentageBasisPoints?: number;
  /** Who pays the fee for this invoice. */
  feeMode: FeeMode;
}

export interface FeeBreakdown {
  originalAmount: Toman;
  /** Fee added to the customer's payable amount (CUSTOMER mode) or 0. */
  customerFee: Toman;
  /** Fee debited from the merchant's wallet (MERCHANT mode) or 0. */
  merchantFee: Toman;
  /** Total platform fee for this invoice: customerFee + merchantFee. */
  gatewayFee: Toman;
  /** What the unique-amount generator adds its suffix to. */
  baseAmount: Toman;
  feeMode: FeeMode;
}

export function isFeeMode(value: unknown): value is FeeMode {
  return value === 'CUSTOMER' || value === 'MERCHANT';
}

/**
 * Percentage component, in basis points, floored to whole Toman.
 *
 * Flooring rather than rounding is deliberate: rounding a fee can push it above
 * what the merchant agreed to, and a floor can only ever under-charge by less than
 * one Toman. Percentage fees are disabled by default (0 bp).
 */
function percentageComponent(amount: Toman, basisPoints: number): Toman {
  if (!Number.isInteger(basisPoints) || basisPoints <= 0) return 0;
  return Math.floor((amount * basisPoints) / 10_000);
}

/**
 * Splits an invoice into its fee components. Throws rather than guessing when it
 * is handed a nonsensical configuration, because a silently wrong fee is a
 * financial incident.
 */
export function computeFees(
  input: { originalAmount: Toman } & FeeConfiguration,
): FeeBreakdown {
  assertToman(input.originalAmount, { field: 'amount' });
  assertToman(input.gatewayFee, { field: 'gatewayFee', allowZero: true });

  if (!isFeeMode(input.feeMode)) {
    throw new AppError('INVALID_FEE_MODE', { details: { feeMode: input.feeMode } });
  }

  const percentage = percentageComponent(input.originalAmount, input.percentageBasisPoints ?? 0);
  const totalFee = input.gatewayFee + percentage;

  const customerFee: Toman = input.feeMode === 'CUSTOMER' ? totalFee : 0;
  const merchantFee: Toman = input.feeMode === 'MERCHANT' ? totalFee : 0;

  const baseAmount = input.originalAmount + customerFee;
  assertToman(baseAmount, { field: 'baseAmount' });

  return {
    originalAmount: input.originalAmount,
    customerFee,
    merchantFee,
    gatewayFee: totalFee,
    baseAmount,
    feeMode: input.feeMode,
  };
}

/**
 * The fee a merchant must be able to cover before an invoice is issued.
 *
 * Only MERCHANT mode reserves wallet money. In CUSTOMER mode the platform takes
 * its fee out of the incoming transfer, so the merchant's balance is untouched and
 * requiring a balance would block merchants for no reason. Returning 0 here is
 * what makes the wallet check in the invoice service mode-aware instead of
 * blanket-refusing.
 */
export function requiredWalletReserve(feeMode: FeeMode, gatewayFee: Toman): Toman {
  return feeMode === 'MERCHANT' ? gatewayFee : 0;
}

/**
 * Reservation booked against the wallet while an invoice is live in MERCHANT mode.
 * The suffix is not part of it: the suffix lands in the merchant's own bank
 * account, not in their Steve Gate wallet.
 */
export function walletReservationFor(breakdown: FeeBreakdown): Toman {
  return breakdown.merchantFee;
}

export interface SettlementInput {
  /** What the customer actually transferred (payable amount). */
  receivedAmount: Toman;
  originalAmount: Toman;
  customerFee: Toman;
  merchantFee: Toman;
  /** payableAmount - baseAmount; the disambiguating remainder. */
  uniqueSuffix: Toman;
  feeMode: FeeMode;
  suffixRemainderOwner?: SuffixRemainderOwner;
}

export interface Settlement {
  /** Platform revenue recognised from this payment. */
  platformTake: Toman;
  /** What the merchant keeps from this payment. */
  merchantNet: Toman;
  /** True when the merchant's wallet was debited rather than the transfer reduced. */
  chargedToWallet: boolean;
}

/**
 * Settles a confirmed payment.
 *
 * This is the function that answers "who got what", and it is unit-tested against
 * the brief's worked example (359,000 requested, 3,000 fee, 363,706 transferred).
 */
export function computeSettlement(input: SettlementInput): Settlement {
  assertToman(input.receivedAmount, { field: 'receivedAmount', allowZero: true });
  assertToman(input.originalAmount, { field: 'originalAmount' });
  assertToman(input.customerFee, { field: 'customerFee', allowZero: true });
  assertToman(input.merchantFee, { field: 'merchantFee', allowZero: true });
  assertToman(input.uniqueSuffix, { field: 'uniqueSuffix', allowZero: true });

  const suffixOwner = input.suffixRemainderOwner ?? 'PLATFORM';

  if (input.receivedAmount < input.originalAmount) {
    throw new AppError('INVALID_AMOUNT', {
      message: 'مبلغ دریافتی از مبلغ فاکتور کمتر است.',
      details: { receivedAmount: input.receivedAmount, originalAmount: input.originalAmount },
    });
  }

  if (input.feeMode === 'CUSTOMER') {
    // Merchant keeps their invoice value. The platform keeps the fee plus the
    // suffix remainder, unless the deal says the suffix stays with the merchant.
    const platformTake =
      suffixOwner === 'PLATFORM'
        ? input.customerFee + input.uniqueSuffix
        : input.customerFee;
    return {
      platformTake,
      merchantNet: input.originalAmount,
      chargedToWallet: false,
    };
  }

  // MERCHANT mode: the transfer went straight to the merchant's bank account, so
  // the fee is recovered from the wallet. The merchant keeps the suffix here.
  return {
    platformTake: input.merchantFee,
    merchantNet: input.originalAmount - input.merchantFee + input.uniqueSuffix,
    chargedToWallet: true,
  };
}

/**
 * Human-readable fee summary for documents, invoices and support conversations.
 * Kept beside the arithmetic so the wording can never drift from the numbers.
 */
export function describeFeeMode(feeMode: FeeMode): string {
  return feeMode === 'CUSTOMER'
    ? 'کارمزد به مبلغ فاکتور اضافه می‌شود و مشتری آن را پرداخت می‌کند.'
    : 'کارمزد از موجودی کیف پول شما کسر می‌شود.';
}

export function describeFeeModeShort(feeMode: FeeMode): string {
  return feeMode === 'CUSTOMER' ? 'مشتری پرداخت می‌کند' : 'من پرداخت می‌کنم';
}
