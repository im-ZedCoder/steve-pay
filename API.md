# API reference

Base URL: `https://steve-gate.ir/api/v1`

That host is the one this deployment answers on today. Nothing in the platform is configured
with it: every absolute URL it returns — `paymentUrl`, `webhookUrl`, the links in a Telegram
alert — is built from the request being served, so a second host or a renamed domain needs no
change here or in the code. If you are calling a preview or a different environment, use *its*
host and the paths below.

All requests are JSON. All responses are JSON. Every response carries `X-Request-Id` — quote it
in support requests and it will line up with the logs and the audit trail.

---

## Authentication

Send your API key in `X-API-Key`:

```http
X-API-Key: sk_live_<key-id><secret>
```

The value is the prefix `sk_live_` followed by a 12-character key id and a 32-character secret —
44 characters after the prefix. `sk_test_` is the same shape for the test environment. The full
key is shown once, when it is created; only its hash is stored.

`Authorization: Bearer <key>` is also accepted, because SMS forwarder apps and generic HTTP
clients differ in which header they can set.

Keys come in two environments:

| Prefix | Environment | Effect |
|---|---|---|
| `sk_live_` | live | Creates real invoices |
| `sk_test_` | test | Invoices are marked `isTest: true`, never touch wallet balances, and test SMS messages never confirm live invoices |

**The full key is shown once**, at creation. Only a peppered HMAC of it is stored, so it cannot be
recovered — rotate if lost. Keys can carry a per-key IP allowlist and a scope list.

Scopes: `payments:create`, `payments:read`, `transactions:read`, `wallet:read`, `cards:read`,
`sms:write`.

---

## makePayment

`POST /api/v1/payments`

Creates an invoice and allocates a unique payable amount.

### Request

```json
{
  "amount": 359000,
  "currency": "IRT",
  "description": "Order #1234",
  "customCallback": "https://merchant.example.com/payment/callback",
  "returnUrl": "https://merchant.example.com/orders/1234",
  "metadata": { "orderId": "1234" },
  "expiresInMinutes": 30,
  "feeMode": "CUSTOMER",
  "cardId": "card_..."
}
```

| Field | Required | Notes |
|---|---|---|
| `amount` | yes | Integer **Toman**. Minimum 1,000, maximum 500,000,000 by default. |
| `currency` | no | Only `IRT`. Anything else is `CURRENCY_NOT_SUPPORTED`. |
| `description` | no | Shown to the customer on the payment page. |
| `customCallback` | no | Overrides the merchant's default webhook for this payment. Must be `https` in production. |
| `returnUrl` | no | Where to send the customer after paying. Must be on the merchant's own configured host. |
| `metadata` | no | Opaque key/value data, echoed back in the webhook. |
| `expiresInMinutes` | no | 15–60 by default. Outside the allowed range is `INVALID_EXPIRY`. |
| `feeMode` | no | `CUSTOMER` (default) or `MERCHANT`. Changes **who pays**, never how much. |
| `cardId` | no | Which receiving card to use. Defaults to the merchant's default card. |

Unknown fields are **rejected**, not ignored. A typo like `ammount` would otherwise produce an
invoice for the wrong value and the merchant would find out from a customer.

`Idempotency-Key` is optional but strongly recommended — see below.

### Response `200`

```json
{
  "success": true,
  "paymentId": "pay_01J8XK...",
  "invoiceId": "inv_01J8XK...",
  "paymentUrl": "https://steve-gate.ir/pay/inv_01J8XK...",
  "amount": 363706,
  "amountRial": 3637060,
  "currency": "IRT",
  "expiresAt": "2026-09-22T10:45:00.000Z",
  "status": "pending",
  "payment": {
    "id": "pay_01J8XK...",
    "invoiceId": "inv_01J8XK...",
    "status": "pending",
    "originalAmount": 359000,
    "fee": 3000,
    "payableAmount": 363706,
    "payableAmountRial": 3637060,
    "baseAmount": 362000,
    "uniqueSuffix": 1706,
    "paymentUrl": "https://steve-gate.ir/pay/inv_01J8XK...",
    "expiresAt": "2026-09-22T10:45:00.000Z",
    "createdAt": "2026-09-22T10:15:00.000Z",
    "environment": "live",
    "testMode": false
  }
}
```

