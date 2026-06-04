/**
 * Bid token (refundable deposit) calculator.
 * Tier rule:
 *   price > 100,000 → 10,000
 *   price >  50,000 →  5,000
 *   price >  10,000 →  1,000
 *   otherwise        →      0  (no token required)
 *
 * "price" here = listing starting price (i.e. listing.price).
 */
export function calculateBidToken(startingPrice) {
  const n = Number(startingPrice);
  if (!Number.isFinite(n) || n <= 10000) return 0;
  if (n > 100000) return 10000;
  if (n > 50000) return 5000;
  return 1000;
}

export function formatRs(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 'Rs. 0';
  return `Rs. ${x.toLocaleString()}`;
}
