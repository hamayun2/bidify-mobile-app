import { getSupabase, isSupabaseConfigured } from './supabaseClient';
import { getSupabaseAuthRedirectUrl } from './supabase/authRedirect';
import { logSupabaseError, logPostgrestError } from './supabaseErrors';
import { fetchProfileById, mapProfileRowToAppUser } from './profileService';
import { finalizePendingRegistration } from './registrationService';

function mapAuthErrorMessage(message, fallback) {
  const raw = String(message || '').trim();
  const m = raw.toLowerCase();
  if (m.includes('invalid login credentials')) return 'Incorrect email or password.';
  if (m.includes('email not confirmed')) return 'Please confirm your email before signing in.';
  if (m.includes('invalid api key') || m.includes('jwt'))
    return 'Invalid Supabase API key. Set EXPO_PUBLIC_SUPABASE_ANON_KEY (eyJ…).';
  if (m.includes('already registered')) return 'This email is already registered.';
  if (raw) return raw;
  return fallback || 'Something went wrong.';
}

export async function checkAuthEmailExists(email) {
  if (!isSupabaseConfigured()) return null;
  const supabase = getSupabase();
  const trimmed = String(email || '').trim();
  if (!trimmed) return null;
  const { data, error } = await supabase.rpc('auth_email_exists', { p_email: trimmed });
  if (error) {
    logPostgrestError('auth_email_exists', error);
    return null;
  }
  return !!data;
}

export async function signInWithEmail(email, password) {
  const supabase = getSupabase();
  const em = String(email).trim();
  console.log('[Bidify/authService] signInWithPassword', em);
  const { data, error } = await supabase.auth.signInWithPassword({
    email: em,
    password: String(password),
  });
  if (error) {
    console.error('[Bidify/authService] signIn FAILED', error.message, error.code);
    throw new Error(mapAuthErrorMessage(error.message, 'Login failed.'));
  }
  const { session, user } = data;
  if (!session || !user) throw new Error('Login failed — no session.');

  if (user.email && !user.email_confirmed_at) {
    await supabase.auth.signOut();
    throw new Error('Please verify your email before signing in.');
  }

  let profileRow = await fetchProfileById(user.id).catch(() => null);
  if (!profileRow) {
    const fin = await finalizePendingRegistration().catch(() => null);
    if (fin?.appUser) profileRow = await fetchProfileById(user.id).catch(() => null);
  }
  const appUser = mapProfileRowToAppUser(profileRow, user) || mapProfileRowToAppUser({}, user);
  console.log('[Bidify/authService] signIn OK', appUser.email);
  return { token: session.access_token, user: appUser };
}

export async function signOut() {
  const supabase = getSupabase();
  console.log('[Bidify/authService] signOut');
  const { error } = await supabase.auth.signOut();
  if (error) logSupabaseError('auth.signOut', error);
}

/**
 * Verify current password, then set a new one via Supabase Auth.
 * Re-signs in with the old password first so incorrect old passwords are rejected cleanly.
 */
const INCORRECT_OLD_PASSWORD = 'Incorrect old password. Please try again.';

/**
 * Step 1: Re-authenticate with current password (proves old password is correct).
 * Step 2: updateUser({ password }) on the active session.
 */
export async function changePasswordWithReauth(email, oldPassword, newPassword) {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured.');
  }
  const supabase = getSupabase();

  let em = String(email || '').trim();
  if (!em) {
    const {
      data: { session },
      error: sessErr,
    } = await supabase.auth.getSession();
    if (sessErr) logSupabaseError('auth.getSession changePassword', sessErr);
    em = String(session?.user?.email || '').trim();
  }
  if (!em) throw new Error('No email on file for this account.');

  const oldPw = String(oldPassword);
  const newPw = String(newPassword);
  if (!oldPw || !newPw) throw new Error('Please fill in all password fields.');

  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email: em,
    password: oldPw,
  });
  if (signInError || !signInData?.session) {
    logSupabaseError('auth.signInWithPassword reauth', signInError);
    throw new Error(INCORRECT_OLD_PASSWORD);
  }

  const { data: updateData, error: updateError } = await supabase.auth.updateUser({
    password: newPw,
  });
  if (updateError || !updateData?.user) {
    logSupabaseError('auth.updateUser password', updateError);
    throw new Error(updateError?.message || 'Could not update password.');
  }

  return { ok: true };
}

export { INCORRECT_OLD_PASSWORD };

export async function requestSupabasePasswordReset(email) {
  const supabase = getSupabase();
  const redirectTo = getSupabaseAuthRedirectUrl();
  console.log('[Bidify/authService] resetPasswordForEmail', email);
  const { error } = await supabase.auth.resetPasswordForEmail(String(email).trim(), { redirectTo });
  if (error) {
    logSupabaseError('auth.resetPasswordForEmail', error);
    throw new Error(error.message || 'Could not send reset email.');
  }
  return { ok: true, message: 'Password reset link sent.' };
}

export const loginWithSupabase = signInWithEmail;
export const signOutSupabase = signOut;
