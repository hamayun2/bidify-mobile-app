/**
 * Read wallet balances and activity from Supabase (service_role).
 * Tables: profiles, wallet_ledger, wallet_transactions
 */

const {
  isSupabaseWalletSyncConfigured,
  isUuid,
} = require('../supabaseWallet');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  '';

async function supabaseRestGet(pathAndQuery, { logTag } = {}) {
  if (!isSupabaseWalletSyncConfigured()) {
    throw new Error('Supabase not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).');
  }
  const url = `${String(SUPABASE_URL).replace(/\/$/, '')}/rest/v1/${pathAndQuery}`;
  const res = await fetch(url, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const tag = logTag || 'supabaseRestGet';
    console.error(`[${tag}] HTTP ${res.status}`, data);
    const msg =
      (data && typeof data === 'object' && (data.message || data.error || data.hint)) ||
      (typeof data === 'string' ? data : null) ||
      res.statusText;
    throw new Error(msg || `Supabase request failed (${res.status})`);
  }
  return Array.isArray(data) ? data : data != null ? [data] : [];
}

/**
 * @param {string} userId — auth.users.id / profiles.id
 * @param {{ ledgerLimit?: number, txLimit?: number }} [opts]
 */
async function fetchWalletBundleForUser(userId, opts = {}) {
  const uid = userId != null ? String(userId).trim() : '';
  if (!uid || !isUuid(uid)) {
    return null;
  }

  const ledgerLimit = Math.min(100, Math.max(1, Number(opts.ledgerLimit) || 80));
  const txLimit = Math.min(100, Math.max(1, Number(opts.txLimit) || 80));

  const [profiles, ledger, walletTransactions] = await Promise.all([
    supabaseRestGet(
      `profiles?select=wallet_balance,held_balance,locked_balance&id=eq.${encodeURIComponent(uid)}&limit=1`,
      { logTag: 'wallet/profiles' }
    ),
    supabaseRestGet(
      `wallet_ledger?select=id,entry_type,amount,listing_id,bid_id,metadata,created_at&user_id=eq.${encodeURIComponent(uid)}&order=created_at.desc&limit=${ledgerLimit}`,
      { logTag: 'wallet/ledger' }
    ).catch((e) => {
      console.warn('[wallet] wallet_ledger fetch failed', e?.message || e);
      return [];
    }),
    supabaseRestGet(
      `wallet_transactions?select=id,kind,amount,currency,payment_status,provider,note,balance_after,created_at&user_id=eq.${encodeURIComponent(uid)}&order=created_at.desc&limit=${txLimit}`,
      { logTag: 'wallet/wallet_transactions' }
    ).catch((e) => {
      console.warn('[wallet] wallet_transactions fetch failed', e?.message || e);
      return [];
    }),
  ]);

  const profile = Array.isArray(profiles) ? profiles[0] : null;

  return {
    balance: Number(profile?.wallet_balance) || 0,
    heldBalance: Number(profile?.held_balance) || 0,
    lockedBalance: Number(profile?.locked_balance) || 0,
    ledger: Array.isArray(ledger) ? ledger : [],
    walletTransactions: Array.isArray(walletTransactions) ? walletTransactions : [],
    source: 'supabase',
  };
}

/**
 * @param {string} userId
 * @param {number} [limit]
 */
async function fetchWalletLedgerForUser(userId, limit = 80) {
  const bundle = await fetchWalletBundleForUser(userId, { ledgerLimit: limit, txLimit: 0 });
  return bundle?.ledger || [];
}

/**
 * @param {string} userId
 * @param {number} [limit]
 */
async function fetchWalletTransactionsForUser(userId, limit = 80) {
  const uid = userId != null ? String(userId).trim() : '';
  if (!uid || !isUuid(uid)) return [];
  return supabaseRestGet(
    `wallet_transactions?select=*&user_id=eq.${encodeURIComponent(uid)}&order=created_at.desc&limit=${Math.min(100, Math.max(1, limit))}`,
    { logTag: 'wallet/wallet_transactions' }
  );
}

module.exports = {
  fetchWalletBundleForUser,
  fetchWalletLedgerForUser,
  fetchWalletTransactionsForUser,
  isSupabaseWalletDataConfigured: isSupabaseWalletSyncConfigured,
};