Both shapes are intentional. `payment` is the object a typed SDK consumes; the flat keys are the
ones a hand-written script reads. Note that the flat `amount` is the **payable** amount, not the
original — `payment.originalAmount` is the original.

`baseAmount + uniqueSuffix === payableAmount`, always. The suffix is what makes this invoice
distinguishable from every other live invoice, which is why it is visible.

### Idempotency

```http
Idempotency-Key: order_1234
```

Send a key derived from your own order ID. A retry — network timeout, confusing error, deploy —
returns the **original invoice**, not a second one. Replays are marked with
`Idempotent-Replay: true`.

The same key with a **different body** returns `409 IDEMPOTENCY_CONFLICT`. That is a client bug and
answering it with the first result would hide it. A failed request releases its key, so a genuine
retry does the work.

Keys are remembered for 24 hours.

### Errors

| Code | Status | Meaning |
|---|---|---|
| `UNAUTHENTICATED` | 401 | No key sent |
| `INVALID_API_KEY` | 401 | Key unknown, or wrong secret |
| `API_KEY_REVOKED` | 401 | Key was revoked |
| `API_KEY_EXPIRED` | 401 | Key passed its expiry |
| `API_KEY_ENVIRONMENT_MISMATCH` | 401 | Test key against a live route, or vice versa |
| `INSUFFICIENT_SCOPE` | 403 | Key lacks the endpoint's scope |
| `IP_NOT_ALLOWED` | 403 | Request came from outside the key's allowlist |
| `ACCOUNT_PENDING_APPROVAL` | 403 | Awaiting admin approval |
| `ACCOUNT_SUSPENDED` | 403 | Suspended |
| `ACCOUNT_BANNED` | 403 | Banned |
| `VALIDATION_FAILED` | 400 | A field was missing or malformed |
| `AMOUNT_BELOW_MINIMUM` | 400 | Below `invoices.min_amount_toman` |
| `AMOUNT_ABOVE_MAXIMUM` | 400 | Above `invoices.max_amount_toman` |
| `CURRENCY_NOT_SUPPORTED` | 400 | Only `IRT` |
| `INVALID_FEE_MODE` | 400 | Not `CUSTOMER` or `MERCHANT` |
| `INVALID_EXPIRY` | 400 | Outside the allowed expiry range |
| `CARD_REQUIRED` | 400 | No active receiving card |
| `INSUFFICIENT_WALLET_BALANCE` | 402 | `MERCHANT` fee mode with too little balance |
| `AMOUNT_SPACE_EXHAUSTED` | 503 | Every suffix in the space is claimed — see below |
| `MAINTENANCE_MODE` | 503 | Invoice creation is disabled by an admin |
| `IDEMPOTENCY_CONFLICT` | 409 | Key reused with a different body, or in flight |
| `RATE_LIMITED` | 429 | Includes `Retry-After` |
| `DATABASE_ERROR` | 500 | Internal. Retry with the same idempotency key. |

### Failure shape

```json
{
  "success": false,
  "code": "INSUFFICIENT_WALLET_BALANCE",
  "message": "موجودی کیف پول کافی نیست.",
  "requestId": "req_01J8XM...",
  "details": { "required": 3000, "available": 0, "feeMode": "MERCHANT" }
}
```

Stack traces are never returned. `details` is present only where it is useful to act on.

---

## myCards

`GET /api/v1/cards` — scope `cards:read`

```json
{
  "success": true,
  "cards": [
    {
      "id": "card_01J8XK...",
      "masked": "6104-****-****-3456",
      "title": "Main",
      "bankName": "بانک ملت",
      "holderName": "فروشگاه نمونه",
      "isDefault": true,
      "displayOrder": 0
    }
  ]
}
```

Only the masked form is ever returned over the API.

---

## myStatus

`GET /api/v1/status` — scope `payments:read`

