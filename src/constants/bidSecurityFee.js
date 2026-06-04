/**
 * Bid commitment / security fee (PKR) — must match
 * public.place_bid_with_wallet_lock (p_security_fee IN 100, 500, 1000).
 */

export const BID_SECURITY_FEE_LOW_PKR = 100;
export const BID_SECURITY_FEE_MID_PKR = 500;
export const BID_SECURITY_FEE_HIGH_PKR = 1000;

/** Same bid amount tiers as wallet hold rules. */
export const BID_FEE_THRESHOLD_LOW_PKR = 1000;
export const BID_FEE_THRESHOLD_MID_PKR = 5000;
export const BID_FEE_THRESHOLD_HIGH_PKR = 10000;

/**
 * @param {number} bidAmountPkr
 * @returns {100 | 500 | 1000}
 */
/** Server locks exact bid only when execute_order_completion_master.sql is deployed. */
export function getBidSecurityFeePkr(_bidAmountPkr) {
  return 0;
}

/**
 * Total spendable wallet needed for one bid (full lock + security fee).
 * @param {number} bidAmountPkr
 */
export function getTotalBidWalletRequirementPkr(bidAmountPkr) {
  const bid = Number(bidAmountPkr) || 0;
  return bid + getBidSecurityFeePkr(bid);
}
