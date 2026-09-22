# Steve Pay — Production-Grade Payment Gateway

You are a senior full-stack architect and engineer.

Build a production-ready payment gateway platform named **Steve Pay**.

The system must be designed from the beginning as a real production service, not as a demo or prototype.

Primary domain:

`steve-pay.ir`

The system will run primarily on **Cloudflare Pages / Cloudflare Workers** with a custom domain.

The architecture must be Cloudflare-native, scalable, secure, observable, and easy to maintain.

---

# 1. Core Concept

Steve Pay is a payment gateway based on:

1. User registration and admin approval
2. API keys per merchant/user
3. Payment invoice generation
4. Bank-card based payment instructions
5. Unique payment amounts
6. Automatic transaction confirmation using incoming bank SMS
7. SMS Forwarder application integration
8. Merchant wallet and gateway fees
9. Merchant dashboard
10. Admin dashboard
11. Telegram notifications
12. Merchant callbacks/webhooks
13. Ticket/support system
14. Financial reports
15. Real-time transaction monitoring

The system must support multiple merchants/users.

Each merchant can create payment invoices through the API.

Incoming bank SMS messages are received through a central webhook and matched against pending invoices.

---

# 2. Recommended Architecture

Use a Cloudflare-first architecture.

Recommended stack:

* Cloudflare Pages for frontend
* Cloudflare Workers / Pages Functions for backend APIs
* Cloudflare D1 for relational database
* Cloudflare KV where appropriate for caching/rate limiting/configuration
* Cloudflare Queues where appropriate for asynchronous processing
* Cloudflare Cron Triggers for cleanup/reconciliation/maintenance jobs
* Cloudflare Turnstile for public registration/payment abuse protection
* TypeScript
* Modern frontend framework
* Clean REST API architecture

Use the existing project's preferred framework if already present. Otherwise choose a modern lightweight stack suitable for Cloudflare Pages.

Do NOT introduce a traditional VPS unless absolutely necessary.

Keep the architecture modular:

* Authentication
* Merchant Management
* API
* Payments
* Wallet
* SMS Gateway
* Transaction Matcher
* Webhooks
* Notifications
* Telegram
* Tickets
* Admin
* Analytics
* Audit Logs
* System Settings

---

# 3. Domain Structure

Main domain:

`https://steve-pay.ir`

Suggested routes:

## Public

`/`
`/register`
`/login`
`/pay/:invoiceId`
`/pay/:invoiceId/success`
`/pay/:invoiceId/expired`
`/status/:invoiceId`

## Merchant Panel

`/dashboard`
`/dashboard/profile`
`/dashboard/api`
`/dashboard/cards`
`/dashboard/payments`
`/dashboard/invoices`
`/dashboard/wallet`
`/dashboard/transactions`
`/dashboard/webhooks`
`/dashboard/settings`
`/dashboard/setup`
`/dashboard/notifications`
`/dashboard/tickets`
`/dashboard/logs`

## Admin

`/admin`
`/admin/users`
`/admin/users/:id`
`/admin/invoices`
`/admin/transactions`
`/admin/wallets`
`/admin/revenue`
`/admin/tickets`
`/admin/notifications`
`/admin/webhooks`
`/admin/sms`
`/admin/audit-logs`
`/admin/settings`
`/admin/system-health`

## API

`/api/v1/...`

## SMS

`POST /sms`

---

# 4. Merchant Registration

Create a registration form containing:

* Mobile number
* Telegram username OR Telegram user ID
* Job/business type
* Optional business description
* Password
* Confirm password

Do NOT automatically activate new accounts.

New accounts must enter:

`PENDING_APPROVAL`

Admin can:

* Approve
* Reject
* Suspend
* Ban
* Reactivate

When approved:

* Generate API credentials
* Generate merchant ID
* Enable dashboard
* Enable invoice creation
* Send Telegram notification if configured

Store API secrets securely.

Never store raw API secrets in plaintext if avoidable.

Store hashes and only show the full secret once when it is generated/regenerated.

---

# 5. Authentication

Support:

* Merchant login
* Admin login
* Secure password hashing
* Session-based authentication
* Session expiration
* Refresh mechanism if appropriate
* Logout from all devices
* Optional 2FA architecture
* Login rate limiting
* Failed login tracking

Admin accounts must have stronger security requirements.

---

# 6. API Authentication

Every merchant has an API key.

Example:

`X-API-Key: sk_live_xxxxxxxxx`

Support:

* API key rotation
* Revoke API key
* Multiple API keys per merchant if useful
* Last-used timestamp
* Created-at timestamp
* IP usage information
* Environment:

  * live
  * test

Never expose API keys in logs.

Never store raw API keys.

---

# 7. API Endpoints

The initial public API must support:

## makePayment

Create a payment invoice.

