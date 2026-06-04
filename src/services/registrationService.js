import { getSupabase } from './supabaseClient';
import { getSupabaseAuthRedirectUrl } from './supabase/authRedirect';
import { uploadCnicImage } from './storageService';
import { fetchProfileById, mapProfileRowToAppUser, upsertProfile } from './profileService';
import { logSupabaseError } from './supabaseErrors';
import { loadPendingRegistration, clearPendingRegistration } from './supabase/pendingRegistration';
import { isReservedAdminEmail } from '../constants/adminConfig';
import { checkAuthEmailExists } from './authService';
import { mapProfileUniqueViolation } from '../utils/profileErrors';
import {
  assertCnicNotRegistered,
  assertPhoneNotRegistered,
} from './registrationFieldChecks';

function mapAuthErrorMessage(message, fallback) {
  const raw = String(message || '').trim();
  if (raw.toLowerCase().includes('already registered')) return 'This email is already registered.';
  if (raw) return raw;
  return fallback || 'Registration failed.';
}

function isDuplicateSignupError(error) {
  if (!error) return false;
  const msg = String(error.message || '').toLowerCase();
  return msg.includes('already registered') || String(error.code) === 'user_already_exists';
}

function isEmailNotConfirmedAuthError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('email not confirmed') || err?.code === 'email_not_confirmed';
}

export function isEmailAlreadyRegisteredMessage(message) {
  const m = String(message || '').toLowerCase();
  return m.includes('already registered');
}

/**
 * Step 1 signup — account only (no CNIC). Profile row starts as `verification_status: unverified`.
 */
export async function registerBasicAccount(userData) {
  const supabase = getSupabase();
  const email = String(userData.email || '').trim();
  const password = String(userData.password || '');
  const firstName = String(userData.firstName || '').trim();
  const lastName = String(userData.lastName || '').trim();
  const fullName =
    String(userData.fullName || userData.name || '').trim() ||
    [firstName, lastName].filter(Boolean).join(' ').trim();
  const phoneNumber = String(userData.phoneNumber || userData.phone || '').replace(/\D/g, '').trim();

  if (!email || !password) throw new Error('Email and password required');
  if (!fullName) throw new Error('Please enter your name.');
  if (isReservedAdminEmail(email)) throw new Error('This email is reserved for admin. Use Login.');

  if (phoneNumber) {
    await assertPhoneNotRegistered(phoneNumber);
  }

  console.log('[Bidify/registrationService] registerBasicAccount signUp', email);
  const { data: signData, error: signErr } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: getSupabaseAuthRedirectUrl(),
      data: { full_name: fullName, phone: phoneNumber || undefined },
    },
  });

  if (signErr && !isDuplicateSignupError(signErr)) {
    logSupabaseError('auth.signUp', signErr);
    throw new Error(mapAuthErrorMessage(signErr.message));
  }

  let authUser = signData?.user;
  let session = signData?.session;

  if (signErr && isDuplicateSignupError(signErr)) {
    const { data: inData, error: inErr } = await supabase.auth.signInWithPassword({ email, password });
    if (inErr) {
      if (isEmailNotConfirmedAuthError(inErr)) {
        await supabase.auth.signOut().catch(() => {});
        return { pendingEmailVerification: true, email, authUserId: authUser?.id };
      }
      throw new Error(mapAuthErrorMessage(inErr?.message));
    }
    authUser = inData.user;
    session = inData.session;
    const existing = await fetchProfileById(authUser.id).catch(() => null);
    if (existing?.email) {
      await supabase.auth.signOut().catch(() => {});
      throw new Error('This email is already registered.');
    }
  }

  if (!authUser?.id) throw new Error('Registration failed — no user id.');

  if (!session) {
    console.warn('[Bidify/registrationService] registerBasicAccount — email confirmation required');
    await clearPendingRegistration();
    return {
      pendingEmailVerification: true,
      email,
      authUserId: authUser.id,
      message: 'Verify your email, then sign in to complete KYC.',
    };
  }

  const cnicDigits =
    userData.cnic != null ? String(userData.cnic).replace(/\D/g, '').trim() : '';
  const profilePayload = {
    id: authUser.id,
    email,
    full_name: fullName,
    phone_number: phoneNumber || null,
    cnic: cnicDigits || null,
    father_name: userData.fatherName != null ? String(userData.fatherName).trim() : null,
    dob: userData.dob != null ? String(userData.dob).trim() : null,
    verification_status: userData.verificationStatus || 'unverified',
    verification_submitted_at: userData.verificationSubmittedAt || null,
    is_real_face: userData.isRealFace === true,
  };

  try {
    await upsertProfile(profilePayload);
  } catch (profileErr) {
    const unique = mapProfileUniqueViolation(profileErr);
    if (unique) throw new Error(unique);
    throw profileErr;
  }

  await clearPendingRegistration();
  const profileRow = await fetchProfileById(authUser.id);
  const appUser = mapProfileRowToAppUser(profileRow, authUser);
  console.log('[Bidify/registrationService] registerBasicAccount complete', appUser?.email);
  return { token: session.access_token, user: appUser };
}

