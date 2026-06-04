import { getSupabase, isSupabaseConfigured } from './supabaseClient';
import { logPostgrestError } from './supabaseErrors';
import { isAuxiliaryApiConfigured } from '../api/client';
import {
  verifyDeliveryOtpRpc,
  revealBuyerDeliveryOtpRpc,
  raiseOrderDisputeRpc,
} from './apiService';
import {
  fetchEscrowOrdersViaApi,
  revealBuyerDeliveryOtpViaApi,
  verifyDeliveryOtpViaApi,
} from '../api/escrow';
import {
  revealBuyerDeliveryOtpViaOtpApi,
  verifyDeliveryOtpViaOtpApi,
} from '../api/otp';
import { raiseOrderDisputeViaApi } from '../api/dispute';
import {
  syncUserEndedAuctionsToOrders,
  triggerResolveExpiredBatch,
} from './auctionResolveScheduler';

/** public.auction_orders — OTP: delivery_otp_hash, otp_verified_at (plaintext via reveal RPC). */
const ORDER_SELECT_BASE = `
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
  otp_verified_by,
  completed_at,
  created_at,
  updated_at,
  metadata
`;

const ORDER_SELECT_WITH_LISTING = `
  ${ORDER_SELECT_BASE},
  listings (
    id,
    title,
    image_url,
    image_urls
  )
`;

function normUuid(v) {
  return v != null ? String(v).trim().toLowerCase() : '';
}

/** Canonical auth UUID for PostgREST filters (preserve casing from Supabase Auth). */
function canonUuid(v) {
  return v != null ? String(v).trim() : '';
}

export function normalizeOrderStatus(raw) {
  if (raw == null) return '';
  if (typeof raw === 'object') {
    const inner = raw.status ?? raw.value ?? raw.enum ?? raw.label;
    if (inner != null) return normalizeOrderStatus(inner);
    return '';
  }
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/^auction_order_status\./, '')
    .replace(/['"]/g, '');
}

export function resolveOrderRole(order, currentUserId) {
  if (!order) return 'viewer';
  const uid = normUuid(currentUserId);
  const buyerId = normUuid(order.buyerId ?? order.buyer_id);
  const sellerId = normUuid(order.sellerId ?? order.seller_id);
  if (uid && buyerId && uid === buyerId) return 'buyer';
  if (uid && sellerId && uid === sellerId) return 'seller';
  return order.role || 'viewer';
}

function isRlsOrPermissionError(error) {
  const code = String(error?.code || '');
  const msg = String(error?.message || '').toLowerCase();
  return (
    code === '42501' ||
    code === 'PGRST301' ||
    msg.includes('row-level security') ||
    msg.includes('permission denied')
  );
}

function parseRpcError(error, fallback = 'Something went wrong.') {
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

export function mapOrderRowForUi(row, currentUserId) {
  if (!row || typeof row !== 'object') return null;

  const uid = normUuid(currentUserId);
  const buyerId = normUuid(row.buyer_id);
  const sellerId = normUuid(row.seller_id);
  const listing = Array.isArray(row.listings) ? row.listings[0] : row.listings;
  const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};

  let role = 'viewer';
  if (uid && buyerId && uid === buyerId) role = 'buyer';
  else if (uid && sellerId && uid === sellerId) role = 'seller';

  const imageUrl =
    listing?.image_url ||
    (Array.isArray(listing?.image_urls) && listing.image_urls[0]) ||
    null;

  const statusRaw = normalizeOrderStatus(row.status);

  return {
    id: String(row.id),
    listingId: row.listing_id != null ? String(row.listing_id) : null,
    buyerId,
    sellerId,
    winningBidAmount: Number(row.winning_bid_amount) || 0,
    escrowAmount: Number(row.escrow_amount) || 0,
    status: statusRaw || 'unknown',
    deliveryOtpExpiresAt: row.delivery_otp_expires_at,
    otpVerifiedAt: row.otp_verified_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    role,
    isPending: statusRaw === 'pending_delivery',
    isCompleted: statusRaw === 'completed',
    isDisputed: statusRaw === 'disputed',
    isRefunded: statusRaw === 'refunded',
    disputedAt: row.disputed_at,
    raw: row,
    listingTitle:
      (listing?.title && String(listing.title).trim()) ||
      (meta.listing_title && String(meta.listing_title)) ||
      'Auction item',
    listingImage: imageUrl,
  };
}

function dedupeOrdersById(rows) {
  const map = new Map();
  for (const row of rows) {
    if (row?.id) map.set(String(row.id), row);
  }
  return [...map.values()];
}

function bucketOrders(mapped) {
  const pending = mapped.filter((o) => o.isPending);
  const completed = mapped.filter((o) => o.isCompleted || o.isRefunded);
  const other = mapped.filter(
    (o) => !o.isPending && !o.isCompleted && !o.isRefunded
  );
  return { pending, completed, other, all: mapped };
}

const SYNC_TIMEOUT_MS = 20_000;

export async function syncAuctionCompletionBeforeFetch(userId) {
  if (!isSupabaseConfigured()) return null;
  try {
    const syncPromise = (async () => {
      const userSync = await syncUserEndedAuctionsToOrders(userId);
      const batch = await triggerResolveExpiredBatch();
      return { userSync, batch };
    })();

    const result = await Promise.race([
      syncPromise,
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error('Auction sync timed out — loading orders without waiting.')),
          SYNC_TIMEOUT_MS
        );
      }),
    ]);

    if (__DEV__) {
      console.log('[auctionOrders] sync completion', {
        userSync: result?.userSync,
        batchCount: result?.batch?.resolved_count,
      });
    }
    return result;
  } catch (e) {
    console.warn('[auctionOrders] sync completion skipped or failed', e?.message || e);
    return null;
  }
}

