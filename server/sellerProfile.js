/**
 * Public seller profile + listing stats (Supabase service role).
 * Used by GET /api/users/:id/public-profile and listing detail enrichment.
 */

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  '';

function isSupabaseSellerProfileConfigured() {
  return !!(SUPABASE_URL && SERVICE_KEY);
}

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v || '')
  );
}

async function supabaseRestGet(pathAndQuery) {
  if (!isSupabaseSellerProfileConfigured()) {
    throw new Error('Supabase is not configured for seller profiles.');
  }
  const url = `${String(SUPABASE_URL).replace(/\/$/, '')}/rest/v1/${pathAndQuery}`;
  const res = await fetch(url, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
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
    const msg =
      (data && typeof data === 'object' && (data.message || data.error || data.hint)) ||
      (typeof data === 'string' ? data : null) ||
      res.statusText;
    throw new Error(`Supabase request failed (${res.status}): ${msg}`);
  }
  return data;
}

async function supabaseRpc(functionName, body) {
  if (!isSupabaseSellerProfileConfigured()) {
    throw new Error('Supabase is not configured for seller profiles.');
  }
  const url = `${String(SUPABASE_URL).replace(/\/$/, '')}/rest/v1/rpc/${functionName}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg =
      (data && typeof data === 'object' && (data.message || data.error || data.hint)) ||
      (typeof data === 'string' ? data : null) ||
      res.statusText;
    throw new Error(`Supabase RPC ${functionName} failed (${res.status}): ${msg}`);
  }
  return data;
}

function formatDisplayName(row) {
  if (!row) return 'Seller';
  const first = row.first_name != null ? String(row.first_name).trim() : '';
  const last = row.last_name != null ? String(row.last_name).trim() : '';
  const combined = [first, last].filter(Boolean).join(' ');
  if (combined) return combined;
  const full = row.full_name ? String(row.full_name).trim() : '';
  if (full) return full;
  const username = row.username ? String(row.username).trim() : '';
  if (username) return username;
  const email = row.email ? String(row.email).trim() : '';
  if (email.includes('@')) return email.split('@')[0];
  return 'Seller';
}

function mapSellerSummaryRow(row, listingCount) {
  if (!row) return null;
  const displayName = formatDisplayName(row);
  const profileImage = row.profile_image || null;
  const total = Number(listingCount) || 0;
  return {
    id: String(row.id),
    displayName,
    profileImage: profileImage && String(profileImage).trim() ? String(profileImage) : null,
    totalListingsCount: total,
    total_ads: total,
  };
}

/**
 * SELECT COUNT(*) FROM listings WHERE seller_id = $1
 * Implemented as RPC count_seller_listings (SECURITY DEFINER) with row-fetch fallback.
 */
async function countListingsForSeller(sellerId) {
  const sid = String(sellerId || '').trim();
  if (!sid) {
    console.warn('[sellerProfile] countListingsForSeller: missing sellerId');
    return 0;
  }
  if (!isUuid(sid)) {
    console.warn('[sellerProfile] countListingsForSeller: sellerId is not a UUID', sid);
    return 0;
  }

  try {
    const rpcResult = await supabaseRpc('count_seller_listings', { p_seller_id: sid });
    const n = Number(rpcResult);
    if (Number.isFinite(n) && n >= 0) {
      return n;
    }
  } catch (e) {
    console.warn('[sellerProfile] RPC count_seller_listings:', e?.message || e);
  }

  try {
    const rows = await supabaseRestGet(
      `listings?seller_id=eq.${encodeURIComponent(sid)}&select=id`
    );
    const n = Array.isArray(rows) ? rows.length : 0;
    if (process.env.NODE_ENV !== 'production') {
      console.log('[sellerProfile] count fallback rows', { sellerId: sid, n });
    }
    return n;
  } catch (e) {
    console.error('[sellerProfile] countListingsForSeller failed', e?.message || e);
    return 0;
  }
}

/**
 * Profile row + total listings count (parallel requests).
 */
async function fetchSellerPublicProfile(sellerId) {
  const sid = String(sellerId || '').trim();
  if (!isUuid(sid)) {
    console.warn('[sellerProfile] fetchSellerPublicProfile: invalid sellerId', sid);
    return null;
  }

  const profilePath = `profiles?id=eq.${encodeURIComponent(sid)}&select=id,first_name,last_name,full_name,username,email,profile_image,total_ads&limit=1`;
  const [profileRows, listingRows, rpcCount] = await Promise.all([
    supabaseRestGet(profilePath),
    fetchSellerListingsRows(sid),
    countListingsForSeller(sid),
  ]);
  const row = Array.isArray(profileRows) ? profileRows[0] : null;
  if (!row) return null;
  const columnCount = row.total_ads != null ? Number(row.total_ads) : null;
  const listingCount =
    Number.isFinite(columnCount) && columnCount >= 0
      ? columnCount
      : Number.isFinite(rpcCount) && rpcCount >= 0
        ? rpcCount
        : Array.isArray(listingRows)
          ? listingRows.length
          : 0;
  return mapSellerSummaryRow(row, listingCount);
}

async function fetchSellerListingsRows(sellerId) {
  const sid = String(sellerId || '').trim();
  if (!isUuid(sid)) return [];
  const path = `listings?seller_id=eq.${encodeURIComponent(sid)}&select=*&order=created_at.desc`;
  const rows = await supabaseRestGet(path);
  return Array.isArray(rows) ? rows : [];
}

function buildSellerSummaryFromExpressUser(user, listingCount) {
  if (!user) return null;
  const email = user.email ? String(user.email).trim() : '';
  const displayName =
    user.fullName || user.name || (email ? email.split('@')[0] : '') || 'Seller';
  const total = Number(listingCount) || 0;
  return {
    id: String(user.id),
    displayName,
    profileImage: user.profileImage || user.avatarUrl || null,
    totalListingsCount: total,
    total_ads: total,
  };
}

function countExpressSellerListings(sellerId) {
  const { store } = require('./store');
  return (store.listings || []).filter((l) => String(l.sellerId) === String(sellerId)).length;
}

function fetchExpressSellerPublicProfile(sellerId) {
  const { store } = require('./store');
  const user = (store.users || []).find((u) => String(u.id) === String(sellerId));
  const count = countExpressSellerListings(sellerId);
  return buildSellerSummaryFromExpressUser(user, count);
}

module.exports = {
  isSupabaseSellerProfileConfigured,
  fetchSellerPublicProfile,
  fetchSellerListingsRows,
  fetchExpressSellerPublicProfile,
  countExpressSellerListings,
  countListingsForSeller,
  buildSellerSummaryFromExpressUser,
  mapSellerSummaryRow,
};
