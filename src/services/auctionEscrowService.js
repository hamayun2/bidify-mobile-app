import { isAuxiliaryApiConfigured } from '../api/client';
import {
  resolveAuctionViaApi,
  resolveExpiredAuctionsViaEscrowApi,
} from '../api/escrow';
import { callSupabaseRpc, SUPABASE_RPC } from './apiService';
import { logPostgrestError } from './supabaseErrors';

/**
 * Resolve an ended auction: refund wallet holds for losing bidders;
 * winner's hold stays in held_balance until settlement.
 *
 * Primary: supabase.rpc('resolve_auction') as signed-in user.
 * Fallback: Express /api/escrow/resolve/:id when RPC fails and API is configured.
 */
export async function resolveAuction(listingId, opts = {}) {
  const id = listingId != null ? String(listingId).trim() : '';
  if (!id) throw new Error('Listing not found.');

  try {
    const data = await callSupabaseRpc(
      SUPABASE_RPC.RESOLVE_AUCTION,
      { p_listing_id: id, p_force: !!opts.force },
      { logTag: 'resolveAuction' }
    );
    return data != null && typeof data === 'object' ? data : { ok: true, raw: data };
  } catch (rpcErr) {
    if (!isAuxiliaryApiConfigured()) {
      logPostgrestError('rpc.resolve_auction', rpcErr);
      throw new Error(rpcErr?.message || 'Could not resolve auction escrow.');
    }
    if (__DEV__) {
      console.warn('[auctionEscrow] resolve_auction RPC failed, trying Express', rpcErr?.message);
    }
    const data = await resolveAuctionViaApi(id, opts);
    return data != null && typeof data === 'object' ? data : { ok: true, raw: data };
  }
}

/**
 * Batch-resolve auctions past end time.
 * Primary: supabase.rpc('resolve_expired_auctions'); fallback: Express cron endpoint.
 */
export async function resolveExpiredAuctions(limit = 50) {
  try {
    return await callSupabaseRpc(
      SUPABASE_RPC.RESOLVE_EXPIRED_AUCTIONS,
      { p_limit: limit },
      { logTag: 'resolveExpiredAuctions' }
    );
  } catch (rpcErr) {
    if (!isAuxiliaryApiConfigured()) {
      logPostgrestError('rpc.resolve_expired_auctions', rpcErr);
      throw new Error(rpcErr?.message || 'Could not resolve expired auctions.');
    }
    if (__DEV__) {
      console.warn('[auctionEscrow] batch RPC failed, trying Express', rpcErr?.message);
    }
    return resolveExpiredAuctionsViaEscrowApi(limit);
  }
}

/** Client-side mirror of DB tier function (for UI hints). */
export { getBidWalletHoldAmount } from '../constants/bidHoldRules';
