import { computeAuctionEndIso, durationDaysForListing } from '../constants/auctionDuration';
import {
  calculateAuctionListingFee,
  formatAuctionListingFeeMessage,
} from '../constants/auctionListingFee';
import { fetchProfileWallet } from './profileWalletService';
import { getSupabase } from './supabaseClient';
import { uploadListingImage } from './storageService';
import { logPostgrestError, logSupabaseError } from './supabaseErrors';
import {
  normalizeListing,
  isListingPubliclyVisible,
  isListingMarketplaceVisible,
  isLocalDeviceMediaUri,
} from '../utils/listingMedia';

/** Fresh ledger idempotency key per publish attempt (wallet_ledger_idempotency_uidx). */
function newAuctionListingFeeIdempotencyKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `auction_listing_fee:${crypto.randomUUID()}`;
  }
  const hex = () =>
    Math.floor((1 + Math.random()) * 0x10000)
      .toString(16)
      .slice(1);
  return `auction_listing_fee:${hex()}${hex()}-${hex()}-4${hex().slice(1)}-a${hex().slice(1)}-${hex()}${hex()}${hex()}`;
}

/** Inserts/reads columns per `supabase/alter_app_schema_sync.sql` + legacy `type` / `moderation_status` / `end_time` / `image_urls`. */
function canonicalListingType(raw) {
  const t = raw?.listing_type ?? raw?.type;
  return t === 'auction' ? 'auction' : 'standard';
}

export function mapListingRowToApp(row) {
  if (!row) return null;

  const listingType = canonicalListingType(row);
  const dbStatus = String(
    row.status ?? row.moderation_status ?? 'active'
  ).toLowerCase();

  const media = normalizeListing(row);
  const id = row.id != null ? String(row.id) : media?.id;
  if (!id) return null;

  return {
    ...media,
    id,
    sellerId: String(row.seller_id ?? row.sellerId ?? media.sellerId ?? ''),
    title: row.title ?? media.title,
    description: row.description ?? media.description ?? '',
    price: Number(row.price ?? media.price) || 0,
    type: listingType,
    category: row.category ?? media.category ?? '',
    location: row.location ?? media.location ?? '',
    moderationStatus:
      dbStatus === 'active' ? 'approved' : dbStatus === 'sold' ? 'sold' : 'pending',
    status: dbStatus,
    currentBid:
      row.current_bid != null
        ? Number(row.current_bid)
        : media.currentBid,
    buyNowPrice:
      row.buy_now_price != null
        ? Number(row.buy_now_price)
        : media.buyNowPrice,
    endTime: row.auction_end_time || row.end_time || media.endTime || null,
    auctionResolvedAt: row.auction_resolved_at || media.auctionResolvedAt || null,
    winnerBidderId:
      row.winner_bidder_id != null
        ? String(row.winner_bidder_id)
        : media.winnerBidderId,
    createdAt: row.created_at ?? media.createdAt,
    image: media.image,
    images: media.images,
    image_url: row.image_url ?? media.image_url ?? media.image,
    image_urls: row.image_urls ?? media.image_urls ?? media.images,
  };
}

export async function fetchListings({ includeInactive = false, marketplaceMode = true } = {}) {
  const supabase = getSupabase();
  console.log('[Bidify/listingsService] fetchListings', { includeInactive, marketplaceMode });
  const q = supabase.from('listings').select('*').order('created_at', { ascending: false });
  const { data, error } = await q;
  if (error) {
    logPostgrestError('listings.select', error);
    throw new Error(error.message || 'Could not load listings.');
  }
  const rows = Array.isArray(data) ? data : [];
  let mapped = rows.map(mapListingRowToApp);
  if (!includeInactive) {
    const visibleFn = marketplaceMode ? isListingMarketplaceVisible : isListingPubliclyVisible;
    mapped = mapped.filter(visibleFn);
    if (marketplaceMode && mapped.length === 0 && rows.length > 0) {
      mapped = rows
        .map(mapListingRowToApp)
        .filter((row) => row && String(row.status || '').toLowerCase() !== 'rejected');
    }
  }
  console.log('[Bidify/listingsService] fetchListings OK', mapped.length);
  return mapped;
}

