import { deleteMyListingAPI } from '../api/listings';
import { fetchSellerPublicProfile } from './sellerProfileService';

/**
 * Step 2–3: Call DELETE /api/listings/:id and require 200 + deleted:true.
 */
export async function callDeleteListingApi(sellerId, listingId) {
  const sid = String(sellerId || '').trim();
  const lid = String(listingId || '').trim();
  if (!sid || !lid) {
    throw new Error('Seller id and listing id are required.');
  }

  const { getDeleteListingRequestUrl } = await import('../api/listings');
  const url = getDeleteListingRequestUrl(lid);
  console.log(`[deleteListingPipeline] The request is going to ${url} with listingId=${lid}`);
  console.log('[deleteListingPipeline] DELETE /api/listings/:id', { sellerId: sid, listingId: lid });
  const result = await deleteMyListingAPI(sid, lid);

  if (result?.success !== true || result?.deleted !== true) {
    throw new Error(result?.message || 'Server did not confirm deletion (200 + deleted).');
  }

  console.log('[deleteListingPipeline] 200 OK — delete confirmed', {
    listingId: lid,
    sellerTotalAds: result?.sellerTotalAds ?? result?.total_ads,
  });

  return result;
}

/**
 * Step 5: Re-fetch seller profile stats (Total Ads) from DB/API.
 */
export async function refetchSellerProfileStats(sellerId) {
  const sid = String(sellerId || '').trim();
  if (!sid) return null;
  console.log('[deleteListingPipeline] refetch seller profile stats', sid);
  try {
    return await fetchSellerPublicProfile(sid);
  } catch (e) {
    console.warn('[deleteListingPipeline] profile refetch failed', e?.message);
    return null;
  }
}

