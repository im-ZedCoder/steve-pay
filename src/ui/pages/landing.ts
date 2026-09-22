/**
 * Landing page.
 *
 * The hero is a thesis: the most characteristic thing this system produces is an
 * *amount that does not round* — a figure forged so that no two live invoices can
 * collide. So the hero is that figure, live, with the arithmetic that produced it
 * visible beside it. Not a headline over a screenshot, and not a big number with a
 * small label: the moving part is the thing a merchant will actually see in their
 * own dashboard, and the numbers around it are the real base, the real fee and the
 * real suffix.
 *
 * Everything below the fold is the pipeline in order, because the sequence is the
 * product. A reader who understands the order can debug their own integration; one
 * who only reads the feature list cannot.
 *
 * The page is cacheable for five minutes and contains no request data. The forge
 * animates client-side (see CLIENT_JS) so the cache stays honest — the numbers on
 * screen are examples, and the copy says so.
 */

import { toPersianDigits } from '../../core/digits';
import { formatRialFa, formatTomanFa, toRial } from '../../core/money';
import {
  bandHead,
  codeBlock,
  eyebrow,
  factGrid,
  publicShell,
  stepList,
} from '../layout';

/** The worked example, matching the brief's own figures. */
const EXAMPLE = {
  order: 359_000,
  fee: 3_000,
  suffix: 3_706,
};

const BASE = EXAMPLE.order + EXAMPLE.fee;
const PAYABLE = BASE + EXAMPLE.suffix;

/**
 * Syntax spans. Local so the class names stay in one place per language.
 *
 * They accept numbers because the figures in these samples are computed from the
 * same constants the copy uses — a hard-coded digit in a code sample is a digit that
 * silently stops matching the example above it.
 */
const span = (cls: string) => (text: string | number): string => `<span class="${cls}">${text}</span>`;
const K = span('k');
const S = span('s');
const N = span('n');
const C = span('c');
const P = span('p');

/**
 * The samples on this page show the host the reader is on.
 *
 * They are functions of the origin rather than constants because the platform has no
 * configured base URL: the deployment answers on a `*.pages.dev` name, a preview alias
 * and a custom domain, and a sample that names one of them would be wrong on the other
 * two. It also means a reader can copy an example and run it as-is.
 */
const CURL = (origin: string) => `${K('curl')} -X POST ${S(`${origin}/api/v1/payments`)} \\
  -H ${S('"X-API-Key: sk_live_<key-id><secret>"')} \\
  -H ${S('"Idempotency-Key: order-1234"')} \\
  -H ${S('"Content-Type: application/json"')} \\
  -d ${P("'{")}
    ${P('"amount"')}: ${N('359000')},
    ${P('"description"')}: ${P('"سفارش ۱۲۳۴"')},
    ${P('"customCallback"')}: ${P('"https://shop.example.com/pay/callback"')},
    ${P('"metadata"')}: { ${P('"orderId"')}: ${P('"1234"')} }
  ${P("}'")}`;

const RESPONSE = (origin: string) => `{
  ${P('"success"')}: ${N('true')},
  ${P('"invoiceId"')}: ${P('"inv_01J8XK4M2Q"')},
  ${P('"amount"')}: ${N(PAYABLE)},          ${C('// تومان — مبلغ دقیق پرداخت')}
  ${P('"amountRial"')}: ${N(toRial(PAYABLE))},    ${C('// ریال')}
  ${P('"uniqueSuffix"')}: ${N(EXAMPLE.suffix)},
  ${P('"paymentUrl"')}: ${P(`"${origin}/pay/inv_01J8XK4M2Q"`)},
  ${P('"status"')}: ${P('"pending"')},
  ${P('"expiresAt"')}: ${P('"2026-09-22T09:41:07.000Z"')}
}`;