export async function fetchMyListings(sellerId) {
  const supabase = getSupabase();
  console.log('[Bidify/listingsService] fetchMyListings', sellerId);
  const { data, error } = await supabase
    .from('listings')
    .select('*')
    .eq('seller_id', sellerId)
    .order('created_at', { ascending: false });
  if (error) {
    logPostgrestError('listings.select mine', error);
    throw new Error(error.message || 'Could not load your listings.');
  }
  return (data || []).map(mapListingRowToApp);
}

export async function fetchListingById(id) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('listings').select('*').eq('id', id).maybeSingle();
  if (error) {
    logPostgrestError('listings.select by id', error);
    throw new Error(error.message || 'Listing not found.');
  }
  return mapListingRowToApp(data);
}

export async function createListing(listingData) {
  const supabase = getSupabase();
  const {
    data: { session },
    error: sessErr,
  } = await supabase.auth.getSession();
  if (sessErr) logSupabaseError('auth.getSession', sessErr);
  if (!session?.user?.id) throw new Error('You must be signed in to create a listing.');

  const sellerId = session.user.id;
  const imgs = Array.isArray(listingData.images) ? listingData.images : [];
  const publicUrls = [];

  console.log('[Bidify/listingsService] createListing — upload images', imgs.length);
  for (let i = 0; i < imgs.length; i += 1) {
    const uri = imgs[i];
    if (!uri) continue;
    if (isLocalDeviceMediaUri(uri)) {
      const url = await uploadListingImage(sellerId, uri, i);
      if (url) publicUrls.push(url);
    } else if (/^https?:\/\//i.test(uri)) {
      publicUrls.push(uri);
    }
  }
  if (publicUrls.length === 0) {
    throw new Error('At least one valid image is required.');
  }

  const canonical = canonicalListingType(listingData);
  const price = Number(listingData.price) || 0;
  let listingActivationFee = 0;

  if (canonical === 'auction') {
    listingActivationFee = calculateAuctionListingFee(price);
    const pw = await fetchProfileWallet(sellerId);
    if (pw.walletBalance < listingActivationFee) {
      throw new Error(formatAuctionListingFeeMessage(listingActivationFee));
    }
  }
  const durationValue =
    canonical === 'auction'
      ? String(listingData.duration != null ? listingData.duration : '3').trim()
      : null;
  const durationDays =
    canonical === 'auction' ? durationDaysForListing(durationValue) : null;
  let auctionEnd = null;
  let currentBid = null;
  if (canonical === 'auction') {
    currentBid = price;
    auctionEnd = computeAuctionEndIso(durationValue);
  }

  const nowIso = new Date().toISOString();
  const primaryImage = publicUrls[0];
  const row = {
    seller_id: sellerId,
    title: String(listingData.title || '').trim(),
    description: String(listingData.description || '').trim(),
    category: listingData.category || null,
    image_url: primaryImage,
    /** Legacy `schema.sql`: public read RLS uses moderation_status = 'approved'. */
    moderation_status: 'approved',
    approved_at: nowIso,
    image_urls: [primaryImage],
    price,
    /** Legacy schema (`supabase/schema.sql`) — `type` is NOT NULL */
    type: canonical,
    listing_type: canonical,
    status: 'active',
    current_bid: currentBid,
    auction_end_time: auctionEnd,
    /** Same instant as auction_end_time when present — legacy readers / RPCs may use `end_time`. */
    end_time: auctionEnd,
    duration_days: canonical === 'auction' ? durationDays : null,
    listing_activation_fee: canonical === 'auction' ? listingActivationFee : null,
  };

  console.log('[Bidify/listingsService] createListing — insert', row.title, row.listing_type);
  const { data: inserted, error: insErr } = await supabase.from('listings').insert(row).select('*').single();
  if (insErr) {
    logPostgrestError('listings.insert', insErr);
    throw new Error(insErr.message || 'Could not save listing.');
  }

  const listingId = inserted?.id != null ? String(inserted.id) : '';
  if (!listingId) {
    throw new Error('Listing was created but no id was returned. Please try again.');
  }

  if (canonical === 'auction' && listingActivationFee > 0) {
    const { error: feeErr } = await supabase.rpc('charge_auction_listing_fee', {
      p_starting_bid: price,
      p_listing_id: listingId,
      p_idempotency_key: `auction_listing_fee:${listingId}`,
    });
    if (feeErr) {
      logPostgrestError('rpc.charge_auction_listing_fee', feeErr);
      const msg = String(feeErr.message || '').replace(/^charge_auction_listing_fee:\s*/i, '').trim();
      if (/insufficient wallet balance/i.test(msg)) {
        throw new Error(formatAuctionListingFeeMessage(listingActivationFee));
      }
      throw new Error(msg || formatAuctionListingFeeMessage(listingActivationFee));
    }
  }

  const confirmed = await confirmListingRecordExists(listingId);
  return { success: true, listing: confirmed, listingId };
}

