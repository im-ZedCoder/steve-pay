/**
 * Registration and login (§4, §5).
 *
 * Both are plain HTML forms that post to the server and re-render with an error. No
 * client-side validation: the server is the only authority on whether a mobile number is
 * usable or a password is strong enough, so duplicating those rules in the browser would
 * only create a second version to keep in sync. The one script these pages load is for the
 * password reveal — an affordance, not a rule, and the only thing here that cannot be done
 * without it.
 *
 * The arrangement is two columns. A single centred form on a wide screen is a small card
 * floating in an empty room, and the registration form in that shape is a sixty-rem-tall
 * column of inputs with nothing anywhere to say why. The aside answers the question someone
 * hesitating on this page is actually asking, and it is hidden below 900px, where the form
 * should simply be the page.
 *
 * Every input carries `autocomplete` hints and `aria-describedby` on its hint or error, so
 * password managers fill them correctly and a screen reader announces the reason a field was
 * rejected rather than just its name. A field shows its hint OR its error, never both.
 */

import { escapeHtml } from '../../core/http';
import { toPersianDigits } from '../../core/digits';
import { BUSINESS_TYPES, businessTypeLabel } from '../../core/validation';
import { shell } from '../layout';

export interface FieldError {
  field: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

/** Small stroke icons at 14px. Inline because they are four paths, not a sprite sheet. */
function icon(path: string, size = 14): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor"
stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

const ICON_ALERT = icon('<circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/>');
const ICON_EXCLAIM = icon(
  '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
);
const ICON_EYE = icon('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>');
const ICON_EYE_OFF = icon(
  '<path d="M10.6 5.2A9.9 9.9 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3 4.1M6.2 6.4A17.4 17.4 0 0 0 2 12s3.6 7 10 7a9.9 9.9 0 0 0 4.3-.9"/><path d="m3 3 18 18"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
);

/**
 * Field labels, for the error summary.
 *
 * The summary names the field a reader has to go back to, so it needs the same words the
 * label above the input uses. A map is the only way to keep those two in step when the
 * label lives at the call site and the error lives in a server response.
 */
const FIELD_LABELS: Record<string, string> = {
  mobile: 'شماره موبایل',
  password: 'گذرواژه',
  confirmPassword: 'تکرار گذرواژه',
  displayName: 'نام کسب‌وکار',
  businessType: 'نوع کسب‌وکار',
  businessDescription: 'توضیح کسب‌وکار',
  telegramUsername: 'نام کاربری تلگرام',
  telegramUserId: 'شناسه عددی تلگرام',
  turnstile: 'تأیید امنیتی',
};

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

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
  /** Renders the reveal button and points it at this field. */
  reveal?: boolean;
}

function describedBy(id: string, hint?: string, error?: string): string {
  const ids = [
    error ? `${id}_error` : '',
    // The hint is not rendered when there is an error, so it must not be referenced either.
    !error && hint ? `${id}_hint` : '',
  ].filter(Boolean);
  return ids.length ? ` aria-describedby="${ids.join(' ')}"` : '';
}