```json
{
  "success": true,
  "merchant": {
    "id": "usr_01J8XK...",
    "merchantCode": "SP-1042",
    "displayName": "فروشگاه نمونه",
    "accountStatus": "ACTIVE",
    "environment": "live"
  },
  "apiKey": { "id": "key_...", "environment": "live", "scopes": ["payments:create"] },
  "sms": {
    "pipelineConnected": true,
    "verifiedAt": "2026-09-20T09:12:00.000Z",
    "webhookUrl": "https://steve-gate.ir/sms"
  },
  "webhooks": { "configured": true, "active": 1 },
  "wallet": { "balance": 147000, "availableBalance": 147000, "reservedBalance": 0, "currency": "IRT" },
  "fees": { "gatewayFee": 3000, "feeMode": "CUSTOMER", "suffixDigits": 4 },
  "setup": {
    "completionPercent": 87,
    "ready": false,
    "remainingSteps": [{ "key": "sms_test", "title": "آزمایش خط پیامک", "detail": null }]
  },
  "health": { "database": "ok", "invoiceCreationEnabled": true }
}
```

`setup.remainingSteps` names the unfinished steps rather than counting them — a merchant told
"3 steps remaining" still has to go and find them.

---

## myWallet

`GET /api/v1/wallet` — scope `wallet:read`

```json
{
  "success": true,
  "wallet": {
    "balance": 147000,
    "availableBalance": 147000,
    "reservedBalance": 0,
    "totalDeposited": 150000,
    "totalFeesPaid": 3000,
    "totalAdjustments": 0,
    "currency": "IRT"
  }
}
```

`availableBalance = balance - reservedBalance`. Reserved money is spoken for by live
`MERCHANT`-fee invoices and cannot be spent twice.

---

## transactionsCount

`GET /api/v1/transactions/count?range=today` — scope `transactions:read`

| `range` | Meaning |
|---|---|
| `today` (default) | Since midnight **Asia/Tehran** |
| `yesterday` | The previous Tehran day |
| `last7days` / `last30days` | Rolling Tehran days |
| `custom` | Requires `from`; `to` optional. Both inclusive Tehran days. |

```json
{
  "success": true,
  "range": "today",
  "from": "2026-09-21T20:30:00.000Z",
  "to": null,
  "counts": {
    "total": 42,
    "successful": 38,
    "pending": 3,
    "expired": 1,
    "failed": 0,
    "manualReview": 0
  },
  "amounts": { "volume": 13842000, "volumeRial": 138420000, "fees": 114000, "currency": "IRT" },
  "successRate": 90.5,
  "averagePaymentSeconds": 214,
  "lifetime": { "total": 1840, "successful": 1791, "volume": 612000000, "successRate": 97.3 }
}
```

`range=today` means the **Tehran** day, not the UTC day. A merchant in Iran asking at 01:00 local
time means the last few hours, and a UTC boundary would answer for yesterday.

---

## SMS intake

`POST /sms` — scope `sms:write`

This is what the merchant's SMS forwarder calls. It is not a normal API endpoint: it is the write
path into the matching engine, and it is rate-limited per IP *and* per merchant.

```json
{
  "message": "واریز به کارت 6104337890123456 مبلغ ۳۶۳٬۷۰۶ تومان شماره پیگیری ۸۴۲۱۹۰۳۳۱",
  "sender": "BANKMELLI",
  "receivedAt": "2026-09-22T10:31:00.000Z",
  "deviceId": "pixel-7"
}
```

Only `message` is required. `receivedAt` is the forwarder's clock and is **never trusted** for
matching — a phone with a wrong clock could otherwise place a payment inside the window.

### Response `200`

```json
{
  "success": true,
  "outcome": "CONFIRMED",
  "requestId": "req_01J8XM...",
  "smsMessageId": "sms_01J8XM...",
  "invoiceId": "inv_01J8XK...",
  "transactionId": "txn_01J8XM...",
  "detail": "پرداخت تأیید شد.",
  "parse": { "parser": "bank_melli", "bank": "BANK_MELLI", "confidence": 95, "amountToman": 363706, "reference": "842190331", "warnings": [] },
  "reference": "842190331"
}
```

| `outcome` | Meaning | Retry? |
|---|---|---|
| `CONFIRMED` | Payment matched and confirmed | no |
| `MANUAL_REVIEW` | Matched but a risk signal fired; an admin will decide | no |
| `DUPLICATE` | This exact message was already received | no |
| `DUPLICATE_TRANSACTION` | The bank reference already settled a transaction | no |
| `NOT_A_PAYMENT` | Parsed as a debit, a balance notice, or marketing | no |
| `UNPARSEABLE` | Nothing usable was extracted (`202`) | yes, after a parser update |
| `TEST_VERIFIED` | A test token matched; the pipeline is connected | no |
| `TEST_TOKEN_INVALID` | A test token was present but wrong | no |
| `NO_MATCH` | Parsed fine, but no live invoice matches | no |

