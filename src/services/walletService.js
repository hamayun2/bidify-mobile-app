import { MIN_WALLET_BALANCE_TO_BID_PKR } from '../constants/walletRules';
import { getBidSecurityFeePkr } from '../constants/bidSecurityFee';
import { fetchProfileWallet } from './profileWalletService';
import { isSupabaseConfigured } from './supabaseClient';

/**
 * Live wallet from public.profiles (source of truth for place_bid_with_wallet_lock).
 */
export async function fetchWalletSummary(userId) {
  if (!isSupabaseConfigured() || !userId) {
    return { balance: 0, heldBalance: 0, transactions: [] };
  }
  const pw = await fetchProfileWallet(userId);
  return {
    balance: pw.walletBalance,
    heldBalance: pw.heldBalance,
    transactions: [],
  };
}

/**
 * Client-side hint before calling bid API. When balance is unknown (offline), returns { ok: true } and lets the server enforce.
 */
export function evaluateBidWalletGate(walletBalance) {
  if (walletBalance == null || Number.isNaN(Number(walletBalance))) {
    return { ok: true, skipped: true };
  }
  const b = Number(walletBalance);
  if (b < MIN_WALLET_BALANCE_TO_BID_PKR) {
    return {
      ok: false,
      topUpRequired: true,
      minBalance: MIN_WALLET_BALANCE_TO_BID_PKR,
      balance: b,
    };
  }
  return { ok: true, balance: b };
}

/**
 * Minimum wallet gate plus full bid amount available for escrow lock
 * (mirrors `place_bid_with_wallet_lock`).
 * @param {number|null|undefined} walletBalance — spendable `wallet_balance`
 * @param {number} bidAmountPkr — full amount locked in escrow when bid succeeds
 * @param {number} [securityFeePkr] — commitment fee (100|500|1000); computed from bid if omitted
 */
export function evaluateBidWalletGateWithHold(walletBalance, bidAmountPkr, securityFeePkr) {
  const base = evaluateBidWalletGate(walletBalance);
  const n = Number(bidAmountPkr);
  const lockRequired = Number.isFinite(n) && n > 0 ? n : 0;
  const securityFee =
    securityFeePkr != null && Number.isFinite(Number(securityFeePkr))
      ? Number(securityFeePkr)
      : getBidSecurityFeePkr(lockRequired);
  const totalRequired = lockRequired + securityFee;

  if (!base.ok) return { ...base, lockRequired, securityFee, totalRequired };

  if (lockRequired <= 0) {
    return { ...base, lockRequired: 0, securityFee, totalRequired: securityFee };
  }

  if (walletBalance == null || Number.isNaN(Number(walletBalance))) {
    return { ok: true, skipped: true, lockRequired, securityFee, totalRequired };
  }

  const b = Number(walletBalance);
  if (b < totalRequired) {
    return {
      ok: false,
      topUpRequired: true,
      insufficientBalance: true,
      minBalance: totalRequired,
      balance: b,
      lockRequired,
      securityFee,
      totalRequired,
      message: `Insufficient wallet balance. Need Rs. ${totalRequired.toLocaleString()} (bid Rs. ${lockRequired.toLocaleString()} + security fee Rs. ${securityFee.toLocaleString()}); you have Rs. ${b.toLocaleString()}.`,
    };
  }
  return { ok: true, balance: b, lockRequired, securityFee, totalRequired };
}
