import client, { isAuxiliaryApiConfigured } from '../api/client';
import { getSupabase } from './supabaseClient';
import { logPostgrestError } from './supabaseErrors';
import { mapListingRowToApp } from './listingsService';
import {
  callSupabaseRpc,
  logSupabaseConnectivity,
  SUPABASE_RPC,
} from './apiService';
import { runBidTransactionPipeline } from './transactionPipeline';
import { parsePlaceBidRpcError } from './bidErrors';

export { parsePlaceBidRpcError } from './bidErrors';

const PLACE_BID_RPC = SUPABASE_RPC.PLACE_BID;

const LISTING_JOIN_SELECT = `
  id, title, image_url, image_urls, status, moderation_status,
  end_time, auction_end_time, auction_resolved_at, current_bid,
  winner_bidder_id, listing_type, type, price
`;

export function mapBidRowForUi(row) {
  if (!row || typeof row !== 'object') return null;
  const amt = row.bid_amount != null ? Number(row.bid_amount) : Number(row.amount);
  const label =
    row.bidder_display_name != null && String(row.bidder_display_name).trim() !== ''
      ? String(row.bidder_display_name).trim()
      : 'Bidder';
  return {
    id: String(row.id),
    listingId: row.listing_id != null ? String(row.listing_id) : null,
    bidderId: row.bidder_id != null ? String(row.bidder_id) : null,
    amount: Number.isFinite(amt) ? amt : 0,
    bidderDisplayName: label,
    walletHoldApplied: row.wallet_hold_applied != null ? Number(row.wallet_hold_applied) : 0,
    walletHoldReleased: row.wallet_hold_released_at != null,
    createdAt: row.created_at,
    raw: row,
  };
}

/**
 * Place bid — token/wallet prerequisites then supabase.rpc('place_bid_with_wallet_lock').
 * @param {string} listingId
 * @param {number} amount
 * @param {{ userId?: string, startingPrice?: number }} [opts]
 */
export async function placeBid(listingId, amount, opts = {}) {
  logSupabaseConnectivity();

  const id = listingId != null ? String(listingId).trim() : '';
  if (!id) throw new Error('Listing not found.');
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Enter a valid bid amount.');

  const userId = opts.userId != null ? String(opts.userId) : null;
  const startingPrice = Number(opts.startingPrice) || 0;

  console.log('[Bidify/bidsService] placeBid flow: token gate → wallet → RPC', {
    listingId: id,
    amount: n,
    userId: userId || '(session)',
  });

  try {
    if (userId) {
      const pipeline = await runBidTransactionPipeline({
        userId,
        listingId: id,
        bidAmount: n,
        startingPrice,
        waitForHold: true,
      });
      const data = pipeline.bidResult;
      console.log('[Bidify/bidsService] placeBid OK (pipeline)', data?.id ?? data, pipeline.hold);
      return data;
    }

    const data = await callSupabaseRpc(
      PLACE_BID_RPC,
      {
        p_listing_id: id,
        p_amount: n,
        p_security_fee: 0,
      },
      { logTag: 'placeBid' }
    );
    console.log('[Bidify/bidsService] placeBid OK (RPC, session user)', data?.id ?? data);
    return data;
  } catch (rpcErr) {
    const parsed = parsePlaceBidRpcError(rpcErr);
    console.error('[Bidify/bidsService] placeBid failed', {
      code: rpcErr?.code,
      message: parsed.message,
      details: rpcErr?.details,
      hint: rpcErr?.hint,
    });

    if (!isAuxiliaryApiConfigured()) {
      throw parsed;
    }

    console.log('[Bidify/bidsService] trying Express POST /bids/place fallback');
    try {
      const { data: apiData } = await client.post(
        '/bids/place',
        { listingId: id, amount: n },
        { timeout: 20_000, __logResponse: true }
      );
      console.log('[Bidify/bidsService] placeBid OK (Express fallback)', apiData);
      return apiData?.bid ?? apiData;
    } catch (apiErr) {
      console.error('[Bidify/bidsService] Express fallback failed', {
        status: apiErr?.response?.status,
        data: apiErr?.response?.data,
      });
      throw parsed;
    }
  }
}

export { resolveAuction, resolveExpiredAuctions } from './auctionEscrowService';

