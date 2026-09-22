/**
 * Roles and permissions (§59).
 *
 * The matrix lives in code, not in the database, so that it is reviewable in a
 * pull request and testable without a fixture. `admin_permissions` exists purely
 * for per-user exceptions: a grant row adds a permission, a deny row removes one.
 *
 * The split is motivated by blast radius. A support agent needs to read a
 * merchant's history to answer a question; they do not need to move money. A
 * finance operator needs to move money; they do not need to change platform
 * settings. Only a SUPER_ADMIN can manage other admins, because that is the one
 * permission that can silently escalate anything else.
 */

export type Role = 'MERCHANT' | 'SUPER_ADMIN' | 'ADMIN' | 'SUPPORT' | 'FINANCE' | 'VIEWER';

export const ADMIN_ROLES: readonly Role[] = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'FINANCE', 'VIEWER'];
export const ALL_ROLES: readonly Role[] = ['MERCHANT', ...ADMIN_ROLES];

export type Permission =
  // merchants
  | 'merchants:read'
  | 'merchants:approve'
  | 'merchants:suspend'
  | 'merchants:reset'
  | 'merchants:impersonate'
  // api keys
  | 'api_keys:read'
  | 'api_keys:manage'
  // invoices / payments
  | 'invoices:read'
  | 'invoices:cancel'
  | 'transactions:read'
  | 'transactions:confirm'
  | 'transactions:reject'
  | 'review:read'
  | 'review:resolve'
  // wallet
  | 'wallets:read'
  | 'wallets:credit'
  | 'wallets:debit'
  // support
  | 'tickets:read'
  | 'tickets:reply'
  | 'tickets:assign'
  | 'tickets:close'
  // comms
  | 'notifications:send'
  | 'telegram:manage'
  // reporting
  | 'reports:read'
  | 'reports:export'
  | 'audit:read'
  // platform
  | 'settings:read'
  | 'settings:write'
  | 'system:health'
  | 'webhooks:retry'
  | 'sms:read'
  | 'cards:read'
  | 'admins:manage';

export const ALL_PERMISSIONS: readonly Permission[] = [
  'merchants:read',
  'merchants:approve',
  'merchants:suspend',
  'merchants:reset',
  'merchants:impersonate',
  'api_keys:read',
  'api_keys:manage',
  'invoices:read',
  'invoices:cancel',
  'transactions:read',
  'transactions:confirm',
  'transactions:reject',
  'review:read',
  'review:resolve',
  'wallets:read',
  'wallets:credit',
  'wallets:debit',
  'tickets:read',
  'tickets:reply',
  'tickets:assign',
  'tickets:close',
  'notifications:send',
  'telegram:manage',
  'reports:read',
  'reports:export',
  'audit:read',
  'settings:read',
  'settings:write',
  'system:health',
  'webhooks:retry',
  'sms:read',
  'cards:read',
  'admins:manage',
];

const READ_ONLY: readonly Permission[] = [
  'merchants:read',
  'api_keys:read',
  'invoices:read',
  'transactions:read',
  'review:read',
  'wallets:read',
  'tickets:read',
  'reports:read',
  'audit:read',
  'settings:read',
  'system:health',
  'sms:read',
  'cards:read',
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  // A merchant's own account is governed by ownership checks in the services, not
  // by this admin matrix. An empty set here is what keeps a MERCHANT from being
  // treated as a member of staff by an accidental role comparison.
  MERCHANT: [],

  SUPER_ADMIN: ALL_PERMISSIONS,

  // Everything an operator needs day to day, except managing other admins.
  ADMIN: ALL_PERMISSIONS.filter((permission) => permission !== 'admins:manage'),

  // Answers questions. Cannot move money (no wallets:credit/debit, no
  // transactions:confirm) and cannot change platform configuration.
  SUPPORT: [
    'merchants:read',
    'api_keys:read',
    'invoices:read',
    'transactions:read',
    'review:read',
    'wallets:read',
    'tickets:read',
    'tickets:reply',
    'tickets:assign',
    'tickets:close',
    'notifications:send',
    'reports:read',
    'sms:read',
    'cards:read',
    'system:health',
    'webhooks:retry',
  ],

  // Moves money and reconciles it. Cannot read tickets, cannot change settings.
  FINANCE: [
    'merchants:read',
    'invoices:read',
    'transactions:read',
    'review:read',
    'review:resolve',
    'wallets:read',
    'wallets:credit',
    'wallets:debit',
    'reports:read',
    'reports:export',
    'audit:read',
    'settings:read',
    'system:health',
    'cards:read',
  ],

  // Sees everything read-only and can change nothing.
  VIEWER: READ_ONLY,
};

