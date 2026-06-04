/** Server mirror of src/utils/bidToken.js — same tier rules. */
function calculateBidToken(startingPrice) {
  const n = Number(startingPrice);
  if (!Number.isFinite(n) || n <= 10000) return 0;
  if (n > 100000) return 10000;
  if (n > 50000) return 5000;
  return 1000;
}

module.exports = { calculateBidToken };
