-- =============================================================================
-- Bidify — Escrow Phase 3: verify_delivery_otp → release escrow to seller
-- =============================================================================
-- Prerequisites:
--   • escrow_phase_a_migration.sql
--   • escrow_phase_1_place_bid_rpc.sql
--   • escrow_phase_2_resolve_auction.sql
--
-- Run once in Supabase SQL Editor. Does NOT modify frontend code.
--
-- Flow:
--   • Seller (or buyer/admin) submits plaintext OTP for a pending_delivery order
--   • OTP is checked against delivery_otp_hash (SHA-256)
--   • Buyer locked_balance -= escrow_amount; seller wallet_balance += escrow_amount
--   • wallet_ledger entries for both parties; order status → completed
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Phase 3 RPC: verify delivery OTP and release escrow to seller
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_delivery_otp(
  p_order_id uuid,
  p_otp text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.auction_orders;
  v_caller uuid;
  v_otp_plain text;
  v_otp_hash text;
  v_escrow numeric;
  v_release numeric;
  v_buyer_wb numeric;
  v_buyer_lb numeric;
  v_seller_wb numeric;
  v_listing_title text;
  v_win_bid_id uuid;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  v_otp_plain := nullif(trim(coalesce(p_otp, '')), '');
  IF v_otp_plain IS NULL OR length(v_otp_plain) < 4 THEN
    RAISE EXCEPTION 'Enter a valid delivery OTP';
  END IF;

  SELECT o.*
  INTO v_order
  FROM public.auction_orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF v_order.status = 'completed'::public.auction_order_status THEN
    RETURN jsonb_build_object(
      'ok', true,
      'already_completed', true,
      'order_id', v_order.id,
      'status', v_order.status,
      'completed_at', v_order.completed_at
    );
  END IF;

  IF v_order.status = 'disputed'::public.auction_order_status THEN
    RAISE EXCEPTION 'This order is under dispute. OTP verification is blocked; funds remain frozen.';
  END IF;

  IF v_order.status IS DISTINCT FROM 'pending_delivery'::public.auction_order_status THEN
    RAISE EXCEPTION 'Order cannot be completed (status: %)', v_order.status;
  END IF;

  IF v_caller IS DISTINCT FROM v_order.buyer_id
     AND v_caller IS DISTINCT FROM v_order.seller_id
     AND NOT coalesce(public.current_user_is_admin(), false) THEN
    RAISE EXCEPTION 'Not allowed to verify OTP for this order';
  END IF;

  IF v_order.delivery_otp_hash IS NULL THEN
    RAISE EXCEPTION 'No delivery OTP configured for this order';
  END IF;

  IF v_order.delivery_otp_expires_at IS NOT NULL
     AND v_order.delivery_otp_expires_at < now() THEN
    RAISE EXCEPTION 'Delivery OTP has expired';
  END IF;

  v_otp_hash := public._hash_delivery_otp(v_otp_plain);

  IF v_order.delivery_otp_hash IS DISTINCT FROM v_otp_hash THEN
    UPDATE public.auction_orders o
    SET
      otp_attempt_count = coalesce(o.otp_attempt_count, 0) + 1,
      updated_at = now()
    WHERE o.id = p_order_id;

    RAISE EXCEPTION 'Invalid delivery OTP';
  END IF;

  v_escrow := floor(coalesce(v_order.escrow_amount, 0));
  IF v_escrow <= 0 THEN
    RAISE EXCEPTION 'Invalid escrow amount on order';
  END IF;

  v_listing_title := nullif(
    trim(coalesce(v_order.metadata->>'listing_title', '')),
    ''
  );
  v_win_bid_id := v_order.winning_bid_id;

  -- -------------------------------------------------------------------------
  -- Fund transfer: buyer locked_balance → seller wallet_balance
  -- -------------------------------------------------------------------------
  SELECT
    coalesce(pr.wallet_balance, 0),
    coalesce(pr.locked_balance, 0)
  INTO v_buyer_wb, v_buyer_lb
  FROM public.profiles pr
  WHERE pr.id = v_order.buyer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Buyer profile not found';
  END IF;

  SELECT coalesce(pr.wallet_balance, 0)
  INTO v_seller_wb
  FROM public.profiles pr
  WHERE pr.id = v_order.seller_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Seller profile not found';
  END IF;

  v_release := least(v_escrow, v_buyer_lb);

  IF v_release < v_escrow THEN
    RAISE EXCEPTION '%',
      format(
        'Insufficient locked balance to release escrow. Need Rs. %s; buyer has Rs. %s locked.',
        v_escrow,
        v_buyer_lb
      );
  END IF;

  UPDATE public.profiles pr
  SET
    locked_balance = greatest(0, coalesce(pr.locked_balance, 0) - v_release),
    updated_at = now()
  WHERE pr.id = v_order.buyer_id;

  UPDATE public.profiles pr
  SET
    wallet_balance = coalesce(pr.wallet_balance, 0) + v_release,
    updated_at = now()
  WHERE pr.id = v_order.seller_id;

  -- Mark winning bid lock as released (if linked)
  IF v_win_bid_id IS NOT NULL THEN
    UPDATE public.bids b
    SET locked_released_at = coalesce(b.locked_released_at, now())
    WHERE b.id = v_win_bid_id
      AND b.locked_released_at IS NULL;
  END IF;

  -- -------------------------------------------------------------------------
  -- Ledger: buyer (payment released) + seller (payment received)
  -- -------------------------------------------------------------------------
  PERFORM public._wallet_ledger_append(
    v_order.buyer_id,
    'escrow_release'::public.wallet_ledger_entry_type,
    -v_release,
    v_order.listing_id,
    v_win_bid_id,
    format('escrow_release:buyer:order:%s', p_order_id),
    jsonb_build_object(
      'reason', 'Payment released for order',
      'description', 'Payment released for order',
      'order_id', p_order_id,
      'listing_id', v_order.listing_id,
      'listing_title', coalesce(v_listing_title, 'Auction listing'),
      'escrow_amount', v_release,
      'role', 'buyer'
    ),
    p_order_id
  );

  PERFORM public._wallet_ledger_append(
    v_order.seller_id,
    'escrow_release'::public.wallet_ledger_entry_type,
    v_release,
    v_order.listing_id,
    v_win_bid_id,
    format('escrow_release:seller:order:%s', p_order_id),
    jsonb_build_object(
      'reason', 'Payment received for order',
      'description', 'Payment received for order',
      'order_id', p_order_id,
      'listing_id', v_order.listing_id,
      'listing_title', coalesce(v_listing_title, 'Auction listing'),
      'escrow_amount', v_release,
      'role', 'seller'
    ),
    p_order_id
  );

  -- -------------------------------------------------------------------------
  -- Complete order (invalidate OTP hash to prevent reuse)
  -- -------------------------------------------------------------------------
  UPDATE public.auction_orders o
  SET
    status = 'completed'::public.auction_order_status,
    otp_verified_at = now(),
    otp_verified_by = v_caller,
    completed_at = now(),
    delivery_otp_hash = NULL,
    updated_at = now()
  WHERE o.id = p_order_id
  RETURNING * INTO v_order;

  RETURN jsonb_build_object(
    'ok', true,
    'order_id', v_order.id,
    'listing_id', v_order.listing_id,
    'status', v_order.status,
    'escrow_released', v_release,
    'buyer_id', v_order.buyer_id,
    'seller_id', v_order.seller_id,
    'completed_at', v_order.completed_at,
    'verified_by', v_caller
  );
END;
$$;

REVOKE ALL ON FUNCTION public.verify_delivery_otp(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_delivery_otp(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_delivery_otp(uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- VERIFICATION (manual — requires a real order + OTP from Phase 2 resolve)
-- =============================================================================
-- 1) After resolve_auction, read OTP hash is NOT readable; test with known OTP
--    only if you logged it during dev, or temporarily query metadata.
--
-- 2) SELECT public.verify_delivery_otp(
--      '<order-uuid>'::uuid,
--      '123456'  -- plaintext OTP shown to buyer at delivery
--    );
--
-- 3) SELECT status, completed_at, otp_verified_at
--    FROM public.auction_orders WHERE id = '<order-uuid>';
--
-- 4) SELECT wallet_balance, locked_balance FROM public.profiles
--    WHERE id IN ('<buyer-uuid>', '<seller-uuid>');
--
-- 5) SELECT entry_type, amount, user_id, metadata
--    FROM public.wallet_ledger
--    WHERE order_id = '<order-uuid>'
--    ORDER BY created_at;
-- =============================================================================