export async function registerWithCnic(userData) {
  const supabase = getSupabase();
  const email = String(userData.email || '').trim();
  const password = String(userData.password || '');
  const fullName = String(userData.fullName || userData.name || '').trim();
  const phoneNumber = String(userData.phoneNumber || userData.phone || '').trim();
  const username = String(userData.username || '').trim();
  const cnic = String(userData.cnic || '').replace(/\D/g, '');
  const hasCnic = !!(userData.cnicFrontUri && userData.cnicBackUri);

  if (!email || !password) throw new Error('Email and password required');
  if (isReservedAdminEmail(email)) throw new Error('This email is reserved for admin. Use Login.');
  if (!hasCnic) throw new Error('CNIC front and back images are required.');

  if (phoneNumber) {
    await assertPhoneNotRegistered(phoneNumber.replace(/\D/g, ''));
  }
  if (cnic) {
    await assertCnicNotRegistered(cnic);
  }

  console.log('[Bidify/registrationService] signUp', email);
  const { data: signData, error: signErr } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: getSupabaseAuthRedirectUrl(),
      data: { full_name: fullName, phone: phoneNumber },
    },
  });

  if (signErr && !isDuplicateSignupError(signErr)) {
    logSupabaseError('auth.signUp', signErr);
    throw new Error(mapAuthErrorMessage(signErr.message));
  }

  let authUser = signData?.user;
  let session = signData?.session;

  if (signErr && isDuplicateSignupError(signErr)) {
    const { data: inData, error: inErr } = await supabase.auth.signInWithPassword({ email, password });
    if (inErr) {
      if (isEmailNotConfirmedAuthError(inErr)) {
        await supabase.auth.signOut().catch(() => {});
        return { pendingEmailVerification: true, email, authUserId: authUser?.id };
      }
      throw new Error(mapAuthErrorMessage(inErr?.message));
    }
    authUser = inData.user;
    session = inData.session;
    const existing = await fetchProfileById(authUser.id).catch(() => null);
    if (existing?.cnic_front_url && existing?.cnic_back_url) {
      await supabase.auth.signOut().catch(() => {});
      throw new Error('This email is already registered.');
    }
  }

  if (!authUser?.id) throw new Error('Registration failed — no user id.');

  if (!session) {
    console.warn('[Bidify/registrationService] no session — email confirmation required');
    await clearPendingRegistration();
    return {
      pendingEmailVerification: true,
      email,
      authUserId: authUser.id,
      message: 'Verify your email, then sign in.',
    };
  }

  console.log('[Bidify/registrationService] upload CNIC images');
  const cnicFrontUrl = await uploadCnicImage(authUser.id, 'front', userData.cnicFrontUri);
  const cnicBackUrl = await uploadCnicImage(authUser.id, 'back', userData.cnicBackUri);

  console.log('[Bidify/registrationService] upsert profile after CNIC upload');
  try {
    await upsertProfile({
      id: authUser.id,
      email,
      full_name: fullName,
      username: username || null,
      phone_number: phoneNumber,
      cnic: cnic || null,
      cnic_front_url: cnicFrontUrl,
      cnic_back_url: cnicBackUrl,
    });
  } catch (profileErr) {
    const unique = mapProfileUniqueViolation(profileErr);
    if (unique) throw new Error(unique);
    throw profileErr;
  }

  await clearPendingRegistration();
  const profileRow = await fetchProfileById(authUser.id);
  const appUser = mapProfileRowToAppUser(profileRow, authUser);
  console.log('[Bidify/registrationService] complete', appUser?.email);
  return { token: session.access_token, user: appUser };
}

export async function finalizePendingRegistration() {
  const pending = await loadPendingRegistration();
  const supabase = getSupabase();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.user?.id) return { skipped: true };

  if (!pending || pending.authUserId !== session.user.id) {
    const row = await fetchProfileById(session.user.id).catch(() => null);
    if (row) {
      return {
        skipped: false,
        appUser: mapProfileRowToAppUser(row, session.user),
        token: session.access_token,
      };
    }
    return { skipped: true };
  }

  if (!pending.cnicFrontUri || !pending.cnicBackUri) return { skipped: true };

  const cnicFrontUrl = await uploadCnicImage(session.user.id, 'front', pending.cnicFrontUri);
  const cnicBackUrl = await uploadCnicImage(session.user.id, 'back', pending.cnicBackUri);
  try {
    await upsertProfile({
      id: session.user.id,
      email: pending.email || session.user.email,
      full_name: pending.fullName,
      username: pending.username != null ? String(pending.username).trim() || null : null,
      phone_number: pending.phoneNumber,
      cnic: pending.cnic != null ? String(pending.cnic).replace(/\D/g, '') || null : null,
      cnic_front_url: cnicFrontUrl,
      cnic_back_url: cnicBackUrl,
    });
  } catch (profileErr) {
    const unique = mapProfileUniqueViolation(profileErr);
    if (unique) throw new Error(unique);
    throw profileErr;
  }
  await clearPendingRegistration();
  const profileRow = await fetchProfileById(session.user.id);
  return {
    skipped: false,
    appUser: mapProfileRowToAppUser(profileRow, session.user),
    token: session.access_token,
  };
}

export async function registerWithSupabase(userData) {
  const hasCnicImages = !!(userData?.cnicFrontUri && userData?.cnicBackUri);
  if (hasCnicImages) return registerWithCnic(userData);
  return registerBasicAccount(userData);
}
export const finalizePendingRegistrationIfNeeded = finalizePendingRegistration;

export async function resendSignupVerificationEmail(email) {
  const supabase = getSupabase();
  const { error } = await supabase.auth.resend({ type: 'signup', email: String(email).trim() });
  if (error) {
    logSupabaseError('auth.resend', error);
    throw new Error(error.message || 'Could not resend verification email.');
  }
  return { ok: true };
}
