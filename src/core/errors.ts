/**
 * Standardised API errors (§43).
 *
 * Every failure a merchant can observe has a stable machine-readable `code`, an
 * HTTP status, and a human-readable message. Codes are part of the public API
 * contract: once a code ships it is never repurposed for a different meaning.
 *
 * Messages are written for the person reading them: they say what happened and
 * what to do next, they do not apologise, and they never leak an internal
 * detail. Stack traces are logged, never returned.
 */

export type ErrorCode =
  // request shape
  | 'INVALID_REQUEST'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  // authentication / authorisation
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'SESSION_EXPIRED'
  | 'ACCOUNT_PENDING_APPROVAL'
  | 'ACCOUNT_REJECTED'
  | 'ACCOUNT_SUSPENDED'
  | 'ACCOUNT_BANNED'
  | 'ACCOUNT_LOCKED'
  | 'FORBIDDEN'
  | 'PERMISSION_DENIED'
  | 'INVALID_API_KEY'
  | 'API_KEY_REVOKED'
  | 'API_KEY_EXPIRED'
  | 'API_KEY_ENVIRONMENT_MISMATCH'
  | 'INSUFFICIENT_SCOPE'
  | 'IP_NOT_ALLOWED'
  | 'TURNSTILE_FAILED'
  | 'REGISTRATION_DISABLED'
  | 'DUPLICATE_MOBILE'
  // invoices and payments
  | 'INVOICE_NOT_FOUND'
  | 'INVOICE_EXPIRED'
  | 'INVOICE_ALREADY_PAID'
  | 'INVOICE_CANCELLED'
  | 'INVOICE_NOT_PAYABLE'
  | 'INVOICE_UNDER_REVIEW'
  | 'PAYMENT_NOT_FOUND'
  | 'INVALID_AMOUNT'
  | 'AMOUNT_BELOW_MINIMUM'
  | 'AMOUNT_ABOVE_MAXIMUM'
  | 'CURRENCY_NOT_SUPPORTED'
  | 'INVALID_FEE_MODE'
  | 'INVALID_EXPIRY'
  | 'AMOUNT_SPACE_EXHAUSTED'
  // wallet
  | 'WALLET_NOT_FOUND'
  | 'INSUFFICIENT_WALLET_BALANCE'
  | 'LEDGER_CONFLICT'
  | 'LEDGER_ALREADY_APPLIED'
  // cards
  | 'CARD_INVALID'
  | 'CARD_DUPLICATE'
  | 'CARD_NOT_FOUND'
  | 'CARD_LIMIT_REACHED'
  | 'CARD_REQUIRED'
  // sms
  | 'SMS_INVALID_PAYLOAD'
  | 'SMS_TOO_LARGE'
  | 'SMS_DUPLICATE'
  | 'SMS_UNPARSEABLE'
  | 'SMS_TEST_TOKEN_INVALID'
  // webhooks
  | 'CALLBACK_URL_NOT_ALLOWED'
  | 'WEBHOOK_NOT_FOUND'
  | 'WEBHOOK_NOT_CONFIGURED'
  // idempotency / limits
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RATE_LIMITED'
  // transactions
  | 'TRANSACTION_NOT_FOUND'
  | 'DUPLICATE_TRANSACTION'
  | 'STATE_TRANSITION_INVALID'
  // tickets
  | 'TICKET_NOT_FOUND'
  | 'TICKET_CLOSED'
  // platform
  | 'MAINTENANCE_MODE'
  | 'SETTING_INVALID'
  | 'DATABASE_ERROR'
  | 'INTERNAL_ERROR'
  | 'NOT_IMPLEMENTED';

interface ErrorSpec {
  status: number;
  message: string;
  /** Safe to show to an unauthenticated visitor (public invoice pages, register, login). */
  public?: boolean;
}

/**
 * The single source of truth for code -> status + messaging.
 * `public` marks codes whose message may be rendered on a public page.
 */
