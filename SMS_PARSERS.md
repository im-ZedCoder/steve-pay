# SMS parsers

The parser turns a bank's message into structured fields. It is the component most exposed to the
outside world's messiness, so it is built as a strategy chain rather than a switch statement.

```
SmsParser (interface)
 ├── TemplateParser    one per bank, driven by data in BANK_TEMPLATES
 │    ├── bank:mellat
 │    ├── bank:saderat
 │    ├── bank:parsian
 │    └── ...
 └── GenericParser     keyword + shape heuristics, no per-bank knowledge
```

`parseSms(raw, options)` runs the chain in order, keeps the highest-confidence result, and records
which parser produced it (`ParsedSms.parser`) so a failure can be traced to a strategy.

---

## Why templates are data, not code

`BANK_TEMPLATES` is an array of plain objects. `compileTemplate` validates one at runtime, so a new
bank is a data change plus a test — not a new class. Two consequences that matter in practice:

- A bank that changes its wording is a one-line edit, not a code review of a parser subclass.
- Templates can be validated when loaded, so a malformed pattern is a startup error rather than a
  crash on the first customer payment of the day.

A `RawBankTemplate` accepts patterns as `RegExp` objects or as strings (bare source, or
`/pattern/flags`). Runtime validation rejects a template whose patterns do not compile, and
`g`/`y` flags are stripped so a shared template cannot carry last-index state between messages.

### Template fields

| Field | Required | Purpose |
|---|---|---|
| `id` | yes | Stable identifier, e.g. `bank:mellat` |
| `bank` | yes | Human name used in the UI and the receipt |
| `required` | yes | Patterns that **must** all match for this template to apply |
| `optional` | no | Patterns that raise confidence if present |
| `defaultCurrency` | no | Assumed when the message states none |
| `amountPattern` | no | Overrides the amount extractor |
| `amountPatternGroup` | no | Which capture group holds the amount |
| `referencePattern` | no | Where the bank's tracking number lives |
| `destinationCardPattern` | no | The receiving card |
| `balancePattern` | no | Used to detect and then strip balance figures |
| `directionKeywords` | no | Words that identify this bank's credit/debit phrasing |

`required` is what keeps a template from claiming messages it does not understand. A message with
one bank's footer but another bank's amount phrasing must fail to match rather than half-parse.

---

## The parse pipeline

```
raw message
  ↓ normalizeForParsing      Persian/Arabic digits → ASCII, whitespace collapsed,
                             ZWNJ handled, currency words unified
  ↓ extractAmounts           every numeric fragment with its unit and position
  ↓ normaliseAmount          to integer Toman; Rial ÷ 10, floored, never a float
  ↓ extractReference         pattern first, then labelled fragments
  ↓ extractCards             source / destination from 16-digit runs
  ↓ extractSheba             IBAN, for bank-level disambiguation
  ↓ extractBalanceToman      so the balance is never mistaken for the amount
  ↓ extractDirection         CREDIT / DEBIT / UNKNOWN
  ↓ extractOccurredAt        Jalali or Gregorian stamp → absolute instant
  ↓ scoreConfidence          0–100
ParsedSms
```

### Amount extraction is the hard part

Persian messages contain several numbers: the amount, the balance, the card, the reference, the
date, sometimes the fee. The extractor:

1. Normalises digits and every thousands separator (`٬` U+066C, `,`, `.` where unambiguous).
2. Classifies each candidate by its adjacent unit — تومان / Toman / تومان / ریال / Rial.
3. Discards number-shaped values that are actually cards (16 digits) or references (already
   labelled) or the balance.
4. Prefers the candidate marked as the transaction amount; falls back to the largest non-balance
   candidate.

**Unitless amounts are assumed to be Rial**, which is the conservative direction: Rial ÷ 10 floors
to fewer Toman, so a misread cannot inflate what a merchant is credited with. It also raises a
`warnings` entry, and a warning lowers `confidence`.

If a message has no unit at all and no unambiguous candidate, the outcome is `UNPARSEABLE` rather
than a guess. Refusing is correct: a guessed amount either fails the unique-amount match (harmless)
or, worse, coincidentally matches a *different* invoice's equivalent amount.

### Confidence

`scoreConfidence` starts from the parser's base (a template match starts high, the generic parser
low) and adjusts:

| Signal | Effect |
|---|---|
| A required field was extracted without warnings | + |
| An explicit currency was stated | + |
| A bank reference was found | + |
| Direction is clearly CREDIT | + |
| Direction is UNKNOWN | − |
| Any extractor warning | − |
| A balance was present but could not be confidently separated | − |
| Message length and structure look like a marketing SMS | − |

Confidence drives one decision: whether the matcher may auto-confirm, or must escalate to
`MANUAL_REVIEW`. The threshold is `matching.min_confidence_auto_confirm` (default 70), and
auto-confirmation can be turned off entirely with `matching.auto_confirm_enabled`.

Below the threshold, a human looks at it. A payment that is briefly delayed is recoverable; one
attributed to the wrong invoice is not.

---

## Direction: what the message is *doing*

