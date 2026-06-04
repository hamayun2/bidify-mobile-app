/**
 * Wallet → bid → escrow hold → OTP trigger (Supabase RPC pipeline).
 * Linked to place_bid_with_wallet_lock, resolve_auction, verify_delivery_otp.
 */
import { ensureBidPrerequisites, placeBidWithWalletLockRpc } from './apiService';
import { triggerResolveListingAuction } from './auctionResolveScheduler';
import {
  subscribeOTPListener,
  waitForWalletHoldConfirmed,
  WALLET_HOLD_CONFIRMED_EVENT,
  TRANSACTION_STATUS,
} from './otpListener';

export { WALLET_HOLD_CONFIRMED_EVENT, TRANSACTION_STATUS, subscribeOTPListener, waitForWalletHoldConfirmed };

function canonListingId(listingId) {
  return listingId != null ? String(listingId).trim() : '';
}

/**
 * Full bid pipeline: wallet gate → RPC lock → confirm hold before UI continues.
 */
export async function runBidTransactionPipeline({
  userId,
  listingId,
  bidAmount,
  startingPrice = 0,
  waitForHold = true,
}) {
  const uid = userId != null ? String(userId).trim() : '';
  const lid = canonListingId(listingId);
  const amount = Number(bidAmount);

  if (!uid) throw new Error('Sign in to place a bid.');
  if (!lid) throw new Error('Listing not found.');
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a valid bid amount.');

  const pre = await ensureBidPrerequisites(uid, lid, startingPrice, amount);
  if (!pre.ok) {
    const err = new Error(pre.message || 'Cannot place bid.');
    if (pre.topUpRequired) err.topUpRequired = true;
    if (pre.insufficientBalance) err.insufficientBalance = true;
    if (pre.authRequired) err.authRequired = true;
    if (pre.tokenRequired) err.tokenRequired = true;
    throw err;
  }

  const bidResult = await placeBidWithWalletLockRpc(uid, lid, amount, startingPrice);

  let hold = null;
  if (waitForHold) {
    hold = await waitForWalletHoldConfirmed(uid, lid, { bidAmount: amount });
  }

  return {
    ok: true,
    listingId: lid,
    userId: uid,
    bidAmount: amount,
    bidResult,
    hold,
    transactionStatus: hold?.transactionStatus ?? TRANSACTION_STATUS.HOLD,
  };
}

/**
 * After auction end: resolve_auction → auction_orders + delivery OTP hash.
 */
export async function runEscrowOtpTriggerPipeline(listingId, opts = {}) {
  const lid = canonListingId(listingId);
  if (!lid) throw new Error('Listing not found.');
  return triggerResolveListingAuction(lid, { force: opts.force !== false });
}

/**
 * End-to-end: bid lock then (if auction already ended) escrow/OTP order creation.
 */
export async function runFullAuctionTransactionPipeline(params) {
  const pipeline = await runBidTransactionPipeline(params);
  const lid = pipeline.listingId;

  let resolveResult = null;
  if (params.resolveIfEnded !== false) {
    try {
      resolveResult = await runEscrowOtpTriggerPipeline(lid, { force: false });
    } catch (e) {
      if (__DEV__) console.warn('[transactionPipeline] resolve after bid skipped', e?.message);
    }
  }

  return { ...pipeline, resolveResult };
}
