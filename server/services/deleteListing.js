/**
 * Permanent listing deletion via Supabase service role (bypasses missing client DELETE RLS).
 */
const { createClient } = require('@supabase/supabase-js');
const { syncSellerTotalAdsAfterListingChange } = require('./syncSellerListingCount');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  '';

function isConfigured() {
  return !!(SUPABASE_URL && SERVICE_KEY);
}

function getServiceClient() {
  if (!isConfigured()) return null;
  return createClient(String(SUPABASE_URL).replace(/\/$/, ''), SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function getUserClient(accessToken) {
  if (!SUPABASE_URL || !ANON_KEY || !accessToken) return null;
  return createClient(String(SUPABASE_URL).replace(/\/$/, ''), ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v || '')
  );
}

function canonicalListingType(row) {
  const t = String(row?.listing_type || row?.type || '').toLowerCase();
  return t === 'auction' ? 'auction' : 'standard';
}

/**
 * DELETE FROM listings WHERE id = ? AND seller_id = ?
 * Confirms row is gone before returning success.
 */
async function deleteListingPermanent({ listingId, sellerId, accessToken }) {
  const lid = String(listingId || '').trim();
  const sid = String(sellerId || '').trim();

  if (!lid || !isUuid(lid)) {
    const err = new Error('Invalid listing id.');
    err.statusCode = 400;
    throw err;
  }
  if (!sid || !isUuid(sid)) {
    const err = new Error('Invalid seller id.');
    err.statusCode = 400;
    throw err;
  }

  const admin = getServiceClient();
  if (!admin) {
    const err = new Error('Supabase service role is not configured on the server.');
    err.statusCode = 503;
    throw err;
  }

  console.log('[deleteListing] start', { listingId: lid, sellerId: sid });

  const { data: row, error: fetchErr } = await admin
    .from('listings')
    .select(
      'id, seller_id, listing_type, type, listing_activation_fee, auction_end_time, status'
    )
    .eq('id', lid)
    .maybeSingle();

  if (fetchErr) {
    console.error('[deleteListing] select before delete', fetchErr.message);
    const err = new Error(fetchErr.message || 'Could not load listing.');
    err.statusCode = 500;
    throw err;
  }

  if (!row) {
    const { count: idOnlyCount, error: countErr } = await admin
      .from('listings')
      .select('*', { count: 'exact', head: true })
      .eq('id', lid);
    console.log('[deleteListing] not found in DB', {
      listingId: lid,
      listingIdType: typeof lid,
      sellerId: sid,
      rowExistsByIdOnly: !countErr && (idOnlyCount ?? 0) > 0,
      countErr: countErr?.message,
    });
    const err = new Error('Listing not found.');
    err.statusCode = 404;
    throw err;
  }

  if (String(row.seller_id) !== sid) {
    console.warn('[deleteListing] forbidden', { listingId: lid, sellerId: sid, owner: row.seller_id });
    const err = new Error('You can only delete your own listings.');
    err.statusCode = 403;
    throw err;
  }

  let feeRefunded = false;
  const listingType = canonicalListingType(row);

  if (listingType === 'auction' && accessToken) {
    const userClient = getUserClient(accessToken);
    if (userClient) {
      const { data: refundData, error: refundErr } = await userClient.rpc(
        'refund_auction_listing_fee',
        { p_listing_id: lid }
      );
      if (refundErr) {
        console.error('[deleteListing] refund_auction_listing_fee', refundErr.message);
        const err = new Error(
          String(refundErr.message || '').replace(/^refund_auction_listing_fee:\s*/i, '').trim() ||
            'Could not refund listing fee before delete.'
        );
        err.statusCode = 400;
        throw err;
      }
      feeRefunded = !!(refundData && refundData.refunded !== false);
      console.log('[deleteListing] refund RPC', refundData);
    }
  }

  const { data: deletedRows, error: delErr } = await admin
    .from('listings')
    .delete()
    .eq('id', lid)
    .eq('seller_id', sid)
    .select('id');

  if (delErr) {
    console.error('[deleteListing] DELETE failed', delErr.message);
    const err = new Error(delErr.message || 'Could not delete listing.');
    err.statusCode = 500;
    throw err;
  }

  if (!Array.isArray(deletedRows) || deletedRows.length === 0) {
    console.error('[deleteListing] DELETE returned 0 rows', lid);
    const err = new Error('Listing was not deleted from the database.');
    err.statusCode = 500;
    throw err;
  }

  const { data: stillThere, error: verifyErr } = await admin
    .from('listings')
    .select('id')
    .eq('id', lid)
    .maybeSingle();

  if (verifyErr) {
    console.error('[deleteListing] verify select', verifyErr.message);
  }

  if (stillThere?.id) {
    console.error('[deleteListing] row still exists after DELETE', lid);
    const err = new Error('Listing still exists after delete — please try again.');
    err.statusCode = 500;
    throw err;
  }

  const sellerTotalAds = await syncSellerTotalAdsAfterListingChange(sid);

  console.log('[deleteListing] permanent delete OK', {
    listingId: lid,
    sellerId: sid,
    deletedIds: deletedRows.map((r) => r.id),
    sellerTotalAds,
  });

  return {
    success: true,
    deleted: true,
    listingId: lid,
    sellerId: sid,
    sellerTotalAds,
    totalListingsCount: sellerTotalAds,
    total_ads: sellerTotalAds,
    message: 'Listing deleted successfully.',
    feeRefunded: listingType === 'auction' && feeRefunded,
  };
}

module.exports = {
  deleteListingPermanent,
  isDeleteListingConfigured: isConfigured,
};
