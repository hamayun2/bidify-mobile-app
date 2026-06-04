/**
 * Keep in sync with `src/constants/auctionListingFee.js` — flat auction listing fee (PKR).
 */
const MIN_AUCTION_LISTING_FEE_PKR = 500;

function calculateAuctionListingFee(startingBidPkr) {
  const n = Number(startingBidPkr);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return MIN_AUCTION_LISTING_FEE_PKR;
}

module.exports = {
  MIN_AUCTION_LISTING_FEE_PKR,
  calculateAuctionListingFee,
};
