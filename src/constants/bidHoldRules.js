/**
 * Bid wallet hold (PKR) — keep in sync with `public.compute_bid_wallet_hold`
 * in supabase/wallet_hold_lifecycle.sql
 *
 * When a tier applies, that amount moves from spendable `wallet_balance`
 * into `held_balance` on `public.profiles` inside `place_bid`.
 * On auction end, `resolve_auction` releases losers' holds back to `wallet_balance`.
 */

/** Bid above this (PKR) triggers the low hold. */
export const BID_HOLD_THRESHOLD_LOW_PKR = 1000;

/** Bid above this (PKR) triggers the mid hold. */
export const BID_HOLD_THRESHOLD_MID_PKR = 5000;

/** Bid above this (PKR) triggers the high hold (e.g. 10,000+ bid). */
export const BID_HOLD_THRESHOLD_HIGH_PKR = 10000;

/** Hold when bid > BID_HOLD_THRESHOLD_LOW_PKR and ≤ mid tier. */
export const BID_HOLD_AMOUNT_LOW_PKR = 500;

/** Hold when bid > BID_HOLD_THRESHOLD_MID_PKR and ≤ high tier. */
export const BID_HOLD_AMOUNT_MID_PKR = 1000;

/** Hold when bid > BID_HOLD_THRESHOLD_HIGH_PKR. */
export const BID_HOLD_AMOUNT_HIGH_PKR = 2000;

/**
 * @param {number} bidAmountPkr
 * @returns {number} Hold amount (0 if no tier applies)
 */
export function getBidWalletHoldAmount(bidAmountPkr) {
  const n = Number(bidAmountPkr);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > BID_HOLD_THRESHOLD_HIGH_PKR) return BID_HOLD_AMOUNT_HIGH_PKR;
  if (n > BID_HOLD_THRESHOLD_MID_PKR) return BID_HOLD_AMOUNT_MID_PKR;
  if (n > BID_HOLD_THRESHOLD_LOW_PKR) return BID_HOLD_AMOUNT_LOW_PKR;
  return 0;
}