Example conceptual request:

```json
{
  "amount": 359000,
  "currency": "IRT",
  "description": "Order #1234",
  "customCallback": "https://merchant.example.com/payment/callback",
  "metadata": {
    "orderId": "1234"
  }
}
```

Response should contain:

```json
{
  "success": true,
  "paymentId": "...",
  "invoiceId": "...",
  "paymentUrl": "https://steve-pay.ir/pay/...",
  "amount": 363706,
  "amountRial": 3637060,
  "currency": "IRT",
  "expiresAt": "...",
  "status": "pending"
}
```

---

## myCards

Return merchant's configured cards.

---

## myStatus

Return:

* merchant status
* account status
* API status
* SMS webhook status
* wallet balance
* fee configuration
* system health relevant to merchant

---

## myWallet

Return:

* current balance
* total deposits
* total fees
* total withdrawals if implemented
* available balance
* reserved balance

---

## transactionsCount

Return transaction statistics.

Support filters:

* today
* yesterday
* last 7 days
* last 30 days
* custom date range
* successful
* pending
* expired
* failed

---

# 8. Payment Invoice

Route:

`/pay/:invoiceId`

The payment page must be mobile-first.

Display:

* Merchant name
* Merchant logo if configured
* Payment description
* Bank card
* Card holder/card name
* Card number
* Copy card button
* Unique amount in Toman
* Unique amount in Rial
* Countdown timer
* Custom merchant message
* Payment status
* Support/contact information

Clicking the card number must copy it to clipboard.

Copy buttons should provide visual feedback.

---

# 9. Merchant Bank Cards

Merchant can add multiple cards.

Each card contains:

* Card ID
* Card number
* Card title/name
* Bank name
* Card holder
* Active/inactive
* Display order

Merchant can choose which cards are available for payment.

Merchant can define the default card.

Allow multiple cards so future load balancing can be implemented.

Validate Iranian card number format using the standard checksum algorithm.

Do not store unnecessary sensitive data.

---

# 10. Payment Fee System

Default gateway fee:

`3000 Toman`

The merchant can choose:

### Mode A — Customer pays the fee

The fee is added to the invoice amount.

Example:

Original amount:

`359000`

Fee:

`3000`

Base amount:

`362000`

Then generate a unique payment amount.

Example:

`363706`

Rial:

`3637060`

### Mode B — Merchant pays the fee

Customer pays only the original amount plus the unique suffix.

The `3000 Toman` fee is deducted from the merchant wallet when the transaction is successfully confirmed.

The system must never accidentally charge the fee twice.

Store:

* original amount
* gateway fee
* customer fee
* merchant fee
* final payable amount
* received amount
* merchant net amount

All financial calculations must use integer arithmetic.

Never use floating point for money.

---

# 11. Unique Payment Amount Algorithm

This is a critical feature.

Every active invoice must receive a unique payment amount.

The generated amount:

* Must never be lower than the required base amount
* Must be unique among relevant active/pending invoices
* Must contain a 3 or 4 digit unique suffix
* Must be generated server-side
* Must be collision-safe
* Must be transaction-safe
* Must not reuse an active amount
* Must expire when the invoice expires

Example:

Original:

`359000`

Customer fee:

`3000`

Base:

`362000`

Possible unique amount:

`363706`

Rial:

`3637060`

The algorithm can work conceptually like:

```text
baseAmount = originalAmount + applicableFee

baseRounded = round base amount appropriately

generate random suffix between configured minimum/maximum

uniqueAmount = baseAmount + suffix

verify that uniqueAmount is not currently assigned to another active invoice

if collision:
    generate another suffix

repeat until unique

persist atomically
```

Do not rely only on application-level checks.

Add a database uniqueness strategy where appropriate.

The algorithm must remain safe under concurrent requests.

Do not allow two simultaneous API requests to accidentally receive the same amount.

Make the unique suffix configurable:

* 3 digits
* 4 digits

Default to 4 digits.

Allow system administrators to configure this.

---

# 12. Invoice Expiration

Merchant can configure invoice expiration between:

`15 minutes`

and

`60 minutes`

Allow only predefined safe values or a validated range.

When invoice expires:

* Mark it `expired`
* Unique amount becomes reusable only according to safe reuse rules
* Customer cannot complete the invoice normally
* Late SMS must not automatically confirm the expired invoice
* Late payments must enter a manual-review state

---

# 13. Payment State Machine

Implement a strict state machine.

Possible states:

```text
CREATED
PENDING
PAYMENT_DETECTED
CONFIRMING
PAID
FAILED
EXPIRED
CANCELLED
MANUAL_REVIEW
REFUNDED
```

Do not allow arbitrary status transitions.

Every transition must be logged.

---

# 14. SMS Forwarder Integration

The merchant configures an SMS Forwarder application.

