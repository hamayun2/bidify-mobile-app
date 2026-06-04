/**
 * Recompute seller listing count from DB and sync profiles.total_ads when present.
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  '';

function getServiceClient() {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  return createClient(String(SUPABASE_URL).replace(/\/$/, ''), SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function countSellerListingsRpc(admin, sellerId) {
  const { data, error } = await admin.rpc('count_seller_listings', {
    p_seller_id: sellerId,
  });
  if (!error && data != null) {
    const n = Number(data);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  if (error) {
    console.warn('[syncSellerListingCount] count_seller_listings RPC', error.message);
  }

  const { data: rows, error: selErr } = await admin
    .from('listings')
    .select('id')
    .eq('seller_id', sellerId);
  if (selErr) {
    console.warn('[syncSellerListingCount] listings select count', selErr.message);
    return 0;
  }
  return Array.isArray(rows) ? rows.length : 0;
}

/**
 * After DELETE: sync profiles.total_ads via RPC (or COUNT + UPDATE fallback).
 */
async function syncSellerTotalAdsAfterListingChange(sellerId) {
  const sid = String(sellerId || '').trim();
  if (!sid) return 0;

  const admin = getServiceClient();
  if (!admin) return 0;

  let total = await countSellerListingsRpc(admin, sid);

  const { data: rpcSync, error: syncErr } = await admin.rpc('sync_profile_total_ads', {
    p_seller_id: sid,
  });
  if (!syncErr && rpcSync != null) {
    const n = Number(rpcSync);
    if (Number.isFinite(n) && n >= 0) {
      total = n;
      console.log('[syncSellerListingCount] sync_profile_total_ads OK', { sellerId: sid, total });
      return total;
    }
  }
  if (syncErr) {
    const { error: updErr } = await admin
      .from('profiles')
      .update({ total_ads: total })
      .eq('id', sid);
    if (updErr) {
      console.warn(
        '[syncSellerListingCount] profiles.total_ads update skipped (run supabase/profiles_total_ads_sync.sql)',
        updErr.message
      );
    } else {
      console.log('[syncSellerListingCount] profiles.total_ads updated', { sellerId: sid, total });
    }
  }

  return total;
}

module.exports = {
  syncSellerTotalAdsAfterListingChange,
  countSellerListingsRpc,
};
