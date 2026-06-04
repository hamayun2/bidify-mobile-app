/**
 * Pre-bid wallet hold — listens for wallet_ledger bid_lock INSERT (Supabase realtime + poll).
 * Backend writes entry_type = 'bid_lock' directly (no pending → hold transition).
 */
import { DeviceEventEmitter } from 'react-native';
import { getSupabase, isSupabaseConfigured } from './supabaseClient';
import { logPostgrestError } from './supabaseErrors';

export const WALLET_HOLD_CONFIRMED_EVENT = 'bidify:wallet-hold-confirmed';

/** @deprecated Legacy export — holds are confirmed on bid_lock INSERT. */
export const TRANSACTION_STATUS = {
  PENDING: 'pending',
  HOLD: 'hold',
};

function canonListingId(listingId) {
  return listingId != null ? String(listingId).trim() : '';
}

function canonUserId(userId) {
  return userId != null ? String(userId).trim() : '';
}

/**
 * @param {object} row wallet_ledger row
 * @param {string} listingId
 * @param {string} userId
 */
export function isBidLockLedgerRow(row, listingId, userId) {
  if (!row) return false;
  if (String(row.user_id) !== userId) return false;
  if (listingId && String(row.listing_id) !== listingId) return false;
  if (String(row.entry_type || '').toLowerCase() !== 'bid_lock') return false;
  return Math.abs(Number(row.amount) || 0) > 0;
}

function buildHoldPayload(row, listingId, userId) {
  return {
    listingId: listingId || (row.listing_id != null ? String(row.listing_id) : ''),
    userId,
    ledgerId: row.id,
    bidId: row.bid_id != null ? String(row.bid_id) : undefined,
    amount: Math.abs(Number(row.amount) || 0),
    transactionStatus: TRANSACTION_STATUS.HOLD,
  };
}

function emitHoldConfirmed(payload) {
  DeviceEventEmitter.emit(WALLET_HOLD_CONFIRMED_EVENT, payload);
}

/**
 * Poll until wallet_ledger contains bid_lock for this user + listing.
 */
export async function waitForWalletHoldConfirmed(
  userId,
  listingId,
  { bidAmount, timeoutMs = 20_000, intervalMs = 450 } = {}
) {
  const lid = canonListingId(listingId);
  if (!lid || !isSupabaseConfigured()) {
    throw new Error('Cannot confirm wallet hold — sign in and try again.');
  }

  const supabase = getSupabase();
  let uid = canonUserId(userId);
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const sessionUid = session?.user?.id ? String(session.user.id).trim() : '';
    if (sessionUid) uid = sessionUid;
  } catch (_) {
    /* fall back to passed userId */
  }
  if (!uid) {
    throw new Error('Cannot confirm wallet hold — sign in and try again.');
  }

  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const { data: ledgerRows, error: ledgerErr } = await supabase
      .from('wallet_ledger')
      .select('id, user_id, listing_id, bid_id, entry_type, amount, metadata, created_at')
      .eq('user_id', uid)
      .eq('listing_id', lid)
      .eq('entry_type', 'bid_lock')
      .order('created_at', { ascending: false })
      .limit(5);

    if (ledgerErr) logPostgrestError('wallet_ledger.select hold', ledgerErr, { uid, lid });

    const holdRow = (ledgerRows || []).find((r) => isBidLockLedgerRow(r, lid, uid));
    if (holdRow) {
      if (
        bidAmount != null &&
        Number.isFinite(Number(bidAmount)) &&
        Math.abs(Number(holdRow.amount) || 0) !== Math.abs(Number(bidAmount))
      ) {
        /* keep polling — may be an older lock row */
      } else {
        const payload = buildHoldPayload(holdRow, lid, uid);
        emitHoldConfirmed(payload);
        return payload;
      }
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error('Wallet hold was not confirmed in time. Check your balance and try again.');
}

/**
 * Realtime — INSERT on wallet_ledger where entry_type = bid_lock for current user + listing.
 */
export function subscribeOTPListener({ userId, listingId, onHoldConfirmed }) {
  const uid = canonUserId(userId);
  const lid = canonListingId(listingId);
  if (!uid || !lid || !isSupabaseConfigured()) return () => {};

  const supabase = getSupabase();
  const channel = supabase
    .channel(`wallet-ledger-bid-lock:${uid}:${lid}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'wallet_ledger',
        filter: `user_id=eq.${uid}`,
      },
      (payload) => {
        const row = payload?.new;
        if (!isBidLockLedgerRow(row, lid, uid)) return;
        const result = buildHoldPayload(row, lid, uid);
        onHoldConfirmed?.(result);
        emitHoldConfirmed(result);
      }
    )
    .subscribe((status) => {
      if (__DEV__ && status === 'CHANNEL_ERROR') {
        console.warn('[otpListener] wallet_ledger realtime channel error', { uid, lid });
      }
    });

  return () => {
    supabase.removeChannel(channel);
  };
}