The application sends bank SMS messages to:

`POST https://steve-pay.ir/sms`

Authentication must use the merchant API key.

Example:

```http
POST /sms
X-API-Key: sk_live_xxxxxxxxx
Content-Type: application/json
```

Example body:

```json
{
  "message": "..."
}
```

Support additional metadata when available:

```json
{
  "message": "...",
  "sender": "...",
  "receivedAt": "...",
  "deviceId": "..."
}
```

The server must validate:

* API key
* merchant status
* request format
* rate limit
* timestamp if available
* duplicate SMS

Never trust client-provided transaction status.

---

# 15. SMS Test Pipeline

Merchant dashboard must have a setup page.

Steps:

1. Merchant enters/configures API key in SMS Forwarder
2. Merchant activates webhook
3. System generates a test token/message
4. SMS Forwarder sends the test payload
5. Server recognizes the test payload
6. Server confirms that the SMS pipeline works
7. Dashboard shows:

`SMS Pipeline: Connected`

If it fails:

`SMS Pipeline: Not Connected`

The test request must never create a real transaction or affect wallet balance.

---

# 16. Full Pipeline Test

Create a "Test Pipeline" button.

This test must simulate:

1. Invoice creation
2. Fee calculation
3. Unique amount generation
4. Payment page creation
5. SMS payload reception
6. Transaction matching
7. Callback execution

But:

* No real wallet deduction
* No real financial transaction
* No real merchant balance change
* Clearly mark all test data
* Automatically clean test records where appropriate

---

# 17. SMS Parsing Engine

Do NOT hardcode one SMS format.

Build a parser abstraction.

Example:

```text
SmsParser
 ├── BankParserA
 ├── BankParserB
 ├── BankParserC
 └── GenericParser
```

The parser should try to extract:

* Amount
* Currency
* Transaction/reference number
* Destination card if present
* Source card if present
* Sender
* Date/time
* Balance if present
* Bank/provider
* Raw message

Normalize Persian/Arabic digits to English digits.

Normalize:

* تومان
* ریال
* Toman
* Rial

The system must be able to convert Rial ↔ Toman safely.

Keep the original SMS untouched for auditing.

---

# 18. Transaction Matching

When an SMS arrives:

1. Authenticate merchant
2. Parse SMS
3. Normalize amount
4. Find matching pending invoices
5. Compare:

   * unique amount
   * merchant
   * destination card if available
   * payment window
   * transaction/reference number
6. Check whether the SMS has already been processed
7. Check whether the invoice has already been paid
8. Confirm only when matching rules pass
9. Otherwise move to `MANUAL_REVIEW`

Never process the same bank transaction twice.

Implement idempotency.

Use:

* SMS hash
* bank reference number when available
* merchant ID
* amount
* timestamp

to detect duplicates.

---

# 19. Suspicious Payment Protection

Create a risk/scoring layer.

Examples of suspicious cases:

* Same SMS received multiple times
* Amount matches but invoice expired
* Multiple invoices have suspiciously similar values
* SMS timestamp is outside allowed window
* Unknown sender
* Unsupported bank format
* Already-used bank reference
* Amount mismatch
* Merchant/card mismatch

Suspicious transactions must go to:

`MANUAL_REVIEW`

instead of automatically marking them as paid.

Admin can manually review and resolve them.

---

# 20. Merchant Callback

After successful confirmation, send a callback to:

1. Merchant's `customCallback`, if supplied
2. Otherwise merchant's configured default callback

Example:

```json
{
  "event": "payment.success",
  "paymentId": "...",
  "invoiceId": "...",
  "merchantId": "...",
  "status": "paid",
  "amount": 363706,
  "originalAmount": 359000,
  "fee": 3000,
  "currency": "IRT",
  "paidAt": "...",
  "referenceId": "...",
  "metadata": {}
}
```

Callback must be signed.

Use HMAC signature.

Example headers:

```text
X-StevePay-Signature
X-StevePay-Event
X-StevePay-Timestamp
X-StevePay-Delivery
```

The merchant must be able to verify the callback.

Implement:

* retry mechanism
* exponential backoff
* delivery logs
* response status
* timeout
* maximum retry count
* manual retry from dashboard

Do not block payment confirmation because a callback fails.

Payment confirmation and callback delivery must be separate concerns.

---

# 21. Webhook Security

For all outgoing webhooks:

Use:

```text
HMAC-SHA256
```

Include timestamp and delivery ID.

Reject replayed requests.

For incoming SMS:

* API authentication
* rate limiting
* optional IP allowlist
* request signature if supported by SMS Forwarder
* timestamp validation
* body size limits

Never log API secrets or webhook secrets.

---

# 22. Wallet System

Each merchant has a wallet.

Wallet fields:

* balance
* available balance
* reserved balance
* total deposited
* total fees paid
* total manual adjustments

Wallet must use an immutable ledger.

Do NOT simply update a balance without recording the reason.

Create:

`wallet_ledger`

with:

* id
* merchantId
* type
* amount
* balanceBefore
* balanceAfter
* reference
* description
* createdAt
* createdBy

Types:

```text
DEPOSIT
WITHDRAWAL
PAYMENT_FEE
REFUND
ADMIN_CREDIT
ADMIN_DEBIT
ADJUSTMENT
REVERSAL
```

---

# 23. Invoice Creation Wallet Protection

If merchant wallet balance is insufficient:

Do NOT create the invoice.

Return an appropriate API error.

Example:

```json
{
  "success": false,
  "code": "INSUFFICIENT_WALLET_BALANCE",
  "message": "Insufficient wallet balance"
}
```

Send Telegram notification:

```text
❌ Invoice creation failed

Invoice: #...
Reason: Insufficient wallet balance
Required: ...
Available: ...

Please recharge your wallet.
```

The exact notification text should be configurable.

---

# 24. Low Balance Warning

When wallet balance becomes less than:

`10000 Toman`

send a Telegram warning.

The message should communicate that the current balance is approximately enough for 3 invoices.

Do not hardcode "3 invoices" if the actual fee calculation means otherwise.

Calculate the estimated number of fee-covered invoices dynamically.

Avoid notification spam.

Implement notification cooldown / deduplication.

---

# 25. Telegram Bot

Create a Telegram bot integration.

Use it for:

* account approval notification
* account rejection notification
* invoice creation failure
* low wallet balance
* successful payment
* failed payment
* suspicious transaction
* webhook failure
* system alerts
* ticket notifications
* admin alerts

Merchant can configure Telegram username/user ID during registration.

For security, verify Telegram ownership through a verification flow.

Do not blindly trust a Telegram username supplied by the user.

---

# 26. Merchant Dashboard

Dashboard should be modern, dark, glassmorphism/cyber-premium style.

Prefer:

* dark UI
* glass panels
* subtle gradients
* neon accents
* clean charts
* responsive layout
* mobile support
* Persian RTL support
* Vazirmatn font

Dashboard overview should show:

* Wallet balance
* Today's revenue
* Today's successful transactions
* Pending invoices
* Expired invoices
* Success rate
* Total fees
* SMS pipeline status
* Webhook status
* API status
* Recent transactions
* Recent invoices

---

# 27. Merchant Payment Settings

Merchant can configure:

* Customer pays fee / merchant pays fee
* Default invoice expiration
* Default payment card
* Active payment cards
* Default callback URL
* Webhook secret
* Custom payment page message
* Merchant display name
* Logo
* Support contact
* Telegram notifications
* Notification preferences

---

# 28. Admin Dashboard

Admin dashboard must provide a complete operational overview.

Show:

* Total merchants
* Pending registrations
* Active merchants
* Suspended merchants
* Total invoices
* Today's invoices
* Successful payments
* Pending payments
* Expired payments
* Manual review count
* Total processed volume
* Total gateway fees
* Wallet deposits
* Failed callbacks
* SMS pipeline errors
* System health

Use real-time or near-real-time updates where practical.

---

# 29. Admin User Management

Admin can:

* approve merchant
* reject merchant
* suspend merchant
* ban merchant
* reactivate merchant
* reset account
* rotate API key
* revoke API key
* view wallet
* manually credit wallet
* manually debit wallet
* view transactions
* view invoices
* view webhook logs
* view login/activity logs
* send notification
* open merchant support view

Every sensitive admin action must be logged.

---

# 30. Admin Wallet Management

Admin can manually:

* increase wallet
* decrease wallet

Require:

* amount
* reason
* admin identity
* timestamp
* reference

Never allow silent balance modifications.

Every manual change must create a wallet ledger entry and audit log.

---

# 31. Revenue Reports

Create a complete revenue section.

Reports:

* Total fees
* Fees today
* Fees this week
* Fees this month
* Fees by merchant
* Fees by day
* Fees by payment method
* Customer-paid fees
* Merchant-paid fees
* Wallet deposits
* Manual adjustments

Charts:

* Daily revenue
* Monthly revenue
* Transaction volume
* Success/failure ratio

Allow CSV export.

---

# 32. Transaction Reports

Provide filters:

* merchant
* date
* status
* amount
* invoice ID
* payment ID
* bank reference
* card
* SMS source
* manual/automatic confirmation

Admin should be able to inspect the complete lifecycle of a transaction.

---

# 33. Real-Time Invoice Monitor

Create an admin page that continuously displays:

* invoice ID
* merchant
* original amount
* fee
* unique payable amount
* payment card
* creation time
* expiration
* current status
* SMS match status
* reference ID