async function resolveSessionUserId(passedUid) {
  const supabase = getSupabase();
  const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();
  const sessionUid = sessionData?.session?.user?.id
    ? canonUuid(sessionData.session.user.id)
    : '';

  if (sessionUid) return sessionUid;

  const { data: authData, error: authError } = await supabase.auth.getUser();
  const authUid = authData?.user?.id ? canonUuid(authData.user.id) : '';
  if (authUid) return authUid;

  const fallback = canonUuid(passedUid);
  if (fallback) return fallback;

  throw new Error(
    sessionErr?.message || authError?.message || 'Not signed in — auth session missing.'
  );
}

/**
 * Direct read from public.auction_orders (buyer_id OR seller_id = auth user).
 */
async function fetchOrdersFromSupabase(passedUid) {
  const supabase = getSupabase();
  const effectiveUid = await resolveSessionUserId(passedUid);

  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData?.session?.access_token) {
    throw new Error('Sign in again — no active Supabase session for orders.');
  }

  let rows = [];
  let lastError = null;

  const { data: orData, error: orError } = await supabase
    .from('auction_orders')
    .select(ORDER_SELECT_BASE)
    .or(`buyer_id.eq.${effectiveUid},seller_id.eq.${effectiveUid}`)
    .order('created_at', { ascending: false });

  if (orError) {
    lastError = orError;
    logPostgrestError('auction_orders.select.or', orError, { userId: effectiveUid });
  } else if (Array.isArray(orData)) {
    rows = orData;
  }

  if (rows.length === 0) {
    const [buyerRes, sellerRes] = await Promise.all([
      supabase
        .from('auction_orders')
        .select(ORDER_SELECT_BASE)
        .eq('buyer_id', effectiveUid)
        .order('created_at', { ascending: false }),
      supabase
        .from('auction_orders')
        .select(ORDER_SELECT_BASE)
        .eq('seller_id', effectiveUid)
        .order('created_at', { ascending: false }),
    ]);

    if (buyerRes.error) {
      lastError = buyerRes.error;
      logPostgrestError('auction_orders.select.buyer', buyerRes.error, {
        userId: effectiveUid,
      });
    }
    if (sellerRes.error) {
      lastError = sellerRes.error;
      logPostgrestError('auction_orders.select.seller', sellerRes.error, {
        userId: effectiveUid,
      });
    }

    if (buyerRes.error && sellerRes.error) {
      if (isRlsOrPermissionError(buyerRes.error) || isRlsOrPermissionError(sellerRes.error)) {
        throw new Error(
          'Orders are blocked by database permissions (RLS). Run supabase/fix_auction_orders_select_rls.sql in the SQL Editor, then reload the app.'
        );
      }
      throw new Error(
        buyerRes.error.message || sellerRes.error.message || 'Could not load your orders.'
      );
    }

    rows = dedupeOrdersById([
      ...(Array.isArray(buyerRes.data) ? buyerRes.data : []),
      ...(Array.isArray(sellerRes.data) ? sellerRes.data : []),
    ]).sort((a, b) => {
      const ta = new Date(a.created_at).getTime();
      const tb = new Date(b.created_at).getTime();
      return tb - ta;
    });
  }

  if (rows.length === 0 && lastError && isRlsOrPermissionError(lastError)) {
    throw new Error(
      'Orders are blocked by database permissions (RLS). Run supabase/fix_auction_orders_select_rls.sql in the SQL Editor, then reload the app.'
    );
  }

  const listingIds = [...new Set(rows.map((r) => r.listing_id).filter(Boolean))];
  if (listingIds.length > 0) {
    const { data: listings, error: listErr } = await supabase
      .from('listings')
      .select('id, title, image_url, image_urls')
      .in('id', listingIds);

    if (!listErr && Array.isArray(listings)) {
      const byId = Object.fromEntries(listings.map((l) => [String(l.id), l]));
      rows = rows.map((r) => ({
        ...r,
        listings: r.listing_id ? byId[String(r.listing_id)] ?? null : null,
      }));
    }
  }

  if (rows.length > 0 && !rows[0].listings) {
    const { data: embedded, error: embedErr } = await supabase
      .from('auction_orders')
      .select(ORDER_SELECT_WITH_LISTING)
      .or(`buyer_id.eq.${effectiveUid},seller_id.eq.${effectiveUid}`)
      .order('created_at', { ascending: false });

    if (!embedErr && Array.isArray(embedded) && embedded.length > 0) {
      rows = embedded;
    } else if (embedErr) {
      logPostgrestError('auction_orders.select.embed', embedErr, { userId: effectiveUid });
      console.warn(
        '[auctionOrders] listing embed failed — showing orders without images',
        embedErr.message
      );
    }
  }

  const mapped = rows.map((r) => mapOrderRowForUi(r, effectiveUid)).filter(Boolean);

  const viewerOnly =
    mapped.length > 0 &&
    mapped.every((o) => resolveOrderRole(o, effectiveUid) === 'viewer');

  if (__DEV__) {
    console.log('[auctionOrders] loaded', {
      uid: effectiveUid,
      rawRows: rows.length,
      total: mapped.length,
      buyer: mapped.filter((o) => o.role === 'buyer').length,
      seller: mapped.filter((o) => o.role === 'seller').length,
      pending: mapped.filter((o) => o.isPending).length,
      statuses: mapped.map((o) => o.status),
      viewerOnly,
    });
  }

  if (viewerOnly) {
    console.warn(
      '[auctionOrders] rows returned but auth uid does not match buyer_id/seller_id — check order UUIDs vs signed-in user',
      { uid: effectiveUid, sample: mapped[0] }
    );
  }

  return bucketOrders(mapped);
}

