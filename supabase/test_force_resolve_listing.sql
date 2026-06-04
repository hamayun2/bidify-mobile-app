-- =============================================================================
-- E2E: force-resolve listing ef77c12d-45b5-47ec-b172-be924620e8eb → auction_orders
-- =============================================================================

-- STEP 0 (required if you saw error 42883 digest does not exist):
--   Run: supabase/enable_pgcrypto_escrow.sql  OR  supabase/deploy_hash_otp_and_resolve.sql
--   Uses extensions.digest (not public.digest). hash_len_64 must be true.

-- STEP 1: Optional — confirm resolve_auction includes order INSERT
SELECT CASE
  WHEN pg_get_functiondef(p.oid) ILIKE '%INSERT INTO public.auction_orders%'
    THEN 'OK'
  ELSE 'Run escrow_phase_2_resolve_auction.sql'
END AS resolve_auction_check
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'resolve_auction';

-- STEP 2: Pre-check listing + bids
SELECT l.id, l.title, l.status, l.auction_resolved_at,
       (SELECT count(*) FROM public.bids b WHERE b.listing_id = l.id) AS bids
FROM public.listings l
WHERE l.id = 'ef77c12d-45b5-47ec-b172-be924620e8eb'::uuid;

-- STEP 3: Force resolve (p_force = true skips "auction not ended yet")
SELECT public.resolve_auction('ef77c12d-45b5-47ec-b172-be924620e8eb'::uuid, true);

-- STEP 4: Verify auction_orders insertion
SELECT
  o.id AS order_id,
  o.listing_id,
  o.buyer_id,
  o.seller_id,
  o.winning_bid_id,
  o.escrow_amount,
  o.status,
  o.delivery_otp_hash IS NOT NULL AS has_otp_hash,
  o.created_at
FROM public.auction_orders o
WHERE o.listing_id = 'ef77c12d-45b5-47ec-b172-be924620e8eb'::uuid;

-- STEP 5: Listing resolved flags
SELECT id, auction_resolved_at, winner_bidder_id, winning_bid_id, status
FROM public.listings
WHERE id = 'ef77c12d-45b5-47ec-b172-be924620e8eb'::uuid;

-- STEP 6: Errors (only if step 3 failed)
SELECT * FROM public.auction_resolve_errors
WHERE listing_id = 'ef77c12d-45b5-47ec-b172-be924620e8eb'::uuid
ORDER BY created_at DESC
LIMIT 5;
