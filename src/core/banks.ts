/**
 * Card-issuer themes, keyed by card number prefix.
 *
 * A Shetab card carries its issuer's identity in its first six digits — the BIN — and the
 * issuer prints the card with its own colours. The merchant's panel and the payment page
 * both show the receiving card, and showing it in the colours of the bank it belongs to is
 * the difference between a row of digits and a picture of the card the customer is holding.
 * A payer comparing the card in their hand against the screen is comparing shape and colour
 * before they compare sixteen digits, and only one of those catches a mistype at a glance.
 *
 * THE PREFIX IS THE DATA, NOT THE ORDER
 *
 * A prefix table is a longest-match problem: `502910` is Bank Karafarin and `502908` is Bank
 * Tose'e Ta'avon, so a five-digit prefix would match both an entry that means it and one that
 * does not. The usual fix is to keep the array sorted longest-first and hope nobody appends to
 * the end — which is a rule enforced by nothing and broken by the next person to add a bank.
 * `PREFIX_INDEX` is therefore built at module load, sorted by prefix length, so correctness
 * is a property of the data rather than the order someone typed it in.
 */

import { stripNonDigits } from './digits';

export interface BankTheme {
  /** The issuer's Persian name, as it appears on a card. */
  name: string;
  /** Background: a 135° gradient between the bank's signature colours. */
  gradient: string;
  /** Primary foreground — the brand name and the card number. */
  brand: string;
  /** Secondary foreground — marks and secondary labels, already alpha-blended. */
  muted: string;
  /** Up to three characters inside the logo mark. */
  mark: string;
}

interface BankEntry {
  /** BINs. Several banks issue under more than one. */
  prefixes: readonly string[];
  theme: BankTheme;
}