/**
 * Buyer + seller dashboard orders from public.auction_orders.
 */
export async function fetchMyAuctionOrders(userId, opts = {}) {
  const skipSync = opts.skipSync === true;

  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured.');
  }

  const uid = canonUuid(userId);
  if (!skipSync && uid) {
    await syncAuctionCompletionBeforeFetch(uid);
  }

  let buckets;
  try {
    buckets = await fetchOrdersFromSupabase(uid);
  } catch (e) {
    console.error('[auctionOrders] fetchOrdersFromSupabase failed', {
      userId: uid,
      message: e?.message,
      code: e?.code,
    });
    throw e;
  }

  if (isAuxiliaryApiConfigured() && buckets.all.length === 0) {
    try {
      const apiRows = await fetchEscrowOrdersViaApi();
      const sessionUid = await resolveSessionUserId(uid);
      const mapped = (Array.isArray(apiRows) ? apiRows : [])
        .map((r) => mapOrderRowForUi(r, sessionUid))
        .filter(Boolean);
      if (mapped.length > 0) {
        buckets = bucketOrders(mapped);
      }
    } catch (e) {
      if (__DEV__) console.warn('[auctionOrders] API supplement failed', e?.message);
    }
  }

  return buckets;
}

/**
 * Realtime on auction_orders (RLS limits events to buyer/seller rows).
 */
