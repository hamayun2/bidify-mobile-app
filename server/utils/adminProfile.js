/**
 * Built-in admin — excluded from Mock NADRA auto-verification and wallet KYC gates.
 */
const ADMIN_EMAIL = String(
  process.env.EXPO_PUBLIC_BUILTIN_ADMIN_EMAIL ||
    process.env.BUILTIN_ADMIN_EMAIL ||
    'admin@bidify.com'
)
  .trim()
  .toLowerCase();

function isAdminProfile(row) {
  if (!row) return false;
  if (String(row.role || '').toLowerCase() === 'admin') return true;
  const email = String(row.email || '').trim().toLowerCase();
  return !!email && email === ADMIN_EMAIL;
}

function isAdminEmail(email) {
  return String(email || '').trim().toLowerCase() === ADMIN_EMAIL;
}

module.exports = { ADMIN_EMAIL, isAdminProfile, isAdminEmail };
