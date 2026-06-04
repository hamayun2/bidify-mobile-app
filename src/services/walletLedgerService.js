import { getSupabase, isSupabaseConfigured } from './supabaseClient';
import { logPostgrestError } from './supabaseErrors';

const LEDGER_SELECT = 'id, entry_type, amount, listing_id, bid_id, metadata, created_at';

/**
 * Fetch wallet_ledger rows for the signed-in user (newest first).
 * @param {string} userId
 * @param {number} [limit]
 */
export async function fetchWalletLedgerForUser(userId, limit = 60) {
  if (!isSupabaseConfigured()) return [];
  const uid = userId != null ? String(userId).trim() : '';
  if (!uid) return [];

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('wallet_ledger')
    .select(LEDGER_SELECT)
    .eq('user_id', uid)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));

  if (error) {
    logPostgrestError('wallet_ledger.select', error, { userId: uid });
    throw new Error(error.message || 'Could not load wallet activity.');
  }

  return Array.isArray(data) ? data : [];
}

function listingTitleFromRow(row, listingTitleById) {
  const lid = row?.listing_id != null ? String(row.listing_id) : '';
  if (lid && listingTitleById[lid]) return listingTitleById[lid];
  const meta = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  if (meta.listing_title) return String(meta.listing_title);
  return 'Auction listing';
}

function titleForEntryType(entryType) {
  switch (String(entryType || '')) {
    case 'bid_lock':
      return 'Bid Hold Placed';
    case 'bid_refund':
      return 'Bid Hold Refunded';
    case 'auction_listing_fee':
      return 'Listing Fee Paid';
    case 'topup':
      return 'Wallet Top-up';
    case 'escrow_lock':
      return 'Escrow Hold';
    case 'escrow_release':
      return 'Escrow Release';
    case 'escrow_refund':
      return 'Escrow Refund';
    default:
      return 'Wallet Transaction';
  }
}

function sourceLabel(meta, entryType) {
  const m = meta && typeof meta === 'object' ? meta : {};
  if (m.source) return String(m.source);
  if (m.description) return String(m.description);
  if (entryType === 'topup') return 'Wallet top-up';
  return '';
}

/**
 * Map wallet_ledger row → WalletScreen activity item.
 */
export function mapLedgerRowToActivity(row, listingTitleById = {}) {
  if (!row || typeof row !== 'object') return null;

  const entryType = String(row.entry_type || '');
  const rawAmount = Number(row.amount);
  const absAmount = Math.abs(Number.isFinite(rawAmount) ? rawAmount : 0);
  if (absAmount <= 0) return null;

  const listingTitle = listingTitleFromRow(row, listingTitleById);
  const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const title = titleForEntryType(entryType);

  switch (entryType) {
    case 'topup':
      return {
        id: String(row.id),
        kind: 'deposit',
        amount: absAmount,
        isCredit: true,
        title: sourceLabel(meta, entryType) || title,
        note: meta.provider ? String(meta.provider) : null,
        createdAt: row.created_at,
      };

    case 'bid_lock':
      return {
        id: String(row.id),
        kind: 'bid_lock',
        amount: absAmount,
        isCredit: false,
        title,
        note: listingTitle !== 'Auction listing' ? listingTitle : null,
        createdAt: row.created_at,
      };

    case 'bid_refund':
      return {
        id: String(row.id),
        kind: 'bid_refund',
        amount: absAmount,
        isCredit: true,
        title,
        note: listingTitle !== 'Auction listing' ? listingTitle : null,
        createdAt: row.created_at,
      };

    case 'legacy_tier_release':
      return {
        id: String(row.id),
        kind: 'bid_refund',
        amount: absAmount,
        isCredit: true,
        title: 'Bid Hold Refunded',
        note: listingTitle !== 'Auction listing' ? listingTitle : null,
        createdAt: row.created_at,
      };

    case 'legacy_tier_hold':
      return {
        id: String(row.id),
        kind: 'bid_lock',
        amount: absAmount,
        isCredit: false,
        title: 'Bid Hold Placed',
        note: listingTitle !== 'Auction listing' ? listingTitle : null,
        createdAt: row.created_at,
      };

    case 'escrow_lock':
      return {
        id: String(row.id),
        kind: 'bid_lock',
        amount: absAmount,
        isCredit: false,
        title,
        note: meta.reason || (listingTitle !== 'Auction listing' ? listingTitle : null),
        createdAt: row.created_at,
      };

    case 'escrow_release': {
      const isCredit = rawAmount > 0;
      return {
        id: String(row.id),
        kind: 'bid_refund',
        amount: absAmount,
        isCredit,
        title,
        note: meta.description || meta.reason || (listingTitle !== 'Auction listing' ? listingTitle : null),
        createdAt: row.created_at,
      };
    }

    case 'auction_listing_fee':
      return {
        id: String(row.id),
        kind: 'listing_fee',
        amount: absAmount,
        isCredit: rawAmount > 0,
        title,
        note: meta.reason || (listingTitle !== 'Auction listing' ? listingTitle : null),
        createdAt: row.created_at,
      };

    case 'escrow_refund':
      return {
        id: String(row.id),
        kind: 'escrow_refund',
        amount: absAmount,
        isCredit: true,
        title,
        note: meta.reason || meta.action || (listingTitle !== 'Auction listing' ? listingTitle : null),
        createdAt: row.created_at,
      };

    default:
      return {
        id: String(row.id),
        kind: entryType || 'other',
        amount: absAmount,
        isCredit: rawAmount > 0,
        title,
        note: sourceLabel(meta, entryType) || null,
        createdAt: row.created_at,
      };
  }
}

export function mapLedgerRowsToActivity(rows, listingTitleById = {}) {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => mapLedgerRowToActivity(r, listingTitleById)).filter(Boolean);
}