export function subscribeToMyAuctionOrders(userId, onChange) {
  if (!isSupabaseConfigured() || !userId) return () => {};

  const supabase = getSupabase();
  const uid = canonUuid(userId);
  let debounceTimer = null;

  const scheduleRefresh = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      onChange?.();
    }, 400);
  };

  const channel = supabase
    .channel(`auction_orders_live:${uid}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'auction_orders' },
      scheduleRefresh
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'auction_orders' },
      scheduleRefresh
    )
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'auction_orders' },
      scheduleRefresh
    )
    .subscribe((status) => {
      if (__DEV__ && status === 'CHANNEL_ERROR') {
        console.warn('[auctionOrders] realtime channel error');
      }
    });

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    supabase.removeChannel(channel);
  };
}

export async function verifyDeliveryOtp(orderId, otp) {
  const id = orderId != null ? String(orderId).trim() : '';
  const code = String(otp ?? '').trim();
  if (!id) throw new Error('Order not found.');
  if (!code) throw new Error('Enter the 6-digit delivery OTP.');

  try {
    return await verifyDeliveryOtpRpc(id, code);
  } catch (rpcErr) {
    if (!isAuxiliaryApiConfigured()) {
      throw parseRpcError(rpcErr, 'Could not verify delivery OTP.');
    }
    for (const fn of [verifyDeliveryOtpViaOtpApi, verifyDeliveryOtpViaApi]) {
      try {
        const data = await fn(id, code);
        if (data && typeof data === 'object' && data.ok === false) {
          throw parseRpcError({ message: data.message || 'Invalid OTP' });
        }
        return data != null && typeof data === 'object' ? data : { ok: true };
      } catch (e) {
        if (__DEV__) console.warn('[auctionOrders] verify OTP API fallback', e?.message);
      }
    }
    throw parseRpcError(rpcErr, 'Could not verify delivery OTP.');
  }
}

export async function revealBuyerDeliveryOtp(orderId) {
  const id = orderId != null ? String(orderId).trim() : '';
  if (!id) throw new Error('Order not found.');

  try {
    return await revealBuyerDeliveryOtpRpc(id);
  } catch (rpcErr) {
    if (!isAuxiliaryApiConfigured()) {
      throw parseRpcError(rpcErr, 'Could not load delivery OTP.');
    }
    for (const fn of [revealBuyerDeliveryOtpViaOtpApi, revealBuyerDeliveryOtpViaApi]) {
      try {
        return await fn(id);
      } catch (e) {
        if (__DEV__) console.warn('[auctionOrders] reveal OTP API fallback', e?.message);
      }
    }
    throw parseRpcError(rpcErr, 'Could not load delivery OTP.');
  }
}

export async function raiseOrderDispute(orderId, reason) {
  const id = orderId != null ? String(orderId).trim() : '';
  const text = String(reason ?? '').trim();
  if (!id) throw new Error('Order not found.');
  if (text.length < 10) {
    throw new Error('Please describe the issue (at least 10 characters).');
  }

  try {
    return await raiseOrderDisputeRpc(id, text);
  } catch (rpcErr) {
    if (!isAuxiliaryApiConfigured()) {
      throw parseRpcError(rpcErr, 'Could not raise dispute.');
    }
    try {
      return await raiseOrderDisputeViaApi(id, text);
    } catch (e) {
      throw parseRpcError(rpcErr, 'Could not raise dispute.');
    }
  }
}