const WEBHOOK = `${C('// سرور شما، هنگام تأیید پرداخت')}
POST /pay/callback
${P('X-StevePay-Signature')}: ${S('t=1758534120,v1=8f2c…')}
${P('X-StevePay-Event')}: ${S('payment.success')}
${P('X-StevePay-Delivery')}: ${S('whd_01J8XK9Q7A')}

{
  ${P('"event"')}: ${P('"payment.success"')},
  ${P('"invoiceId"')}: ${P('"inv_01J8XK4M2Q"')},
  ${P('"status"')}: ${P('"paid"')},
  ${P('"amount"')}: ${N(PAYABLE)},
  ${P('"originalAmount"')}: ${N(EXAMPLE.order)},
  ${P('"fee"')}: ${N(EXAMPLE.fee)},
  ${P('"paidAt"')}: ${P('"2026-09-22T09:38:52.000Z"')}
}`;

export function landingPage(input: { origin: string }): string {
  const { origin } = input;

  const hero = `<section class="hero">
<div class="grid-field" aria-hidden="true"></div>
<div class="hero-glow" aria-hidden="true"></div>
<div class="hero-inner">
  <div>
    ${eyebrow('PAYMENT GATEWAY · IRAN')}
    <h1 class="hero-title">پرداخت کارتی را<br><em>خودکار</em> تأیید کنید</h1>
    <p class="hero-lede">
      برای هر فاکتور یک مبلغ یکتا ساخته می‌شود. مشتری همان مبلغ را کارت‌به‌کارت می‌کند،
      پیامک بانک به سرور می‌رسد و پرداخت بدون دخالت انسان تأیید می‌شود — بعد وبهوک
      امضاشده به فروشگاه شما می‌رود.
    </p>
    <div class="hero-actions">
      <a class="btn btn-primary btn-lg" href="/register">ساخت حساب پذیرنده</a>
      <a class="btn btn-lg" href="/docs">مستندات API</a>
    </div>
    <ul class="hero-facts">
      <li><b>${toPersianDigits(formatTomanFa(3_000))}</b><span>تومان کارمزد ثابت</span></li>
      <li><b>HMAC</b><span>امضای وبهوک</span></li>
      <li><b>${toPersianDigits('3')}</b><span>ثانیه تا تأیید خودکار</span></li>
    </ul>
  </div>

  <div class="forge" data-forge>
    <div class="forge-head"><span class="tracked">UNIQUE AMOUNT</span><span>مبلغ یکتا · نمونه</span></div>
    <div class="forge-amount">
      <b data-forge-amount>${toPersianDigits(formatTomanFa(PAYABLE))}</b><span>تومان</span>
    </div>
    <div class="forge-rial" data-forge-rial>${toPersianDigits(formatRialFa(toRial(PAYABLE)))} ریال</div>
    <div class="forge-rows">
      <div><span>مبلغ سفارش</span><b>${toPersianDigits(formatTomanFa(EXAMPLE.order))} تومان</b></div>
      <div><span>کارمزد</span><b>${toPersianDigits(formatTomanFa(EXAMPLE.fee))} تومان</b></div>
      <div><span>پسوند یکتا</span><b data-forge-suffix>${toPersianDigits(formatTomanFa(EXAMPLE.suffix))} تومان</b></div>
      <div><span>مبلغ قابل پرداخت</span><b class="ok" data-forge-total>${toPersianDigits(formatTomanFa(PAYABLE))} تومان</b></div>
    </div>
    <div class="trace" style="margin-top:1.1rem" aria-hidden="true"></div>
    <p style="margin:.7rem 0 0;font-size:.73rem;color:var(--haze);line-height:1.9">
      همین مبلغ، همین پسوند، فقط برای همین فاکتور. تا وقتی فاکتور باز است هیچ پذیرنده
      دیگری این عدد را نمی‌گیرد.
    </p>
  </div>
</div>
</section>`;

  const pipeline = `<section class="band band-alt">
<div style="max-width:74rem;margin:0 auto">
${bandHead({
  eyebrow: 'PO1 · THE PIPELINE',
  title: 'از یک درخواست API تا پول تأییدشده، در شش مرحله',
  lede: 'این ترتیب مهم است: مبلغ یکتا پیش از پرداخت ساخته می‌شود، پیامک شاهد است نه ادعا، و وبهوک بعد از قطعی‌شدن پول می‌رود. اگر جایی گیر کردید، همین ترتیب را دنبال کنید تا بفهمید کدام مرحله انجام نشده.',
})}
${stepList([
  {
    title: 'فاکتور ساخته می‌شود',
    body: 'یک درخواست به <code>POST /api/v1/payments</code> می‌فرستید. کارمزد اضافه می‌شود و یک پسوند یکتا روی مبلغ می‌نشیند تا هیچ دو فاکتور فعالی مبلغ یکسان نداشته باشند.',
  },
  {
    title: 'مشتری مبلغ دقیق را واریز می‌کند',
    body: 'صفحه پرداخت شماره کارت، مبلغ دقیق به تومان و ریال، و زمان باقی‌مانده را نشان می‌دهد. کم یا زیاد واریز کردن، پرداخت را ناموفق می‌کند — و همین است که تطبیق را ممکن می‌سازد.',
  },
  {
    title: 'پیامک بانک به سرور می‌رسد',
    body: 'برنامه فورواردر روی گوشی، پیامک بانک را به <code>POST /sms</code> می‌فرستد. احراز هویت با همان کلید API انجام می‌شود و پیامک تکراری پیش از هر پردازشی رد می‌شود.',
  },
  {
    title: 'پیامک تجزیه و تطبیق داده می‌شود',
    body: 'مبلغ، شماره پیگیری، کارت مبدأ و مقصد و زمان پیامک استخراج می‌شوند و با فاکتورهای فعال همان پذیرنده مقایسه می‌شوند. ارقام فارسی و عربی و جداکننده‌های هزار پیش از خواندن مبلغ یکسان‌سازی می‌شوند.',
  },
  {
    title: 'پرداخت تأیید می‌شود',
    body: 'اگر مبلغ یکتا، پنجره زمانی و شماره پیگیری کنار هم بنشینند، فاکتور <code>PAID</code> می‌شود و کارمزد از کیف پول کسر می‌گردد. هر نشانه مشکوک، پرداخت را به صف بررسی دستی می‌فرستد و پول تا تصمیم مدیر معلق می‌ماند.',
  },
  {
    title: 'وبهوک امضاشده ارسال می‌شود',
    body: 'رویداد <code>payment.success</code> با امضای HMAC-SHA256 به آدرس شما می‌رود، با تلاش مجدد پله‌ای و لاگ تحویل. اگر سرور شما پایین باشد، پرداخت برنمی‌گردد؛ فقط تحویل دوباره تلاش می‌شود.',
  },
])}
</div>
</section>`;

  const api = `<section class="band">
<div style="max-width:74rem;margin:0 auto">
${bandHead({
  eyebrow: 'PO2 · THE API',
  title: 'یک درخواست، یک مبلغ یکتا، یک وبهوک امضاشده',
  lede: 'مبلغ یکتا در پاسخ برمی‌گردد چون خودش بخشی از نتیجه است: همان عددی است که باید در تلفن بانک ببینید. وبهوک هم امضا دارد تا مطمئن شوید از طرف ما آمده.',
})}
<div class="split">
  ${codeBlock({ label: 'REQUEST', note: 'makePayment', html: CURL(origin) })}
  ${codeBlock({ label: 'RESPONSE', note: '200 OK', html: RESPONSE(origin) })}
</div>
<div class="split" style="margin-top:1.25rem">
  ${codeBlock({ label: 'WEBHOOK', note: 'به سرور شما', html: WEBHOOK })}
  <div class="panel">
    <div class="panel-head"><h2>چیزهایی که در طراحی به‌شان تکیه نکنید</h2></div>
    <ul style="margin:0;padding-inline-start:1.15rem;font-size:.85rem;line-height:2.15;color:var(--steel)">
      <li>مبلغ را از سمت مشتری قبول نمی‌کنیم؛ همان مبلغی که ما ساختیم معتبر است.</li>
      <li>وضعیت فاکتور را از پارامتر ورودی نمی‌خوانیم؛ فقط از پیامک بانک و پایگاه‌داده.</li>
      <li>کارمزد را از درخواست شما حساب نمی‌کنیم؛ تنظیمات پذیرنده مبنا است.</li>
      <li><span class="mono" style="font-size:.78rem">Idempotency-Key</span> را نگه دارید: ارسال دوباره همان درخواست، فاکتور دوم نمی‌سازد.</li>
      <li>مبلغ ریالی همیشه دقیقاً ده برابر تومان است، بدون اعشار.</li>
    </ul>
    <a class="btn" href="/docs" style="margin-top:1rem">همه اندپوینت‌ها در مستندات</a>
  </div>
</div>
</div>
</section>`;

  const why = `<section class="band band-alt">
<div style="max-width:74rem;margin:0 auto">
${bandHead({
  eyebrow: 'PO3 · ARCHITECTURE',
  title: 'چیزهایی که در بیشتر درگاه‌ها به کد سپرده شده، اینجا در پایگاه‌داده قفل است',
  lede: 'این تفاوت را در پیام خطاها می‌بینید: حالتی که باید رد شود، رد می‌شود و به جای امیدواری، علتش را می‌گوید.',
})}
${factGrid([
  {
    value: '۱',
    label: 'مبلغ یکتا در هر لحظه',
    note: 'ایندکس یکتای پایگاه‌داده روی مبلغ فعال، نه بررسی در کد. دو درخواست همزمان نمی‌توانند یک مبلغ بگیرند.',
  },
  {
    value: '۱۰۰٪',
    label: 'تغییرات کیف پول در دفتر کل',
    note: 'موجودی بدون رکورد دفتر کل تغییر نمی‌کند و رکوردهای دفتر کل از سمت برنامه تغییرناپذیرند.',
  },
  {
    value: 'HMAC',
    label: 'امضای وبهوک',
    note: 'امضا با مهر زمانی و شناسه تحویل می‌رود تا دریافت دوباره قابل تشخیص باشد.',
  },
  {
    value: '۰',
    label: 'ذخیره اطلاعات کارت مشتری',
    note: 'فقط شماره کارت خود پذیرنده برای دریافت پول نگه داشته می‌شود. هیچ توکن یا CVV مشتری ذخیره نمی‌شود.',
  },
])}
</div>
</section>`;

  const cta = `<section class="band">
<div style="max-width:74rem;margin:0 auto">
  <div class="panel" style="padding:2rem 1.75rem;text-align:center">
    ${eyebrow('GET STARTED')}
    <h2 style="margin:.2rem 0 .6rem;font-size:clamp(1.3rem,2.4vw,1.7rem);font-weight:700;letter-spacing:-.025em">
      حساب پذیرنده بسازید و اولین پرداخت را تست کنید
    </h2>
    <p style="margin:0 auto 1.5rem;max-width:34rem;color:var(--steel);font-size:.9rem;line-height:2.1">
      بعد از ثبت‌نام، مدیر حساب را بررسی و تأیید می‌کند. پس از تأیید کلید API ساخته می‌شود و
      می‌توانید مسیر کامل را با یک تراکنش آزمایشی امتحان کنید.
    </p>
    <div style="display:flex;gap:.7rem;justify-content:center;flex-wrap:wrap">
      <a class="btn btn-primary btn-lg" href="/register">ثبت‌نام پذیرنده</a>
      <a class="btn btn-lg" href="/login">ورود به پنل</a>
    </div>
    <div class="trace" style="margin-top:1.75rem" aria-hidden="true"></div>
    <p style="margin:.8rem 0 0;font-family:var(--mono);font-size:.68rem;color:var(--haze);letter-spacing:.06em">
      REGISTER → ADMIN APPROVAL → API KEY → FIRST PAYMENT
    </p>
  </div>
</div>
</section>`;

  return publicShell(
    {
      title: 'Steve Pay — درگاه پرداخت با تأیید خودکار از پیامک بانک',
      description:
        'درگاه پرداخت کارتی با مبلغ یکتا، تطبیق خودکار پیامک بانک، کیف پول و دفتر کل، و وبهوک امضاشده با HMAC.',
      currentPath: '/',
      script: true,
      origin,
    },
    `${hero}${pipeline}${api}${why}${cta}`,
  );
}
