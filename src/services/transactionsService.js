import { getSupabase } from './supabaseClient';
import { logPostgrestError } from './supabaseErrors';
import { fetchWalletLedgerForUser } from './walletLedgerService';

const TX_LIMIT = 80;

/**
 * Wallet activity rows from public.wallet_ledger (source of truth for bids, fees, escrow).
 */
export async function fetchTransactionsForUser(userId) {
  return fetchWalletLedgerForUser(userId, TX_LIMIT);
}

export async function insertTransaction(row) {
  const supabase = getSupabase();
  const payload = { ...row };
  const table = row?.stripe_session_id || row?.payment_status != null ? 'wallet_transactions' : 'transactions';
  const { data, error } = await supabase.from(table).insert(payload).select('*').single();
  if (error) {
    logPostgrestError(`${table}.insert`, error);
    throw new Error(error.message || 'Could not record transaction.');
  }
  return data;
}

/** Map wallet_transactions row → WalletContext / WalletScreen item */
export function mapWalletTransactionToWalletTx(row) {
  if (!row) return null;
  const kind = String(row.kind || 'topup');
  const kindMap = {
    stripe_topup: 'topup',
    topup: 'topup',
    bid_hold: 'token_paid',
    bid_refund: 'token_refund',
    auction_listing_fee: 'token_paid',
  };
  return {
    id: row.id,
    kind: kindMap[kind] || kind,
    amount: Number(row.amount) || 0,
    note: row.note || row.provider || null,
    createdAt: row.created_at,
    balanceAfter: row.balance_after != null ? Number(row.balance_after) : null,
    paymentStatus: row.payment_status,
    provider: row.provider,
  };
}

/** Legacy transactions table mapper */
export function mapTransactionToWalletTx(row) {
  if (!row) return null;
  if (row.payment_status != null || row.stripe_session_id != null) {
    return mapWalletTransactionToWalletTx(row);
  }
  const kindMap = {
    stripe_topup: 'topup',
    topup: 'topup',
    bid_hold: 'token_paid',
    bid_refund: 'token_refund',
  };
  return {
    id: row.id,
    kind: kindMap[row.kind] || row.kind,
    amount: Number(row.amount) || 0,
    note: row.note,
    createdAt: row.created_at,
    balanceAfter: row.balance_after != null ? Number(row.balance_after) : null,
  };
}
