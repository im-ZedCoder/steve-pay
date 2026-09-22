/**
 * Registration and login (§4, §5).
 *
 * Both are plain HTML forms that post to the server and re-render with an error. No
 * client-side validation script: the server is the only authority on whether a mobile
 * number is usable or a password is strong enough, so duplicating those rules in the
 * browser would only create a second version to keep in sync, and the fields are few
 * enough that native HTML validation plus a round trip is faster than shipping code.
 *
 * Every input carries `autocomplete` hints and `aria-describedby` on its hint and error,
 * so password managers fill them correctly and a screen reader announces the reason a
 * field was rejected rather than just its name.
 */

import { escapeHtml } from '../../core/http';
import { BUSINESS_TYPES, businessTypeLabel } from '../../core/validation';
import { shell } from '../layout';

export interface FieldError {
  field: string;
  message: string;
}

interface FieldOptions {
  name: string;
  label: string;
  type?: string;
  value?: string;
  hint?: string;
  required?: boolean;
  autocomplete?: string;
  inputmode?: 'text' | 'numeric' | 'tel' | 'email' | 'url';
  dir?: 'rtl' | 'ltr';
  error?: string;
}

function field(options: FieldOptions): string {
  const id = `f_${options.name}`;
  const hintId = options.hint ? `${id}_hint` : '';
  const errorId = options.error ? `${id}_error` : '';
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return `<div class="field">
  <label for="${id}">${escapeHtml(options.label)}${options.required ? '' : ' (اختیاری)'}</label>
  <input
    class="input"
    id="${id}"
    name="${escapeHtml(options.name)}"
    type="${escapeHtml(options.type ?? 'text')}"
    ${options.value !== undefined ? `value="${escapeHtml(options.value)}"` : ''}
    ${options.required ? 'required' : ''}
    ${options.autocomplete ? `autocomplete="${escapeHtml(options.autocomplete)}"` : ''}
    ${options.inputmode ? `inputmode="${escapeHtml(options.inputmode)}"` : ''}
    ${options.dir ? `dir="${escapeHtml(options.dir)}"` : ''}
    ${describedBy ? `aria-describedby="${describedBy}"` : ''}
    ${options.error ? 'aria-invalid="true"' : ''}
  >
  ${options.hint ? `<span class="hint" id="${hintId}">${escapeHtml(options.hint)}</span>` : ''}
  ${options.error ? `<span class="field-error" id="${errorId}" role="alert">${escapeHtml(options.error)}</span>` : ''}
</div>`;
}

interface SelectOptions {
  name: string;
  label: string;
  options: Array<{ value: string; label: string }>;
  selected?: string;
  hint?: string;
  required?: boolean;
  error?: string;
}

function select(options: SelectOptions): string {
  const id = `f_${options.name}`;
  const hintId = options.hint ? `${id}_hint` : '';
  const errorId = options.error ? `${id}_error` : '';
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const items = [
    '<option value="">انتخاب کنید…</option>',
    ...options.options.map(
      (option) =>
        `<option value="${escapeHtml(option.value)}"${
          options.selected === option.value ? ' selected' : ''
        }>${escapeHtml(option.label)}</option>`,
    ),
  ].join('');
  return `<div class="field">
  <label for="${id}">${escapeHtml(options.label)}</label>
  <select class="input" id="${id}" name="${escapeHtml(options.name)}"${
    options.required ? ' required' : ''
  }${describedBy ? ` aria-describedby="${describedBy}"` : ''}${
    options.error ? ' aria-invalid="true"' : ''
  }>${items}</select>
  ${options.hint ? `<span class="hint" id="${hintId}">${escapeHtml(options.hint)}</span>` : ''}
  ${options.error ? `<span class="field-error" id="${errorId}" role="alert">${escapeHtml(options.error)}</span>` : ''}
</div>`;
}

/** Errors are rendered at the top as well as inline: the eye is at the top after a reload. */
function summary(errors: FieldError[], general?: string): string {
  const lines = [
    ...(general ? [general] : []),
    ...errors.map((error) => error.message),
  ];
  if (lines.length === 0) return '';
  return `<div class="alert alert-error" role="alert">
${lines.map((line) => escapeHtml(line)).join('<br>')}
</div>`;
}

function errorFor(errors: FieldError[], name: string): string | undefined {
  return errors.find((error) => error.field === name)?.message;
}