export const ERROR_SPECS: Record<ErrorCode, ErrorSpec> = {
  INVALID_REQUEST: { status: 400, message: 'درخواست نامعتبر است.', public: true },
  VALIDATION_FAILED: { status: 422, message: 'داده‌های ارسالی معتبر نیست.', public: true },
  NOT_FOUND: { status: 404, message: 'منبع مورد نظر پیدا نشد.', public: true },

  UNAUTHENTICATED: { status: 401, message: 'برای این درخواست باید وارد شده باشید.', public: true },
  INVALID_CREDENTIALS: { status: 401, message: 'شماره موبایل یا گذرواژه نادرست است.', public: true },
  SESSION_EXPIRED: { status: 401, message: 'نشست شما منقضی شده است. دوباره وارد شوید.', public: true },
  ACCOUNT_PENDING_APPROVAL: {
    status: 403,
    message: 'حساب شما در انتظار تأیید مدیر است.',
    public: true,
  },
  ACCOUNT_REJECTED: { status: 403, message: 'درخواست حساب شما پذیرفته نشد.', public: true },
  ACCOUNT_SUSPENDED: { status: 403, message: 'حساب شما موقتاً غیرفعال شده است.', public: true },
  ACCOUNT_BANNED: { status: 403, message: 'دسترسی این حساب مسدود شده است.', public: true },
  ACCOUNT_LOCKED: {
    status: 403,
    message: 'به دلیل تلاش‌های ناموفق، حساب موقتاً قفل شده است.',
    public: true,
  },
  FORBIDDEN: { status: 403, message: 'به این بخش دسترسی ندارید.', public: true },
  PERMISSION_DENIED: { status: 403, message: 'برای این کار مجوز لازم را ندارید.' },
  INVALID_API_KEY: { status: 401, message: 'کلید API نامعتبر است.' },
  API_KEY_REVOKED: { status: 401, message: 'این کلید API باطل شده است.' },
  API_KEY_EXPIRED: { status: 401, message: 'این کلید API منقضی شده است.' },
  API_KEY_ENVIRONMENT_MISMATCH: {
    status: 401,
    message: 'کلید API با محیط درخواستی هم‌خوانی ندارد.',
  },
  INSUFFICIENT_SCOPE: { status: 403, message: 'این کلید API به این عملیات دسترسی ندارد.' },
  IP_NOT_ALLOWED: { status: 403, message: 'درخواست از IP مجاز ارسال نشده است.' },
  TURNSTILE_FAILED: { status: 400, message: 'تأیید امنیتی ناموفق بود. دوباره تلاش کنید.', public: true },
  REGISTRATION_DISABLED: {
    status: 403,
    message: 'ثبت‌نام کاربر جدید در حال حاضر بسته است.',
    public: true,
  },
  DUPLICATE_MOBILE: { status: 409, message: 'این شماره موبایل قبلاً ثبت شده است.', public: true },

  INVOICE_NOT_FOUND: { status: 404, message: 'فاکتور مورد نظر پیدا نشد.', public: true },
  INVOICE_EXPIRED: { status: 410, message: 'مهلت پرداخت این فاکتور به پایان رسیده است.', public: true },
  INVOICE_ALREADY_PAID: { status: 409, message: 'این فاکتور قبلاً پرداخت شده است.', public: true },
  INVOICE_CANCELLED: { status: 410, message: 'این فاکتور لغو شده است.', public: true },
  INVOICE_NOT_PAYABLE: {
    status: 409,
    message: 'این فاکتور در وضعیت قابل پرداخت نیست.',
    public: true,
  },
  INVOICE_UNDER_REVIEW: {
    status: 409,
    message: 'پرداخت این فاکتور در حال بررسی دستی است.',
    public: true,
  },
  PAYMENT_NOT_FOUND: { status: 404, message: 'پرداخت مورد نظر پیدا نشد.' },
  INVALID_AMOUNT: { status: 400, message: 'مبلغ نامعتبر است. مبلغ باید عددی صحیح به تومان باشد.' },
  AMOUNT_BELOW_MINIMUM: { status: 400, message: 'مبلغ از حداقل مجاز کمتر است.' },
  AMOUNT_ABOVE_MAXIMUM: { status: 400, message: 'مبلغ از حداکثر مجاز بیشتر است.' },
  CURRENCY_NOT_SUPPORTED: { status: 400, message: 'فقط واحد تومان (IRT) پشتیبانی می‌شود.' },
  INVALID_FEE_MODE: { status: 400, message: 'حالت کارمزد باید CUSTOMER یا MERCHANT باشد.' },
  INVALID_EXPIRY: { status: 400, message: 'مدت اعتبار فاکتور خارج از بازه مجاز است.' },
  AMOUNT_SPACE_EXHAUSTED: {
    status: 503,
    message: 'ظرفیت تولید مبلغ یکتا در این لحظه تکمیل است. چند لحظه بعد دوباره تلاش کنید.',
  },

  WALLET_NOT_FOUND: { status: 404, message: 'کیف پول این حساب پیدا نشد.' },
  INSUFFICIENT_WALLET_BALANCE: {
    status: 402,
    message: 'موجودی کیف پول برای ساخت فاکتور کافی نیست.',
  },
  LEDGER_CONFLICT: { status: 409, message: 'تناقض در دفتر کل کیف پول.' },
  LEDGER_ALREADY_APPLIED: { status: 200, message: 'این تراکنش قبلاً در دفتر کل ثبت شده است.' },

  CARD_INVALID: { status: 400, message: 'شماره کارت معتبر نیست.' },
  CARD_DUPLICATE: { status: 409, message: 'این کارت قبلاً ثبت شده است.' },
  CARD_NOT_FOUND: { status: 404, message: 'کارت مورد نظر پیدا نشد.' },
  CARD_LIMIT_REACHED: { status: 409, message: 'تعداد کارت‌های ثبت‌شده به سقف رسیده است.' },
  CARD_REQUIRED: {
    status: 409,
    message: 'برای ساخت فاکتور باید حداقل یک کارت فعال ثبت کنید.',
  },

  SMS_INVALID_PAYLOAD: { status: 400, message: 'ساختار پیامک ارسالی نامعتبر است.' },
  SMS_TOO_LARGE: { status: 413, message: 'متن پیامک بیش از حد مجاز طولانی است.' },
  SMS_DUPLICATE: { status: 200, message: 'این پیامک قبلاً دریافت و پردازش شده است.' },
  SMS_UNPARSEABLE: { status: 200, message: 'پیامک دریافت شد اما قابل تفسیر نبود.' },
  SMS_TEST_TOKEN_INVALID: { status: 400, message: 'توکن آزمایشی پیامک نامعتبر یا منقضی است.' },

  CALLBACK_URL_NOT_ALLOWED: {
    status: 400,
    message: 'آدرس بازگشت باید HTTPS و متعلق به دامنه ثبت‌شده شما باشد.',
  },
  WEBHOOK_NOT_FOUND: { status: 404, message: 'وب‌هوک مورد نظر پیدا نشد.' },
  WEBHOOK_NOT_CONFIGURED: {
    status: 409,
    message: 'برای این حساب وب‌هوکی تنظیم نشده است.',
  },

  IDEMPOTENCY_KEY_REQUIRED: {
    status: 400,
    message: 'برای ساخت پرداخت، هدر Idempotency-Key الزامی است.',
  },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    message: 'این Idempotency-Key قبلاً با درخواست دیگری استفاده شده است.',
  },
  RATE_LIMITED: { status: 429, message: 'تعداد درخواست‌ها از حد مجاز بیشتر است.' },

  TRANSACTION_NOT_FOUND: { status: 404, message: 'تراکنش مورد نظر پیدا نشد.' },
  DUPLICATE_TRANSACTION: {
    status: 409,
    message: 'این تراکنش بانکی قبلاً ثبت و تسویه شده است.',
  },
  STATE_TRANSITION_INVALID: { status: 409, message: 'این تغییر وضعیت مجاز نیست.' },

  TICKET_NOT_FOUND: { status: 404, message: 'تیکت مورد نظر پیدا نشد.' },
  TICKET_CLOSED: { status: 409, message: 'این تیکت بسته شده است. برای ادامه، تیکت تازه بسازید.' },

  MAINTENANCE_MODE: { status: 503, message: 'سرویس موقتاً در حالت تعمیر است.' },
  SETTING_INVALID: { status: 400, message: 'مقدار تنظیمات معتبر نیست.' },
  DATABASE_ERROR: { status: 500, message: 'خطای داخلی پایگاه داده.' },
  INTERNAL_ERROR: { status: 500, message: 'خطای داخلی سرور.' },
  NOT_IMPLEMENTED: { status: 501, message: 'این قابلیت فعال نیست.' },
};

