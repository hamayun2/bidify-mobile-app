/**
 * Map Postgres unique violations (23505) on profiles to user-facing copy.
 * @param {import('@supabase/supabase-js').PostgrestError | Error | null | undefined} error
 * @returns {string | null} User message, or null if not a known unique violation.
 */
export function mapProfileUniqueViolation(error) {
  if (!error) return null;
  const code = String(error.code || '');
  if (code !== '23505') return null;

  const hay = [
    error.message,
    error.details,
    error.hint,
    error.constraint,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (
    hay.includes('profiles_phone_number_unique') ||
    hay.includes('phone_number_unique') ||
    (hay.includes('phone_number') && hay.includes('unique'))
  ) {
    return 'This phone number is already in use. Please check your number or log in.';
  }

  if (
    hay.includes('profiles_id_card_unique') ||
    hay.includes('profiles_cnic_unique') ||
    hay.includes('id_card_unique') ||
    hay.includes('cnic_unique') ||
    ((hay.includes('id_card') || hay.includes('cnic')) && hay.includes('unique'))
  ) {
    return 'This CNIC is already in use. Please check your number or log in.';
  }

  return null;
}

/**
 * @param {import('@supabase/supabase-js').PostgrestError | Error | null | undefined} error
 * @param {string} fallback
 */
export function throwProfileError(error, fallback = 'Could not save profile.') {
  const unique = mapProfileUniqueViolation(error);
  if (unique) throw new Error(unique);
  const msg = String(error?.message || error || '').trim();
  throw new Error(msg || fallback);
}
