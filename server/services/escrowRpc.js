/**
 * Run Supabase escrow RPCs as the signed-in user (Bearer = Supabase access token).
 * Does not change RPC logic — proxies to the same functions the mobile app calls.
 */

const { createClient } = require('@supabase/supabase-js');
const { isSupabaseWalletSyncConfigured, isUuid } = require('../supabaseWallet');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

const ORDER_SELECT = `
  id,
  listing_id,
  buyer_id,
  seller_id,
  winning_bid_id,
  winning_bid_amount,
  escrow_amount,
  status,
  disputed_at,
  disputed_by,
  delivery_otp_expires_at,
  otp_verified_at,
  completed_at,
  created_at,
  updated_at,
  metadata
`;

function parseRpcMessage(error, fallback = 'Request failed.') {
  const raw = String(error?.message || error?.details || '').trim();
  let message = raw
    .replace(/^.*?\bP0001:\s*/i, '')
    .replace(/^ERROR:\s*/i, '')
    .trim();
  if (!message) message = fallback;
  const err = new Error(message);
  if (error?.code) err.code = error.code;
  if (/invalid delivery otp/i.test(message)) err.invalidOtp = true;
  return err;
}

function createUserClient(accessToken) {
  if (!SUPABASE_URL || !ANON_KEY || !accessToken) return null;
  return createClient(String(SUPABASE_URL).replace(/\/$/, ''), ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * @param {string} accessToken — Supabase session JWT
 * @param {string} functionName
 * @param {Record<string, unknown>} params
 */
async function rpcAsUser(accessToken, functionName, params = {}) {
  const client = createUserClient(accessToken);
  if (!client) {
    throw new Error('Supabase anon client not configured on API server.');
  }
  const { data, error } = await client.rpc(functionName, params);
  if (error) throw parseRpcMessage(error, `RPC ${functionName} failed.`);
  return data;
}

/**
 * @param {string} accessToken
 * @param {string} userId
 */
async function fetchAuctionOrdersForUser(accessToken, userId) {
  const uid = userId != null ? String(userId).trim() : '';
  if (!uid || !isUuid(uid)) return [];

  const client = createUserClient(accessToken);
  if (!client) throw new Error('Supabase client unavailable.');

  const { data, error } = await client
    .from('auction_orders')
    .select(ORDER_SELECT)
    .or(`buyer_id.eq.${uid},seller_id.eq.${uid}`)
    .order('created_at', { ascending: false });

  if (error) throw parseRpcMessage(error, 'Could not load orders.');
  return Array.isArray(data) ? data : [];
}

module.exports = {
  isEscrowRpcConfigured: isSupabaseWalletSyncConfigured,
  isUuid,
  parseRpcMessage,
  rpcAsUser,
  fetchAuctionOrdersForUser,
  ORDER_SELECT,
};