Use polling or WebSocket/SSE only where appropriate for Cloudflare compatibility.

---

# 34. Tickets / Support Chat

Create a ticket system.

Merchant can:

* create ticket
* choose category
* set subject
* send messages
* upload safe attachments if implemented
* close ticket

Admin can:

* reply
* assign ticket
* change priority
* change status
* close/reopen

Statuses:

```text
OPEN
IN_PROGRESS
WAITING_FOR_USER
WAITING_FOR_ADMIN
RESOLVED
CLOSED
```

Make the UI feel like a chat application.

Send Telegram notification when a ticket receives a new reply.

---

# 35. Notifications

Create notification center.

Admin can send:

### Broadcast

To all active merchants.

### Targeted

To a specific merchant.

Notification fields:

* title
* message
* type
* priority
* createdAt
* readAt

Types:

```text
INFO
SUCCESS
WARNING
ERROR
SYSTEM
PAYMENT
SECURITY
```

Allow notification history.

---

# 36. Audit Logs

Everything sensitive must be auditable.

Log:

* login
* logout
* failed login
* API key creation
* API key rotation
* API key revoke
* merchant approval
* merchant rejection
* suspension
* wallet changes
* payment status changes
* manual transaction review
* callback retry
* settings changes
* card changes
* admin actions

Audit records must be append-only from the application perspective.

---

# 37. Webhook Logs

Create a dedicated webhook log system.

Store:

* delivery ID
* merchant
* event
* URL
* request timestamp
* response status
* response body preview
* duration
* retry count
* next retry time
* success/failure

Never store secrets.

Provide a "Retry" button in admin/merchant dashboard where appropriate.

---

# 38. API Idempotency

`makePayment` must support:

```http
Idempotency-Key: ...
```

If the same merchant sends the same idempotency key again:

Return the original payment instead of creating a second invoice.

This is mandatory for production reliability.

---

# 39. API Rate Limiting

Implement per-merchant rate limits.

Different limits for:

* authentication
* makePayment
* SMS webhook
* public invoice pages
* admin API

Return:

```http
429 Too Many Requests
```

with useful retry information.

---

# 40. Security

Implement:

* CSRF protection where applicable
* XSS protection
* SQL injection protection
* strict input validation
* schema validation
* rate limiting
* secure headers
* CSP
* HSTS
* secure cookies
* session expiration
* password hashing
* API key hashing
* webhook signing
* replay protection
* audit logging
* authorization checks
* admin permission checks

Never trust:

* client-side amount
* client-side invoice status
* client-side merchant identity
* client-side fee
* client-side wallet balance

The server must calculate all financial values.

---

# 41. Database Design

Design a proper normalized schema.

At minimum consider:

```text
users
admins
merchant_profiles
api_keys
sessions
bank_cards
invoices
payments
transactions
sms_messages
sms_parser_results
wallets
wallet_ledger
webhook_endpoints
webhook_deliveries
notifications
notification_reads
tickets
ticket_messages
audit_logs
login_attempts
idempotency_keys
system_settings
telegram_links
test_runs
```

Add appropriate indexes.

Important unique constraints:

* API key identifier
* invoice ID
* payment ID
* active unique payment amount
* idempotency key per merchant
* webhook delivery ID
* bank reference where appropriate

Use foreign keys and cascading behavior carefully.

---

# 42. Money Representation

Never use floating-point numbers.

Store all money as integer Toman units.

For Rial:

```text
rial = toman * 10
```

Use explicit fields or currency metadata.

Never perform financial calculations using JavaScript floating-point arithmetic.

---

# 43. API Error System

Create standardized errors.

Example:

```json
{
  "success": false,
  "code": "INVOICE_EXPIRED",
  "message": "This invoice has expired",
  "requestId": "..."
}
```

Include:

* HTTP status
* machine-readable code
* human-readable message
* request ID

Never expose stack traces in production.

---

# 44. Request IDs

Every request must receive a request ID.

Example:

`req_01J...`

Include it in:

* logs
* API response
* errors
* webhook logs
* admin debugging

---

# 45. Observability

Create structured logs.

Track:

* request latency
* API errors
* SMS processing failures
* transaction matching failures
* callback failures
* wallet errors
* database errors

Create an admin health page.

Health checks:

```text
Database
API
SMS Pipeline
Telegram
Webhook Delivery
Queue
Cron
```

---

# 46. Merchant Setup Wizard

Create a setup wizard.

Steps:

### Step 1

Account status

### Step 2

API key

### Step 3

Bank card

### Step 4

Payment settings

### Step 5

Callback URL

### Step 6

SMS Forwarder

### Step 7

Test SMS pipeline

### Step 8

Full pipeline test

At the end:

```text
Steve Pay is ready.
```

Show a setup completion percentage.

---

# 47. Developer API Documentation

