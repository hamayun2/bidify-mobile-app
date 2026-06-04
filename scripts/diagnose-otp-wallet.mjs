/**
 * Read-only OTP + Wallet diagnostic (service role). Does not modify data.
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL || 'https://hpshnitkiuqclneqaoco.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!key) {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

function iso(d) {
  return d ? new Date(d).toISOString() : null;
}

async function main() {
  console.log('=== Bidify OTP & Wallet Diagnosis ===\n');
  console.log('Supabase:', url);

  const { data: recentBids, error: bidsErr } = await supabase
    .from('bids')
    .select(
      'id, listing_id, bidder_id, bid_amount, amount, wallet_hold_applied, locked_amount, created_at'
    )
    .order('created_at', { ascending: false })
    .limit(8);

  if (bidsErr) console.error('bids error:', bidsErr.message);
  else {
    console.log('\n--- Last 8 bids ---');
    for (const b of recentBids || []) {
      console.log({
        bidId: b.id,
        listingId: b.listing_id,
        bidderId: b.bidder_id,
        bid_amount: b.bid_amount,
        wallet_hold_applied: b.wallet_hold_applied,
        locked_amount: b.locked_amount,
        created_at: iso(b.created_at),
      });
    }
  }

  const { data: ledger, error: ledErr } = await supabase
    .from('wallet_ledger')
    .select('id, user_id, listing_id, bid_id, entry_type, amount, metadata, created_at')
    .order('created_at', { ascending: false })
    .limit(12);

  if (ledErr) console.error('wallet_ledger error:', ledErr.message);
  else {
    console.log('\n--- Last 12 wallet_ledger rows ---');
    for (const r of ledger || []) {
      const meta = r.metadata || {};
      console.log({
        ledgerId: r.id,
        userId: r.user_id,
        listingId: r.listing_id,
        bidId: r.bid_id,
        entry_type: r.entry_type,
        amount: r.amount,
        transaction_status: meta.transaction_status ?? meta.status ?? '(none)',
        metadata: meta,
        created_at: iso(r.created_at),
      });
    }
  }

  const { data: txs, error: txErr } = await supabase
    .from('transactions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);

  if (txErr) console.error('transactions error:', txErr.message, txErr.code);
  else {
    console.log('\n--- Last 10 transactions rows (raw) ---');
    console.log(JSON.stringify(txs, null, 2));
  }

  const { data: wtx, error: wtxErr } = await supabase
    .from('wallet_transactions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(8);

  if (wtxErr) console.error('wallet_transactions error:', wtxErr.message, wtxErr.code);
  else {
    console.log('\n--- Last 8 wallet_transactions ---');
    console.log(JSON.stringify(wtx, null, 2));
  }

  const { data: orders, error: ordErr } = await supabase
    .from('auction_orders')
    .select(
      'id, listing_id, buyer_id, seller_id, status, winning_bid_id, delivery_otp_expires_at, otp_verified_at, created_at'
    )
    .order('created_at', { ascending: false })
    .limit(8);

  if (ordErr) console.error('auction_orders error:', ordErr.message);
  else {
    console.log('\n--- Last 8 auction_orders ---');
    for (const o of orders || []) {
      console.log({
        orderId: o.id,
        listingId: o.listing_id,
        buyerId: o.buyer_id,
        status: o.status,
        otp_verified_at: iso(o.otp_verified_at),
        created_at: iso(o.created_at),
      });
    }
  }

  const lastBid = recentBids?.[0];
  if (lastBid) {
    console.log('\n--- Deep trace: latest bid ---');
    console.log('ListingID:', lastBid.listing_id);
    console.log('BidID:', lastBid.id);
    console.log('TransactionID: N/A — place_bid_with_wallet_lock does NOT insert public.transactions');

    const { data: bidLedger } = await supabase
      .from('wallet_ledger')
      .select('*')
      .eq('listing_id', lastBid.listing_id)
      .eq('user_id', lastBid.bidder_id)
      .order('created_at', { ascending: false });

    console.log('Ledger rows for this listing+bidder:', bidLedger?.length ?? 0);
    for (const r of bidLedger || []) {
      console.log('  ', {
        id: r.id,
        entry_type: r.entry_type,
        amount: r.amount,
        metadata: r.metadata,
      });
    }

    const { data: bidTx } = await supabase
      .from('transactions')
      .select('*')
      .eq('user_id', lastBid.bidder_id)
      .order('created_at', { ascending: false })
      .limit(5);

    console.log('transactions for bidder (last 5):', bidTx?.length ?? 0);
    if (bidTx?.length) console.log(JSON.stringify(bidTx, null, 2));

    const { data: orderForListing } = await supabase
      .from('auction_orders')
      .select('*')
      .eq('listing_id', lastBid.listing_id)
      .maybeSingle();

    console.log('auction_order for listing:', orderForListing ? orderForListing.id : '(none)');
    if (orderForListing) {
      console.log('  status:', orderForListing.status);
    }
  }

  console.log('\n--- Listener compatibility check (latest bid_lock ledger) ---');
  const bidLock = (ledger || []).find((r) => r.entry_type === 'bid_lock');
  if (bidLock) {
    const meta = bidLock.metadata || {};
    const status = String(meta.transaction_status ?? meta.status ?? '').toLowerCase();
    const passesPendingReject = status !== 'pending';
    const passesHold =
      status === 'hold' || status === '' || status === '(none)' || !meta.transaction_status;
    console.log({
      ledgerId: bidLock.id,
      listingId: bidLock.listing_id,
      metadata_status: status || '(empty)',
      otpListener_would_fire_INSERT: passesPendingReject && passesHold,
      note:
        status === 'pending'
          ? 'FAIL: isHoldLedgerRow rejects pending'
          : 'OK for isHoldLedgerRow if amount < 0 and entry_type bid_lock',
    });
  } else {
    console.log('No bid_lock ledger row in last 12 — hold may not be written');
  }

  console.log('\n=== Done ===');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
