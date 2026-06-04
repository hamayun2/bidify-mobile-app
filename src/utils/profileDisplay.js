import { formatCnicDisplay, normalizeDigits } from './pakValidation';

/** Shown when a profile field has no value yet. */
export const PROFILE_EMPTY = '—';

/**
 * Normalize CNIC from profiles row or app user (supports cnic, id_card, cnic_number).
 * Returns 13 digits when valid, otherwise ''.
 */
export function resolveCnicDigits(...candidates) {
  for (const raw of candidates) {
    if (raw === undefined || raw === null) continue;
    const digits = normalizeDigits(raw).slice(0, 13);
    if (digits.length === 13) return digits;
  }
  return '';
}

export function resolveCnicFromRow(row) {
  if (!row || typeof row !== 'object') return '';
  return resolveCnicDigits(row.cnic, row.cnic_number, row.id_card, row.cnicNumber, row.idCard);
}

export function resolveCnicFromUser(user) {
  if (!user || typeof user !== 'object') return '';
  return resolveCnicDigits(user.cnic, user.cnic_number, user.id_card, user.cnicNumber, user.idCard);
}

/** Read-only CNIC for Profile / settings — never shows partial dashes like "12345-". */
export function formatProfileCnicDisplay(...candidates) {
  const digits = resolveCnicDigits(...candidates);
  if (digits.length === 13) return formatCnicDisplay(digits);
  return PROFILE_EMPTY;
}

export function formatProfileText(value, placeholder = PROFILE_EMPTY) {
  if (value === undefined || value === null) return placeholder;
  const s = String(value).trim();
  return s || placeholder;
}

/**
 * Display name: first_name + last_name, then full_name, then email local-part.
 */
export function formatProfileDisplayName(source) {
  if (!source || typeof source !== 'object') return '';
  const first = String(source.first_name ?? source.firstName ?? '').trim();
  const last = String(source.last_name ?? source.lastName ?? '').trim();
  const combined = [first, last].filter(Boolean).join(' ');
  if (combined) return combined;
  const full = String(source.full_name ?? source.fullName ?? source.name ?? '').trim();
  if (full) return full;
  const email = String(source.email ?? '').trim();
  if (email.includes('@')) return email.split('@')[0];
  return '';
}

export function formatProfilePhone(value, placeholder = PROFILE_EMPTY) {
  const digits = normalizeDigits(value);
  if (digits.length === 11 && /^03\d{9}$/.test(digits)) {
    return digits;
  }
  const s = value == null ? '' : String(value).trim();
  return s || placeholder;
}
