/**
 * Pakistan-specific validators used by the registration flow.
 *
 *   - Phone (PK mobile): exactly 11 digits and starts with "03".
 *     e.g. 03001234567
 *   - CNIC: exactly 13 digits (no dashes accepted from the user — we strip them
 *     before validation in the UI).
 */

export const PK_PHONE_RE = /^03\d{9}$/;
export const CNIC_RE = /^\d{13}$/;

export function normalizeDigits(value) {
  return String(value == null ? '' : value).replace(/\D/g, '');
}

export function validatePakPhone(value) {
  const digits = normalizeDigits(value);
  if (!digits) return 'Please enter your phone number.';
  if (!PK_PHONE_RE.test(digits))
    return 'Phone must be exactly 11 digits and start with "03" (e.g. 03001234567).';
  return null;
}

export function validateCnic(value) {
  const digits = normalizeDigits(value);
  if (!digits) return 'Please enter your CNIC number.';
  if (!CNIC_RE.test(digits)) return 'CNIC must be exactly 13 digits.';
  return null;
}

/** Format CNIC for display: 12345-1234567-1 */
export function formatCnicDisplay(value) {
  const d = normalizeDigits(value).slice(0, 13);
  if (d.length <= 5) return d;
  if (d.length <= 12) return `${d.slice(0, 5)}-${d.slice(5)}`;
  return `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}`;
}