**Non-2xx means "not delivered"** to a forwarder, so almost everything is a `200`. Retrying a
duplicate cannot change the answer.

---

## Rate limits

| Endpoint | Default |
|---|---|
| `makePayment` | 60/minute per merchant |
| `POST /sms` | 120/minute per IP and per merchant |
| Public API generally | 300/minute per merchant |
| Login | 10/15 minutes |
| Registration | 5/hour per IP |
| Payment page | 120/minute per IP |

`429` responses include `Retry-After` (seconds), `X-RateLimit-Limit` and `X-RateLimit-Remaining`.
Honour `Retry-After`.

---

## Examples

### cURL

```bash
curl -X POST https://steve-gate.ir/api/v1/payments \
  -H "X-API-Key: sk_live_<key-id><secret>" \
  -H "Idempotency-Key: order_1234" \
  -H "Content-Type: application/json" \
  -d '{"amount": 359000, "description": "Order #1234"}'
```

### JavaScript

```js
const response = await fetch('https://steve-gate.ir/api/v1/payments', {
  method: 'POST',
  headers: {
    'X-API-Key': process.env.STEVE_GATE_KEY,
    // Derive this from your own order id so a retry cannot create a second invoice.
    'Idempotency-Key': `order_${order.id}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    amount: order.totalToman,
    description: `Order #${order.id}`,
    metadata: { orderId: String(order.id) },
    returnUrl: `https://shop.example.com/orders/${order.id}`,
  }),
});

if (!response.ok) {
  const error = await response.json();
  // error.code is stable; error.message is for humans; error.requestId is for support.
  throw new Error(`Steve Gate ${error.code}: ${error.message} (${error.requestId})`);
}

const { payment } = await response.json();
redirect(payment.paymentUrl);
```

### PHP

```php
<?php
$payload = json_encode([
  'amount'      => 359000,
  'description' => 'Order #1234',
  'metadata'    => ['orderId' => '1234'],
], JSON_UNESCAPED_UNICODE);

$ch = curl_init('https://steve-gate.ir/api/v1/payments');
curl_setopt_array($ch, [
  CURLOPT_POST           => true,
  CURLOPT_POSTFIELDS     => $payload,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER     => [
    'X-API-Key: ' . getenv('STEVE_GATE_KEY'),
    'Idempotency-Key: order_1234',
    'Content-Type: application/json',
  ],
]);

$body = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

$data = json_decode($body, true);

if ($status !== 200) {
  // $data['code'] is the stable identifier; log $data['requestId'] too.
  error_log("Steve Gate error {$data['code']}: {$data['requestId']}");
  exit(1);
}

header('Location: ' . $data['payment']['paymentUrl']);
```

### Python

```python
import os
import requests

response = requests.post(
    "https://steve-gate.ir/api/v1/payments",
    headers={
        "X-API-Key": os.environ["STEVE_GATE_KEY"],
        "Idempotency-Key": f"order_{order_id}",
    },
    json={
        "amount": 359000,
        "description": f"Order #{order_id}",
        "metadata": {"orderId": str(order_id)},
    },
    timeout=15,
)

if response.status_code != 200:
    error = response.json()
    raise RuntimeError(f"Steve Gate {error['code']}: {error['message']} ({error['requestId']})")

payment = response.json()["payment"]
print(payment["paymentUrl"], payment["payableAmount"])
```

---

## Verifying a callback

Your webhook is signed. Verify before trusting it — see [WEBHOOKS.md](./WEBHOOKS.md) for a full
example in each language and for the replay rules.

---

## Test mode

Use an `sk_test_` key. Test invoices:

- are marked `isTest: true` / `testMode: true`
- render the payment page with a **TEST MODE** banner
- never touch a real wallet balance
- never send a live webhook (`isTest` is set on the delivery)

Test SMS messages can verify the SMS pipeline (`TEST_VERIFIED`) and can never confirm a live
invoice.
