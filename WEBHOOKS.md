# Webhooks

When a payment is confirmed, Steve Gate calls the merchant. The callback is signed, delivered
asynchronously, retried on failure, and logged in full.

---

## The event

`payment.success` is sent after confirmation. The payload is exactly this shape — merchants write
code against it, so it does not change without a version bump:

```json
{
  "event": "payment.success",
  "paymentId": "pay_01J8XK...",
  "invoiceId": "inv_01J8XK...",
  "merchantId": "usr_01J8XK...",
  "status": "paid",
  "amount": 363706,
  "originalAmount": 359000,
  "fee": 3000,
  "currency": "IRT",
  "paidAt": "2026-09-22T10:31:04.000Z",
  "referenceId": "842190331",
  "metadata": { "orderId": "1234" }
}
```

| Field | Notes |
|---|---|
| `amount` | The **payable** amount that was transferred, including the uniqueness suffix |
| `originalAmount` | What the merchant asked for |
| `fee` | Total platform fee (`customerFee + merchantFee`) |
| `paidAt` | When the bank transaction was confirmed |
| `referenceId` | The bank's tracking number, or `null` if the bank sent none |
| `metadata` | Exactly what the merchant passed to `makePayment` |

Subscribe to more events per endpoint in the dashboard: `payment.created`, `payment.pending`,
`payment.success`, `payment.failed`, `payment.expired`, `payment.manual_review`,
`wallet.low_balance`. `*` subscribes to all.

The destination is the invoice's `customCallback` if one was supplied at creation, otherwise the
merchant's default endpoint.

---

## Headers

```http
X-SteveGate-Signature: t=1758539464,v1=5f3c...e91
X-SteveGate-Event: payment.success
X-SteveGate-Timestamp: 1758539464
X-SteveGate-Delivery: whd_01J8XM7K2P...
Content-Type: application/json
```

`X-SteveGate-Delivery` is stable across retries of the same delivery, so it is the right key for the
merchant's own dedupe. `X-SteveGate-Timestamp` is Unix seconds.

### The previous names still arrive

The platform was called Steve Pay until the rename, and these header names are the one part of that
rename an integration has code written against. Every delivery therefore carries **both sets**:

```http
X-SteveGate-Signature: t=1758539464,v1=5f3c...e91
X-StevePay-Signature:  t=1758539464,v1=5f3c...e91
```

The values are identical — this is a duplicate, not a second scheme, so reading either header is
enough and there is nothing extra to verify. New code should read `X-SteveGate-*`; code already in
testing does not have to change. The legacy set will be dropped in a later release, and it will be
announced here rather than removed quietly.

---

## Verifying a signature

HMAC-SHA256 over `"{timestamp}.{rawBody}"`, hex encoded. The timestamp is **inside** the signed
material, which is what makes a captured request non-replayable: an attacker cannot change the
timestamp without invalidating the signature, so a merchant that rejects stale timestamps is
protected.

**Verify against the raw bytes.** Parsing the JSON and re-serialising it will change key order and
whitespace, and the signature will not match. Read the body as a string first.

### JavaScript (Express)

```js
const crypto = require('crypto');

// express.raw() — NOT express.json(): the signature covers the exact bytes.
app.post('/payment/callback', express.raw({ type: 'application/json' }), (req, res) => {
  const header = req.get('X-SteveGate-Signature') || '';
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const timestamp = parts.t;
  const provided = parts.v1;

  if (!timestamp || !provided) return res.status(400).send('missing signature');

  // Reject a stale request: this is the replay defence.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    return res.status(400).send('timestamp out of range');
  }

  const expected = crypto
    .createHmac('sha256', process.env.STEVE_GATE_WEBHOOK_SECRET)
    .update(`${timestamp}.${req.body.toString('utf8')}`)
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).send('bad signature');
  }

  const event = JSON.parse(req.body.toString('utf8'));

  // Acknowledge fast, then work. Do the slow part asynchronously: a slow handler is
  // indistinguishable from a failing one, and it will be retried.
  res.status(200).send('ok');
  queueForProcessing(event);
});
```

### PHP

```php
$raw = file_get_contents('php://input');
$secret = getenv('STEVE_GATE_WEBHOOK_SECRET');

parse_str(str_replace(',', '&', $_SERVER['HTTP_X_STEVEPAY_SIGNATURE'] ?? ''), $parts);
$timestamp = $parts['t'] ?? '';
$provided  = $parts['v1'] ?? '';

if ($timestamp === '' || $provided === '') {
    http_response_code(400);
    exit('missing signature');
}

if (abs(time() - (int) $timestamp) > 300) {
    http_response_code(400);
    exit('timestamp out of range');
}

$expected = hash_hmac('sha256', $timestamp . '.' . $raw, $secret);

if (!hash_equals($expected, $provided)) {   // hash_equals is the constant-time comparison
    http_response_code(401);
    exit('bad signature');
}

$event = json_decode($raw, true);
http_response_code(200);
echo 'ok';
```

### Python (Flask)