Create:

`/docs/api`

Documentation must include:

* Authentication
* makePayment
* myCards
* myStatus
* myWallet
* transactionsCount
* Webhooks
* Callback verification
* Error codes
* Idempotency
* Examples
* Test mode

Provide copyable examples for:

* JavaScript
* PHP
* Python
* cURL

---

# 48. Sandbox/Test Mode

Implement a test environment.

Test API keys:

`sk_test_...`

Live:

`sk_live_...`

Test invoices must never affect real wallet balance.

Test SMS messages must never confirm live invoices.

Clearly mark test pages:

`TEST MODE`

---

# 49. Payment Page UX

Payment page should be extremely simple.

Structure:

```text
Merchant
↓
Description
↓
Bank Card
[ COPY CARD NUMBER ]
↓
Amount
[ 363,706 تومان ]
[ 3,637,060 ریال ]
↓
COPY AMOUNT
↓
Remaining Time
09:42
↓
Merchant Custom Message
↓
Payment Status
```

Use polished modern glassmorphism.

Mobile-first.

Fast loading.

Do not put unnecessary content on the payment page.

---

# 50. Payment Success Page

After successful confirmation:

Show:

* Payment successful
* Amount
* Payment ID
* Reference number
* Merchant
* Time
* Transaction status

If merchant callback redirects to a return URL, handle it securely.

Do not trust arbitrary redirect URLs without validation/configuration.

---

# 51. Failure / Expired Page

Show:

* Invoice expired
* Payment failed
* Already paid
* Payment under review

with clear explanations.

---

# 52. Automatic Transaction Confirmation

The intended flow:

```text
Merchant
   ↓
makePayment
   ↓
Steve Pay
   ↓
Generate unique amount
   ↓
Create invoice
   ↓
Customer opens payment page
   ↓
Customer transfers exact amount
   ↓
Bank sends SMS
   ↓
SMS Forwarder
   ↓
POST /sms
   ↓
Authenticate merchant
   ↓
Parse SMS
   ↓
Normalize amount
   ↓
Find matching invoice
   ↓
Risk checks
   ↓
Confirm transaction
   ↓
Update wallet/transaction state
   ↓
Send merchant callback
   ↓
Send Telegram notification
   ↓
Customer sees success
```

---

# 53. Important Race Conditions

Handle these carefully:

* Two SMS messages arriving simultaneously
* Two API requests creating invoices simultaneously
* Same SMS sent twice
* Two invoices with similar amounts
* Payment arriving just before expiration
* Callback retry after successful callback
* Admin manually confirming while automatic processor is confirming
* Wallet balance changing during invoice creation

Use database transactions / atomic operations wherever supported.

---

# 54. Manual Review System

Create a powerful manual review page.

For each suspicious payment show:

* Raw SMS
* Parsed SMS
* Invoice
* Expected amount
* Received amount
* Merchant
* Card
* Timestamp
* Matching score/reasons
* Bank reference
* Previous processing attempts

Admin actions:

* Confirm
* Reject
* Link to invoice
* Mark duplicate
* Ignore
* Add note

---

# 55. Smart Matching

Create a matching engine rather than hardcoding a single `amount == invoice.amount` condition.

Use matching signals:

```text
amount
merchant
card
time window
bank reference
sender
transaction uniqueness
SMS hash
invoice state
```

Make the rules configurable.

For example:

```text
EXACT_AMOUNT = required
INVOICE_ACTIVE = required
DUPLICATE_REFERENCE = forbidden
TIME_WINDOW = required
CARD_MATCH = preferred
```

---

# 56. Database Migrations

Use proper migrations.

Never manually modify production schema.

Include:

* initial migration
* incremental migrations
* seed data
* development admin account setup
* test fixtures

---

# 57. Environment Variables

Create `.env.example`.

Potential variables:

```text
DATABASE
SESSION_SECRET
API_KEY_PEPPER
WEBHOOK_SECRET
TELEGRAM_BOT_TOKEN
TELEGRAM_ADMIN_CHAT_ID
TURNSTILE_SECRET
TURNSTILE_SITE_KEY
ENVIRONMENT
BASE_URL
```

Never commit secrets.

---

# 58. Cloudflare Deployment

Create everything needed for Cloudflare deployment.

Include:

* Wrangler configuration
* D1 bindings
* KV bindings if used
* Queue bindings if used
* environment separation
* development environment
* staging environment
* production environment

Document deployment steps.

---

# 59. Admin Roles

Support role architecture:

```text
SUPER_ADMIN
ADMIN
SUPPORT
FINANCE
VIEWER
```

Permissions should be granular.

For example:

Finance can manage wallets.

Support can manage tickets.

Viewer cannot change anything.

---

# 60. Backup / Recovery

Design the system so that:

* important data is recoverable
* financial ledger is immutable
* destructive actions are minimized
* audit logs survive normal record changes

Provide backup/export tooling where Cloudflare platform limitations require it.

---

# 61. UI Design

The entire dashboard should have a premium cyber-fintech aesthetic.

Use:

* dark background
* glass cards
* subtle glow
* neon blue/purple accents
* clean typography
* rounded cards
* minimal but useful animations
* RTL Persian interface
* responsive design

Avoid overdoing animations.

Performance is more important than visual effects.

Payment page must be extremely lightweight.

---

# 62. Accessibility

Support:

* keyboard navigation
* readable contrast
* accessible buttons
* clear error states
* semantic HTML
* screen-reader friendly labels

---

# 63. Performance

Optimize for:

* Cloudflare edge latency
* low JavaScript bundle size
* lazy loading
* database indexes
* caching of safe public data
* minimal API calls
* efficient dashboard queries

Do not introduce a heavy frontend architecture unnecessarily.

---

# 64. Admin Analytics

Add advanced analytics:

* hourly payment volume
* daily payment volume
* merchant growth
* transaction success rate
* SMS matching success rate
* manual review percentage
* callback success rate
* wallet revenue
* average invoice amount
* average time-to-payment
* expired invoice percentage

---

# 65. Merchant Analytics

Merchant dashboard should show:

* today's payments
* total payments
* successful payments
* pending
* expired
* total volume
* total fees
* net received
* success rate
* average payment time

---

# 66. Smart Notifications

Avoid notification spam.

Implement:

* notification deduplication
* cooldown
* severity
* per-user notification preferences

Example:

Do not send the same low-balance notification every time an invoice is created.

---

# 67. Security Events

Detect:

* repeated failed API authentication
* unusual SMS volume
* suspicious API usage
* excessive invoice creation
* repeated callback failures
* unusual login activity

Create security alerts for admins.

---

# 68. Data Privacy

Do not expose:

* raw API keys
* webhook secrets
* passwords
* unnecessary SMS data
* private merchant information

Minimize sensitive information in logs.

---

# 69. Testing

Write comprehensive tests.

At minimum:

### Unit tests

* money conversion
* fee calculation
* unique amount generation
* card validation
* SMS digit normalization
* SMS parsing
* matching engine
* wallet calculations
* state transitions

### Integration tests

* registration
* admin approval
* API authentication
* invoice creation
* wallet insufficient balance
* SMS webhook
* payment confirmation
* callback
* webhook retry
* Telegram notification

### Security tests

* unauthorized API access
* invalid API key
* replay attack
* duplicate SMS
* duplicate idempotency key
* SQL injection
* XSS
* privilege escalation

### Load/concurrency tests

Especially test:

```text
100 simultaneous makePayment requests
100 simultaneous SMS webhook requests
```

Make sure duplicate unique payment amounts cannot occur.

---

# 70. Developer Experience

Create:

```text
README.md
ARCHITECTURE.md
API.md
DATABASE.md
SECURITY.md
DEPLOYMENT.md
SMS_PARSERS.md
WEBHOOKS.md
TESTING.md
```

Explain important architectural decisions.

---

# 71. Code Quality

Follow:

* strict TypeScript
* modular architecture
* typed API contracts
* schema validation
* reusable services
* repository/data-access layer where useful
* service layer
* centralized error handling
* centralized logging
* no duplicated financial logic

Never put business logic directly inside UI components.

---

# 72. Important Financial Rules

These rules are non-negotiable:

1. Never use floating-point money calculations.
2. Never trust client-provided fee calculations.
3. Never trust client-provided invoice status.
4. Never confirm the same transaction twice.
5. Never deduct the same fee twice.
6. Never modify wallet balance without ledger entry.
7. Never delete financial records casually.
8. Never expose API secrets.
9. Never allow duplicate active payment amounts.
10. Never allow an expired invoice to be automatically paid without explicit rules.
11. Never let callback failure reverse a successful payment.
12. Never allow race conditions to create duplicate payments.

---

# 73. Suggested Extra Features

Add these if they fit the architecture without overcomplicating the MVP:

### Merchant API statistics

Show:

* requests/minute
* error rate
* callback success rate

### API key scopes

Example:

```text
payments:create
payments:read
transactions:read
wallet:read
```

### IP allowlist

Optional per API key.

### Maintenance mode

Admin can temporarily disable invoice creation.

### Global fee configuration

Admin can change default gateway fee.

### Per-merchant fee configuration

Admin can override fee for a specific merchant.

### Dynamic fee support

Prepare architecture for percentage + fixed fee:

```text
fixedFee = 3000
percentageFee = 0
```

Do not necessarily enable percentage fees in MVP.

### Card rotation

Allow system to rotate payment cards according to merchant configuration.

### Webhook event subscriptions

