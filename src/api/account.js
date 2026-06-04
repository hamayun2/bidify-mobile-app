import client, { buildAccountDeleteUrl, isAuxiliaryApiConfigured } from './client';
import { getSupabase } from '../services/supabaseClient';
import { logPostgrestError } from '../services/supabaseErrors';

/**
 * Permanently delete the signed-in account via Express (service role on server).
 */
export async function deleteAccountViaExpress(accessToken) {
  if (!isAuxiliaryApiConfigured()) {
    throw new Error(
      'Backend API is not configured. Set EXPO_PUBLIC_API_URL (e.g. http://YOUR_PC_IP:4000/api) and run npm run api.'
    );
  }

  const token = String(accessToken || '').trim();
  if (!token) {
    throw new Error('You are not signed in.');
  }

  const deleteUrl = buildAccountDeleteUrl();

  if (__DEV__) {
    console.log('[Bidify/account] POST', deleteUrl, { hasToken: Boolean(token) });
  }

  const { data } = await client.post(
    deleteUrl,
    {},
    {
      timeout: 90_000,
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (data && data.ok === false) {
    throw new Error(data.message || 'Could not delete your account.');
  }

  return data != null && typeof data === 'object' ? data : { ok: true };
}

/**
 * Permanently delete the signed-in account (Express first, then Supabase RPC fallback).
 */
export async function deleteAccountAPI(accessToken) {
  const supabase = getSupabase();
  const {
    data: { session },
    error: sessionErr,
  } = await supabase.auth.getSession();

  const token = String(accessToken || session?.access_token || '').trim();
  if (sessionErr || !token) {
    throw new Error('You are not signed in.');
  }

  const userId = session?.user?.id;

  if (isAuxiliaryApiConfigured()) {
    const data = await deleteAccountViaExpress(token);
    try {
      await supabase.auth.signOut();
    } catch (signOutErr) {
      if (__DEV__) console.warn('[account] signOut after delete', signOutErr?.message || signOutErr);
    }
    return data;
  }

  const { data, error } = await supabase.rpc('delete_my_account', {
    p_user_id: userId,
  });

  if (error) {
    logPostgrestError('rpc.delete_my_account', error);
    const msg = String(error.message || '');
    if (/delete_my_account|function.*does not exist|42883/i.test(msg)) {
      throw new Error(
        'Account deletion is not enabled on the database yet. Run supabase/profiles_unique_and_delete_account.sql in the Supabase SQL Editor, then try again.'
      );
    }
    throw new Error(error.message || 'Could not delete your account.');
  }

  if (data && data.ok === false) {
    throw new Error(data.message || 'Could not delete your account.');
  }

  try {
    await supabase.auth.signOut();
  } catch (signOutErr) {
    if (__DEV__) console.warn('[account] signOut after delete', signOutErr?.message || signOutErr);
  }

  return data != null && typeof data === 'object' ? data : { ok: true };
}