```python
import hashlib, hmac, json, time
from flask import Flask, request, abort

app = Flask(__name__)
SECRET = os.environ["STEVE_GATE_WEBHOOK_SECRET"].encode()

@app.post("/payment/callback")
def callback():
    raw = request.get_data()               # raw bytes, before any parsing
    header = request.headers.get("X-SteveGate-Signature", "")

    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    timestamp, provided = parts.get("t"), parts.get("v1")
    if not timestamp or not provided:
        abort(400, "missing signature")

    if abs(time.time() - int(timestamp)) > 300:
        abort(400, "timestamp out of range")

    expected = hmac.new(SECRET, f"{timestamp}.".encode() + raw, hashlib.sha256).hexdigest()

    if not hmac.compare_digest(expected, provided):   # constant time
        abort(401, "bad signature")

    event = json.loads(raw)
    # Persist with X-SteveGate-Delivery as the unique key, so a retry cannot double-process.
    return "ok", 200
```

### cURL (manual check)

```bash
BODY='{"event":"payment.success","amount":363706}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$STEVE_GATE_WEBHOOK_SECRET" -hex | awk '{print $2}')

curl -X POST https://shop.example.com/payment/callback \
  -H "Content-Type: application/json" \
  -H "X-SteveGate-Signature: t=$TS,v1=$SIG" \
  -H "X-SteveGate-Event: payment.success" \
  -H "X-SteveGate-Timestamp: $TS" \
  -d "$BODY"
```

---

## Responding correctly

| Response | Interpretation |
|---|---|
| `2xx` | Delivered. Nothing further happens. |
| Anything else, or a timeout | Failed. Retried on the schedule below. |
| Any non-2xx | Treated as a failure. A `200` with a JSON body `{"ok":false}` is still delivery. |

**Return `2xx` quickly.** The timeout is `webhooks.timeout_seconds` (default 10). If your handler
needs to do real work — updating an order, sending an email, calling a warehouse — acknowledge
first and queue the work. A slow handler is indistinguishable from a broken one and will be retried,
delivering the same event again.

**Handle duplicates.** A retry after a timeout is not evidence that the first attempt failed; it may
have succeeded and the response was lost. Key on `X-SteveGate-Delivery` (stable across retries of
one delivery) or on `invoiceId`, which is the more meaningful idempotency key for the merchant's
own domain.

---

## Retries

Failed deliveries retry with exponential backoff:

| Attempt | Delay after previous |
|---|---|
| 1 | immediately |
| 2 | 1 minute |
| 3 | 5 minutes |
| 4 | 30 minutes |
| 5 | 2 hours |
| 6 | 12 hours |
| 7 | 24 hours |

Six retries spanning roughly a day and a half, capped by `webhooks.max_attempts` (default 6). The
window is chosen so a five-minute deploy or a short outage recovers on its own, while a permanently
broken endpoint eventually stops consuming capacity.

After `webhooks.disable_after_consecutive_failures` (default 25) consecutive failures the endpoint is
**disabled** rather than dropped: the merchant gets a Telegram alert, and every affected delivery
stays in the log with its payload, so nothing is lost. Re-enabling it in the dashboard resumes
delivery, and failed deliveries can be retried manually.

---

## Delivery logs

Every attempt is recorded — the merchant's dashboard and the admin console both read this, and the
"Retry" button operates on it.

| Field | Purpose |
|---|---|
| `delivery_id` | Stable across retries of one delivery |
| `event`, `url` | What was sent, where |
| `request_timestamp` | When the attempt started |
| `response_status`, `response_body` | What came back, truncated |
| `duration_ms` | Extraction point for a merchant whose endpoint is degrading |
| `retry_count`, `next_retry_at` | Where the delivery is in its schedule |
| `status` | `PENDING` / `DELIVERED` / `FAILED` / `DEAD` |

**Secrets are never stored** in a log. The webhook secret is sealed in the endpoint row and is
never written to a delivery record or echoed into a response body.

---

## Why delivery cannot affect a payment

```
confirmPayment()            commits. One transaction. Done.
       ↓
announceConfirmedPayment()  enqueue + Telegram, afterwards and best-effort
```

The webhook is **enqueued** onto Cloudflare Queues, not sent inline. Two consequences:

1. A slow merchant endpoint never delays a confirmation, so the customer's page and the SMS
   forwarder are never held up by someone else's outage.
2. A merchant with no endpoint configured gets `skipped: true` and still has a paid invoice.

`announceConfirmedPayment` returns a summary and never throws. By the time it runs the payment is
committed, and nothing in the notification path can reach back into the confirmation path — which is
how "callback failure must never reverse a successful payment" is guaranteed structurally rather
than by remembering to catch an exception.

When the queue binding is absent (local development), delivery falls back to `waitUntil`, so the
behaviour is exercised in development without requiring a running queue.

---

## Security

- **HTTPS only in production.** A `http://` callback URL is rejected at creation and at delivery.
- **No internal targets.** Delivery refuses loopback, link-local, private and reserved address
  ranges. A merchant cannot make the platform probe its own infrastructure.
- **Endpoint secrets** are generated with 32 bytes of randomness, shown once, and sealed with
  AES-GCM derived via HKDF from `WEBHOOK_SECRET`. Rotating an endpoint secret is a dashboard action;
  rotating `WEBHOOK_SECRET` itself requires re-sealing every endpoint.
- **Signing is over the raw body and the timestamp**, so neither the payload nor the timestamp can
  be altered in flight without detection.

---

## Testing your endpoint

The dashboard's setup wizard can send a test delivery: it uses `payment.success` with synthetic data
marked `isTest`, through the same signing and retry path, so a green result means the real path
works. Test deliveries never touch a wallet balance and are excluded from the merchant's real
delivery statistics.
