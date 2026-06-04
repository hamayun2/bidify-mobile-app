/**
 * Map PostgREST / PostgreSQL errors from place_bid_with_wallet_lock.
 */
export function parsePlaceBidRpcError(postgrestError) {
  const raw = String(
    postgrestError?.message || postgrestError?.details || postgrestError?.hint || ''
  ).trim();

  let message = raw
    .replace(/^.*?\bP0001:\s*/i, '')
    .replace(/^place_bid_with_wallet_lock:\s*/i, '')
    .replace(/^ERROR:\s*/i, '')
    .trim();

  if (!message) message = 'Could not place bid. Please try again.';

  const err = new Error(message);
  if (postgrestError?.code) err.code = postgrestError.code;

  if (/insufficient wallet balance/i.test(message)) {
    err.insufficientBalance = true;
    err.topUpRequired = true;
  }
  if (/bid must be higher|bid too low/i.test(message)) {
    err.bidTooLow = true;
  }
  if (/not authenticated/i.test(message)) {
    err.authRequired = true;
  }
  if (/auction has ended|not active|not an auction|own listing/i.test(message)) {
    err.bidRejected = true;
  }

  return err;
}
