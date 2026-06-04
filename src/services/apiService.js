/**
 * Central map: Supabase RPC vs Express REST.
 * Bidding / escrow / OTP / disputes use RPC with the signed-in user's session.
 */

import { getSupabase, getSupabaseUrl, getSupabaseAnonKey, isSupabaseConfigured } from './supabaseClient';
import { logPostgrestError } from './supabaseErrors';
import { fetchProfileWallet } from './profileWalletService';
import {
  getBidTokenStatusSupabase,
  payBidTokenSupabase,
  shouldUseSupabaseBidToken,
} from './bidTokenService';
import { evaluateBidWalletGateWithHold } from './walletService';

/** @readonly */
export const SUPABASE_RPC = {
  PLACE_BID: 'place_bid_with_wallet_lock',
  RESOLVE_AUCTION: 'resolve_auction',
  RESOLVE_EXPIRED_AUCTIONS: 'resolve_expired_auctions',
  VERIFY_DELIVERY_OTP: 'verify_delivery_otp',
  REVEAL_BUYER_DELIVERY_OTP: 'reveal_buyer_delivery_otp',
  RAISE_ORDER_DISPUTE: 'raise_order_dispute',
  ATOMIC_SETTLE_DISPUTE: 'atomic_settle_dispute',
};

export const EXPRESS_REST = {
  ESCROW_BUY: '/escrow/buy',
  ESCROW_ORDERS: '/escrow/orders',
  OTP_VERIFY: '/otp/verify',
  OTP_REVEAL: '/otp/reveal',
  DISPUTE_RAISE: '/dispute/raise',
  BIDS_PLACE: '/bids/place',
  WALLET: '/wallet',
};

export function logSupabaseConnectivity() {
  const url = getSupabaseUrl();
  const key = getSupabaseAnonKey();
  const keyKind = !key
    ? 'MISSING'
    : key.includes('YOUR_')
      ? 'PLACEHOLDER'
      : key.startsWith('eyJ')
        ? 'jwt_anon'
        : key.startsWith('sb_publishable_')
          ? 'sb_publishable'
          : key.startsWith('sb_secret_')
            ? 'ERROR_SERVICE_ROLE_IN_CLIENT'
            : 'unknown';

  let host = null;
  try {
    host = url ? new URL(url).host : null;
  } catch {
    host = 'invalid_url';
  }

  console.log('[Bidify/apiService] Supabase connectivity', {
    configured: isSupabaseConfigured(),
    urlHost: host,
    anonKeyKind: keyKind,
    note:
      keyKind === 'ERROR_SERVICE_ROLE_IN_CLIENT'
        ? 'Use EXPO_PUBLIC_SUPABASE_ANON_KEY only in the app (never service role).'
        : 'RPC uses auth session JWT, not service role.',
  });

  return { configured: isSupabaseConfigured(), urlHost: host, anonKeyKind: keyKind };
}

/**
 * Raw Supabase RPC — throws PostgrestError on failure.
 */
