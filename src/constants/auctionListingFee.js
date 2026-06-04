/**
 * Seller auction listing escrow hold (PKR). Standard / Buy Now: no fee.
 * Charged on publish; refunded if seller deletes before the auction ends.
 */
export const MIN_AUCTION_LISTING_FEE_PKR = 500;

/**
 * @param {number} startingBidPkr — must be > 0 for a valid auction listing
 * @returns {number} Fee in PKR (0 for invalid/non-auction use)
 */
export function calculateAuctionListingFee(startingBidPkr) {
  const n = Number(startingBidPkr);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return MIN_AUCTION_LISTING_FEE_PKR;
}

export function formatAuctionListingFeeMessage(feePkr) {
  const fee = Number(feePkr) || 0;
  return `Insufficient wallet balance to pay the required Auction Listing Fee of ${fee.toLocaleString()} Rs.`;
}
