import { getSupabase, isSupabaseConfigured } from './supabaseClient';
import { logPostgrestError } from './supabaseErrors';

/**
 * Prefer Supabase auth.uid() so wallet reads match RLS / profiles.id.
 */
export async function resolveWalletUserId(explicitUserId) {
  if (!isSupabaseConfigured()) {
    return explicitUserId != null ? String(explicitUserId).trim() : '';
  }
  const supabase = getSupabase();
  const paramId = explicitUserId != null ? String(explicitUserId).trim() : '';
  let authUid = '';
  try {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();
    if (error) logPostgrestError('auth.getUser wallet', error);
    authUid = user?.id ? String(user.id).trim() : '';
  } catch (e) {
    if (__DEV__) console.warn('[Bidify/Wallet] auth.getUser failed', e?.message);
  }
  if (authUid && paramId && authUid !== paramId) {
    console.warn('[Bidify/Wallet] user.id !== auth.uid() — using auth.uid() for profiles', {
      paramId,
      authUid,
    });
    return authUid;
  }
  return authUid || paramId || '';
}

/**
 * Live spendable / held balances from public.profiles (source of truth for place_bid).
 */
export async function fetchProfileWallet(userId) {
  if (!isSupabaseConfigured()) {
    return { walletBalance: 0, heldBalance: 0, lockedBalance: 0, offline: true };
  }
  const id = await resolveWalletUserId(userId);
  if (!id) {
    return { walletBalance: 0, heldBalance: 0, lockedBalance: 0 };
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('profiles')
    .select('id, wallet_balance, held_balance, locked_balance')
    .eq('id', id)
    .maybeSingle();

  console.log('[Bidify/Wallet] Supabase profiles SELECT (wallet)', {
    queryUserId: id,
    error: error?.message || null,
    row: data ?? null,
  });

  if (error) {
    logPostgrestError('profiles.wallet_balance', error, { userId: id });
    throw new Error(error.message || 'Could not load wallet from profile.');
  }

  if (!data) {
    return { walletBalance: 0, heldBalance: 0, lockedBalance: 0, missingProfile: true };
  }

  return {
    walletBalance: Number(data.wallet_balance ?? 0) || 0,
    heldBalance: Number(data.held_balance ?? 0) || 0,
    lockedBalance: Number(data.locked_balance ?? 0) || 0,
    missingProfile: false,
  };
}
