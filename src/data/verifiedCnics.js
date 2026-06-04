/**
 * Mock "verified CNIC" database used during signup.
 *
 * Real-world: this lookup will be a server-side verified-CNIC store or a
 * NADRA-style API. For development we treat a CNIC as verified when the LAST
 * TWO DIGITS represent a number between 1 and 99 (inclusive). That makes it
 * trivial to test with any 13-digit string ending in 01..99.
 *
 *   Examples (last two digits → status)
 *     1234567890101 → "01" → ✅ verified
 *     1234567890142 → "42" → ✅ verified
 *     1234567890199 → "99" → ✅ verified
 *     1234567890100 → "00" → ❌ not verified
 *
 * To override the list (e.g. seed specific test CNICs), set
 * EXPO_PUBLIC_VERIFIED_CNICS to a comma-separated list of full 13-digit IDs.
 */

import { normalizeDigits, CNIC_RE } from '../utils/pakValidation';

const ENV_VERIFIED = (process.env.EXPO_PUBLIC_VERIFIED_CNICS || '')
  .split(',')
  .map((s) => normalizeDigits(s))
  .filter((s) => CNIC_RE.test(s));

/**
 * Numeric "verified slot" check. Last two digits 01..99 are verified.
 * Stored as a Set so callers can also see the full eligible set.
 */
export const VERIFIED_SLOTS = new Set(
  Array.from({ length: 99 }, (_, i) => String(i + 1).padStart(2, '0'))
);

export function isCnicVerified(rawCnic) {
  const cnic = normalizeDigits(rawCnic);
  if (!CNIC_RE.test(cnic)) return false;
  if (ENV_VERIFIED.length > 0 && ENV_VERIFIED.includes(cnic)) return true;
  const last2 = cnic.slice(-2);
  return VERIFIED_SLOTS.has(last2);
}

export const VERIFIED_CNIC_HINT =
  'Verified CNICs end in 01–99 (last two digits). Try 12345-1234567-1 in dev.';