const BANKS: readonly BankEntry[] = [
  {
    // ملت — زرشکی رو به نارنجی
    prefixes: ['610433', '991975'],
    theme: {
      name: 'بانک ملت',
      gradient: 'linear-gradient(135deg,#7f1d1d 0%,#b91c1c 45%,#ea580c 100%)',
      brand: '#fecaca',
      muted: 'rgba(254,202,202,.65)',
      mark: 'مل',
    },
  },
  {
    // ملی — طلایی روی سبز تیره
    prefixes: ['603799'],
    theme: {
      name: 'بانک ملی',
      gradient: 'linear-gradient(135deg,#14532d 0%,#166534 50%,#3f6212 100%)',
      brand: '#bbf7d0',
      muted: 'rgba(187,247,208,.6)',
      mark: 'ملی',
    },
  },
  {
    // صادرات — آبی برند
    prefixes: ['603769'],
    theme: {
      name: 'بانک صادرات',
      gradient: 'linear-gradient(135deg,#0c2d6b 0%,#1d4ed8 60%,#2563eb 100%)',
      brand: '#bfdbfe',
      muted: 'rgba(191,219,254,.6)',
      mark: 'صا',
    },
  },
  {
    // سامان — بنفش
    prefixes: ['621986'],
    theme: {
      name: 'بانک سامان',
      gradient: 'linear-gradient(135deg,#312e81 0%,#4c1d95 50%,#6d28d9 100%)',
      brand: '#ddd6fe',
      muted: 'rgba(221,214,254,.6)',
      mark: 'سا',
    },
  },
  {
    // پاسارگاد — قرمز تیره
    prefixes: ['502229', '639347'],
    theme: {
      name: 'بانک پاسارگاد',
      gradient: 'linear-gradient(135deg,#7f1d1d 0%,#991b1b 50%,#dc2626 100%)',
      brand: '#fecaca',
      muted: 'rgba(254,202,202,.6)',
      mark: 'پا',
    },
  },
  {
    // پارسیان — زرشکی رو به نارنجی
    prefixes: ['622106', '639194'],
    theme: {
      name: 'بانک پارسیان',
      gradient: 'linear-gradient(135deg,#831843 0%,#9f1239 50%,#ea580c 100%)',
      brand: '#fbcfe8',
      muted: 'rgba(251,207,232,.6)',
      mark: 'پار',
    },
  },
  {
    // تجارت — فیروزه‌ای
    prefixes: ['627353', '585983'],
    theme: {
      name: 'بانک تجارت',
      gradient: 'linear-gradient(135deg,#164e63 0%,#0e7490 55%,#06b6d4 100%)',
      brand: '#a5f3fc',
      muted: 'rgba(165,243,252,.6)',
      mark: 'تج',
    },
  },
  {
    // اقتصاد نوین — نارنجی
    prefixes: ['627412'],
    theme: {
      name: 'بانک اقتصاد نوین',
      gradient: 'linear-gradient(135deg,#7c2d12 0%,#c2410c 55%,#f59e0b 100%)',
      brand: '#fed7aa',
      muted: 'rgba(254,215,170,.6)',
      mark: 'اق',
    },
  },
  {
    // شهر — سرمه‌ای
    prefixes: ['502806', '502938'],
    theme: {
      name: 'بانک شهر',
      gradient: 'linear-gradient(135deg,#1e1b4b 0%,#3730a3 55%,#4f46e5 100%)',
      brand: '#c7d2fe',
      muted: 'rgba(199,210,254,.6)',
      mark: 'شر',
    },
  },
  {
    // کارآفرین — سبز رو به فیروزه‌ای
    prefixes: ['627488', '539386', '502910'],
    theme: {
      name: 'بانک کارآفرین',
      gradient: 'linear-gradient(135deg,#064e3b 0%,#047857 50%,#0891b2 100%)',
      brand: '#a7f3d0',
      muted: 'rgba(167,243,208,.6)',
      mark: 'کر',
    },
  },
  {
    // آینده — آبی تیره
    prefixes: ['636214'],
    theme: {
      name: 'بانک آینده',
      gradient: 'linear-gradient(135deg,#172554 0%,#1e40af 55%,#3b82f6 100%)',
      brand: '#bfdbfe',
      muted: 'rgba(191,219,254,.6)',
      mark: 'آی',
    },
  },
  {
    // گردشگری — فیروزه‌ای
    prefixes: ['505416'],
    theme: {
      name: 'بانک گردشگری',
      gradient: 'linear-gradient(135deg,#134e4a 0%,#0f766e 55%,#14b8a6 100%)',
      brand: '#99f6e4',
      muted: 'rgba(153,246,228,.6)',
      mark: 'گر',
    },
  },
  {
    // رسالت — سبز تیره
    prefixes: ['504172', '502942'],
    theme: {
      name: 'بانک رسالت',
      gradient: 'linear-gradient(135deg,#052e16 0%,#14532d 55%,#16a34a 100%)',
      brand: '#bbf7d0',
      muted: 'rgba(187,247,208,.6)',
      mark: 'رس',
    },
  },
  {
    // کشاورزی — سبز رو به لیمویی
    prefixes: ['622015', '603770'],
    theme: {
      name: 'بانک کشاورزی',
      gradient: 'linear-gradient(135deg,#1a2e05 0%,#3f6212 55%,#65a30d 100%)',
      brand: '#d9f99d',
      muted: 'rgba(217,249,157,.6)',
      mark: 'کش',
    },
  },
  {
    // توسعه تعاون — آبی رو به سبز
    prefixes: ['502908'],
    theme: {
      name: 'بانک توسعه تعاون',
      gradient: 'linear-gradient(135deg,#082f49 0%,#075985 55%,#0d9488 100%)',
      brand: '#bae6fd',
      muted: 'rgba(186,230,253,.6)',
      mark: 'تع',
    },
  },
  {
    // قوامین — آبی روشن
    prefixes: ['639599'],
    theme: {
      name: 'بانک قوامین',
      gradient: 'linear-gradient(135deg,#0c4a6e 0%,#0369a1 55%,#38bdf8 100%)',
      brand: '#bae6fd',
      muted: 'rgba(186,230,253,.6)',
      mark: 'قو',
    },
  },
  {
    // مهر ایران — زرشکی
    prefixes: ['606373'],
    theme: {
      name: 'بانک مهر ایران',
      gradient: 'linear-gradient(135deg,#4c0519 0%,#831843 55%,#be123c 100%)',
      brand: '#fecdd3',
      muted: 'rgba(254,205,211,.6)',
      mark: 'مه',
    },
  },
  {
    // کوثر — آبی رو به فیروزه‌ای روشن
    prefixes: ['505801'],
    theme: {
      name: 'بانک کوثر',
      gradient: 'linear-gradient(135deg,#164e63 0%,#0284c7 55%,#22d3ee 100%)',
      brand: '#a5f3fc',
      muted: 'rgba(165,243,252,.6)',
      mark: 'کو',
    },
  },
  {
    // سپه — سرمه‌ای رو به خاکستری
    prefixes: ['585949', '589210'],
    theme: {
      name: 'بانک سپه',
      gradient: 'linear-gradient(135deg,#0f172a 0%,#1e3a5f 55%,#334155 100%)',
      brand: '#cbd5e1',
      muted: 'rgba(203,213,225,.6)',
      mark: 'سپ',
    },
  },
  {
    // پست بانک — طلایی
    prefixes: ['627760'],
    theme: {
      name: 'پست بانک',
      gradient: 'linear-gradient(135deg,#713f12 0%,#a16207 50%,#ca8a04 100%)',
      brand: '#fef08a',
      muted: 'rgba(254,240,138,.6)',
      mark: 'پس',
    },
  },
];