function field(options: FieldOptions): string {
  const id = `f_${options.name}`;
  const input = `<input
    class="input"
    id="${id}"
    name="${escapeHtml(options.name)}"
    type="${escapeHtml(options.type ?? 'text')}"
    ${options.value !== undefined ? `value="${escapeHtml(options.value)}"` : ''}
    ${options.required ? 'required' : ''}
    ${options.autocomplete ? `autocomplete="${escapeHtml(options.autocomplete)}"` : ''}
    ${options.inputmode ? `inputmode="${escapeHtml(options.inputmode)}"` : ''}
    ${options.dir ? `dir="${escapeHtml(options.dir)}"` : ''}
    ${describedBy(id, options.hint, options.error)}
    ${options.error ? 'aria-invalid="true"' : ''}
  >`;

  const reveal = options.reveal
    ? `<button class="pw-toggle" type="button" data-pw-toggle="${id}" aria-pressed="false"
      aria-label="نمایش گذرواژه" title="نمایش گذرواژه">
      <span class="pw-eye">${ICON_EYE}</span><span class="pw-eye-off">${ICON_EYE_OFF}</span>
    </button>`
    : '';

  return `<div class="field">
  <label for="${id}">${escapeHtml(options.label)}${
    options.required ? '' : ' <span class="hint">(اختیاری)</span>'
  }</label>
  ${reveal ? `<div class="input-wrap">${input}${reveal}</div>` : input}
  ${
    /*
     * The hint and the error occupy the same slot, and the error wins.
     *
     * They used to render together, which is the worst of both: the field grew by two lines,
     * the error sat underneath a paragraph of explanation, and the one sentence that needed
     * acting on was the second thing the eye reached. A field says one thing about itself at
     * a time.
     */
    options.error
      ? `<span class="field-error" id="${id}_error" role="alert">${ICON_ALERT}<span>${escapeHtml(options.error)}</span></span>`
      : options.hint
        ? `<span class="hint" id="${id}_hint">${escapeHtml(options.hint)}</span>`
        : ''
  }
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
  <label for="${id}">${escapeHtml(options.label)}${
    options.required ? '' : ' <span class="hint">(اختیاری)</span>'
  }</label>
  <select class="input" id="${id}" name="${escapeHtml(options.name)}"${
    options.required ? ' required' : ''
  }${describedBy(id, options.hint, options.error)}${
    options.error ? ' aria-invalid="true"' : ''
  }>${items}</select>
  ${
    options.error
      ? `<span class="field-error" id="${id}_error" role="alert">${ICON_ALERT}<span>${escapeHtml(options.error)}</span></span>`
      : options.hint
        ? `<span class="hint" id="${id}_hint">${escapeHtml(options.hint)}</span>`
        : ''
  }
</div>`;
}

/**
 * The error summary: an index, not a second copy of the form.
 *
 * It used to be every message joined by line breaks with no field names, printed above
 * fields that then repeated each message verbatim — so the reader got the same sentences
 * twice and, in the summary, no way to tell which field the third one belonged to. Each line
 * now names its field and links to it, so the summary does the one job a summary has: get the
 * reader to the thing that needs fixing.
 */
function summary(errors: FieldError[], general?: string): string {
  if (errors.length === 0 && !general) return '';
  /*
   * A headline that repeats the first bullet is not a headline.
   *
   * A validation failure arrives as one error carrying a field, and the route passes its
   * message as both the general message and the field's own error — so the reader got the
   * same sentence twice, the second time unlabelled, and the summary grew a line without
   * adding a fact. When the general message is already in the list, the list speaks for
   * itself.
   */
  const repeated = general !== undefined && errors.some((error) => error.message === general);
  const items = errors
    .map((error) => {
      const label = FIELD_LABELS[error.field];
      return label
        ? `<li><a href="#f_${escapeHtml(error.field)}">${escapeHtml(label)}</a>: ${escapeHtml(error.message)}</li>`
        : `<li>${escapeHtml(error.message)}</li>`;
    })
    .join('');
  const headline =
    general !== undefined && !repeated
      ? general
      : `${toPersianDigits(errors.length)} مورد در فرم نیاز به اصلاح دارد.`;
  return `<div class="error-summary" role="alert">
  <b>${ICON_EXCLAIM}<span>${escapeHtml(headline)}</span></b>
  ${items ? `<ul>${items}</ul>` : ''}
</div>`;
}

