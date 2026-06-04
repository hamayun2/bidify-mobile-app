import { BUILTIN_ADMIN_EMAIL } from '../constants/adminConfig';

export function isAdminUser(user) {
  if (!user || typeof user !== 'object') return false;
  if (user.role === 'admin') return true;
  if (user.isAdmin === true) return true;
  const email = String(user.email || '').trim().toLowerCase();
  if (email && email === String(BUILTIN_ADMIN_EMAIL).toLowerCase()) return true;
  return false;
}