/**
 * The card shown when the issuer is not one we know.
 *
 * Deliberately plain rather than colourful: an unrecognised prefix must not be dressed up as
 * a bank it might not be. It still reads as a card, which is what the layout needs.
 */
export const UNKNOWN_BANK_THEME: BankTheme = {
  name: 'کارت بانکی',
  gradient: 'linear-gradient(135deg,#1e293b 0%,#334155 55%,#475569 100%)',
  brand: '#e2e8f0',
  muted: 'rgba(226,232,240,.6)',
  // A question mark rather than an abbreviation. Every other mark names a bank, and the one
  // case that cannot name one should not look like it just did.
  mark: '؟',
};

const PREFIX_INDEX: ReadonlyArray<readonly [prefix: string, theme: BankTheme]> = BANKS.flatMap(
  (bank) => bank.prefixes.map((prefix) => [prefix, bank.theme] as const),
).sort((a, b) => b[0].length - a[0].length);

/**
 * The issuer theme for a card number, or the neutral one.
 *
 * Everything a merchant might paste is accepted: spaces, dashes, and — the case that actually
 * happens, because bank apps print them that way — Persian and Arabic-Indic digits. All of it
 * normalises to ASCII before the six-digit comparison, so a card is identified by what it is
 * rather than by how it was typed.
 *
 * A **masked** number cannot be identified, and that is not a defect to work around: masking
 * keeps the first four digits and the last four, and the BIN is six digits long. Callers that
 * only have a masked number get the neutral theme; the panel and the payment page both pass
 * the real number for the theme and the masked form only for what is printed.
 */
export function bankThemeFor(number: string | null | undefined): BankTheme {
  const digits = stripNonDigits(number ?? '');
  if (digits.length < 6) return UNKNOWN_BANK_THEME;
  for (const [prefix, theme] of PREFIX_INDEX) {
    if (digits.startsWith(prefix)) return theme;
  }
  return UNKNOWN_BANK_THEME;
}

/** The issuer's name alone, for a plain label or a table cell. */
export function bankNameFor(number: string | null | undefined): string {
  return bankThemeFor(number).name;
}

/** True when the prefix is a bank we can name, as opposed to the neutral fallback. */
export function isKnownBank(number: string | null | undefined): boolean {
  return bankThemeFor(number) !== UNKNOWN_BANK_THEME;
}
