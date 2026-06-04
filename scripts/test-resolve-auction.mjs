import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !KEY) {
  console.error('Missing EXPO_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
};

async function getJson(path) {
  const res = await fetch(`${SUPABASE_URL}${path}`, { headers });
  const body = await res.json();
  return { status: res.status, body };
}

async function main() {
  const { status: listStatus, body: listings } = await getJson(
    '/rest/v1/listings?select=id,title,listing_type,type,status,auction_end_time,end_time,auction_resolved_at,current_bid,seller_id&auction_resolved_at=is.null&order=created_at.desc&limit=30'
  );

  console.log('LISTINGS_STATUS', listStatus);
  if (!Array.isArray(listings)) {
    console.log('LISTINGS_ERROR', JSON.stringify(listings, null, 2));
    process.exit(1);
  }

  const auctions = listings.filter((l) => {
    const t = String(l.listing_type || l.type || '').toLowerCase();
    return t === 'auction' || (!t && l.auction_end_time);
  });

  let picked = null;
  let topBids = [];

  for (const l of auctions) {
    const { body: bids } = await getJson(
      `/rest/v1/bids?listing_id=eq.${l.id}&select=id,bidder_id,bid_amount,amount,locked_amount&order=created_at.desc&limit=1`
    );
    if (Array.isArray(bids) && bids.length > 0) {
      picked = l;
      topBids = bids;
      break;
    }
  }

  if (!picked && auctions.length > 0) {
    picked = auctions[0];
    const { body: bids } = await getJson(
      `/rest/v1/bids?listing_id=eq.${picked.id}&select=id,bidder_id,bid_amount,amount&limit=1`
    );
    topBids = Array.isArray(bids) ? bids : [];
  }

  if (!picked) {
    console.log('NO_ACTIVE_UNRESOLVED_LISTING');
    process.exit(2);
  }

  console.log('PICKED_LISTING', {
    id: picked.id,
    title: picked.title,
    status: picked.status,
    end: picked.auction_end_time || picked.end_time,
    current_bid: picked.current_bid,
    has_bids: topBids.length,
    top_bid: topBids[0] || null,
  });

  const { body: ordersBefore } = await getJson(
    `/rest/v1/auction_orders?listing_id=eq.${picked.id}&select=id,status,buyer_id,seller_id`
  );
  console.log('ORDERS_BEFORE', ordersBefore);

  const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/resolve_auction`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ p_listing_id: picked.id, p_force: true }),
  });
  const rpcText = await rpcRes.text();
  let rpcJson = null;
  try {
    rpcJson = JSON.parse(rpcText);
  } catch {
    rpcJson = rpcText;
  }
  console.log('RESOLVE_RPC_STATUS', rpcRes.status);
  console.log('RESOLVE_RPC_BODY', rpcJson);

  const { body: ordersAfter } = await getJson(
    `/rest/v1/auction_orders?listing_id=eq.${picked.id}&select=id,listing_id,buyer_id,seller_id,status,escrow_amount,winning_bid_id,delivery_otp_hash,created_at`
  );
  console.log('ORDERS_AFTER', ordersAfter);

  const { body: listingAfter } = await getJson(
    `/rest/v1/listings?id=eq.${picked.id}&select=id,auction_resolved_at,winner_bidder_id,winning_bid_id,status`
  );
  console.log('LISTING_AFTER', listingAfter);

  const success = Array.isArray(ordersAfter) && ordersAfter.length > 0;
  console.log('INSERTION_SUCCESS', success);
  if (!success) {
    const { body: errors } = await getJson(
      '/rest/v1/auction_resolve_errors?listing_id=eq.' +
        picked.id +
        '&select=error_message,error_detail,created_at&order=created_at.desc&limit=5'
    );
    console.log('RESOLVE_ERRORS', errors);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
