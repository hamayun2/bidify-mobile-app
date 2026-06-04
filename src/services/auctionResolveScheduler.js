import { DeviceEventEmitter } from 'react-native';
import { resolveAuction, resolveExpiredAuctions } from './auctionEscrowService';
import { isSupabaseConfigured } from './supabaseClient';
import { getSupabase } from './supabaseClient';

export const AUCTION_RESOLVED_EVENT = 'bidify:auction-resolved';

const inFlight = new Set();
const attempted = new Map();
const BATCH_COOLDOWN_MS = 30_000;
let lastBatchAt = 0;
let batchInFlight = false;

function emitResolved(listingId, result) {
  DeviceEventEmitter.emit(AUCTION_RESOLVED_EVENT, { listingId, result });
}

function listingEndMs(listing) {
  const raw = listing?.auction_end_time || listing?.end_time || listing?.endTime;
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isAuctionListingRow(row) {
  const t = String(row?.listing_type || row?.type || '').toLowerCase();
  return t === 'auction';
}

/**
 * Resolve one ended auction → creates auction_orders + OTP hash (DB: resolve_auction).
 */
export async function triggerResolveListingAuction(listingId, opts = {}) {
  const id = listingId != null ? String(listingId).trim() : '';
  if (!id || !isSupabaseConfigured()) return null;
  if (inFlight.has(id)) return null;

  const last = attempted.get(id);
  if (!opts.force && last && Date.now() - last < 45_000) return null;

  inFlight.add(id);
  try {
    const result = await resolveAuction(id, { force: opts.force !== false });
    attempted.set(id, Date.now());
    if (result && (result.ok || result.already_resolved)) {
      emitResolved(id, result);
    }
    if (__DEV__) {
      console.log('[auctionResolve] resolve_auction', id, {
        order_id: result?.order_id,
        order_status: result?.order_status,
        otp_generated: result?.otp_generated,
      });
    }
    return result;
  } catch (e) {
    attempted.set(id, Date.now());
    if (__DEV__) console.warn('[auctionResolve] listing failed', id, e?.message || e);
    throw e;
  } finally {
    inFlight.delete(id);
  }
}

/**
 * Batch-resolve expired auctions (DB: resolve_expired_auctions → resolve_auction per listing).
 */
export async function triggerResolveExpiredBatch() {
  if (!isSupabaseConfigured()) return null;
  if (batchInFlight) return null;
  if (Date.now() - lastBatchAt < BATCH_COOLDOWN_MS) return null;

  batchInFlight = true;
  lastBatchAt = Date.now();
  try {
    const data = await resolveExpiredAuctions(50);
    const count = Number(data?.resolved_count) || 0;
    if (count > 0) {
      DeviceEventEmitter.emit(AUCTION_RESOLVED_EVENT, {
        batch: true,
        resolved_count: count,
        results: data?.results,
      });
    }
    if (__DEV__ && count > 0) console.log('[auctionResolve] batch resolved', count);
    return data;
  } catch (e) {
    if (__DEV__) console.warn('[auctionResolve] batch failed', e?.message || e);
    return null;
  } finally {
    batchInFlight = false;
  }
}

/**
 * Resolve ended auctions the user participates in (seller or bidder) so auction_orders exist.
 */
export async function syncUserEndedAuctionsToOrders(userId) {
  if (!isSupabaseConfigured() || !userId) return { resolved: 0 };

  const supabase = getSupabase();
  const uid = String(userId).trim();
  const now = Date.now();
  const listingIds = new Set();

  const { data: sellerRows } = await supabase
    .from('listings')
    .select('id, listing_type, type, auction_end_time, end_time, auction_resolved_at')
    .eq('seller_id', uid);

  for (const row of sellerRows || []) {
    if (!isAuctionListingRow(row)) continue;
    const end = listingEndMs(row);
    if (end != null && end <= now) listingIds.add(String(row.id));
  }

  const { data: bidRows } = await supabase
    .from('bids')
    .select('listing_id, listings ( id, listing_type, type, auction_end_time, end_time )')
    .eq('bidder_id', uid);

  for (const b of bidRows || []) {
    const L = Array.isArray(b.listings) ? b.listings[0] : b.listings;
    if (!L?.id && !b.listing_id) continue;
    const id = String(L?.id || b.listing_id);
    if (!isAuctionListingRow(L)) continue;
    const end = listingEndMs(L);
    if (end != null && end <= now) listingIds.add(id);
  }

  let resolved = 0;
  for (const lid of listingIds) {
    try {
      const r = await triggerResolveListingAuction(lid, { force: true });
      if (r?.ok || r?.already_resolved) resolved += 1;
    } catch {
      /* continue other listings */
    }
  }

  await triggerResolveExpiredBatch();

  return { resolved, listingCount: listingIds.size };
}

/** Scan feed listings and resolve any whose timer has passed. */
export function scanEndedAuctionsFromListings(listings) {
  if (!isSupabaseConfigured() || !Array.isArray(listings)) return;
  const now = Date.now();
  let hasEnded = false;

  for (const L of listings) {
    if (L?.type !== 'auction') continue;
    if (L.auctionResolvedAt) continue;
    const endRaw = L.endTime || L.end_time || L.auction_end_time;
    if (!endRaw) continue;
    const endMs = new Date(endRaw).getTime();
    if (!Number.isFinite(endMs) || endMs > now) continue;
    hasEnded = true;
    void triggerResolveListingAuction(L.id, { force: true }).catch(() => {});
  }

  if (hasEnded) {
    void triggerResolveExpiredBatch();
  }
}
