/**
 * Bid token gate (pre-bid) — Supabase path when Express store has no listing row.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { calculateBidToken } from '../utils/bidToken';
import { getSupabase, isSupabaseConfigured } from './supabaseClient';
import { fetchProfileWallet } from './profileWalletService';
import { logPostgrestError } from './supabaseErrors';

const TOKEN_PAID_PREFIX = 'bidify:bid-token-paid:';

function tokenStorageKey(userId, listingId) {
  return `${TOKEN_PAID_PREFIX}${String(userId)}:${String(listingId)}`;
}

function isUuidLike(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(id || '')
  );
}

async function userHasBidOnListing(userId, listingId) {
  if (!isSupabaseConfigured() || !userId || !listingId) return false;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('bids')
    .select('id')
    .eq('listing_id', String(listingId))
    .eq('bidder_id', String(userId))
    .limit(1);
  if (error) {
    logPostgrestError('bids.select.token-gate', error);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

/**
 * @param {string} userId
 * @param {string} listingId
 * @param {number} startingPrice
 */
export async function getBidTokenStatusSupabase(userId, listingId, startingPrice) {
  const tokenAmount = calculateBidToken(startingPrice);
  if (tokenAmount <= 0) {
    return {
      requiresToken: false,
      tokenAmount: 0,
      paid: true,
      token: null,
      walletBalance: 0,
      source: 'supabase',
    };
  }

  const uid = String(userId);
  const lid = String(listingId);
  const [hasBid, storedPaid, pw] = await Promise.all([
    userHasBidOnListing(uid, lid),
    AsyncStorage.getItem(tokenStorageKey(uid, lid)).catch(() => null),
    fetchProfileWallet(uid).catch(() => ({ walletBalance: 0 })),
  ]);

  const paid = hasBid || storedPaid === '1';

  return {
    requiresToken: true,
    tokenAmount,
    paid,
    token: paid ? { source: hasBid ? 'existing_bid' : 'local_ack' } : null,
    walletBalance: Number(pw?.walletBalance) || 0,
    source: 'supabase',
  };
}

/**
 * Reserve bid token on Supabase listings (wallet balance check + local ack).
 * Full lock happens in place_bid_with_wallet_lock on first bid.
 */
export async function payBidTokenSupabase(userId, listingId, startingPrice) {
  const tokenAmount = calculateBidToken(startingPrice);
  if (tokenAmount <= 0) {
    return { success: true, alreadyPaid: true, tokenAmount: 0, source: 'supabase' };
  }

  const uid = String(userId);
  const lid = String(listingId);

  if (await userHasBidOnListing(uid, lid)) {
    return { success: true, alreadyPaid: true, tokenAmount, source: 'supabase' };
  }

  const pw = await fetchProfileWallet(uid);
  if (Number(pw?.walletBalance) < tokenAmount) {
    const err = new Error(
      `Insufficient wallet balance (Rs. ${Number(pw?.walletBalance || 0).toLocaleString()}). Top up at least Rs. ${tokenAmount.toLocaleString()} to bid.`
    );
    err.topUpRequired = true;
    err.tokenAmount = tokenAmount;
    err.balance = Number(pw?.walletBalance) || 0;
    throw err;
  }

  await AsyncStorage.setItem(tokenStorageKey(uid, lid), '1');
  return {
    success: true,
    alreadyPaid: false,
    tokenAmount,
    wallet: { balance: pw.walletBalance },
    source: 'supabase',
  };
}

export function shouldUseSupabaseBidToken(listingId) {
  return isSupabaseConfigured() && isUuidLike(listingId);
}
