import { isAuctionListing } from './listingMedia';

/**
 * Auction has ended when status says so or end_time / auction_end_time is in the past.
 */
export function isMyAuctionEnded(listing) {
  if (!listing) return false;
  const status = String(listing.status || '').toLowerCase();
  if (status === 'ended' || status === 'sold' || status === 'expired') return true;
  if (listing.auctionResolvedAt) return true;

  if (!isAuctionListing(listing)) return false;

  const endRaw = listing.endTime || listing.auction_end_time || listing.end_time;
  if (!endRaw) return false;
  const endMs = new Date(endRaw).getTime();
  return Number.isFinite(endMs) && endMs <= Date.now();
}

export function isMyAuctionActive(listing) {
  if (!listing || !isAuctionListing(listing)) return false;
  return !isMyAuctionEnded(listing);
}

export function partitionMyAuctions(listings) {
  const rows = listings || [];
  const active = [];
  const ended = [];
  for (const item of rows) {
    if (isAuctionListing(item)) {
      if (isMyAuctionEnded(item)) ended.push(item);
      else active.push(item);
      continue;
    }
    const st = String(item.status || '').toLowerCase();
    if (st === 'sold' || st === 'expired' || st === 'ended') ended.push(item);
    else active.push(item);
  }
  return { active, ended, all: rows };
}

export function sortMyAuctions(listings, sortOrder = 'newest') {
  const dir = sortOrder === 'oldest' ? 1 : -1;
  return [...(listings || [])].sort((a, b) => {
    const ta = new Date(a?.createdAt || a?.created_at || 0).getTime();
    const tb = new Date(b?.createdAt || b?.created_at || 0).getTime();
    if (!Number.isFinite(ta) && !Number.isFinite(tb)) return 0;
    if (!Number.isFinite(ta)) return 1;
    if (!Number.isFinite(tb)) return -1;
    return (ta - tb) * dir;
  });
}