/**
 * Wait until Supabase returns the listing row (avoids first-attempt UI race).
 */
export async function confirmListingRecordExists(
  listingId,
  { retries = 5, delayMs = 400 } = {}
) {
  const id = listingId != null ? String(listingId).trim() : '';
  if (!id) throw new Error('Listing id missing after publish.');

  for (let attempt = 0; attempt < retries; attempt += 1) {
    const row = await fetchListingById(id);
    if (row?.id) return row;
    if (attempt < retries - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw new Error(
    'Listing could not be confirmed in the database yet. Pull to refresh on Home or try again.'
  );
}

export async function updateMyListing(sellerId, listingId, patch) {
  const supabase = getSupabase();
  const allowed = { updated_at: new Date().toISOString() };
  if (patch.title != null) allowed.title = String(patch.title).trim();
  if (patch.description != null) allowed.description = String(patch.description).trim();
  if (patch.price != null) allowed.price = Number(patch.price);
  if (patch.category != null) allowed.category = String(patch.category).trim() || null;
  if (patch.buyNowPrice != null) {
    const bn = Number(patch.buyNowPrice);
    allowed.buy_now_price = Number.isFinite(bn) && bn > 0 ? bn : null;
  }
  if (Array.isArray(patch.images) && patch.images.length > 0) {
    const urls = patch.images.map(String).filter(Boolean);
    allowed.image_url = urls[0];
    allowed.image_urls = urls;
  } else if (patch.image != null) {
    const url = String(patch.image).trim();
    if (url) {
      allowed.image_url = url;
      allowed.image_urls = [url];
    }
  }

  const { data, error } = await supabase
    .from('listings')
    .update(allowed)
    .eq('id', listingId)
    .eq('seller_id', sellerId)
    .select('*')
    .single();

  if (error) {
    logPostgrestError('listings.update mine', error);
    throw new Error(error.message || 'Could not update listing.');
  }
  return mapListingRowToApp(data);
}

export async function deleteMyListing(sellerId, listingId) {
  const supabase = getSupabase();
  const sid = String(sellerId ?? '').trim();
  const lid = String(listingId ?? '').trim();
  console.log('[deleteMyListing Supabase] lookup', {
    listingId: lid,
    sellerId: sid,
    listingIdType: typeof listingId,
  });

  const { data: row, error: fetchErr } = await supabase
    .from('listings')
    .select('id, seller_id, listing_type, type, listing_activation_fee, auction_end_time, status')
    .eq('id', lid)
    .eq('seller_id', sid)
    .maybeSingle();

  if (fetchErr) {
    logPostgrestError('listings.select before delete', fetchErr);
    throw new Error(fetchErr.message || 'Could not load listing.');
  }
  if (!row) {
    const { data: byIdOnly } = await supabase
      .from('listings')
      .select('id, seller_id')
      .eq('id', lid)
      .maybeSingle();
    console.warn('[deleteMyListing Supabase] Listing not found for seller+id', {
      lid,
      sid,
      existsByIdOnly: !!byIdOnly?.id,
      actualSellerId: byIdOnly?.seller_id,
    });
    throw new Error('Listing not found.');
  }

  const listingType = canonicalListingType(row);
  if (listingType === 'auction') {
    const { data: refundData, error: refundErr } = await supabase.rpc(
      'refund_auction_listing_fee',
      { p_listing_id: listingId }
    );
    if (refundErr) {
      logPostgrestError('rpc.refund_auction_listing_fee', refundErr);
      const msg = String(refundErr.message || '').replace(/^refund_auction_listing_fee:\s*/i, '').trim();
      throw new Error(msg || 'Could not refund listing fee before delete.');
    }
    if (__DEV__) {
      console.log('[listingsService] listing fee refund', refundData);
    }
  }

  const { data: deletedRows, error } = await supabase
    .from('listings')
    .delete()
    .eq('id', listingId)
    .eq('seller_id', sellerId)
    .select('id');

  if (error) {
    logPostgrestError('listings.delete mine', error);
    throw new Error(error.message || 'Could not delete listing.');
  }

  if (!Array.isArray(deletedRows) || deletedRows.length === 0) {
    throw new Error(
      'Listing was not deleted. Run supabase/listings_delete_own.sql or use the API server delete endpoint.'
    );
  }

  const { data: stillThere } = await supabase
    .from('listings')
    .select('id')
    .eq('id', listingId)
    .maybeSingle();

  if (stillThere?.id) {
    throw new Error('Listing still exists after delete.');
  }

  const { count, error: countErr } = await supabase
    .from('listings')
    .select('id', { count: 'exact', head: true })
    .eq('seller_id', sellerId);
  let sellerTotalAds = 0;
  if (!countErr && count != null) {
    sellerTotalAds = Number(count) || 0;
  } else {
    const { data: rpcCount } = await supabase.rpc('count_seller_listings', {
      p_seller_id: sellerId,
    });
    sellerTotalAds = Number(rpcCount) || 0;
  }

  try {
    await supabase.rpc('sync_profile_total_ads', { p_seller_id: sellerId });
  } catch (_) {
    /* optional — run supabase/profiles_total_ads_sync.sql */
  }

  if (__DEV__) {
    console.log('[listingsService] permanent delete OK', listingId, deletedRows, {
      sellerTotalAds,
    });
  }

  return {
    success: true,
    deleted: true,
    sellerId,
    sellerTotalAds,
    totalListingsCount: sellerTotalAds,
    total_ads: sellerTotalAds,
    feeRefunded: listingType === 'auction',
  };
}

export async function setListingStatus(id, status) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('listings')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) {
    logPostgrestError('listings.update status', error);
    throw new Error(error.message || 'Could not update listing.');
  }
  return mapListingRowToApp(data);
}

/** @deprecated use setListingStatus */
export async function setListingModeration(id, moderationStatus) {
  const status =
    moderationStatus === 'approved' ? 'active' : moderationStatus === 'rejected' ? 'expired' : 'active';
  return setListingStatus(id, status);
}

export const fetchListingsSupabase = fetchListings;
export const fetchMyListingsSupabase = fetchMyListings;
export const fetchListingByIdSupabase = fetchListingById;
export const createListingWithSupabase = createListing;
export const setListingModerationSupabase = setListingModeration;
export const fetchAdminListingsSupabase = () => fetchListings({ includeInactive: true });
