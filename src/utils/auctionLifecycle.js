import { getListingModerationStatus, isAuctionListing } from './listingMedia';
import { isMyAuctionEnded } from './myAuctionsHelpers';

export { isMyAuctionEnded };

/** Marketplace / home feed: auction whose timer or status has ended. */
export function isMarketplaceAuctionEnded(listing) {
  return isAuctionListing(listing) && isMyAuctionEnded(listing);
}

/** Live on marketplace — active bidding window (not draft/pending, not ended). */
export function isAuctionLiveOrActive(listing) {
  if (!listing || !isAuctionListing(listing)) return false;
  if (isMyAuctionEnded(listing)) return false;

  const status = String(listing.status || '').toLowerCase();
  if (status === 'ended' || status === 'sold' || status === 'expired') return false;

  const moderation = getListingModerationStatus(listing);
  if (moderation === 'pending' || moderation === 'rejected') return false;

  if (status === 'active' || status === 'live') return true;

  if (moderation === 'approved') {
    const endRaw = listing.endTime || listing.auction_end_time || listing.end_time;
    if (endRaw) {
      const endMs = new Date(endRaw).getTime();
      if (Number.isFinite(endMs) && endMs > Date.now()) return true;
    }
  }

  return false;
}

/** Seller may edit drafts / pre-live listings only. */
export function canEditMyListing(listing) {
  if (!listing) return false;
  if (isMyAuctionEnded(listing)) return false;

  if (isAuctionListing(listing)) {
    return !isAuctionLiveOrActive(listing);
  }

  const st = String(listing.status || '').toLowerCase();
  return st !== 'sold' && st !== 'ended' && st !== 'expired';
}

/** Live auctions cannot be deleted; ended, draft, and buy-now (not sold) may be removed. */
export function canDeleteMyListing(listing) {
  if (!listing) return false;
  if (isMyAuctionEnded(listing)) return true;
  if (isAuctionListing(listing)) {
    return !isAuctionLiveOrActive(listing);
  }
  const st = String(listing.status || '').toLowerCase();
  return st !== 'sold' && st !== 'ended' && st !== 'expired';
}

export function getAuctionEndMs(listing) {
  const raw = listing?.endTime ?? listing?.auction_end_time ?? listing?.end_time;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}
