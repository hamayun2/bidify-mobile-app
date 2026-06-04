import client, { isAuxiliaryApiConfigured } from '../api/client';
import { getSupabase, isSupabaseConfigured } from './supabaseClient';
import { logPostgrestError } from './supabaseErrors';
import { formatProfileDisplayName } from '../utils/profileDisplay';
import { normalizeListing } from '../utils/listingMedia';
import { fetchListingById, mapListingRowToApp } from './listingsService';

const PROFILE_TABLE = 'profiles';
const COUNT_RPC = 'count_seller_listings';

const PROFILE_SELECT =
  'id, first_name, last_name, full_name, username, email, profile_image, total_ads';

function buildDisplayNameFromRow(row) {
  if (!row) return 'Seller';
  return formatProfileDisplayName(row) || 'Seller';
}

function normalizeSellerSummary(raw, listingCountFromDb = 0) {
  if (!raw) return null;
  const total = Number(listingCountFromDb) || 0;
  const displayName =
    raw.displayName ||
    raw.display_name ||
    buildDisplayNameFromRow(raw) ||
    'Seller';
  return {
    id: String(raw.id),
    displayName,
    firstName: raw.firstName ?? raw.first_name ?? '',
    lastName: raw.lastName ?? raw.last_name ?? '',
    profileImage: raw.profileImage || raw.profile_image || null,
    totalListingsCount: total,
    total_ads: total,
  };
}

/**
 * Dynamic COUNT(*) FROM listings WHERE seller_id = :sellerId
 */
export async function countSellerListingsSupabase(sellerId) {
  const sid = String(sellerId || '').trim();
  if (!sid) {
    if (__DEV__) console.warn('[sellerProfile] count: missing sellerId');
    return 0;
  }

  const supabase = getSupabase();

  const { data: rpcData, error: rpcError } = await supabase.rpc(COUNT_RPC, {
    p_seller_id: sid,
  });
  if (!rpcError && rpcData != null) {
    const n = Number(rpcData);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  if (rpcError && __DEV__) {
    console.warn(
      '[sellerProfile] RPC count_seller_listings — run supabase/seller_listings_count.sql',
      rpcError.message
    );
  }

  const { data: rows, error } = await supabase
    .from('listings')
    .select('id')
    .eq('seller_id', sid);
  if (error) {
    logPostgrestError('listings.select id for count', error, { sellerId: sid });
    return 0;
  }
  return Array.isArray(rows) ? rows.length : 0;
}

/** Seller public card — prefers API (service role count). */
export async function fetchSellerPublicProfile(sellerId) {
  const sid = String(sellerId || '').trim();
  if (!sid) return null;

  if (isAuxiliaryApiConfigured()) {
    try {
      const r = await client.get(`/users/${encodeURIComponent(sid)}/public-profile`, {
        timeout: 8000,
        __skipAuth: true,
      });
      const seller = normalizeSellerSummary(
        r.data?.seller,
        Number(r.data?.seller?.totalListingsCount ?? r.data?.seller?.total_ads ?? 0)
      );
      if (seller) return seller;
    } catch (e) {
      if (__DEV__) console.warn('[sellerProfile] API public-profile', e?.message);
    }
  }

  if (isSupabaseConfigured()) {
    const supabase = getSupabase();
    const listingCount = await countSellerListingsSupabase(sid);

    const profileRes = await supabase
      .from(PROFILE_TABLE)
      .select(PROFILE_SELECT)
      .eq('id', sid)
      .maybeSingle();

    if (profileRes.error) {
      logPostgrestError(`${PROFILE_TABLE}.select seller`, profileRes.error, { sellerId: sid });
      throw new Error(profileRes.error.message || 'Could not load seller profile.');
    }
    if (!profileRes.data) return null;

    const columnCount =
      profileRes.data.total_ads != null ? Number(profileRes.data.total_ads) : null;
    const total =
      Number.isFinite(columnCount) && columnCount >= 0 ? columnCount : listingCount;

    return normalizeSellerSummary(
      {
        ...profileRes.data,
        displayName: buildDisplayNameFromRow(profileRes.data),
      },
      total
    );
  }

  return null;
}

export async function fetchSellerListings(sellerId) {
  const sid = String(sellerId || '').trim();
  if (!sid) return [];

  if (isAuxiliaryApiConfigured()) {
    try {
      const r = await client.get(`/users/${encodeURIComponent(sid)}/listings`, {
        timeout: 10000,
        __skipAuth: true,
      });
      const rows = Array.isArray(r.data?.listings) ? r.data.listings : [];
      if (rows.length > 0) {
        return rows
          .map((item) => {
            const mapped = mapListingRowToApp(item);
            if (mapped?.image || (Array.isArray(mapped?.images) && mapped.images.length > 0)) {
              return mapped;
            }
            return normalizeListing(item);
          })
          .filter(Boolean);
      }
    } catch (e) {
      if (__DEV__) console.warn('[sellerProfile] API listings', e?.message);
    }
  }

  if (isSupabaseConfigured()) {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('listings')
      .select('*')
      .eq('seller_id', sid)
      .order('created_at', { ascending: false });
    if (error) {
      logPostgrestError('listings.select by seller', error, { sellerId: sid });
      throw new Error(error.message || 'Could not load seller listings.');
    }
    return (data || []).map(mapListingRowToApp).filter(Boolean);
  }

  return [];
}

/** Listing detail — listing + seller summary. */
export async function fetchListingWithSellerSummary(listingId) {
  const listing = await fetchListingById(listingId);
  if (!listing) return { listing: null, sellerSummary: null };

  const sellerId = listing.sellerId ?? listing.seller_id;
  let sellerSummary = null;
  if (sellerId) {
    try {
      sellerSummary = await fetchSellerPublicProfile(String(sellerId));
    } catch (e) {
      if (__DEV__) console.warn('[sellerProfile] summary', e?.message);
    }
  }
  const normalized = {
    ...listing,
    sellerId: sellerId ? String(sellerId) : listing.sellerId,
    sellerSummary,
  };
  return { listing: normalized, sellerSummary };
}
