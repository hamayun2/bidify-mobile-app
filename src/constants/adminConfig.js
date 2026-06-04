/**
 * Built-in admin account (dev defaults). Override via Expo env at build time.
 * Do NOT use production passwords in client bundles — set EXPO_PUBLIC_BUILTIN_ADMIN_* only for dev builds.
 */

function readEnv(name) {
  try {
    const v = process.env[name];
    return typeof v === 'string' ? v.trim() : '';
  } catch {
    return '';
  }
}

export const BUILTIN_ADMIN_EMAIL =
  readEnv('EXPO_PUBLIC_BUILTIN_ADMIN_EMAIL') ||
  readEnv('EXPO_PUBLIC_ADMIN_EMAIL') ||
  'admin@bidify.com';

export const BUILTIN_ADMIN_PASSWORD =
  readEnv('EXPO_PUBLIC_BUILTIN_ADMIN_PASSWORD') || 'admin1234';

export function isReservedAdminEmail(email) {
  const em = String(email || '').trim().toLowerCase();
  return em === String(BUILTIN_ADMIN_EMAIL).toLowerCase();
}