export async function fetchBidsForListing(listingId) {
  const supabase = getSupabase();
  const listingKey = listingId != null ? String(listingId).trim() : '';
  if (!listingKey) return [];
  const { data, error } = await supabase
    .from('bids')
    .select('*')
    .eq('listing_id', listingKey)
    .order('created_at', { ascending: false });
  if (error) {
    logPostgrestError('bids.select', error);
    throw new Error(error.message || 'Could not load bids.');
  }
  return Array.isArray(data) ? data.map(mapBidRowForUi).filter(Boolean) : [];
}

const BIDS_WITH_LISTING = `
  id, listing_id, bidder_id, bid_amount, amount, created_at, wallet_hold_applied,
  listings ( ${LISTING_JOIN_SELECT.trim().replace(/\n/g, ' ')} )
`;

function listingEndMs(listingRow) {
  const raw =
    listingRow?.auction_end_time ||
    listingRow?.end_time ||
    listingRow?.endTime;
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isAuctionEnded(listingRow) {
  const end = listingEndMs(listingRow);
  if (end == null) return false;
  return end <= Date.now();
}

function userWonAuction(listingRow, userId, myBidAmount) {
  const uid = String(userId || '').toLowerCase();
  const winner = String(
    listingRow?.winner_bidder_id ?? listingRow?.winnerBidderId ?? ''
  ).toLowerCase();
  if (winner && uid && winner === uid) return true;
  const current = Number(listingRow?.current_bid ?? listingRow?.currentBid) || 0;
  return isAuctionEnded(listingRow) && myBidAmount >= current && current > 0;
}

export async function fetchMyBidCardsForUser(userId) {
  const supabase = getSupabase();
  const uid = userId != null ? String(userId).trim() : '';
  if (!uid) return { active: [], won: [], lost: [] };

  let rows = [];
  const { data, error } = await supabase
    .from('bids')
    .select(BIDS_WITH_LISTING)
    .eq('bidder_id', uid)
    .order('created_at', { ascending: false });

  if (error) {
    logPostgrestError('bids.select.my', error, { userId: uid });
    const { data: plain, error: plainErr } = await supabase
      .from('bids')
      .select('*')
      .eq('bidder_id', uid)
      .order('created_at', { ascending: false });
    if (plainErr) throw new Error(plainErr.message || 'Could not load your bids.');
    rows = Array.isArray(plain) ? plain : [];
    const listingIds = [...new Set(rows.map((r) => r.listing_id).filter(Boolean))];
    if (listingIds.length) {
      const { data: listings } = await supabase
        .from('listings')
        .select(LISTING_JOIN_SELECT.replace(/\n/g, ' '))
        .in('id', listingIds);
      const byId = Object.fromEntries((listings || []).map((l) => [String(l.id), l]));
      rows = rows.map((r) => ({
        ...r,
        listings: r.listing_id ? byId[String(r.listing_id)] : null,
      }));
    }
  } else {
    rows = Array.isArray(data) ? data : [];
  }

  const bestByListing = new Map();
  for (const row of rows) {
    const listingKey = row.listing_id != null ? String(row.listing_id) : '';
    if (!listingKey) continue;
    const amt = Number(row.bid_amount ?? row.amount) || 0;
    const prev = bestByListing.get(listingKey);
    if (!prev || amt > (Number(prev.bid_amount ?? prev.amount) || 0)) {
      bestByListing.set(listingKey, row);
    }
  }

  const active = [];
  const won = [];
  const lost = [];

  for (const row of bestByListing.values()) {
    const listingKey = row.listing_id != null ? String(row.listing_id) : '';
    if (!listingKey) continue;
    const listingRaw = Array.isArray(row.listings) ? row.listings[0] : row.listings;
    const listingRow = listingRaw || null;
    const listing = listingRow ? mapListingRowToApp(listingRow) : null;
    const myBidAmount = Number(row.bid_amount ?? row.amount) || 0;
    const ended = listingRow ? isAuctionEnded(listingRow) : false;
    const wonAuction = listingRow && userWonAuction(listingRow, uid, myBidAmount);
    const current = Number(listingRow?.current_bid ?? listingRow?.currentBid) || 0;
    const leading = !ended && myBidAmount >= current;

    let statusLabel = 'Outbid';
    if (wonAuction) statusLabel = 'Won';
    else if (ended) statusLabel = 'Ended';
    else if (leading) statusLabel = 'Highest bidder';

    const card = {
      id: `${listingKey}-${uid}`,
      listingId: listingKey,
      listing_id: listingKey,
      myBidAmount,
      statusLabel,
      listing,
      listingRow,
    };

    if (!ended) active.push(card);
    else if (wonAuction) won.push(card);
    else lost.push(card);
  }

  return { active, won, lost };
}
