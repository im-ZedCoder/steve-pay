/**
 * Landing page.
 *
 * THE ARGUMENT OF THIS PAGE
 *
 *   Steve Pay's whole mechanism is that it reads your bank's incoming SMS. So the hero is
 *   not a headline with a gradient behind it, and not a screenshot of a dashboard — it is
 *   the actual artifact the product operates on, a bank SMS, with the four facts extracted
 *   from it listed underneath. The page proves the mechanism instead of describing it.
 *
 *   It reuses the same `.slip` component as the payment success page, which is the
 *   intended coherence: a customer sees the same object when their payment is confirmed,
 *   so the landing page and the receipt are recognisably the same product.
 *
 *   The numbered steps below are numbered because the content genuinely is a sequence —
 *   a payment moves through those stages in that order, and the order carries information
 *   the reader needs. (Numbering used as decoration on non-sequential content is a
 *   different thing, and this is not that.)
 *
 *   Restraint: one artifact, one short argument, one code sample, two actions. No feature
 *   grid, no testimonials, no logo wall, no animation.
 */

import { escapeHtml } from '../../core/http';
import { shell } from '../layout';

const STEPS = [
  {
    title: 'پذیرنده ثبت‌نام می‌کند',
    body: 'حساب در وضعیت «در انتظار تأیید» می‌ماند تا مدیر آن را بررسی و تأیید کند.',
  },
  {
    title: 'کلید API و کارت بانکی',
    body: 'پس از تأیید، کلید API ساخته می‌شود و پذیرنده کارتی که پول به آن واریز می‌شود را ثبت می‌کند.',
  },
  {
    title: 'مبلغ یکتا ساخته می‌شود',
    body: 'برای هر فاکتور یک مبلغ منحصربه‌فرد با پسوند چندرقمی ساخته می‌شود تا هر واریزی به یک فاکتور برسد.',
  },
  {
    title: 'بانک پیامک می‌فرستد',
    body: 'پیامک بانک از طریق اپلیکیشن فورواردر به Steve Pay می‌رسد، خوانده می‌شود و پرداخت را تأیید می‌کند.',
  },
] as const;

export function landingPage(input: { baseUrl: string }): string {
  const steps = STEPS.map(
    (step, index) => `<li style="display:grid;gap:.3rem;padding:.875rem 0;border-bottom:1px solid var(--hairline-soft)">
  <div style="display:flex;align-items:baseline;gap:.6rem">
    <span class="num" style="color:var(--faint);font-size:.8rem">${String(index + 1).padStart(2, '0')}</span>
    <b style="font-size:.92rem">${escapeHtml(step.title)}</b>
  </div>
  <p style="margin:0;color:var(--muted);font-size:.82rem">${escapeHtml(step.body)}</p>
</li>`,
  ).join('');

  const body = `<div class="pay-wrap" style="justify-content:flex-start;gap:0;padding-top:2.5rem">
<div style="width:100%;max-width:44rem;display:grid;gap:1.75rem">

  <header style="display:grid;gap:.75rem">
    <div class="pay-brand" style="font-size:.85rem"><i aria-hidden="true"></i>Steve Pay — درگاه پرداخت کارت‌به‌کارت</div>
    <h1 style="margin:0;font-size:clamp(1.6rem,5vw,2.35rem);font-weight:700;line-height:1.45;letter-spacing:-.01em">
      مشتری کارت‌به‌کارت می‌کند.<br>تأیید پرداخت کار ما است.
    </h1>
    <p style="margin:0;color:var(--muted);font-size:.95rem;max-width:34rem">
      Steve Pay برای هر فاکتور یک مبلغ یکتا می‌سازد. پیامک بانکی که به موبایل شما می‌رسد را می‌خواند،
      مبلغ را با همان فاکتور تطبیق می‌دهد و پرداخت را تأیید می‌کند. بعد از آن، پیام وب‌هوک به سرور شما می‌رود.
    </p>
  </header>

  <!-- The hero: the real object the product operates on, annotated. -->
  <div style="display:grid;gap:.75rem">
    <p class="pay-label" style="margin:0">پیامکی که بانک می‌فرستد، همان چیزی است که خوانده می‌شود</p>
    <div class="slip" style="margin:0">
      <div class="slip-head">پیامک ورودی بانک<span>نمونه</span></div>
      <div class="slip-body">واریز به کارت ۶۱۰۴۳۳۷۸۹۰۱۲۳۴۵۶
مبلغ <mark>۳٬۶۳۷٬۰۶۰</mark> ریال
مانده ۱۲٬۴۵۰٬۰۰۰ ریال
شماره پیگیری <mark>۸۴۲۱۹۰۳۳۱</mark></div>
      <div class="slip-foot">تاریخ ۱۴۰۵/۰۶/۳۱ - ۱۴:۲۳ — خوانده‌شده توسط Steve Pay</div>
    </div>
    <dl class="receipt-rows" style="margin:0">
      <div class="receipt-row"><dt>مبلغ استخراج‌شده</dt><dd class="num">۳۶۳٬۷۰۶ تومان</dd></div>
      <div class="receipt-row"><dt>شماره پیگیری</dt><dd class="mono">۸۴۲۱۹۰۳۳۱</dd></div>
      <div class="receipt-row"><dt>فاکتور منطبق</dt><dd class="mono">inv_01J8XK…</dd></div>
      <div class="receipt-row"><dt>نتیجه</dt><dd style="color:var(--settle)">تأیید شد</dd></div>
    </dl>
  </div>

  <section style="display:grid;gap:.5rem">
    <h2 style="margin:0;font-size:1rem">مسیر یک پرداخت</h2>
    <ol style="list-style:none;margin:0;padding:0">${steps}</ol>
  </section>

  <section style="display:grid;gap:.75rem">
    <h2 style="margin:0;font-size:1rem">ساخت فاکتور با یک درخواست</h2>
    <div class="slip" style="margin:0">
      <div class="slip-head">POST /api/v1/payments<span>X-API-Key</span></div>
      <div class="slip-body mono" dir="ltr" style="text-align:left;font-size:.75rem">curl ${escapeHtml(
        input.baseUrl,
      )}/api/v1/payments \\
  -H "X-API-Key: sk_live_…" \\
  -H "Idempotency-Key: order_1234" \\
  -d '{"amount": 359000, "description": "سفارش ۱۲۳۴"}'</div>
    </div>
    <p style="margin:0;color:var(--faint);font-size:.78rem">
      پاسخ شامل مبلغ قابل‌پرداخت، مبلغ ریالی و آدرس صفحه پرداخت است. مستندات کامل در
      <a href="/docs/api">/docs/api</a>.
    </p>
  </section>

  <footer class="pay-foot" style="border-top:1px solid var(--hairline-soft)">
    <span class="pay-brand"><i aria-hidden="true"></i>Steve Pay</span>
    <span style="display:flex;gap:1rem">
      <a href="/register">ثبت‌نام پذیرنده</a>
      <a href="/login">ورود</a>
      <a href="/docs/api">مستندات API</a>
    </span>
  </footer>

</div></div>`;

  return shell({ title: 'Steve Pay — درگاه پرداخت کارت‌به‌کارت', script: false }, body);
}