function authCard(title: string, subtitle: string, body: string, foot: string): string {
  return `<div class="pay-wrap" style="justify-content:flex-start;padding-top:2.5rem">
<div class="pay-card state-review" style="max-width:30rem;--state:transparent">
  <div class="pay-head" style="border-bottom:0;padding-bottom:0">
    <div class="pay-logo" aria-hidden="true">S</div>
    <div>
      <div class="pay-merchant">${escapeHtml(title)}</div>
      <div class="pay-meta">${escapeHtml(subtitle)}</div>
    </div>
  </div>
  <div style="margin-top:1.25rem">${body}</div>
  <div class="pay-foot" style="border-top:0;padding-top:1rem">${foot}</div>
</div></div>`;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export function loginPage(input: {
  errors?: FieldError[];
  general?: string;
  mobile?: string;
  next?: string | null;
  admin?: boolean;
} = {}): string {
  const errors = input.errors ?? [];
  const action = input.admin ? '/login?scope=admin' : '/login';

  const body = authCard(
    'ورود به Steve Pay',
    input.admin ? 'ورود مدیران' : 'پنل پذیرندگان',
    `${summary(errors, input.general)}
<form class="form" method="post" action="${escapeHtml(action)}" novalidate>
  ${input.next ? `<input type="hidden" name="next" value="${escapeHtml(input.next)}">` : ''}
  ${field({
    name: 'mobile',
    label: 'شماره موبایل',
    type: 'tel',
    inputmode: 'tel',
    autocomplete: 'username',
    required: true,
    dir: 'ltr',
    value: input.mobile ?? '',
    hint: 'همان شماره‌ای که با آن ثبت‌نام کرده‌اید. مثال: ۰۹۱۲۳۴۵۶۷۸۹',
    error: errorFor(errors, 'mobile'),
  })}
  ${field({
    name: 'password',
    label: 'گذرواژه',
    type: 'password',
    autocomplete: 'current-password',
    required: true,
    dir: 'ltr',
    error: errorFor(errors, 'password'),
  })}
  <button class="btn btn-primary" type="submit">ورود</button>
</form>`,
    `<a href="/register">حساب ندارید؟ ثبت‌نام کنید</a>
<a href="${input.admin ? '/login' : '/login?scope=admin'}" style="margin-inline-start:auto">${
      input.admin ? 'ورود پذیرندگان' : 'ورود مدیران'
    }</a>`,
  );

  return shell({ title: 'ورود — Steve Pay', bodyClass: 'state-review', noindex: true, script: false }, body);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface RegisterValues {
  mobile?: string;
  telegramUsername?: string;
  telegramUserId?: string;
  businessType?: string;
  businessDescription?: string;
  displayName?: string;
}

export function registerPage(input: {
  errors?: FieldError[];
  general?: string;
  values?: RegisterValues;
  turnstileSiteKey?: string;
} = {}): string {
  const errors = input.errors ?? [];
  const values = input.values ?? {};
  const siteKey = input.turnstileSiteKey ?? '';

  const businessOptions = BUSINESS_TYPES.map((type) => ({
    value: type,
    label: businessTypeLabel(type),
  }));

  // The widget needs Cloudflare's script, which the page's CSP allows only because the
  // response for this route is built with `turnstile: true` (see core/http.ts).
  const turnstile = siteKey
    ? `<div class="field">
  <label for="f_turnstile">تأیید امنیتی</label>
  <div id="f_turnstile" class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}" data-theme="dark"></div>
</div>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`
    : '';

  const body = authCard(
    'ثبت‌نام پذیرنده',
    'ساخت حساب جدید در Steve Pay',
    `${summary(errors, input.general)}
<div class="alert alert-info" role="status">
پس از ثبت‌نام، حساب شما در وضعیت «در انتظار تأیید» قرار می‌گیرد. تا زمانی که مدیر حساب را تأیید نکند،
ساخت کلید API و صدور فاکتور فعال نمی‌شود.
</div>
<form class="form" method="post" action="/register" novalidate>
  ${field({
    name: 'displayName',
    label: 'نام کسب‌وکار',
    autocomplete: 'organization',
    value: values.displayName ?? '',
    hint: 'این نام روی صفحه پرداخت به مشتری نشان داده می‌شود.',
    error: errorFor(errors, 'displayName'),
  })}
  ${field({
    name: 'mobile',
    label: 'شماره موبایل',
    type: 'tel',
    inputmode: 'tel',
    autocomplete: 'username',
    required: true,
    dir: 'ltr',
    value: values.mobile ?? '',
    hint: 'با این شماره وارد می‌شوید و اطلاعیه‌های حساب برایتان ارسال می‌شود.',
    error: errorFor(errors, 'mobile'),
  })}
  ${select({
    name: 'businessType',
    label: 'نوع کسب‌وکار',
    options: businessOptions,
    selected: values.businessType,
    required: true,
    hint: 'برای بررسی حساب لازم است. اگر هیچ‌کدام مناسب نیست، «سایر» را انتخاب کنید.',
    error: errorFor(errors, 'businessType'),
  })}
  ${field({
    name: 'businessDescription',
    label: 'توضیح کسب‌وکار',
    value: values.businessDescription ?? '',
    hint: 'کوتاه بنویسید چه می‌فروشید و از درگاه برای چه استفاده می‌کنید. این توضیح به بررسی و تأیید سریع‌تر حساب کمک می‌کند.',
    error: errorFor(errors, 'businessDescription'),
  })}
  ${field({
    name: 'telegramUsername',
    label: 'نام کاربری تلگرام',
    dir: 'ltr',
    autocomplete: 'off',
    value: values.telegramUsername ?? '',
    hint: 'مثال: @my_shop — اطلاعیه پرداخت‌ها به این حساب تلگرام فرستاده می‌شود.',
    error: errorFor(errors, 'telegramUsername'),
  })}
  ${field({
    name: 'telegramUserId',
    label: 'شناسه عددی تلگرام',
    dir: 'ltr',
    inputmode: 'numeric',
    autocomplete: 'off',
    value: values.telegramUserId ?? '',
    hint: 'اگر شناسه عددی خود را می‌دانید، همین را وارد کنید؛ دقیق‌تر از نام کاربری است.',
    error: errorFor(errors, 'telegramUserId'),
  })}
  ${field({
    name: 'password',
    label: 'گذرواژه',
    type: 'password',
    autocomplete: 'new-password',
    required: true,
    dir: 'ltr',
    hint: 'حداقل ۱۰ نویسه، شامل حرف بزرگ، حرف کوچک و رقم.',
    error: errorFor(errors, 'password'),
  })}
  ${field({
    name: 'confirmPassword',
    label: 'تکرار گذرواژه',
    type: 'password',
    autocomplete: 'new-password',
    required: true,
    dir: 'ltr',
    error: errorFor(errors, 'confirmPassword'),
  })}
  ${turnstile}
  <button class="btn btn-primary" type="submit">ثبت‌نام و ارسال برای تأیید</button>
</form>`,
    '<a href="/login">حساب دارید؟ وارد شوید</a>',
  );

  return shell(
    { title: 'ثبت‌نام — Steve Pay', bodyClass: 'state-review', noindex: true, script: false },
    body,
  );
}

// ---------------------------------------------------------------------------
// Registered: the holding page while an admin reviews the account
// ---------------------------------------------------------------------------

export function registeredPage(input: { merchantCode: string; mobile: string }): string {
  return shell(
    { title: 'ثبت‌نام انجام شد — Steve Pay', bodyClass: 'state-review', noindex: true, script: false },
    authCard(
      'ثبت‌نام انجام شد',
      'حساب شما در صف بررسی است',
      `<p class="pay-desc">
ثبت‌نام شما با موفقیت انجام شد. حساب شما در وضعیت <b>در انتظار تأیید</b> است و پس از بررسی مدیر فعال می‌شود.
</p>
<dl class="receipt-rows">
  <div class="receipt-row"><dt>کد پذیرنده</dt><dd class="mono">${escapeHtml(input.merchantCode)}</dd></div>
  <div class="receipt-row"><dt>شماره موبایل</dt><dd class="mono" dir="ltr">${escapeHtml(input.mobile)}</dd></div>
</dl>
<p class="pay-desc" style="font-size:.83rem;color:var(--muted)">
پس از تأیید، می‌توانید وارد شوید و کلید API بگیرید. اگر اطلاعیه تلگرام را فعال کرده باشید، تأیید حساب به شما اطلاع داده می‌شود.
</p>`,
      '<a href="/login">ورود به حساب</a>',
    ),
  );
}