Allow merchants to subscribe to:

```text
payment.created
payment.pending
payment.success
payment.failed
payment.expired
payment.manual_review
wallet.low_balance
```

---

# 74. Important UX Detail

When a customer opens an invoice, the system should clearly explain:

> مبلغ دقیق نمایش داده‌شده را دقیقاً به همان مقدار واریز کنید.

Do not confuse users between Rial and Toman.

Make the Toman amount prominent.

Show Rial as secondary.

---

# 75. API Example

The API should eventually support something like:

```http
POST /api/v1/payments
X-API-Key: sk_live_xxx
Idempotency-Key: order_123
Content-Type: application/json
```

```json
{
  "amount": 359000,
  "description": "Order #123",
  "customCallback": "https://example.com/payment/callback",
  "metadata": {
    "orderId": "123",
    "userId": "456"
  }
}
```

Response:

```json
{
  "success": true,
  "payment": {
    "id": "pay_xxx",
    "invoiceId": "inv_xxx",
    "status": "pending",
    "originalAmount": 359000,
    "fee": 3000,
    "payableAmount": 363706,
    "payableAmountRial": 3637060,
    "paymentUrl": "https://steve-pay.ir/pay/inv_xxx",
    "expiresAt": "..."
  }
}
```

---

# 76. Implementation Strategy

Do not try to implement everything as one giant unstructured change.

First analyze the existing repository.

Then:

### Phase 1

Architecture + database + migrations

### Phase 2

Authentication + merchant registration + admin approval

### Phase 3

Wallet + ledger + fee engine

### Phase 4

Cards + invoice engine + unique amount engine

### Phase 5

Payment page

### Phase 6

SMS webhook + parser engine

### Phase 7

Transaction matching + automatic confirmation

### Phase 8

Merchant callbacks + webhook delivery system

### Phase 9

Telegram bot + notifications

### Phase 10

Merchant dashboard

### Phase 11

Admin dashboard

### Phase 12

Tickets + support

### Phase 13

Analytics + reporting

### Phase 14

Security hardening

### Phase 15

Tests

### Phase 16

Cloudflare deployment

---

# 77. Critical Instruction for the Agent

Before writing code:

1. Inspect the entire repository.
2. Identify existing framework and architecture.
3. Do not blindly replace an existing project.
4. Reuse useful existing code.
5. Identify missing pieces.
6. Create an implementation plan.
7. Explain the database schema.
8. Explain the API architecture.
9. Explain security architecture.
10. Then implement.

Do not stop at creating a roadmap.

Actually implement the system.

After each major phase:

* run tests
* run type checking
* run linting
* fix errors
* verify migrations
* verify Cloudflare compatibility

Do not leave TODO placeholders for core functionality.

---

# 78. Final Acceptance Criteria

The system is considered complete only when this complete scenario works:

```text
User registers
↓
Admin receives registration
↓
Admin approves user
↓
API key generated
↓
Merchant logs in
↓
Merchant adds bank card
↓
Merchant configures fee mode
↓
Merchant configures expiration
↓
Merchant configures callback
↓
Merchant configures SMS Forwarder
↓
SMS test succeeds
↓
Full pipeline test succeeds
↓
Merchant calls makePayment
↓
Wallet is checked
↓
Fee is calculated
↓
Unique amount is generated
↓
Invoice is created
↓
Customer opens payment page
↓
Customer sees card + exact amount + countdown
↓
Customer pays
↓
Bank SMS arrives
↓
SMS Forwarder sends POST /sms
↓
SMS is authenticated
↓
SMS parser extracts transaction
↓
Matching engine finds invoice
↓
Duplicate/risk checks pass
↓
Payment becomes PAID
↓
Merchant fee is processed if applicable
↓
Wallet ledger is updated
↓
Merchant callback is sent
↓
Callback is signed
↓
Telegram notification is sent
↓
Customer sees successful payment
↓
Admin sees transaction in real-time
↓
All actions exist in audit logs
```

Build the project so this flow is reliable under concurrent requests and real production traffic.

---

# 79. Final Deliverables

At the end provide:

1. Complete source code
2. Database schema
3. All migrations
4. Seed scripts
5. API documentation
6. Cloudflare configuration
7. Environment variable documentation
8. Deployment instructions
9. Security documentation
10. SMS parser documentation
11. Webhook documentation
12. Test suite
13. Example API clients
14. Admin credentials setup instructions
15. Production checklist

Before declaring completion, verify:

```text
npm/bun/pnpm install
typecheck
lint
test
build
Cloudflare build
database migrations
```

Everything must work in production mode.

Do not declare the project finished if core features are mocked or simulated.

If an external dependency is required, clearly identify it and implement the integration boundary cleanly.

The final result should feel like a real commercial payment gateway, not a CRUD dashboard.