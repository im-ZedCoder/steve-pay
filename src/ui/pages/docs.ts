/**
 * API reference.
 *
 * The audience is a developer who has an API key and needs their first payment to
 * confirm. So the page is ordered by that journey — authenticate, create an invoice,
 * forward the bank SMS, verify the webhook — and the reference tables (error codes,
 * limits, events) sit at the end where they are looked up rather than read.
 *
 * Two rules hold throughout:
 *
 *   1. **Every figure here comes from the code, not from memory.** Status codes are the
 *      ones in `ERROR_SPECS`, the retry schedule is `WEBHOOK_BACKOFF_MINUTES`, the
 *      signature is the exact string `signWebhook` builds. A reference that drifts from
 *      the implementation is worse than no reference, because it is trusted.
 *
 *   2. **Every claim about a hard case is stated.** That a bank SMS is evidence rather
 *      than an instruction, that `receivedAt` is not trusted, that a duplicate forward is
 *      harmless, that the payment page shows the bank's own words. These are the things
 *      an integrator will otherwise discover from a support ticket.
 */

import { toPersianDigits } from '../../core/digits';
import {
  codeBlock,
  docsNote,
  docsSection,
  docsShell,
  endpoint,
  stepList,
} from '../layout';

// ---------------------------------------------------------------------------
// Small local renderers
// ---------------------------------------------------------------------------

/** The mono syntax spans. Local, so each language's class names live in one place. */
const span = (cls: string) => (text: string | number): string => `<span class="${cls}">${text}</span>`;
const K = span('k');
const S = span('s');
const N = span('n');
const C = span('c');
const P = span('p');

/** A reference table. Cells are literals from this file; none come from a request. */
function table(headers: string[], rows: string[][]): string {
  return `<div class="table-wrap docs-table"><table>
<thead><tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr></thead>
<tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
    .join('')}</tbody>
</table></div>`;
}

/**
 * The error table.
 *
 * Status comes from `ERROR_SPECS` — quoted here rather than imported, because the table is
 * prose about the contract and an import would silently rewrite the documentation when a
 * status changed. A change to a status code is a change to the contract, and the reference
 * should have to be edited deliberately.
 */
function errorTable(rows: Array<[code: string, status: number, meaning: string]>): string {
  return table(
    ['کد', 'HTTP', 'معنی'],
    rows.map(([code, status, meaning]) => [
      `<code>${code}</code>`,
      `<span class="mono num">${status}</span>`,
      meaning,
    ]),
  );
}

const code = (value: string): string => `<code>${value}</code>`;
const mono = (value: string): string => `<span class="mono">${value}</span>`;

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

const REQUEST = `{
  ${P('"amount"')}: ${N('359000')},                    ${C('// تومان — مبلغ سفارش، عدد صحیح')}
  ${P('"description"')}: ${P('"سفارش ۱۲۳۴"')},          ${C('// روی صفحه پرداخت دیده می‌شود')}
  ${P('"customCallback"')}: ${P('"https://shop.example.com/pay/cb"')},
  ${P('"returnUrl"')}: ${P('"https://shop.example.com/orders/1234"')},
  ${P('"metadata"')}: { ${P('"orderId"')}: ${P('"1234"')} },      ${C('// در وب‌هوک برمی‌گردد')}
  ${P('"expiresInMinutes"')}: ${N('30')},
  ${P('"feeMode"')}: ${P('"CUSTOMER"')},               ${C('// چه کسی کارمزد را می‌دهد')}
  ${P('"cardId"')}: ${P('"card_01J8XK..."')}           ${C('// اختیاری')}
}`;

const RESPONSE = (origin: string) => `{
  ${P('"success"')}: ${N('true')},
  ${P('"paymentId"')}: ${P('"pay_01J8XK4M2Q"')},
  ${P('"invoiceId"')}: ${P('"inv_01J8XK4M2Q"')},
  ${P('"paymentUrl"')}: ${P(`"${origin}/pay/inv_01J8XK4M2Q"`)},
  ${P('"amount"')}: ${N('363706')},          ${C('// مبلغ قابل پرداخت، نه مبلغ سفارش')}
  ${P('"amountRial"')}: ${N('3637060')},
  ${P('"status"')}: ${P('"pending"')},
  ${P('"expiresAt"')}: ${P('"2026-09-22T09:41:07.000Z"')},
  ${P('"payment"')}: {
    ${P('"originalAmount"')}: ${N('359000')},     ${C('// همان مبلغی که فرستادید')}
    ${P('"fee"')}: ${N('3000')},
    ${P('"baseAmount"')}: ${N('362000')},       ${C('// originalAmount + fee')}
    ${P('"uniqueSuffix"')}: ${N('1706')},       ${C('// پسوند یکتا')}
    ${P('"payableAmount"')}: ${N('363706')},     ${C('// baseAmount + uniqueSuffix')}
    ${P('"payableAmountRial"')}: ${N('3637060')},
    ${P('"testMode"')}: ${N('false')}
  }
}`;

const CURL = (origin: string) => `${K('curl')} -X POST ${S(`${origin}/api/v1/payments`)} \\
  -H ${S('"X-API-Key: sk_live_<key-id><secret>"')} \\
  -H ${S('"Idempotency-Key: order-1234"')} \\
  -H ${S('"Content-Type: application/json"')} \\
  -d ${P("'")}{ ${P('"amount"')}: ${N('359000')}, ${P('"description"')}: ${P('"سفارش ۱۲۳۴"')} }${P("'")}`;

const SMS_CURL = (origin: string) => `${K('curl')} -X POST ${S(`${origin}/sms`)} \\
  -H ${S('"X-API-Key: sk_live_<key-id><secret>"')} \\
  -H ${S('"Content-Type: application/json"')} \\
  -d ${P("'")}{
    ${P('"message"')}: ${P('"واریز ۳۶۳٬۷۰۶ تومان به کارت 6104337890123456 شماره پیگیری ۸۴۲۱۹۰۳۳۱"')},
    ${P('"sender"')}: ${P('"BANKMELLI"')},
    ${P('"deviceId"')}: ${P('"shop-phone-1"')}
  }${P("'")}`;

const FORWARDER_BODY = `{
  "msg": "{msg}",
  "time": "{time}",
  "filter-name": "{filter-name}",
  "in-number": "{in-number}",
  "in-sim": "{in-sim}"
}`;

const NODE_VERIFY = `${K('const')} crypto = require('node:crypto');

${C('// خام، بدون تغییر: بدنه باید همان بایتی باشد که امضا شده است')}
${K('function')} ${P('verify')}(rawBody, headers, secret) {
  ${K('const')} timestamp = headers['x-stevepay-timestamp'];
  ${K('const')} delivery  = headers['x-stevepay-delivery'];
  ${K('const')} received  = headers['x-stevepay-signature'];   ${C('// "v1=<hex>"')}

  ${K('const')} expected = ${S("'v1='")} + crypto
    .createHmac(${S("'sha256'")}, secret)
    .update(\`\${timestamp}.\${delivery}.\${rawBody}\`)
    .digest(${S("'hex'")});

  ${K('return')} crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}`;

const PHP_VERIFY = `${K('<?php')}
$timestamp = $_SERVER['HTTP_X_STEVEPAY_TIMESTAMP'];
$delivery  = $_SERVER['HTTP_X_STEVEPAY_DELIVERY'];
$received  = $_SERVER['HTTP_X_STEVEPAY_SIGNATURE'];
$raw       = file_get_contents('php://input');   ${C('// خام، بدون json_decode')}

$expected = 'v1=' . hash_hmac('sha256', $timestamp . '.' . $delivery . $raw, $secret);
${K('if')} (!hash_equals($expected, $received)) {
    http_response_code(400);
    ${K('exit')};
}`;