export interface PermissionOverride {
  permission: Permission;
  granted: boolean;
}

/**
 * Resolves the effective permission set: role defaults, then per-user overrides.
 * A deny always wins over a grant, so the only way to take a permission away from
 * a role is to add a deny row — which requires admins:manage to create.
 */
export function effectivePermissions(
  role: Role,
  overrides: readonly PermissionOverride[] = [],
): Set<Permission> {
  const set = new Set<Permission>(ROLE_PERMISSIONS[role] ?? []);
  for (const override of overrides) {
    if (override.granted) set.add(override.permission);
    else set.delete(override.permission);
  }
  return set;
}

export function hasPermission(
  role: Role,
  permission: Permission,
  overrides: readonly PermissionOverride[] = [],
): boolean {
  return effectivePermissions(role, overrides).has(permission);
}

export function isAdminRole(role: Role): boolean {
  return ADMIN_ROLES.includes(role);
}

/** Wildcard support for API key scopes, which use the same vocabulary. */
export function scopesAllow(scopes: readonly string[], permission: string): boolean {
  if (scopes.includes('*')) return true;
  if (scopes.includes(permission)) return true;
  // 'payments:create' also satisfies a request for 'payments:create:any'
  const namespace = permission.split(':')[0];
  return scopes.includes(`${namespace}:*`);
}

const ROLE_LABELS_FA: Record<Role, string> = {
  MERCHANT: 'پذیرنده',
  SUPER_ADMIN: 'مدیر ارشد',
  ADMIN: 'مدیر',
  SUPPORT: 'پشتیبان',
  FINANCE: 'مالی',
  VIEWER: 'بازدیدکننده',
};

export function roleLabelFa(role: Role): string {
  return ROLE_LABELS_FA[role] ?? role;
}

const PERMISSION_LABELS_FA: Partial<Record<Permission, string>> = {
  'merchants:read': 'مشاهده پذیرندگان',
  'merchants:approve': 'تأیید پذیرنده',
  'merchants:suspend': 'تعلیق پذیرنده',
  'merchants:reset': 'بازنشانی حساب',
  'api_keys:read': 'مشاهده کلیدهای API',
  'api_keys:manage': 'مدیریت کلیدهای API',
  'invoices:read': 'مشاهده فاکتورها',
  'invoices:cancel': 'لغو فاکتور',
  'transactions:read': 'مشاهده تراکنش‌ها',
  'transactions:confirm': 'تأیید تراکنش',
  'transactions:reject': 'رد تراکنش',
  'review:read': 'مشاهده بررسی‌های دستی',
  'review:resolve': 'رسیدگی به بررسی دستی',
  'wallets:read': 'مشاهده کیف پول',
  'wallets:credit': 'افزایش موجودی',
  'wallets:debit': 'کاهش موجودی',
  'tickets:read': 'مشاهده تیکت‌ها',
  'tickets:reply': 'پاسخ به تیکت',
  'tickets:assign': 'ارجاع تیکت',
  'tickets:close': 'بستن تیکت',
  'notifications:send': 'ارسال اطلاعیه',
  'telegram:manage': 'مدیریت تلگرام',
  'reports:read': 'مشاهده گزارش‌ها',
  'reports:export': 'خروجی گزارش',
  'audit:read': 'مشاهده لاگ حسابرسی',
  'settings:read': 'مشاهده تنظیمات',
  'settings:write': 'تغییر تنظیمات',
  'system:health': 'سلامت سامانه',
  'webhooks:retry': 'تلاش دوباره وب‌هوک',
  'sms:read': 'مشاهده پیامک‌ها',
  'cards:read': 'مشاهده کارت‌ها',
  'admins:manage': 'مدیریت مدیران',
};

export function permissionLabelFa(permission: Permission): string {
  return PERMISSION_LABELS_FA[permission] ?? permission;
}