`extractDirection` classifies CREDIT (money in), DEBIT (money out) and UNKNOWN. This matters more
than it looks: a merchant's phone receives both the deposit into their account **and** the debit
from the customer's account if both are on the same device, and they often carry the *same amount*.
Confirming on a debit would mark an invoice paid when no money arrived at the merchant.

Messages that are not payments at all — balance notifications, OTPs, marketing, bill reminders —
are classified `NOT_A_PAYMENT` and recorded but never matched.

---

## Duplicate detection

Two independent keys, because banks differ in what they include:

1. `message_hash = sha256(merchantUserId ‖ normalised raw)` — catches the same SMS forwarded twice,
   by a retrying forwarder or a device that delivers twice.
2. Bank reference — catches the same *transaction* described by two different messages (a debit
   alert and a credit alert, for instance). Enforced platform-wide by
   `ux_transactions_bank_reference`.

Where a bank sends no usable reference, `transaction_fingerprints` holds a composite key
(merchant + amount + time bucket + reference) so a synthetic dedupe still exists.

The raw message is stored **unedited and untruncated**. Anything derived lives in
`sms_parser_results`, so the parser can improve and be re-run over historical messages without any
risk of having lost the evidence.

---

## Adding a bank

1. **Collect real samples.** Five to ten messages, including a debit, a balance notice and one
   message from a different bank, so the required patterns can be tight enough to reject them.
2. **Add a template** to `BANK_TEMPLATES`:

```ts
{
  id: 'bank:example',
  bank: 'بانک نمونه',
  // All required. A message that matches only some of these is not this bank's.
  required: [
    /بانک\s*نمونه/,
    /(واریز|برداشت|انتقال)/,
  ],
  optional: [/شماره\s*پیگیری/],
  defaultCurrency: 'RIAL',
  amountPattern: /مبلغ\s*:?\s*([\d,٬.]+)/,
  amountPatternGroup: 1,
  referencePattern: /پیگیری\s*:?\s*(\d{6,})/,
  destinationCardPattern: /به\s*کارت\s*:?\s*(\d{16})/,
  balancePattern: /مانده\s*:?\s*([\d,٬.]+)/,
  directionKeywords: { credit: ['واریز', 'افزایش'], debit: ['برداشت', 'کسر'] },
}
```

3. **Add fixtures** to the parser test suite:

```ts
{
  raw: 'واریز ۳۶۳٬۷۰۶ تومان به کارت ۶۱۰۴۳۳۷۸۹۰۱۲۳۴۵۶ شماره پیگیری ۸۴۲۱۹۰۳۳۱',
  expect: {
    parser: 'bank:example',
    amountToman: 363706,
    reference: '842190331',
    direction: 'CREDIT',
    warnings: [],
  },
}
```

4. **Run the cross-bank rejection test.** Every fixture must match its own template and **no
   other**. A template that is too loose silently steals another bank's messages, and the symptom
   is a wrong amount rather than an error.
5. **Test the negatives explicitly**: a debit of the same amount, a balance notice, a marketing SMS,
   and a message with no amount.

### Checklist for a new template

- [ ] `required` rejects the other banks' fixtures
- [ ] Credit and debit both classified correctly
- [ ] The balance is never returned as the amount
- [ ] The reference is captured, or evidence is recorded for why it cannot be
- [ ] Jalali and Gregorian timestamps both parse
- [ ] Persian and ASCII digits both parse
- [ ] Confidence is ≥ 70 for a clean message and < 70 for a messy one

---

## Redaction

Two functions, for two audiences. Both live here so redaction cannot be forgotten at a call site.

`redactSmsForCustomer(raw, { amountToman, amountRial, reference })` returns
`{ text, redacted[] }` for a public page:

- removes the balance sentence **entirely** — a masked balance still reveals roughly how much money
  the merchant holds, and the number serves no purpose on a receipt
- masks 16-digit card runs as `6104-****-****-3456`
- masks the IBAN, keeping the bank code and last four
- **keeps** the amount and the bank reference, because those are the two values the payer is
  checking, and hiding them would defeat the point of showing the message

`redactSmsForWebhook(parsed)` masks source and destination cards for delivery payloads. Webhooks go
to a URL the merchant controls, but they are routinely logged by proxies and third-party services,
so the same discipline applies.

---

## Operational notes

- **Length cap** — 2,000 characters (`MAX_SMS_LENGTH`). Real messages are under 300. The HTTP layer
  caps the body at 16 KB before that.
- **`receivedAt` is stored but never trusted.** It is the forwarder's clock; a phone with a wrong
  clock could otherwise place a payment inside the matching window. The server's own clock is
  authoritative for the time-window check.
- **A new parser is a deploy, not a config change.** `platform.sms_templates` exists as a setting
  (default `[]`) for admin-supplied templates, but the shipped `BANK_TEMPLATES` are what runs;
  changing parsing behaviour should go through review and the test suite.
- **Re-parsing history** is possible and safe: raw messages are intact and results are a separate
  table, so a parser fix can be replayed over past messages to find what would have matched
  differently.
