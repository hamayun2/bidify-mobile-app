/**
 * Stash signup payload (including local CNIC URIs) when Supabase returns no session
 * until email is verified and a JWT exists — then finalizePendingRegistrationIfNeeded runs.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const PENDING_REGISTRATION_KEY = 'bidify_pending_registration_v1';

/**
 * @param {{
 *   authUserId: string,
 *   email: string,
 *   fullName?: string,
 *   username?: string,
 *   phoneNumber?: string,
 *   cnic?: string,
 *   cnicFrontUri?: string | null,
 *   cnicBackUri?: string | null,
 * }} payload
 */
export async function savePendingRegistration(payload) {
  if (!payload?.authUserId || !payload?.email) return;
  await AsyncStorage.setItem(PENDING_REGISTRATION_KEY, JSON.stringify(payload));
  console.log('[Bidify/pending-reg] saved draft for', payload.email, 'user', payload.authUserId);
}

export async function loadPendingRegistration() {
  try {
    const raw = await AsyncStorage.getItem(PENDING_REGISTRATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.authUserId || !parsed?.email) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function clearPendingRegistration() {
  await AsyncStorage.removeItem(PENDING_REGISTRATION_KEY);
  console.log('[Bidify/pending-reg] cleared');
}
