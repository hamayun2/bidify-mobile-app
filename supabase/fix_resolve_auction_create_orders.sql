-- =============================================================================
-- FIX: Empty auction_orders — restore resolve_auction order INSERT + backfill
-- =============================================================================
-- ROOT CAUSE (no automatic trigger on auction end):
--   • Orders are created only by RPC public.resolve_auction() / resolve_expired_auctions()
--   • Running supabase/BIDIFY_COMPLETE_SYNC.sql alone installs a STUB resolve_auction
--     that marks listings resolved but NEVER inserts into auction_orders.
--
-- REQUIRED (run this entire file in SQL Editor, in order):
--   1) supabase/escrow_phase_2_resolve_auction.sql  ← full file (updated in repo)
--   2) This file (backfill + optional cron)
--
-- After success:
--   SELECT count(*) FROM public.auction_orders;
--   SELECT * FROM public.auction_resolve_errors ORDER BY created_at DESC LIMIT 20;
-- =============================================================================

-- ---------------------------------------------------------------------------
-- A) Which resolve_auction is deployed? (check prosrc contains auction_orders)
-- ---------------------------------------------------------------------------
SELECT
  p.proname AS function_name,
  CASE
    WHEN pg_get_functiondef(p.oid) ILIKE '%INSERT INTO public.auction_orders%'
      THEN 'OK — creates auction_orders'
    ELSE 'BROKEN — run escrow_phase_2_resolve_auction.sql'
  END AS order_insert_status
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'resolve_auction';

-- ---------------------------------------------------------------------------
-- B) Listings resolved but missing orders (need backfill)
-- ---------------------------------------------------------------------------
SELECT
  l.id AS listing_id,
  l.title,
  l.auction_resolved_at,
  l.winner_bidder_id,
  l.winning_bid_id
FROM public.listings l
WHERE l.auction_resolved_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.auction_orders o WHERE o.listing_id = l.id
  )
  AND EXISTS (SELECT 1 FROM public.bids b WHERE b.listing_id = l.id)
ORDER BY l.auction_resolved_at DESC
LIMIT 50;

-- ---------------------------------------------------------------------------
-- C) Backfill missing auction_orders for already-resolved auctions
--     (requires _insert_auction_order_for_winner from phase 2 script)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backfill_missing_auction_orders(p_limit int DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_listing public.listings;
  v_win_bid public.bids;
  v_order public.auction_orders;
  v_created int := 0;
  v_errors int := 0;
  v_results jsonb := '[]'::jsonb;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  FOR v_listing IN
    SELECT l.*
    FROM public.listings l
    WHERE l.auction_resolved_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.auction_orders o WHERE o.listing_id = l.id
      )
      AND EXISTS (SELECT 1 FROM public.bids b WHERE b.listing_id = l.id)
    ORDER BY l.auction_resolved_at DESC
    LIMIT greatest(1, least(coalesce(p_limit, 100), 500))
  LOOP
    BEGIN
      v_win_bid := NULL;

      IF v_listing.winning_bid_id IS NOT NULL THEN
        SELECT b.* INTO v_win_bid
        FROM public.bids b
        WHERE b.id = v_listing.winning_bid_id;
      END IF;

      IF v_win_bid.id IS NULL THEN
        SELECT b.*
        INTO v_win_bid
        FROM public.bids b
        WHERE b.listing_id = v_listing.id
        ORDER BY coalesce(b.bid_amount, b.amount) DESC NULLS LAST, b.created_at DESC
        LIMIT 1;
      END IF;

      IF v_win_bid.id IS NULL OR v_win_bid.bidder_id IS NULL OR v_listing.seller_id IS NULL THEN
        v_errors := v_errors + 1;
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'listing_id', v_listing.id,
          'ok', false,
          'reason', 'no_winner_or_seller'
        ));
        CONTINUE;
      END IF;

      v_order := public._insert_auction_order_for_winner(v_listing.id, v_listing, v_win_bid);
      v_created := v_created + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'listing_id', v_listing.id,
        'ok', true,
        'order_id', v_order.id
      ));
    EXCEPTION
      WHEN OTHERS THEN
        v_errors := v_errors + 1;
        INSERT INTO public.auction_resolve_errors (listing_id, error_message, error_detail, context)
        VALUES (v_listing.id, SQLERRM, SQLSTATE, jsonb_build_object('fn', 'backfill_missing_auction_orders'));
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'listing_id', v_listing.id,
          'ok', false,
          'error', SQLERRM
        ));
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'orders_created', v_created,
    'errors', v_errors,
    'results', v_results
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backfill_missing_auction_orders(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.backfill_missing_auction_orders(int) TO service_role;
GRANT EXECUTE ON FUNCTION public.backfill_missing_auction_orders(int) TO authenticated;

-- Run backfill now (safe to re-run; INSERT is idempotent per listing)
SELECT public.backfill_missing_auction_orders(200);

-- ---------------------------------------------------------------------------
-- D) Resolve all expired auctions not yet resolved (creates orders going forward)
-- ---------------------------------------------------------------------------
SELECT public.resolve_expired_auctions(100);

-- ---------------------------------------------------------------------------
-- E) Optional: pg_cron — auto-resolve every minute (Supabase: enable pg_cron extension)
-- ---------------------------------------------------------------------------
-- CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
-- SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'bidify-resolve-expired-auctions';
-- SELECT cron.schedule(
--   'bidify-resolve-expired-auctions',
--   '* * * * *',
--   $$SELECT public.resolve_expired_auctions(50)$$
-- );

NOTIFY pgrst, 'reload schema';
