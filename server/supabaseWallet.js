/**
 * Sync Express wallet top-ups → public.profiles.wallet_balance (Supabase).
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in server/.env
 */

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  '';
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

function isSupabaseWalletSyncConfigured() {
  return !!(SUPABASE_URL && SERVICE_KEY);
}

/** Safe diagnostics for logs — never prints full secrets. */
function getSupabaseKeyDiagnostics() {
  const key = SERVICE_KEY || '';
  const anon = ANON_KEY || '';
  let serviceKeyKind = 'MISSING';
  if (key) {
    if (anon && key === anon) serviceKeyKind = 'ERROR_ANON_KEY_NOT_SERVICE_ROLE';
    else if (key.startsWith('eyJ')) serviceKeyKind = 'jwt_service_role';
    else if (key.startsWith('sb_secret_')) serviceKeyKind = 'sb_secret_service_role';
    else if (key.startsWith('sb_publishable_')) serviceKeyKind = 'ERROR_PUBLISHABLE_KEY';
    else serviceKeyKind = `unknown(${key.slice(0, 8)}…)`;
  }
  let urlHost = null;
  if (SUPABASE_URL) {
    try {
      urlHost = new URL(SUPABASE_URL).host;
    } catch {
      urlHost = 'invalid_url';
    }
  }
  return {
    configured: isSupabaseWalletSyncConfigured(),
    supabaseUrlHost: urlHost,
    serviceKeyKind,
    serviceKeyLen: key.length,
    usingAnonByMistake: !!(key && anon && key === anon),
  };
}

async function supabaseRpc(functionName, body, { logTag } = {}) {
  const tag = logTag || 'supabaseRpc';
  if (!isSupabaseWalletSyncConfigured()) {
    const diag = getSupabaseKeyDiagnostics();
    console.error(`[${tag}] Supabase not configured`, diag);
    throw new Error(
      'Supabase RPC blocked: set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (service role, not anon).'
    );
  }
  const url = `${String(SUPABASE_URL).replace(/\/$/, '')}/rest/v1/rpc/${functionName}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    console.error(`[${tag}] RPC ${functionName} HTTP ${res.status}`, data);
    const msg =
      (data && typeof data === 'object' && (data.message || data.error || data.hint)) ||
      (typeof data === 'string' ? data : null) ||
      res.statusText;
    throw new Error(`Supabase RPC ${functionName} failed (${res.status}): ${msg}`);
  }
  return data;
}

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v || '')
  );
}

/**
 * @param {string} profileUserId — auth.users.id / public.profiles.id
 * @param {number} amount
 * @param {string} idempotencyKey — Stripe session id, pi_*, etc.
 * @param {string} [provider]
 */
async function lookupProfileIdByEmail(email) {
  if (!isSupabaseWalletSyncConfigured()) return null;
  const em = String(email || '').trim().toLowerCase();
  if (!em) return null;
  const url = `${String(SUPABASE_URL).replace(/\/$/, '')}/rest/v1/profiles?select=id&email=eq.${encodeURIComponent(em)}&limit=1`;
  const res = await fetch(url, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    console.warn('[supabaseWallet] lookupProfileIdByEmail failed', res.status, text);
    return null;
  }
  const rows = await res.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  const id = row?.id != null ? String(row.id) : null;
  return id && isUuid(id) ? id : null;
}

async function creditProfileWalletTopup(profileUserId, amount, idempotencyKey, provider = 'stripe') {
  if (!isSupabaseWalletSyncConfigured()) {
    throw new Error(
      'Supabase wallet sync not configured on server. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env and restart npm run api.'
    );
  }
  if (!isUuid(profileUserId)) {
    throw new Error('Invalid Supabase profile id — log out and log in again, then retry top-up.');
  }
  const n = Math.floor(Number(amount));
  const key = String(idempotencyKey || '').trim();
  if (!Number.isFinite(n) || n <= 0 || !key) {
    return { ok: false, skipped: true, reason: 'invalid_args' };
  }

  console.log('[supabaseWallet] credit_profile_wallet_topup →', {
    profileUserId,
    amount: n,
    idempotencyKey: key,
    provider,
  });

  const data = await supabaseRpc('credit_profile_wallet_topup', {
    p_user_id: profileUserId,
    p_amount: n,
    p_idempotency_key: key,
    p_provider: provider || 'stripe',
  });

  console.log('[supabaseWallet] credit_profile_wallet_topup OK', {
    profileUserId,
    amount: n,
    duplicate: data?.duplicate,
    wallet_balance: data?.wallet_balance,
  });
  return data;
}

/**
 * Raise profiles.wallet_balance to at least Express ledger balance (login reconcile).
 */
async function reconcileProfileWalletBalance(profileUserId, targetBalance) {
  if (!isSupabaseWalletSyncConfigured()) {
    return { ok: false, skipped: true, reason: 'not_configured' };
  }
  if (!isUuid(profileUserId)) {
    return { ok: false, skipped: true, reason: 'invalid_profile_id' };
  }
  const target = Math.max(0, Math.floor(Number(targetBalance) || 0));
  const data = await supabaseRpc('reconcile_profile_wallet_balance', {
    p_user_id: profileUserId,
    p_target_balance: target,
  });
  console.log('[supabaseWallet] reconcile_profile_wallet_balance', {
    profileUserId,
    target,
    wallet_balance: data?.wallet_balance,
  });
  return data;
}

module.exports = {
  isSupabaseWalletSyncConfigured,
  getSupabaseKeyDiagnostics,
  supabaseRpc,
  creditProfileWalletTopup,
  reconcileProfileWalletBalance,
  lookupProfileIdByEmail,
  isUuid,
};
