/**
 * Multi-step registration API — screens call these only (no direct Supabase in UI).
 * Flow: Step 1 form → pending draft → Step 2 CNIC upload → public.profiles row update.
 */
import client, { isAuxiliaryApiConfigured } from './client';
import { isSupabaseConfigured } from '../services/supabaseClient';
import { checkAuthEmailExists } from '../services/authService';
import {
  CNIC_TAKEN_MESSAGE,
  PHONE_TAKEN_MESSAGE,
} from '../utils/registrationFieldErrors';
import {
  finalizePendingRegistrationIfNeeded,
  isEmailAlreadyRegisteredMessage,
  resendSignupVerificationEmail,
  registerWithCnic,
  registerBasicAccount,
} from '../services/registrationService';
import { savePendingRegistration, loadPendingRegistration } from '../services/supabase/pendingRegistration';

export { isEmailAlreadyRegisteredMessage };

/**
 * Pre-submit uniqueness check (CNIC / phone) via Express + Supabase service role.
 */
export async function checkRegistrationFieldsAPI({ phoneNumber, cnic, excludeUserId } = {}) {
  if (!isAuxiliaryApiConfigured()) {
    return {
      phone: { available: true },
      cnic: { available: true },
      skipped: true,
    };
  }
  try {
    const { data } = await client.post(
      '/profile/check-registration-fields',
      { phoneNumber, cnic, excludeUserId },
      { timeout: 10000, __skipAuth: true }
    );
    return data || { phone: { available: true }, cnic: { available: true } };
  } catch (e) {
    const msg = e?.response?.data?.message || e?.message;
    if (__DEV__) console.warn('[registration] check-fields', msg);
    throw new Error(msg || 'Could not verify phone or CNIC. Try again.');
  }
}

export async function checkPhoneAvailableAPI(phoneNumber, excludeUserId) {
  const result = await checkRegistrationFieldsAPI({ phoneNumber, excludeUserId });
  const phone = result?.phone || {};
  return {
    available: phone.available !== false,
    reason: phone.reason || (phone.available === false ? PHONE_TAKEN_MESSAGE : null),
    code: phone.code || null,
  };
}

export async function checkCnicAvailableAPI(cnic, excludeUserId) {
  const result = await checkRegistrationFieldsAPI({ cnic, excludeUserId });
  const cnicResult = result?.cnic || {};
  return {
    available: cnicResult.available !== false,
    reason: cnicResult.reason || (cnicResult.available === false ? CNIC_TAKEN_MESSAGE : null),
    code: cnicResult.code || null,
  };
}

export async function checkEmailAvailableAPI(email) {
  const em = String(email || '').trim();
  if (!em) return { available: false, reason: 'Email required' };
  if (!isSupabaseConfigured()) {
    console.log('[Bidify/api/registration] checkEmailAvailable — Supabase off, assume available');
    return { available: true };
  }
  try {
    console.log('[Bidify/api/registration] checkEmailAvailable', em);
    const exists = await checkAuthEmailExists(em);
    if (exists === true) {
      console.log('[Bidify/api/registration] email taken', em);
      return { available: false, reason: 'This email is already registered.' };
    }
    return { available: true };
  } catch (e) {
    console.error('[Bidify/api/registration] checkEmailAvailable FAILED', e?.message || e);
    return { available: true, uncertain: true };
  }
}

export async function stashRegistrationDraftAPI(draft) {
  console.log('[Bidify/api/registration] stashRegistrationDraft');
  await savePendingRegistration(draft);
  return { ok: true };
}

export async function loadRegistrationDraftAPI() {
  return loadPendingRegistration();
}

export async function registerBasicAPI({ fullName, email, password }) {
  if (!email || !password || !fullName) {
    throw new Error('Name, email, and password are required.');
  }
  console.log('[Bidify/api/registration] registerBasic — start', { email });
  const result = await registerBasicAccount({ fullName, email, password });
  console.log('[Bidify/api/registration] registerBasic — done', {
    pendingEmailVerification: !!result?.pendingEmailVerification,
    hasToken: !!result?.token,
  });
  return result;
}

export async function completeCnicRegistrationAPI(registration) {
  if (!registration?.email || !registration?.password) {
    throw new Error('Registration data incomplete.');
  }
  if (!registration?.cnicFrontUri || !registration?.cnicBackUri) {
    throw new Error('CNIC front and back images are required.');
  }
  console.log('[Bidify/api/registration] completeCnicRegistration — start', {
    email: registration.email,
    hasFront: !!registration.cnicFrontUri,
    hasBack: !!registration.cnicBackUri,
  });
  const result = await registerWithCnic({
    ...registration,
    cnicFrontUri: registration.cnicFrontUri,
    cnicBackUri: registration.cnicBackUri,
  });
  console.log('[Bidify/api/registration] completeCnicRegistration — done', {
    pendingEmailVerification: !!result?.pendingEmailVerification,
    hasToken: !!result?.token,
  });
  return result;
}

export async function resendVerificationEmailAPI(email) {
  console.log('[Bidify/api/registration] resendVerificationEmail', email);
  return resendSignupVerificationEmail(email);
}

export async function finalizeRegistrationAfterVerifyAPI() {
  console.log('[Bidify/api/registration] finalizeRegistrationAfterVerify');
  return finalizePendingRegistrationIfNeeded();
}