export async function callSupabaseRpc(fnName, params = {}, opts = {}) {
  const tag = opts.logTag || `rpc.${fnName}`;
  const supabase = getSupabase();

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    console.error(`[Bidify/apiService] ${tag} — no Supabase session`);
    throw new Error('Not signed in. Log in again to continue.');
  }

  console.log(`[Bidify/apiService] ${tag} → supabase.rpc('${fnName}')`, params);

  const { data, error } = await supabase.rpc(fnName, params);

  if (error) {
    console.error(`[Bidify/apiService] ${tag} RPC error`, {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    logPostgrestError(tag, error, params);
    throw error;
  }

  console.log(`[Bidify/apiService] ${tag} RPC ok`, data);
  return data;
}

function rpcSucceeded(payload) {
  if (payload == null) return true;
  if (typeof payload !== 'object') return true;
  if (payload.ok === false) return false;
  return true;
}

/**
 * Delivery OTP → release escrow (seller verifies buyer code).
 * RPC runs only after OTP payload is present; throws if RPC returns ok: false.
 */
export async function verifyDeliveryOtpRpc(orderId, otp) {
  const id = orderId != null ? String(orderId).trim() : '';
  const code = String(otp ?? '').trim();
  if (!id) throw new Error('Order not found.');
  if (!code) throw new Error('Enter the 6-digit delivery OTP.');

  const data = await callSupabaseRpc(
    SUPABASE_RPC.VERIFY_DELIVERY_OTP,
    { p_order_id: id, p_otp: code },
    { logTag: 'verifyDeliveryOtp' }
  );

  if (!rpcSucceeded(data)) {
    const msg =
      (data && typeof data === 'object' && (data.message || data.error)) ||
      'Delivery OTP verification failed.';
    const err = new Error(String(msg));
    err.invalidOtp = true;
    throw err;
  }

  return data != null && typeof data === 'object' ? data : { ok: true };
}

export async function revealBuyerDeliveryOtpRpc(orderId) {
  const id = orderId != null ? String(orderId).trim() : '';
  if (!id) throw new Error('Order not found.');

  const data = await callSupabaseRpc(
    SUPABASE_RPC.REVEAL_BUYER_DELIVERY_OTP,
    { p_order_id: id },
    { logTag: 'revealBuyerDeliveryOtp' }
  );

  const row = data != null && typeof data === 'object' ? data : {};
  const otp =
    row.otp != null
      ? String(row.otp).trim()
      : row.delivery_otp != null
        ? String(row.delivery_otp).trim()
        : '';
  return { ...row, otp };
}

export async function raiseOrderDisputeRpc(orderId, reason) {
  const id = orderId != null ? String(orderId).trim() : '';
  const text = String(reason ?? '').trim();
  if (!id) throw new Error('Order not found.');
  if (text.length < 10) {
    throw new Error('Please describe the issue (at least 10 characters).');
  }

  const data = await callSupabaseRpc(
    SUPABASE_RPC.RAISE_ORDER_DISPUTE,
    { p_order_id: id, p_reason: text },
    { logTag: 'raiseOrderDispute' }
  );

  if (!rpcSucceeded(data)) {
    throw new Error(
      (data && typeof data === 'object' && data.message) || 'Could not raise dispute.'
    );
  }

  return data != null && typeof data === 'object' ? data : { ok: true };
}

/**
 * Pre-bid gate: bid token (if required) + wallet balance for bid + security fee.
 * @returns {{ ok: true } | { ok: false, message: string, topUpRequired?: boolean }}
 */
export async function ensureBidPrerequisites(userId, listingId, startingPrice, bidAmount) {
  const uid = userId != null ? String(userId).trim() : '';
  const lid = listingId != null ? String(listingId).trim() : '';
  if (!uid) {
    return { ok: false, message: 'Sign in to place a bid.', authRequired: true };
  }

  if (shouldUseSupabaseBidToken(lid)) {
    const status = await getBidTokenStatusSupabase(uid, lid, startingPrice);
    if (status.requiresToken && !status.paid) {
      return {
        ok: false,
        message: `Pay the bid token (Rs. ${status.tokenAmount.toLocaleString()}) before placing a bid.`,
        tokenRequired: true,
        tokenAmount: status.tokenAmount,
      };
    }
  }

  const pw = await fetchProfileWallet(uid);
  const securityFee = 0;
  const gate = evaluateBidWalletGateWithHold(pw.walletBalance, bidAmount, securityFee);

  if (!gate.ok) {
    return {
      ok: false,
      message:
        gate.message ||
        `Need Rs. ${Number(bidAmount).toLocaleString()} in your wallet for this bid.`,
      topUpRequired: gate.topUpRequired,
      insufficientBalance: gate.insufficientBalance,
      balance: gate.balance,
      lockRequired: gate.lockRequired,
      securityFee,
    };
  }

  return { ok: true, securityFee, walletBalance: pw.walletBalance };
}

/**
 * Full bid flow: prerequisites (token + wallet) → place_bid_with_wallet_lock RPC.
 */
export async function placeBidWithWalletLockRpc(userId, listingId, bidAmount, startingPrice = 0) {
  const id = listingId != null ? String(listingId).trim() : '';
  const n = Number(bidAmount);
  if (!id) throw new Error('Listing not found.');
  if (!Number.isFinite(n) || n <= 0) throw new Error('Enter a valid bid amount.');

  const pre = await ensureBidPrerequisites(userId, id, startingPrice, n);
  if (!pre.ok) {
    const err = new Error(pre.message || 'Cannot place bid.');
    if (pre.topUpRequired) err.topUpRequired = true;
    if (pre.insufficientBalance) err.insufficientBalance = true;
    if (pre.authRequired) err.authRequired = true;
    if (pre.tokenRequired) err.tokenRequired = true;
    throw err;
  }

  return callSupabaseRpc(
    SUPABASE_RPC.PLACE_BID,
    {
      p_listing_id: id,
      p_amount: n,
      p_security_fee: 0,
    },
    { logTag: 'placeBidWithWalletLock' }
  );
}

export { payBidTokenSupabase, getBidTokenStatusSupabase, shouldUseSupabaseBidToken };
