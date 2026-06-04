/**
 * Ensures one built-in admin exists in Supabase Auth + public.profiles (role = admin).
 * Idempotent — safe to call on every app boot.
 */
import { getSupabase, isSupabaseConfigured } from '../supabaseClient';
import { BUILTIN_ADMIN_EMAIL, BUILTIN_ADMIN_PASSWORD } from '../../constants/adminConfig';
import { checkAuthEmailExists } from '../authService';
import { logSupabaseError } from '../supabaseErrors';

function isDuplicateSignupError(error) {
  if (!error) return false;
  const msg = String(error.message || '').toLowerCase();
  return (
    msg.includes('already registered') ||
    msg.includes('user already registered') ||
    String(error.code || '').toLowerCase() === 'user_already_exists'
  );
}

/**
 * @returns {{ ok: boolean, created?: boolean, promoted?: boolean, skipped?: boolean }}
 */
export async function ensureBuiltinAdminAccount() {
  if (!isSupabaseConfigured()) {
    if (__DEV__) console.log('[Bidify/Admin] ensureBuiltinAdmin — Supabase not configured, skip');
    return { ok: true, skipped: true };
  }

  const email = BUILTIN_ADMIN_EMAIL;
  const password = BUILTIN_ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn('[Bidify/Admin] ensureBuiltinAdmin — missing email or password env');
    return { ok: false, skipped: true };
  }

  try {
    const supabase = getSupabase();
    let exists = null;
    try {
      exists = await checkAuthEmailExists(email);
    } catch (e) {
      logSupabaseError('ensureBuiltinAdmin.checkAuthEmailExists', e);
    }

    let authUserId = null;
    let created = false;

    if (exists !== true) {
      console.log('[Bidify/Admin] Creating built-in admin auth user for', email);
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: 'Bidify Admin', username: 'bidify_admin' },
        },
      });
      if (error && !isDuplicateSignupError(error)) {
        logSupabaseError('ensureBuiltinAdmin.signUp', error);
        return { ok: false };
      }
      authUserId = data?.user?.id || null;
      created = !!authUserId;
      if (__DEV__) console.log('[Bidify/Admin] signUp result user id:', authUserId || '(none)');
    } else if (__DEV__) {
      console.log('[Bidify/Admin] Built-in admin auth user already exists');
    }

    const { error: rpcErr } = await supabase.rpc('promote_builtin_admin', {
      p_email: email,
      p_user_id: authUserId,
    });
    if (rpcErr) {
      logSupabaseError('ensureBuiltinAdmin.promote_builtin_admin', rpcErr);
      if (__DEV__) {
        console.warn(
          '[Bidify/Admin] Run supabase/builtin_admin.sql in SQL Editor if promote_builtin_admin is missing.'
        );
      }
      return { ok: false, created };
    }

    if (__DEV__) console.log('[Bidify/Admin] Built-in admin profile role OK for', email);
    return { ok: true, created, promoted: true };
  } catch (e) {
    logSupabaseError('ensureBuiltinAdmin', e);
    return { ok: false };
  }
}