const NODE_FLOW = (origin: string) => `${K('const')} BASE = ${S(`'${origin}/api/v1'`)};
${K('const')} key  = process.env.STEVE_PAY_KEY;

${K('async function')} ${P('createPayment')}(order) {
  ${K('const')} response = ${K('await')} fetch(BASE + ${S("'/payments'")}, {
    method: ${S("'POST'")},
    headers: {
      ${S("'X-API-Key'")}: key,
      ${S("'Content-Type'")}: ${S("'application/json'")},
      ${C('// کلید یکتاسازی از شناسه سفارش خودتان: ارسال دوباره فاکتور دوم نمی‌سازد')}
      ${S("'Idempotency-Key'")}: ${S("'order-'")} + order.id,
    },
    body: JSON.stringify({
      amount: order.total,
      description: ${S("'سفارش '")} + order.number,
      returnUrl: ${S("'https://shop.example.com/orders/'")} + order.id,
      metadata: { orderId: order.id },
    }),
  });

  ${K('if')} (!response.ok) {
    ${K('const')} error = ${K('await')} response.json();
    ${C('// کد خطا پایدار است؛ پیام فارسی است و ممکن است تغییر کند')}
    ${K('throw new')} Error(error.code + ${S("': '")} + error.message);
  }

  ${K('const')} data = ${K('await')} response.json();
  ${C('// همین آدرس را به مشتری بدهید')}
  ${K('return')} data.paymentUrl;
}`;