/** Extra context attached to an error. Never contains secrets or stack traces. */
export interface ErrorDetails {
  [key: string]: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetails;
  readonly public: boolean;
  /** Set by the request middleware so logs, responses and audit rows share one id. */
  requestId?: string;

  constructor(code: ErrorCode, options?: { message?: string; details?: ErrorDetails; cause?: unknown }) {
    const spec = ERROR_SPECS[code];
    super(options?.message ?? spec.message);
    this.name = 'AppError';
    this.code = code;
    this.status = spec.status;
    this.details = options?.details ?? {};
    this.public = spec.public === true;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Narrow helper so services read as `fail('INVOICE_EXPIRED', {...})`. */
export function fail(code: ErrorCode, details?: ErrorDetails): never {
  throw new AppError(code, { details });
}

export interface ApiErrorBody {
  success: false;
  code: ErrorCode;
  message: string;
  requestId: string;
  details?: ErrorDetails;
}

/**
 * Shapes an error for the wire. Unexpected errors collapse to INTERNAL_ERROR so a
 * driver message or stack fragment can never reach a merchant.
 */
export function toApiErrorBody(
  error: unknown,
  requestId: string,
): { status: number; body: ApiErrorBody } {
  if (isAppError(error)) {
    const body: ApiErrorBody = {
      success: false,
      code: error.code,
      message: error.message,
      requestId,
    };
    if (Object.keys(error.details).length > 0) body.details = error.details;
    return { status: error.status, body };
  }
  return {
    status: 500,
    body: {
      success: false,
      code: 'INTERNAL_ERROR',
      message: ERROR_SPECS.INTERNAL_ERROR.message,
      requestId,
    },
  };
}

/** Human-facing string for a code, for pages that render a failure state. */
export function messageFor(code: ErrorCode): string {
  return ERROR_SPECS[code].message;
}