function errorFor(errors: FieldError[], name: string): string | undefined {
  return errors.find((error) => error.field === name)?.message;
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

function brandRow(backLabel: string, backHref: string): string {
  return `<div class="auth-mark">
  <span class="brand-tile" aria-hidden="true">S</span>
  <div class="auth-mark-text">
    <b>Steve Gate</b>
    <span>درگاه پرداخت کارت‌به‌کارت</span>
  </div>
  <a class="auth-out" href="${escapeHtml(backHref)}">${escapeHtml(backLabel)}</a>
</div>`;
}

function authLayout(options: {
  title: string;
  subtitle: string;
  body: string;
  foot: string;
  /** The second column. Hidden below 900px, where the form is the whole page. */
  aside: string;
  backLabel: string;
  backHref: string;
}): string {
  return `<div class="auth-shell">
  <div class="auth-col">
    ${brandRow(options.backLabel, options.backHref)}
    <section class="auth-card">
      <div class="auth-card-head">
        <div>
          <b>${escapeHtml(options.title)}</b>
          <span>${escapeHtml(options.subtitle)}</span>
        </div>
      </div>
      <div class="auth-body">${options.body}</div>
      <div class="auth-foot">${options.foot}</div>
    </section>
  </div>
  <aside class="auth-aside">${options.aside}</aside>
</div>`;
}

/** The value proposition, written for whoever is looking at the form. */
function asideFor(scope: 'merchant' | 'admin'): string {
  const features =
    scope === 'merchant'
      ? [
          ['تأیید خودکار پرداخت', 'پیامک واریز بانک خوانده می‌شود و فاکتور خودکار تأیید می‌گردد.'],
          ['کلید API و وب‌هوک', 'یک درخواست برای ساخت فاکتور، یک وب‌هوک برای نتیجه‌اش.'],
          ['دفتر کل شفاف', 'هر پرداخت، کارمزد و تسویه با شناسه قابل پیگیری است.'],
        ]
      : [
          ['صف بررسی', 'پرداخت‌هایی که تطبیق خودکار روی آن‌ها مطمئن نبود، همین‌جا تصمیم می‌گیرند.'],
          ['تأیید پذیرنده', 'هیچ حسابی بدون تأیید شما فعال نمی‌شود و کلید API نمی‌گیرد.'],
          ['گزارش درآمد', 'درآمد درگاه و حجم تأییدشده، از خود پرداخت‌های تأییدشده.'],
        ];

  return `<h1 class="auth-heading">
  <span>${scope === 'merchant' ? 'همه‌ی پرداخت‌های فروشگاه،' : 'کنسول مدیریت درگاه،'}</span>
  <em>${scope === 'merchant' ? 'بدون پیگیری دستی' : 'بدون ابزار جانبی'}</em>
</h1>
<p class="auth-lede">
${
  scope === 'merchant'
    ? 'پس از ورود، فاکتور می‌سازید، شماره کارت مقصد را تعیین می‌کنید و نتیجه‌ی هر پرداخت را همان‌جا می‌بینید.'
    : 'ورود مدیران به صف بررسی، تأیید پذیرندگان و گزارش درآمد درگاه.'
}
</p>
<ul class="auth-features">${features
    .map(
      ([title, body]) => `<li>
  <span class="pay-num" aria-hidden="true">✓</span>
  <span><b>${escapeHtml(title)}</b><span>${escapeHtml(body)}</span></span>
</li>`,
    )
    .join('')}</ul>
<div class="auth-trust">
  <span>تأیید خودکار از پیامک بانک</span>
  <span>کلید API قابل لغو</span>
  <span>بدون ذخیره‌ی شماره کارت مشتری</span>
</div>`;
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
  const scope = input.admin ? 'admin' : 'merchant';

  const body = `${summary(errors, input.general)}
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
    hint: 'همان شماره‌ای که با آن ثبت‌نام کرده‌اید.',
    error: errorFor(errors, 'mobile'),
  })}
  ${field({
    name: 'password',
    label: 'گذرواژه',
    type: 'password',
    autocomplete: 'current-password',
    required: true,
    dir: 'ltr',
    reveal: true,
    error: errorFor(errors, 'password'),
  })}
  <button class="btn btn-primary form-submit" type="submit">ورود</button>
</form>`;

  const foot = `<a href="/register">حساب ندارید؟ ثبت‌نام کنید</a>
<a class="auth-out" href="${input.admin ? '/login' : '/login?scope=admin'}">${
    input.admin ? 'ورود پذیرندگان' : 'ورود مدیران'
  }</a>`;

  return shell(
    {
      title: input.admin ? 'ورود مدیران — Steve Gate' : 'ورود — Steve Gate',
      bodyClass: 'state-review',
      noindex: true,
      aurora: true,
    },
    authLayout({
      title: input.admin ? 'ورود مدیران' : 'ورود به Steve Gate',
      subtitle: input.admin ? 'کنسول مدیریت درگاه' : 'پنل پذیرندگان',
      body,
      foot,
      aside: asideFor(scope),
      backLabel: 'بازگشت به سایت',
      backHref: '/',
    }),
  );
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
  //
  // The label is a span, not a `<label for>`: `for` must point at a labelable element and
  // the widget renders a div, so the association was invalid and assistive technology
  // ignored it. An explicit group label is the correct shape for a third-party control.
  const turnstile = siteKey
    ? `<div class="field" role="group" aria-label="تأیید امنیتی">
  <span class="field-label">تأیید امنیتی</span>
  <div class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}" data-theme="dark"></div>
</div>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`
    : '';

  /*
   * Eight fields in one stack is a wall; the same eight under three headings is a form, and
   * the headings are what let a person stop halfway and come back. The groups are the order
   * an applicant actually has the answers in: who they are, how to reach them, and the
   * password they are choosing.
   */
  const body = `${summary(errors, input.general)}
<div class="alert alert-info" role="status">
پس از ثبت‌نام، حساب شما در وضعیت «در انتظار تأیید» قرار می‌گیرد. تا زمانی که مدیر حساب را تأیید نکند،
ساخت کلید API و صدور فاکتور فعال نمی‌شود.
</div>
<form class="form" method="post" action="/register" novalidate>
  <fieldset class="form-group">
    <legend>کسب‌وکار <span>این نام روی صفحه پرداخت به مشتری نشان داده می‌شود</span></legend>
    <div class="fields">
      ${field({
        name: 'displayName',
        label: 'نام کسب‌وکار',
        autocomplete: 'organization',
        value: values.displayName ?? '',
        hint: 'مثال: فروشگاه دیجی استور',
        error: errorFor(errors, 'displayName'),
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
    </div>
  </fieldset>

  <fieldset class="form-group">
    <legend>راه ارتباطی <span>برای ورود و اطلاعیه‌ها</span></legend>
    <div class="fields">
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
    </div>
  </fieldset>

  <fieldset class="form-group">
    <legend>گذرواژه <span>حداقل ۱۰ نویسه، شامل حرف بزرگ، حرف کوچک و رقم</span></legend>
    <div class="fields">
      ${field({
        name: 'password',
        label: 'گذرواژه',
        type: 'password',
        autocomplete: 'new-password',
        required: true,
        dir: 'ltr',
        reveal: true,
        error: errorFor(errors, 'password'),
      })}
      ${field({
        name: 'confirmPassword',
        label: 'تکرار گذرواژه',
        type: 'password',
        autocomplete: 'new-password',
        required: true,
        dir: 'ltr',
        reveal: true,
        error: errorFor(errors, 'confirmPassword'),
      })}
    </div>
  </fieldset>

  ${turnstile}
  <button class="btn btn-primary form-submit" type="submit">ثبت‌نام و ارسال برای تأیید</button>
</form>`;

  return shell(
    { title: 'ثبت‌نام — Steve Gate', bodyClass: 'state-review', noindex: true, aurora: true },
    authLayout({
      title: 'ثبت‌نام پذیرنده',
      subtitle: 'ساخت حساب جدید در Steve Gate',
      body,
      foot: '<a href="/login">حساب دارید؟ وارد شوید</a>',
      aside: asideFor('merchant'),
      backLabel: 'بازگشت به سایت',
      backHref: '/',
    }),
  );
}

// ---------------------------------------------------------------------------
// Registered: the holding page while an admin reviews the account
// ---------------------------------------------------------------------------

export function registeredPage(input: { merchantCode: string; mobile: string }): string {
  return shell(
    {
      title: 'ثبت‌نام انجام شد — Steve Gate',
      bodyClass: 'state-review',
      noindex: true,
      aurora: true,
    },
    authLayout({
      title: 'ثبت‌نام انجام شد',
      subtitle: 'حساب شما در صف بررسی است',
      body: `<p class="pay-desc" style="margin:0">
ثبت‌نام شما با موفقیت انجام شد. حساب شما در وضعیت <b>در انتظار تأیید</b> است و پس از بررسی مدیر فعال می‌شود.
</p>
<dl class="receipt-rows">
  <div class="receipt-row"><dt>کد پذیرنده</dt><dd class="mono">${escapeHtml(input.merchantCode)}</dd></div>
  <div class="receipt-row"><dt>شماره موبایل</dt><dd class="mono">${escapeHtml(input.mobile)}</dd></div>
</dl>
<p class="hint">
پس از تأیید، می‌توانید وارد شوید و کلید API بگیرید. اگر اطلاعیه تلگرام را فعال کرده باشید، تأیید حساب به شما اطلاع داده می‌شود.
</p>`,
      foot: '<a href="/login">ورود به حساب</a>',
      aside: asideFor('merchant'),
      backLabel: 'بازگشت به سایت',
      backHref: '/',
    }),
  );
}