const RANGES: Array<[string, string]> = [
  ['today', 'از نیمه‌شب به وقت تهران تا الان (پیش‌فرض)'],
  ['yesterday', 'روز کامل قبل، به وقت تهران'],
  ['last7days', 'هفت روز شمسی گذشته'],
  ['last30days', 'سی روز شمسی گذشته'],
  ['custom', 'بازه دلخواه؛ ' + 'from' + ' الزامی است و ' + 'to' + ' اختیاری. هر دو شامل می‌شوند.'],
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function docsPage(input: { origin: string }): string {
  // Every sample below is rendered against the host the reader is on. The platform has
  // no configured base URL, and a documentation page is the worst place for one: a
  // reader who copies an example containing a hostname they do not own gets a DNS
  // failure and no way to tell whether the example or their account is at fault.
  const { origin } = input;

  const baseUrlNote = docsNote(
    `<b>آدرس پایه:</b> ${code(origin)} — همین آدرسی که این صفحه روی آن باز شده است. همه پاسخ‌ها JSON هستند و هر پاسخ، موفق یا ناموفق، هدر ${code('X-Request-Id')} دارد. اگر خطایی دیدید که خودتان حل نکردید، همین شناسه را برای پشتیبانی بفرستید: با آن، لاگ و رکورد ممیزی همان درخواست پیدا می‌شود.`,
  );

  // -------------------------------------------------------------------------
  // Quickstart
  // -------------------------------------------------------------------------
  const quickstart = docsSection({
    id: 'quickstart',
    title: 'شروع سریع',
    body: `${baseUrlNote}
<p>چهار کار تا اولین پرداخت تأییدشده فاصله دارید. ترتیب مهم است: پیامک بانک شاهدِ پرداخت است، پس تا فورواردر وصل نشود هیچ فاکتوری خودکار تأیید نمی‌شود.</p>
${stepList([
  {
    title: 'حساب پذیرنده بسازید',
    body: 'در صفحه <a href="/register">ثبت‌نام</a> شماره موبایل و گذرواژه را وارد کنید. حساب در وضعیت «در انتظار تأیید» ساخته می‌شود و تا تأیید مدیر، درخواست‌های API با کد <code>ACCOUNT_PENDING_APPROVAL</code> رد می‌شوند.',
  },
  {
    title: 'کلید API بگیرید',
    body: 'پس از تأیید، از <a href="/dashboard/api-keys">پنل پذیرنده → کلیدهای API</a> کلید بسازید. کلید یک‌بار و فقط یک‌بار نشان داده می‌شود؛ فقط هش آن ذخیره است. اگر گم شد، همان کلید را بچرخانید.',
  },
  {
    title: 'کارت مقصد را ثبت کنید',
    body: 'در <a href="/dashboard/cards">پنل پذیرنده → کارت‌ها</a> شماره کارتی که پول به آن واریز می‌شود را اضافه کنید. بدون کارت فعال، ساخت فاکتور با کد <code>CARD_REQUIRED</code> رد می‌شود. شماره کارت مشتری هرگز ذخیره نمی‌شود.',
  },
  {
    title: 'فورواردر پیامک را وصل کنید',
    body: 'روی گوشی اندرویدی که پیامک بانک را می‌گیرد، برنامه فورواردر را به <code>POST /sms</code> وصل کنید — <a href="#sms">راهنمای کامل</a>. تا این مرحله انجام نشود، مبلغ واریز می‌شود ولی فاکتور تأیید نمی‌شود.',
  },
])}`,
  });

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------
  const auth = docsSection({
    id: 'auth',
    title: 'احراز هویت',
    body: `<p>کلید را در هدر <code>X-API-Key</code> بفرستید. هدر <code>Authorization: Bearer &lt;key&gt;</code> هم پذیرفته می‌شود، چون بعضی برنامه‌های فورواردر فقط یکی از این دو را می‌توانند تنظیم کنند.</p>
${table(
  ['هدر', 'الزام', 'توضیح'],
  [
    [code('X-API-Key'), 'بله', 'کلید کامل با پیشوند محیط: ' + code('sk_live_…') + ' یا ' + code('sk_test_…')],
    [code('Content-Type'), 'بله', code('application/json')],
    [code('Idempotency-Key'), 'برای پرداخت توصیه‌شده', 'هر رشته یکتا با حداکثر ۲۵۵ نویسه — <a href="#idempotency">کلید یکتاسازی</a>.'],
    [code('Authorization'), 'جانشین', code('Bearer sk_live_…')],
  ],
)}

<h3>شکل کلید</h3>
<p>کلید از پیشوند محیط، یک شناسه ۱۲ نویسه‌ای و یک راز ۳۲ نویسه‌ای ساخته می‌شود: ${code('sk_live_')} به‌علاوه ۴۴ نویسه. کلید کامل تنها در لحظه ساخت نمایش داده می‌شود و در پایگاه‌داده فقط HMAC آن با یک فلفل نگه داشته می‌شود — یعنی حتی مدیر سامانه هم نمی‌تواند کلید شما را بخواند.</p>
${docsNote(
  'اگر کلید در جای عمومی منتشر شد، در پنل روی «چرخش کلید» بزنید. چرخش در یک عملیات، کلید تازه می‌سازد و کلید قدیمی را باطل می‌کند، پس هیچ پنجره‌ای با دو کلید زنده باقی نمی‌ماند.',
)}

<h3>دو محیط</h3>
${table(
  ['پیشوند', 'محیط', 'اثر'],
  [
    [code('sk_live_'), 'عملیاتی', 'فاکتور واقعی می‌سازد و کیف پول را کم می‌کند.'],
    [code('sk_test_'), 'آزمایشی', 'فاکتور با ' + code('testMode: true') + ' ساخته می‌شود، کیف پول دست نمی‌خورد، و پیامک آزمایشی هیچ فاکتور عملیاتی را تأیید نمی‌کند.'],
  ],
)}
${docsNote(
  'فرستادن کلید آزمایشی به مسیر عملیاتی، یا برعکس، با کد <code>API_KEY_ENVIRONMENT_MISMATCH</code> رد می‌شود. عوض‌کردن پیشوند کلید تفاوتی در آن پاسخ ایجاد نمی‌کند؛ چرا که بررسی روی محیط ذخیره‌شده انجام می‌شود، نه روی متن کلید.',
)}

<h3>دسترسی‌ها</h3>
<p>هر کلید فهرست دسترسی مشخصی دارد. اگر کلیدی دسترسی یک اندپوینت را نداشته باشد، پاسخ ${code('INSUFFICIENT_SCOPE')} با کد ۴۰۳ است.</p>
${table(
  ['دسترسی', 'کدام اندپوینت'],
  [
    [code('payments:create'), 'POST /api/v1/payments'],
    [code('payments:read'), 'GET /api/v1/status'],
    [code('transactions:read'), 'GET /api/v1/transactions/count'],
    [code('wallet:read'), 'GET /api/v1/wallet'],
    [code('cards:read'), 'GET /api/v1/cards'],
    [code('sms:write'), 'POST /sms'],
  ],
)}

<p>هر کلید می‌تواند فهرست IP مجاز داشته باشد. اگر فهرست خالی نباشد، درخواست از هر IP دیگری با ${code('IP_NOT_ALLOWED')} رد می‌شود — و این بررسی پیش از هر کار دیگری انجام می‌شود.</p>`,
  });

  // -------------------------------------------------------------------------
  // makePayment
  // -------------------------------------------------------------------------
  const payments = docsSection({
    id: 'payments',
    title: 'ساخت پرداخت',
    body: `${endpoint({ method: 'POST', path: '/api/v1/payments', note: 'payments:create' })}
<p>یک فاکتور می‌سازد و مبلغی یکتا برای آن رزرو می‌کند. پاسخ شامل آدرس صفحه پرداخت است که باید به مشتری بدهید.</p>
${codeBlock({ label: 'REQUEST', note: 'application/json', html: REQUEST })}

<h3>فیلدها</h3>
${table(
  ['فیلد', 'الزام', 'توضیح'],
  [
    [code('amount'), 'بله', 'عدد صحیح به <b>تومان</b>. حداقل ۱٬۰۰۰ و حداکثر ۵۰۰٬۰۰۰٬۰۰۰ به‌صورت پیش‌فرض. عدد اعشاری یا رشته پذیرفته نمی‌شود.'],
    [code('currency'), 'خیر', 'فقط ' + code('IRT') + '. واحد دیگر با ' + code('CURRENCY_NOT_SUPPORTED') + ' رد می‌شود.'],
    [code('description'), 'خیر', 'روی صفحه پرداخت به مشتری نشان داده می‌شود.'],
    [code('customCallback'), 'خیر', 'آدرس وب‌هوک فقط برای همین پرداخت. در محیط عملیاتی باید ' + code('https') + ' باشد.'],
    [code('returnUrl'), 'خیر', 'پس از پرداخت مشتری به این آدرس برمی‌گردد. باید روی دامنه ثبت‌شده خودتان باشد.'],
    [code('metadata'), 'خیر', 'داده دلخواه کلید/مقدار؛ دست‌نخورده در وب‌هوک برمی‌گردد.'],
    [code('expiresInMinutes'), 'خیر', 'بین ۱۵ و ۶۰ دقیقه. خارج از این بازه ' + code('INVALID_EXPIRY') + '.'],
    [code('feeMode'), 'خیر', code('CUSTOMER') + ' (پیش‌فرض) یا ' + code('MERCHANT') + '. تعیین می‌کند کارمزد را چه کسی می‌دهد، نه اینکه چقدر باشد.'],
    [code('cardId'), 'خیر', 'کدام کارت مقصد. اگر نفرستید، کارت پیش‌فرض استفاده می‌شود.'],
  ],
)}
${docsNote(
  '<b>فیلد ناشناخته رد می‌شود، نه نادیده گرفته.</b> اگر <code>ammount</code> بنویسید، درخواست با <code>VALIDATION_FAILED</code> رد می‌شود. جایگزین، ساختن فاکتوری با مبلغ اشتباه بود — و کسی که این اشتباه را می‌فهمید، مشتری بود.',
)}

${codeBlock({ label: 'RESPONSE', note: '200 OK', html: RESPONSE(origin) })}

<h3>چرا مبلغ با مبلغ سفارش یکی نیست</h3>
<p>سه عدد در پاسخ هست و رابطه‌شان همیشه برقرار است:</p>
<div class="docs-note" style="direction:ltr;text-align:center;font-family:var(--mono);font-size:.8rem">
baseAmount + uniqueSuffix = payableAmount<br>
originalAmount + fee = baseAmount
</div>
<p><b>پسوند یکتا</b> همان چیزی است که این فاکتور را از هر فاکتور زنده دیگری جدا می‌کند. یک ایندکس یکتا در پایگاه‌داده تضمین می‌کند در هر لحظه فقط یک فاکتور فعال هر مبلغی را داشته باشد؛ پس اگر دو درخواست همزمان بیایند، یکی پسوند دیگری را نمی‌گیرد. به همین دلیل پسوند در پاسخ برگردانده می‌شود: همان رقمی است که روی صفحه پرداخت و در پیامک بانک باید دیده شود.</p>

<h3>خطاها</h3>
${errorTable([
  ['UNAUTHENTICATED', 401, 'هیچ کلیدی فرستاده نشده'],
  ['INVALID_API_KEY', 401, 'کلید ناشناخته است یا راز آن درست نیست'],
  ['API_KEY_REVOKED', 401, 'کلید باطل شده است'],
  ['API_KEY_EXPIRED', 401, 'مهلت کلید گذشته است'],
  ['API_KEY_ENVIRONMENT_MISMATCH', 401, 'کلید آزمایشی روی مسیر عملیاتی یا برعکس'],
  ['INSUFFICIENT_SCOPE', 403, 'کلید دسترسی ' + mono('payments:create') + ' ندارد'],
  ['IP_NOT_ALLOWED', 403, 'درخواست از خارج فهرست IP کلید آمده است'],
  ['ACCOUNT_PENDING_APPROVAL', 403, 'حساب در انتظار تأیید مدیر است'],
  ['ACCOUNT_SUSPENDED', 403, 'حساب معلق شده است'],
  ['ACCOUNT_BANNED', 403, 'حساب مسدود شده است'],
  ['VALIDATION_FAILED', 422, 'فیلدی ناقص، بدشکل، یا ناشناخته بود'],
  ['INVALID_AMOUNT', 400, 'مبلغ عدد صحیح به تومان نبود'],
  ['AMOUNT_BELOW_MINIMUM', 400, 'کمتر از حداقل مجاز'],
  ['AMOUNT_ABOVE_MAXIMUM', 400, 'بیشتر از حداکثر مجاز'],
  ['CURRENCY_NOT_SUPPORTED', 400, 'واحد پول پشتیبانی نمی‌شود'],
  ['INVALID_FEE_MODE', 400, mono('CUSTOMER') + ' یا ' + mono('MERCHANT') + ' نبود'],
  ['INVALID_EXPIRY', 400, 'مدت اعتبار خارج از بازه مجاز بود'],
  ['CARD_REQUIRED', 409, 'هیچ کارت مقصد فعالی ثبت نشده است'],
  ['INSUFFICIENT_WALLET_BALANCE', 402, 'حالت کارمزد ' + mono('MERCHANT') + ' است و موجودی کیف پول کافی نیست'],
  ['IDEMPOTENCY_CONFLICT', 409, 'همین کلید با بدنه دیگری استفاده شده است'],
  ['AMOUNT_SPACE_EXHAUSTED', 503, 'همه پسوندهای فضای مبلغ در این لحظه اشغال است'],
  ['MAINTENANCE_MODE', 503, 'ساخت فاکتور توسط مدیر غیرفعال شده است'],
  ['RATE_LIMITED', 429, 'محدودیت نرخ؛ هدر ' + mono('Retry-After') + ' را ببینید'],
  ['DATABASE_ERROR', 500, 'خطای داخلی. با همان کلید یکتاسازی دوباره تلاش کنید'],
])}`,
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------
  const idempotency = docsSection({
    id: 'idempotency',
    title: 'یکتاسازی درخواست',
    body: `<p>کلید یکتاسازی از شناسه سفارش خودتان بسازید — نه یک رشته تصادفی. اگر پاسخ گم شود، تایم‌اوت بخورد یا سرور شما وسط کار ری‌استارت شود، ارسال دوباره <b>همان فاکتور اول</b> را برمی‌گرداند، نه فاکتور دوم. پاسخ تکرارشده هدر ${code('Idempotent-Replay: true')} دارد.</p>
${codeBlock({
  label: 'HEADERS',
  note: 'دو درخواست، یک فاکتور',
  html: `${P('Idempotency-Key')}: ${S('order_1234')}\n${C('# ارسال دوباره همان درخواست → همان invoiceId')}\n${P('Idempotent-Replay')}: ${N('true')}`,
})}
${table(
  ['وضعیت', 'نتیجه'],
  [
    ['کلید تازه', 'پرداخت ساخته می‌شود.'],
    ['کلید تکراری با بدنه یکسان', 'فاکتور اصلی برگردانده می‌شود و هدر ' + mono('Idempotent-Replay: true') + ' ست می‌شود.'],
    ['کلید تکراری با بدنه متفاوت', code('IDEMPOTENCY_CONFLICT') + ' با کد ۴۰۹. این اشکال در سمت شماست و پاسخ‌دادن با نتیجه اول، آن را پنهان می‌کرد.'],
    ['درخواست ناموفق', 'کلید آزاد می‌شود، پس تلاش دوباره واقعاً کار را انجام می‌دهد.'],
  ],
)}
<p>کلیدها ۲۴ ساعت نگه داشته می‌شوند. اگر کلید نفرستید، درخواست کار می‌کند اما هر بار فاکتور تازه‌ای می‌سازد — که با یک دکمه «تلاش دوباره» در سمت شما به دو فاکتور زنده ختم می‌شود.</p>`,
  });

  // -------------------------------------------------------------------------
  // cards / status / wallet / transactions
  // -------------------------------------------------------------------------
  const cards = docsSection({
    id: 'cards',
    title: 'کارت‌های مقصد',
    body: `${endpoint({ method: 'GET', path: '/api/v1/cards', note: 'cards:read' })}
<p>کارت‌هایی که پول به آن‌ها واریز می‌شود. فقط شکل ماسک‌شده برگردانده می‌شود؛ شماره کامل هیچ‌وقت از این اندپوینت بیرون نمی‌آید.</p>
${codeBlock({
  label: 'RESPONSE',
  note: '200 OK',
  html: `{
  ${P('"success"')}: ${N('true')},
  ${P('"cards"')}: [{
    ${P('"id"')}: ${P('"card_01J8XK..."')},
    ${P('"masked"')}: ${P('"6104-****-****-3456"')},
    ${P('"title"')}: ${P('"کارت اصلی"')},
    ${P('"bankName"')}: ${P('"بانک ملت"')},
    ${P('"isDefault"')}: ${N('true')}
  }]
}`,
})}
${docsNote(
  'شماره کارت پذیرنده در پایگاه‌داده رمزنگاری‌شده ذخیره می‌شود، چون برای ساختن صفحه پرداخت باید کامل نمایش داده شود. هیچ توکن کارت مشتری، هیچ CVV و هیچ رمز دوم ذخیره نمی‌شود: پول با انتقال کارت‌به‌کارت معمولی می‌آید.',
)}`,
  });

  const status = docsSection({
    id: 'status',
    title: 'وضعیت حساب',
    body: `${endpoint({ method: 'GET', path: '/api/v1/status', note: 'payments:read' })}
<p>دفعه اول این را صدا بزنید. اگر جواب می‌دهد، احراز هویت، دسترسی‌ها و وضعیت حساب درست است و آنچه مانده از فهرست <b>کارهای باقی‌مانده</b> پیداست.</p>
${codeBlock({
  label: 'RESPONSE',
  note: '200 OK',
  html: `{
  ${P('"success"')}: ${N('true')},
  ${P('"merchant"')}: {
    ${P('"merchantCode"')}: ${P('"SP-1042"')},
    ${P('"displayName"')}: ${P('"فروشگاه نمونه"')},
    ${P('"accountStatus"')}: ${P('"ACTIVE"')},
    ${P('"environment"')}: ${P('"live"')}
  },
  ${P('"sms"')}: {
    ${P('"pipelineConnected"')}: ${N('true')},      ${C('// آیا پیامکی در ۲۴ ساعت گذشته رسیده')}
    ${P('"verifiedAt"')}: ${P('"2026-09-20T09:12:00.000Z"')},
    ${P('"webhookUrl"')}: ${P(`"${origin}/sms"`)}
  },
  ${P('"wallet"')}: { ${P('"availableBalance"')}: ${N('147000')}, ${P('"reservedBalance"')}: ${N('0')} },
  ${P('"setup"')}: {
    ${P('"completionPercent"')}: ${N('87')},
    ${P('"ready"')}: ${N('false')},
    ${P('"remainingSteps"')}: [
      { ${P('"key"')}: ${P('"sms_test"')}, ${P('"title"')}: ${P('"آزمایش خط پیامک"')} }
    ]
  }
}`,
})}
<p>${code('setup.remainingSteps')} نام کارهای باقی‌مانده را می‌دهد، نه تعدادشان. پذیرنده‌ای که به او بگویید «۳ کار مانده» تازه باید برود پیدایشان کند.</p>`,
  });

  const wallet = docsSection({
    id: 'wallet',
    title: 'کیف پول',
    body: `${endpoint({ method: 'GET', path: '/api/v1/wallet', note: 'wallet:read' })}
<p>موجودی کیف پول. کارمزد از اینجا کسر می‌شود، پس اگر حالت کارمزد <code>MERCHANT</code> باشد موجودی، سقف تعداد فاکتورهایی است که می‌توانید بسازید.</p>
${codeBlock({
  label: 'RESPONSE',
  note: '200 OK',
  html: `{
  ${P('"wallet"')}: {
    ${P('"balance"')}: ${N('147000')},
    ${P('"availableBalance"')}: ${N('147000')},   ${C('// balance - reservedBalance')}
    ${P('"reservedBalance"')}: ${N('0')},       ${C('// رزرو‌شده برای فاکتورهای در جریان')}
    ${P('"totalDeposited"')}: ${N('150000')},
    ${P('"totalFeesPaid"')}: ${N('3000')},
    ${P('"currency"')}: ${P('"IRT"')}
  }
}`,
})}
<p>${code('availableBalance = balance - reservedBalance')} و در زمان خواندن محاسبه می‌شود. پولی که برای فاکتور زنده <code>MERCHANT</code> رزرو شده، دو بار خرج نمی‌شود.</p>`,
  });

  const transactions = docsSection({
    id: 'transactions',
    title: 'شمارش تراکنش‌ها',
    body: `${endpoint({ method: 'GET', path: '/api/v1/transactions/count?range=today', note: 'transactions:read' })}
<p>خروجی این اندپوینت همان اعدادی است که در پنل پذیرنده می‌بینید، پس اگر عددی در پنل و در گزارش داخلی شما یکی نیست، یکی از این دو مرز بازه را جور دیگری حساب می‌کند.</p>
${table(
  ['range', 'معنی'],
  RANGES.map(([value, meaning]) => [code(value), meaning]),
)}
${codeBlock({
  label: 'RESPONSE',
  note: '200 OK',
  html: `{
  ${P('"range"')}: ${P('"today"')},
  ${P('"from"')}: ${P('"2026-09-21T20:30:00.000Z"')},   ${C('// نیمه‌شب تهران، به UTC')}
  ${P('"counts"')}: {
    ${P('"total"')}: ${N('42')}, ${P('"successful"')}: ${N('38')}, ${P('"pending"')}: ${N('3')},
    ${P('"expired"')}: ${N('1')}, ${P('"failed"')}: ${N('0')}, ${P('"manualReview"')}: ${N('0')}
  },
  ${P('"amounts"')}: { ${P('"volume"')}: ${N('13842000')}, ${P('"fees"')}: ${N('114000')} },
  ${P('"successRate"')}: ${N('90.5')},
  ${P('"averagePaymentSeconds"')}: ${N('214')},
  ${P('"lifetime"')}: { ${P('"total"')}: ${N('1840')}, ${P('"successRate"')}: ${N('97.3')} }
}`,
})}
${docsNote(
  'مقدار <code>from</code> همیشه یک لحظه واقعی UTC است، اما مرزِ بازه نیمه‌شب <b>تهران</b> است. پذیرنده‌ای که ساعت ۱ بامداد می‌پرسد «امروز چقدر فروختم» منظورش چند ساعت گذشته است، و یک مرز UTC به او آمار دیروز را می‌داد.',
)}`,
  });

  // -------------------------------------------------------------------------
  // SMS
  // -------------------------------------------------------------------------
  const sms = docsSection({
    id: 'sms',
    title: 'پیامک بانک',
    body: `<p>این اندپوینت قلب سامانه است: تنها مسیر نوشتن در موتور تطبیق. درگاه کارت را نمی‌خواند و به هیچ API بانکی وصل نیست — شاهدِ پرداخت، پیامکی است که بانک به گوشی شما می‌فرستد. پس اگر این مرحله وصل نشود، هیچ پرداختی خودکار تأیید نمی‌شود.</p>
${endpoint({ method: 'POST', path: '/sms', note: 'sms:write' })}
${codeBlock({ label: 'CURL', note: 'آزمایش دستی', html: SMS_CURL(origin) })}

<h3 id="sms-forwarder">راه‌اندازی فورواردر پیامک روی اندروید</h3>
<p>روی گوشی اندرویدی که پیامک بانک را می‌گیرد، برنامه‌ای لازم است که پیامک را هنگام رسیدن به آدرس این سامانه بفرستد. راهنمای زیر برای برنامه <b>SMS Forwarder</b> است؛ هر برنامه دیگری که بتواند درخواست HTTP با هدر دلخواه بفرستد هم کار می‌کند، فقط نام منوها فرق می‌کند.</p>
<p>قبل از شروع، از <a href="/dashboard/api-keys">پنل پذیرنده → کلیدهای API</a> یک کلید بسازید که دسترسی ${code('sms:write')} داشته باشد، و از <a href="/dashboard/sms">پنل پذیرنده → پیامک</a> آدرس وبهوک را بردارید. در تمام مراحل زیر کلمه «Next» همان دکمه پایین صفحه در برنامه است.</p>
${stepList([
  {
    title: 'یک فیلتر تازه بسازید',
    body: 'در برنامه به بخش <b>Filters</b> بروید و یک فیلتر جدید بسازید. هر فیلتر در این برنامه یعنی «اگر پیامکی با این شرط رسید، این کار را بکن» — پس این فیلتر نقش «قانون واریز بانکی» را بازی می‌کند.',
  },
  {
    title: 'شرط فیلتر را روی پیامک‌های دریافتی بگذارید',
    body: 'در بخش شرط فیلتر، گزینه <b>Incoming SMS/RCS</b> را انتخاب کنید تا فیلتر فقط روی پیامک‌های رسیده کار کند، نه پیامک‌های ارسالی خودتان.',
  },
  {
    title: 'وبهوک را در بخش Where to forward اضافه کنید',
    body: 'در بخش <b>Where to forward</b> روی <b>Add</b> بزنید و از گزینه‌های موجود <b>URL</b> را انتخاب کنید. اینجاست که برنامه یاد می‌گیرد پیامک را به کجا بفرستد.',
  },
  {
    title: 'روش و آدرس را تنظیم کنید',
    body: `گزینه <b>Request Type</b> را روی <code>POST</code> بگذارید و در فیلد <b>Enter URL</b> این آدرس را وارد کنید:<br>${code(`${origin}/sms`)}`,
  },
  {
    title: 'هدر X-Api-Key را اضافه کنید',
    body: `در همان صفحه، بخش <b>Header</b> را باز کنید، روی <b>Add</b> بزنید و کلید API خودتان را بگذارید:<br>نام هدر: ${code('X-Api-Key')} — مقدار: کلید کامل ${code('sk_live_…')} یا ${code('sk_test_…')} از پنل شما.<br>بدون این هدر درخواست با کد ${code('UNAUTHENTICATED')} رد می‌شود.`,
  },
  {
    title: 'بدنه را روی Json بگذارید و این مقدار را کپی کنید',
    body: `بخش <b>Body</b> را روی <b>Json</b> قرار دهید و دقیقاً همین مقدار را کپی و پیست کنید. آکولادهای داخل رشته‌ها متغیرهای خود برنامه‌اند و هنگام ارسال با متن واقعی پیامک جایگزین می‌شوند — ترجمه یا فارسی‌کردن آن‌ها را انجام ندهید:${codeBlock({ label: 'JSON', note: 'بدنه فورواردر', html: FORWARDER_BODY })}`,
  },
  {
    title: 'ذخیره کنید',
    body: 'آیکون سیو را در بالای صفحه، سمت راست، بزنید. تا این مرحله تعریف وبهوک تمام شده است.',
  },
  {
    title: 'تا صفحه Forwarding Conditions 2/2 جلو بروید',
    body: 'صفحه‌ها را دانه‌دانه با <b>Next</b> جلو بروید تا به صفحه <b>Forwarding Conditions 2/2</b> برسید. آنجا سیم‌کارتی را که پیامک بانکی به آن می‌رسد انتخاب کنید. اگر هر دو سیم‌کارتتان پیامک بانکی می‌گیرند، گزینه <b>All Numbers</b> را انتخاب کنید.',
  },
  {
    title: 'بقیه گزینه‌ها را دست نزنید',
    body: 'به هیچ چیز دیگری دست نزنید و فقط <b>Next</b> بزنید تا فرایند ساخت فیلتر تمام شود. در پایان برنامه یک پیام تستی به وبهوک می‌فرستد تا اتصال را بسنجد.',
  },
])}
${docsNote(
  '<b>فقط برنامه فورواردر را روی حساب خودتان تنظیم کنید.</b> متن پیامک بانک ممکن است موجودی حساب شما را داشته باشد. هرچند سامانه پیامک بی‌ربط را جایی نمایش نمی‌دهد و آن را فقط «تجزیه‌نشده» ثبت می‌کند، بهتر است انتخاب سیم‌کارت را هم محدود کنید.',
)}

<h3>چرا بدنه دقیقاً همین شکل است</h3>
<p>هر کلید این JSON به یک مقدار در سامانه نگاشت می‌شود. نام‌ها را عوض نکنید — سامانه نام‌های رایج را می‌شناسد، اما شکل زیر همان چیزی است که خود برنامه تولید می‌کند و کمترین تغییر را لازم دارد:</p>
${table(
  ['متغیر برنامه', 'جایگزین می‌شود با', 'در سامانه'],
  [
    [code('{msg}'), 'متن کامل پیامک', 'همان چیزی که تجزیه و با مبلغ یکتا مقایسه می‌شود'],
    [code('{time}'), 'زمان رسیدن پیامک به گوشی', 'ذخیره می‌شود، اما مبنای تطبیق نیست'],
    [code('{filter-name}'), 'نام همین فیلتر', 'شناسه دستگاه؛ نام فیلتر را همان نام گوشی بگذارید'],
    [code('{in-number}'), 'شماره فرستنده', 'برای تشخیص تکراری و ممیزی نگه داشته می‌شود'],
    [code('{in-sim}'), 'سیم‌کارتی که پیامک را گرفته', 'برای این سامانه معنایی ندارد و نادیده گرفته می‌شود'],
  ],
)}
${docsNote(
  'موقعیت نامه‌ها آزاد است: اگر برنامه شما به جای ' + code('msg') + ' فیلد را ' + code('message') + ' یا ' + code('text') + ' می‌فرستد، همان هم پذیرفته می‌شود. آنچه سامانه لازم دارد فقط <b>متن پیامک</b> است؛ بقیه فیلدها اختیاری‌اند.',
)}

<h3>نام استاندارد وبهوک</h3>
${table(
  ['تنظیم', 'مقدار'],
  [
    ['آدرس', code(`${origin}/sms`)],
    ['روش', code('POST')],
    ['هدر', code('X-Api-Key: sk_live_<key-id><secret>')],
    ['معادل هدر', code('Authorization: Bearer <key>') + ' — اگر برنامه‌ای فقط یکی از این دو را بتواند بفرستد'],
    ['بدنه', 'JSON با کلید ' + code('msg') + ' (یا ' + code('message') + ')'],
    ['ثابت بودن', 'یک کلید ثابت بفرستید؛ چرخاندن کلید به معنی به‌روزرسانی فورواردر است'],
  ],
)}

<h3>تست اتصال</h3>
<p>در <a href="/dashboard/sms">پنل پذیرنده → پیامک</a> دکمه «تست اتصال» یک پیامک نمونه با یک توکن یک‌ساعته نشان می‌دهد. آن را در برنامه فورواردر به‌جای متن عادی بفرستید؛ اگر رسید، مسیر، کلید و بدنه هر سه درست‌اند و از این پس پیامک‌های واقعی هم می‌رسند. توکن آزمایشی هیچ فاکتوری را تأیید نمی‌کند و فقط اتصال را می‌سنجد.</p>

<h3>تطبیق چطور انجام می‌شود</h3>
${table(
  ['بررسی', 'توضیح'],
  [
    ['مبلغ یکتا', 'مبلغ پیامک باید دقیقاً برابر مبلغ قابل پرداخت یک فاکتور زنده همان پذیرنده باشد. کم یا زیاد، پرداخت تأیید نمی‌شود.'],
    ['پنجره زمانی', 'پیامک باید در بازه‌ای حول زمان فاکتور باشد (پیش‌فرض: ۱۰ دقیقه پیش و ۹۰ دقیقه بعد). این بازه با تنطیمات قابل تغییر است.'],
    ['کارت مقصد', 'اگر شماره کارت مقصد در پیامک باشد، با کارت فاکتور مقایسه می‌شود.'],
    ['شماره پیگیری', 'برای درج در رسید ثبت می‌شود و برای تشخیص واریز تکراری به کار می‌رود.'],
    ['تکراری', 'هش متن پیامک یکتاست. فرستادن دوباره همان پیامک، پرداخت دوم نمی‌سازد و فقط بی‌اثر رد می‌شود.'],
  ],
)}
${docsNote(
  '<b>زمان اعلامی برنامه فورواردر پذیرفته نمی‌شود.</b> فیلد <code>receivedAt</code> وجود دارد و ذخیره می‌شود، اما برای تطبیق استفاده نمی‌شود؛ گوشی با ساعت غلط می‌توانست یک پرداخت را داخل پنجره زمانی بگذارد. مبنای تطبیق، زمان سرور است.',
)}

<h3>آنچه ممکن است پیش بیاید</h3>
${errorTable([
  ['SMS_INVALID_PAYLOAD', 400, 'ساختار ارسالی نامعتبر است، مثلاً فیلد ' + mono('message') + ' خالی است'],
  ['SMS_TOO_LARGE', 413, 'متن پیامک بیش از حد مجاز طولانی است'],
  ['SMS_DUPLICATE', 200, 'همین پیامک قبلاً رسیده بود. بی‌اثر و بی‌خطر است'],
  ['SMS_UNPARSEABLE', 200, 'پیامک رسید اما الگوی هیچ بانک شناخته‌شده‌ای را نخواند؛ در پنل با وضعیت «تجزیه‌نشده» دیده می‌شود'],
  ['SMS_TEST_TOKEN_INVALID', 400, 'توکن آزمایشی نامعتبر یا منقضی است'],
  ['RATE_LIMITED', 429, 'سقف پیامک در دقیقه پر شده است'],
])}
<p>قالب ناشناخته یک خطای سرور نیست و درگاه را متوقف نمی‌کند: پیامک ذخیره می‌شود، در لاگ پنل با متن اصلی دیده می‌شود و دستی قابل بررسی است. اگر پیامک‌های واقعی‌تان تجزیه‌نشده ماندند، متن کامل را برای پشتیبانی بفرستید تا قالب بانک اضافه شود.</p>

<h3 id="sms-troubleshoot">وقتی پیامک نمی‌رسد</h3>
<p>ترتیب این فهرست همان ترتیبی است که یک پیامک در آن حرکت می‌کند. هر مرحله را جدا بسنجید؛ اگر یکی درست کار نکند، مرحله بعد اصلاً اتفاق نمی‌افتد و پنل هیچ خطایی نشان نمی‌دهد، چون هیچ درخواستی به سامانه نرسیده است.</p>
${table(
  ['نشانه', 'جایی که باید بگردید'],
  [
    ['در پنل پیامک هیچ رکوردی نیست', 'فیلتر در برنامه فورواردر خاموش یا غیرفعال است، یا انتخاب سیم‌کارت در مرحله Forwarding Conditions اشتباه است'],
    ['رکورد هست ولی «تجزیه‌نشده» است', 'متن پیامک با هیچ قالب بانکی خوانده نشده؛ متن کامل را برای پشتیبانی بفرستید تا الگوی همان بانک اضافه شود'],
    ['رکورد «تکراری» است', 'همین پیامک از قبل رسیده. بی‌خطر است و کاری لازم نیست'],
    ['پاسخ ۴۰۱ گرفته‌اید', 'هدر نام درست تنظیم نشده، یا کلید باطل شده است؛ کلید را در پنل بچرخانید و فورواردر را به‌روز کنید'],
    ['پاسخ ۴۲۹ گرفته‌اید', 'سقف پیامک در دقیقه پر شده است؛ در تنظیمات سامانه قابل تغییر است'],
    ['پرداخت تأیید نشد', 'مبلغ پیامک با هیچ مبلغ قابل پرداخت فاکتور زنده‌ای یکی نبوده؛ دقیقاً مبلغی را واریز کنید که روی صفحه پرداخت نوشته شده'],
  ],
)}
${docsNote(
  '<b>پیامک را از گوشی دستی نفرستید.</b> فرستادن متن پیامک بانک از گوشی دیگر، همان متن را وارد سامانه می‌کند و اگر مبلغش با فاکتوری یکی باشد، آن فاکتور تأیید می‌شود. برای آزمایش همیشه از توکن آزمایشی استفاده کنید.',
)}`,

  });

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------
  const webhooks = docsSection({
    id: 'webhooks',
    title: 'وب‌هوک',
    body: `<p>وقتی پرداختی قطعی شد، رویداد امضاشده به آدرس شما می‌رود. <b>وبهوک تأیید پرداخت نیست</b> — پرداخت پیش از آن تأیید شده است. اگر سرور شما پایین باشد، پول برنمی‌گردد؛ فقط تحویل دوباره تلاش می‌شود.</p>

<h3>رویدادها</h3>
${table(
  ['رویداد', 'چه وقت'],
  [
    [code('payment.created'), 'فاکتور ساخته شد'],
    [code('payment.pending'), 'واریز شناسایی شد ولی هنوز قطعی نشده است'],
    [code('payment.success'), 'پرداخت تأیید و تسویه شد — رویداد اصلی همین است'],
    [code('payment.failed'), 'پرداخت رد شد'],
    [code('payment.expired'), 'مهلت فاکتور تمام شد بدون واریز'],
    [code('payment.manual_review'), 'پرداخت مشکوک است و منتظر تصمیم مدیر'],
    [code('wallet.low_balance'), 'موجودی کیف پول کم شده است'],
    [code('test.pipeline'), 'رویداد آزمایشی برای سنجش اتصال'],
  ],
)}

<h3>هدرها</h3>
${table(
  ['هدر', 'محتوا'],
  [
    [code('X-StevePay-Signature'), code('v1=<hex>') + ' — امضای HMAC-SHA256'],
    [code('X-StevePay-Timestamp'), 'زمان ارسال به میلی‌ثانیه'],
    [code('X-StevePay-Event'), 'نام رویداد'],
    [code('X-StevePay-Delivery'), 'شناسه یکتای این تحویل؛ برای تشخیص دریافت تکراری'],
    [code('X-StevePay-Attempt'), 'شماره تلاش، از ۱'],
  ],
)}

<h3>بررسی امضا</h3>
<p>رشته‌ای که امضا می‌شود دقیقاً این است: ${code('timestamp + "." + deliveryId + "." + body')}. بدنه باید <b>خام</b> باشد — اگر آن را پارس و دوباره سریالایز کنید، فاصله‌ها و ترتیب کلیدها عوض می‌شود و بررسی شکست می‌خورد.</p>
${codeBlock({ label: 'NODE.JS', note: 'بررسی امضا', html: NODE_VERIFY })}
${codeBlock({ label: 'PHP', note: 'بررسی امضا', html: PHP_VERIFY })}
${docsNote(
  'مقایسه را در زمان ثابت انجام دهید (' + code('timingSafeEqual') + ' در Node، ' + code('hash_equals') + ' در PHP). مقایسه رشته‌ای معمولی با زمان پاسخ، به کسی که هزاران درخواست می‌فرستد اجازه می‌دهد امضا را حدس بزند.',
)}

<h3>تلاش دوباره</h3>
<p>پاسخ ۲xx یعنی تحویل موفق. هر چیز دیگر — از جمله تغییر مسیر و تایم‌اوت ده‌ثانیه‌ای — ناموفق است و دوباره تلاش می‌شود، با این فاصله‌ها:</p>
<div class="docs-note" style="direction:ltr;text-align:center;font-family:var(--mono);font-size:.78rem">
1m → 5m → 30m → 2h → 12h → 24h
</div>
<p>هندلر شما باید <b>ایدمپوتنت</b> باشد: یک رویداد ممکن است بیش از یک بار برسد. با ${code('X-StevePay-Delivery')} دریافت‌های تکراری را تشخیص دهید و بی‌صدا ۲۰۰ برگردانید — برگرداندن خطا، تلاش دوباره را طولانی‌تر می‌کند.</p>
${docsNote(
  'سرور خود را طوری بنویسید که <b>پیش از</b> پاسخ‌دادن، پرداخت را تأیید شده ثبت کند. اگر کار اصلی را بعد از پاسخ انجام دهید و بعد از پاسخ شکست بخورد، ما ۲۰۰ دیده‌ایم و دیگر تلاش نمی‌کنیم.',
)}
<p>وضعیت هر تحویل، تعداد تلاش‌ها و متن پاسخ سرور شما در <a href="/dashboard/webhooks">پنل پذیرنده → وب‌هوک</a> دیده می‌شود و از همان‌جا می‌توانید تحویل ناموفق را دوباره بفرستید.</p>`,
  });

  // -------------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------------
  const errors = docsSection({
    id: 'errors',
    title: 'قالب خطا',
    body: `<p>هر خطا یک شکل دارد و کد آن پایدار است: کدها هرگز بازاستفاده نمی‌شوند، پس می‌توانید روی <code>code</code> شرط بگذارید. متن فارسی خواندنی است و ممکن است بهتر شود؛ روی متن شرط نگذارید.</p>
${codeBlock({
  label: 'ERROR',
  note: 'application/json',
  html: `{
  ${P('"success"')}: ${N('false')},
  ${P('"code"')}: ${P('"INSUFFICIENT_WALLET_BALANCE"')},
  ${P('"message"')}: ${P('"موجودی کیف پول برای ساخت فاکتور کافی نیست."')},
  ${P('"requestId"')}: ${P('"req_01J8XM..."')},
  ${P('"details"')}: { ${P('"required"')}: ${N('3000')}, ${P('"available"')}: ${N('0')} }
}`,
})}
<p>${code('details')} فقط جایی می‌آید که بتوان بر اساسش کاری کرد. هیچ‌وقت متن stack trace، نام جدول یا پیام پایگاه‌داده در پاسخ نیست.</p>

<h3>خطاهای عمومی</h3>
${errorTable([
  ['VALIDATION_FAILED', 422, 'داده ارسالی معتبر نیست'],
  ['INVALID_REQUEST', 400, 'درخواست نامعتبر است'],
  ['NOT_FOUND', 404, 'منبع پیدا نشد'],
  ['FORBIDDEN', 403, 'دسترسی به این بخش ندارید'],
  ['PERMISSION_DENIED', 403, 'برای این کار مجوز لازم را ندارید'],
  ['RATE_LIMITED', 429, 'تعداد درخواست بیشتر از حد مجاز؛ ' + mono('Retry-After') + ' را بخوانید'],
  ['MAINTENANCE_MODE', 503, 'سرویس موقتاً در حالت تعمیر است'],
  ['INTERNAL_ERROR', 500, 'خطای داخلی سرور'],
  ['DATABASE_ERROR', 500, 'خطای داخلی پایگاه‌داده. با همان کلید یکتاسازی دوباره تلاش کنید'],
])}

<h3>خطاهای فاکتور و پرداخت</h3>
${errorTable([
  ['INVOICE_NOT_FOUND', 404, 'فاکتور پیدا نشد'],
  ['INVOICE_EXPIRED', 410, 'مهلت فاکتور تمام شده است'],
  ['INVOICE_ALREADY_PAID', 409, 'این فاکتور قبلاً پرداخت شده است'],
  ['INVOICE_CANCELLED', 410, 'فاکتور لغو شده است'],
  ['INVOICE_NOT_PAYABLE', 409, 'فاکتور در وضعیت قابل پرداخت نیست'],
  ['INVOICE_UNDER_REVIEW', 409, 'پرداخت فاکتور در حال بررسی دستی است'],
  ['AMOUNT_SPACE_EXHAUSTED', 503, 'ظرفیت مبلغ یکتا در این لحظه پر است. چند لحظه بعد دوباره تلاش کنید'],
  ['STATE_TRANSITION_INVALID', 409, 'این تغییر وضعیت مجاز نیست'],
  ['DUPLICATE_TRANSACTION', 409, 'این تراکنش بانکی قبلاً ثبت و تسویه شده است'],
])}

<h3>خطاهای کیف پول و کارت</h3>
${errorTable([
  ['WALLET_NOT_FOUND', 404, 'کیف پول حساب پیدا نشد'],
  ['INSUFFICIENT_WALLET_BALANCE', 402, 'موجودی برای کارمزد کافی نیست'],
  ['LEDGER_CONFLICT', 409, 'تناقض در دفتر کل'],
  ['CARD_INVALID', 400, 'شماره کارت معتبر نیست'],
  ['CARD_DUPLICATE', 409, 'این کارت قبلاً ثبت شده است'],
  ['CARD_NOT_FOUND', 404, 'کارت پیدا نشد'],
  ['CARD_LIMIT_REACHED', 409, 'تعداد کارت‌ها به سقف رسیده است'],
  ['CALLBACK_URL_NOT_ALLOWED', 400, 'آدرس بازگشت باید HTTPS و روی دامنه ثبت‌شده شما باشد'],
])}`,
  });

  // -------------------------------------------------------------------------
  // Limits
  // -------------------------------------------------------------------------
  const limits = docsSection({
    id: 'limits',
    title: 'محدودیت‌ها',
    body: `<p>این مقادیر پیش‌فرض سامانه‌اند و مدیر می‌تواند تغییرشان دهد. محدودیت نرخ در پاسخ ۴۲۹ هدر <code>Retry-After</code> با عدد ثانیه می‌فرستد.</p>
${table(
  ['محدوده', 'مقدار پیش‌فرض'],
  [
    ['حداقل مبلغ فاکتور', toPersianDigits('1,000') + ' تومان'],
    ['حداکثر مبلغ فاکتور', toPersianDigits('500,000,000') + ' تومان'],
    ['مدت اعتبار فاکتور', toPersianDigits('15') + ' تا ' + toPersianDigits('60') + ' دقیقه (پیش‌فرض ' + toPersianDigits('30') + ')'],
    ['ساخت پرداخت', toPersianDigits('60') + ' درخواست در دقیقه به‌ازای هر پذیرنده'],
    ['پیامک دریافتی', toPersianDigits('120') + ' در دقیقه به‌ازای هر پذیرنده و هر IP'],
    ['کل درخواست‌های API', toPersianDigits('300') + ' در دقیقه به‌ازای هر کلید'],
    ['ورود', toPersianDigits('10') + ' تلاش در ' + toPersianDigits('15') + ' دقیقه'],
    ['ثبت‌نام', toPersianDigits('5') + ' حساب در ساعت به‌ازای هر IP'],
    ['صفحه عمومی فاکتور', toPersianDigits('120') + ' بازدید در دقیقه به‌ازای هر IP'],
    ['تلاش دوباره وب‌هوک', toPersianDigits('6') + ' تلاش، مهلت ' + toPersianDigits('10') + ' ثانیه برای هر تلاش'],
    ['حداکثر فاکتور زنده هر پذیرنده', toPersianDigits('500')],
    ['حداکثر کارت هر پذیرنده', toPersianDigits('20')],
    ['طول عمر کلید یکتاسازی', toPersianDigits('24') + ' ساعت'],
  ],
)}
${docsNote(
  'سقف وب‌هوک معتبر است: پس از ' + toPersianDigits('25') + ' شکست پیاپی، مسیر وب‌هوک به‌طور خودکار غیرفعال می‌شود تا صف پشت یک آدرس خراب گیر نکند. دلیل غیرفعال‌شدن روی همان صفحه دیده می‌شود و با اصلاح آدرس، دوباره فعال می‌شود.',
)}`,
  });

  // -------------------------------------------------------------------------
  // Recipes
  // -------------------------------------------------------------------------
  const recipes = docsSection({
    id: 'recipes',
    title: 'نمونه کامل',
    body: `<p>یک مسیر کامل: سفارش ساخته می‌شود، فاکتور تولید می‌شود، مشتری به صفحه پرداخت می‌رود، و وب‌هوک سفارش را تأیید می‌کند.</p>
${codeBlock({ label: 'NODE.JS', note: 'ساخت پرداخت', html: NODE_FLOW(origin) })}
${codeBlock({ label: 'CURL', note: 'کل مسیر در یک خط', html: CURL(origin) })}
${table(
  ['گام', 'کار سمت شما'],
  [
    ['۱', 'سفارش را در پایگاه‌داده خودتان با وضعیت «در انتظار پرداخت» بسازید.'],
    ['۲', 'کلید یکتاسازی را از شناسه سفارش بسازید و پرداخت را ثبت کنید.'],
    ['۳', code('paymentUrl') + ' پاسخ را به مشتری بدهید یا ریدایرکت کنید.'],
    ['۴', 'در وب‌هوک ' + mono('payment.success') + ' امضا را بررسی کنید و سفارش را تأیید کنید.'],
    ['۵', 'با همان ' + mono('invoiceId') + ' وضعیت را در پایگاه‌داده خودتان به‌روز کنید — نه با شماره سفارش، که سمت شماست و ما نمی‌شناسیمش.'],
  ],
)}
${docsNote(
  'برای خودآزمایی، <code>returnUrl</code> را به صفحه‌ای بفرستید که وضعیت را از API خودمان می‌خواند، نه به صفحه‌ای که فرض می‌کند پرداخت موفق بوده است. مشتری می‌تواند آدرس بازگشت را دستی باز کند.',
)}`,
  });

  // -------------------------------------------------------------------------
  // Testing
  // -------------------------------------------------------------------------
  const testing = docsSection({
    id: 'testing',
    title: 'محیط آزمایشی',
    body: `<p>کلید <code>sk_test_</code> و کلید <code>sk_live_</code> را از هم جدا نگه دارید. حساب آزمایشی، فاکتور آزمایشی می‌سازد: کیف پول دست نمی‌خورد و پیامک‌های آزمایشی هرگز فاکتور عملیاتی را تأیید نمی‌کنند.</p>
${table(
  ['کار', 'روش درست'],
  [
    ['ساخت فاکتور نمونه', 'با کلید ' + mono('sk_test_') + ' و برنامه فورواردر آزمایشی روی یک گوشی جدا.'],
    ['سنجش اتصال وب‌هوک', 'رویداد ' + mono('test.pipeline') + ' از پنل پذیرنده بفرستید.'],
    ['سنجش اتصال پیامک', 'در ' + '<a href="/dashboard/sms">پنل پذیرنده → پیامک</a> یک توکن تست بسازید و در فورواردر بگذارید.'],
    ['پاک‌کردن داده آزمایشی', 'فاکتورهای آزمایشی در آمار عملیاتی حساب نمی‌شوند و روی کیف پول اثری ندارند.'],
  ],
)}
${docsNote(
  'هیچ گاه برنامه فورواردر را روی گوشی‌ای که پیامک بانکی واقعی می‌گیرد، با کلید آزمایشی تنظیم نکنید: پیامک واقعی به مسیر آزمایشی می‌رود، تجزیه می‌شود، اما پرداخت عملیاتی تأیید نمی‌شود و شما فکر می‌کنید سامانه از کار افتاده است.',
)}

<h3>پشتیبانی</h3>
<p>در هر تماس، <code>requestId</code> پاسخ را بفرستید. آن شناسه در لاگ، در رکورد ممیزی و در تراکنش‌های مرتبط ثبت شده است، پس پیگیری بدون پرسیدن «کدام درخواست؟» انجام می‌شود.</p>`,
  });

  return docsShell(
    {
      title: 'مستندات API — Steve Pay',
      description:
        'مستندات کامل درگاه پرداخت Steve Pay: ساخت پرداخت، پیامک بانک، وب‌هوک امضاشده، کدهای خطا و محدودیت‌ها.',
      currentPath: '/docs',
      script: true,
      origin,
      nav: [
        {
          group: 'شروع',
          links: [
            { href: '#quickstart', label: 'شروع سریع' },
            { href: '#auth', label: 'احراز هویت' },
            { href: '#testing', label: 'محیط آزمایشی' },
          ],
        },
        {
          group: 'اندپوینت‌ها',
          links: [
            { href: '#payments', label: 'ساخت پرداخت' },
            { href: '#idempotency', label: 'یکتاسازی' },
            { href: '#cards', label: 'کارت‌ها' },
            { href: '#status', label: 'وضعیت حساب' },
            { href: '#wallet', label: 'کیف پول' },
            { href: '#transactions', label: 'شمارش تراکنش' },
          ],
        },
        {
          group: 'پیامک بانک',
          links: [
            { href: '#sms-forwarder', label: 'راه‌اندازی فورواردر' },
            { href: '#sms', label: 'تطبیق پرداخت' },
            { href: '#sms-troubleshoot', label: 'عیب‌یابی' },
          ],
        },
        {
          group: 'وبهوک',
          links: [{ href: '#webhooks', label: 'امضا و تلاش دوباره' }],
        },
        {
          group: 'مرجع',
          links: [
            { href: '#errors', label: 'کدهای خطا' },
            { href: '#limits', label: 'محدودیت‌ها' },
            { href: '#recipes', label: 'نمونه کامل' },
          ],
        },
      ],
      heading: 'مستندات API',
      subheading:
        'هر چیزی که برای وصل‌کردن یک فروشگاه لازم است: ساخت پرداخت، دریافت پیامک بانک، بررسی وب‌هوک و معنای هر کد خطا.',
    },
    `${quickstart}${auth}${payments}${idempotency}${cards}${status}${wallet}${transactions}${sms}${webhooks}${errors}${limits}${recipes}${testing}`,
  );
}
