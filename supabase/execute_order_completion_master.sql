-- =============================================================================
-- Bidify — Master order completion + bid hold fix (run once in Supabase SQL Editor)
-- =============================================================================
-- Consolidates: OTP verify → escrow release → listing fee refund → bid security fix
-- Does NOT alter tables, constraints, or app UI.
--
-- After deploy:
--   • App / API still call verify_delivery_otp(...) — it delegates here.
--   • place_bid_with_wallet_lock locks ONLY the exact bid amount (no +Rs. 100).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- 1) MASTER: atomic order completion (OTP + escrow + listing fee)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.execute_order_completion(
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
  v_buyer_lb numeric;
  v_listing_title text;
  v_win_bid_id uuid;
  v_win_bid public.bids;
  v_listing_fee numeric;
  v_listing_fee_idem text;
  v_listing_fee_refunded boolean := false;
  v_has_bids boolean;
  v_sec_released numeric;
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

  -- Lock order row for the whole transaction
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
      'completed_at', v_order.completed_at,
      'function', 'execute_order_completion'
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

  -- Step 1: Verify OTP
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

  -- Step 2: Release escrow (buyer locked_balance → seller wallet_balance)
  SELECT coalesce(pr.locked_balance, 0)
  INTO v_buyer_lb
  FROM public.profiles pr
  WHERE pr.id = v_order.buyer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Buyer profile not found';
  END IF;

  PERFORM 1
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

  IF v_win_bid_id IS NOT NULL THEN
    UPDATE public.bids b
    SET locked_released_at = coalesce(b.locked_released_at, now())
    WHERE b.id = v_win_bid_id
      AND b.locked_released_at IS NULL;

    -- Legacy bids: release any security fee still in held_balance (no extra hold going forward)
    SELECT b.* INTO v_win_bid
    FROM public.bids b
    WHERE b.id = v_win_bid_id;

    IF FOUND
       AND coalesce(nullif(v_win_bid.security_fee, 0), 0) > 0
       AND v_win_bid.security_fee_released_at IS NULL THEN
      v_sec_released := coalesce(
        public._release_bid_security_fee(v_win_bid, v_order.listing_id),
        0
      );
    END IF;
  END IF;

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

  -- Step 3: Listing fee refund (Rs. 500) to seller
  IF v_order.listing_id IS NOT NULL AND v_order.seller_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.bids b WHERE b.listing_id = v_order.listing_id LIMIT 1
    ) INTO v_has_bids;

    SELECT coalesce(
      nullif(l.listing_activation_fee, 0),
      public.calculate_auction_listing_fee(l.price)
    )
    INTO v_listing_fee
    FROM public.listings l
    WHERE l.id = v_order.listing_id;

    IF coalesce(v_listing_fee, 0) > 0 THEN
      IF v_has_bids THEN
        v_listing_fee_idem := format(
          'auction_listing_fee_refund:completed:%s',
          v_order.listing_id
        );
      ELSE
        v_listing_fee_idem := format(
          'auction_listing_fee_refund:no_bids:%s',
          v_order.listing_id
        );
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM public.wallet_ledger wl
        WHERE wl.idempotency_key = v_listing_fee_idem
      ) THEN
        UPDATE public.profiles pr
        SET
          wallet_balance = coalesce(pr.wallet_balance, 0) + v_listing_fee,
          updated_at = now()
        WHERE pr.id = v_order.seller_id;

        PERFORM public._wallet_ledger_append(
          v_order.seller_id,
          'auction_listing_fee'::public.wallet_ledger_entry_type,
          v_listing_fee,
          v_order.listing_id,
          v_win_bid_id,
          v_listing_fee_idem,
          jsonb_build_object(
            'reason', CASE
              WHEN v_has_bids THEN 'Auction listing fee refund (sale completed)'
              ELSE 'Auction listing fee refund (no bids)'
            END,
            'listing_id', v_order.listing_id,
            'order_id', p_order_id,
            'fee', v_listing_fee,
            'had_bids', v_has_bids
          ),
          p_order_id
        );

        v_listing_fee_refunded := true;
      END IF;
    END IF;
  END IF;

  -- Mark order completed (invalidate OTP)
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
    'function', 'execute_order_completion',
    'order_id', v_order.id,
    'listing_id', v_order.listing_id,
    'status', v_order.status,
    'escrow_released', v_release,
    'listing_fee_refunded', v_listing_fee_refunded,
    'listing_fee_amount', coalesce(v_listing_fee, 0),
    'had_bids', coalesce(v_has_bids, true),
    'buyer_id', v_order.buyer_id,
    'seller_id', v_order.seller_id,
    'completed_at', v_order.completed_at,
    'verified_by', v_caller,
    'legacy_security_fee_released', coalesce(v_sec_released, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.execute_order_completion(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.execute_order_completion(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.execute_order_completion(uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 2) Backward-compatible alias (app + API keep calling verify_delivery_otp)
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
BEGIN
  RETURN public.execute_order_completion(p_order_id, p_otp);
END;
$$;

REVOKE ALL ON FUNCTION public.verify_delivery_otp(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_delivery_otp(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_delivery_otp(uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 3) Bid placement: lock exact bid amount only (no +Rs. 100 security fee)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.place_bid_with_wallet_lock(
  p_listing_id uuid,
  p_amount numeric,
  p_security_fee numeric DEFAULT 0
)
RETURNS public.bids
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid;
  v_seller_id uuid;
  v_kind text;
  v_status text;
  v_mod text;
  v_price numeric;
  v_current numeric;
  v_end timestamptz;
  v_resolved_at timestamptz;
  v_min numeric;
  v_prev public.bids;
  v_released numeric;
  v_wb numeric;
  v_lb numeric;
  v_label text;
  v_bid public.bids;
  v_lock_amount numeric;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_listing_id IS NULL THEN
    RAISE EXCEPTION 'Listing not found';
  END IF;

  v_lock_amount := COALESCE(p_amount, 0);
  IF v_lock_amount <= 0 THEN
    RAISE EXCEPTION 'Enter a valid bid amount';
  END IF;

  -- Ignore legacy p_security_fee — only the bid amount is held
  PERFORM public.ensure_profile_wallet(v_uid, NULL);

  SELECT
    l.seller_id,
    lower(nullif(trim(COALESCE(l.listing_type::text, l.type::text)), '')),
    lower(nullif(trim(l.status::text), '')),
    lower(nullif(trim(l.moderation_status::text), '')),
    l.price,
    l.current_bid,
    COALESCE(l.auction_end_time, l.end_time),
    l.auction_resolved_at
  INTO
    v_seller_id,
    v_kind,
    v_status,
    v_mod,
    v_price,
    v_current,
    v_end,
    v_resolved_at
  FROM public.listings l
  WHERE l.id = p_listing_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Listing not found';
  END IF;

  IF v_resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'Auction has ended and been resolved';
  END IF;

  IF v_seller_id = v_uid THEN
    RAISE EXCEPTION 'You cannot bid on your own listing';
  END IF;

  IF v_kind IS DISTINCT FROM 'auction' THEN
    RAISE EXCEPTION 'Not an auction listing';
  END IF;

  IF NOT (v_status = 'active' OR v_mod = 'approved') THEN
    RAISE EXCEPTION 'Auction is not active';
  END IF;

  IF v_end IS NOT NULL AND v_end < now() THEN
    RAISE EXCEPTION 'Auction has ended';
  END IF;

  v_min := COALESCE(v_current, v_price, 0);
  IF v_lock_amount <= v_min THEN
    RAISE EXCEPTION '%', format('Bid must be higher than current bid (Rs. %s).', v_min);
  END IF;

  SELECT b.*
  INTO v_prev
  FROM public.bids b
  WHERE b.listing_id = p_listing_id
  ORDER BY b.bid_amount DESC, b.created_at DESC
  LIMIT 1
  FOR UPDATE;

  PERFORM public.release_bidder_listing_holds(p_listing_id, v_uid);

  IF v_prev.id IS NOT NULL AND v_prev.bidder_id IS NOT NULL THEN
    PERFORM public.release_bidder_listing_holds(p_listing_id, v_prev.bidder_id);

    IF COALESCE(NULLIF(v_prev.locked_amount, 0), 0) > 0
       AND v_prev.locked_released_at IS NULL THEN
      v_released := public._release_full_bid_lock(v_prev, p_listing_id);
    ELSIF COALESCE(NULLIF(v_prev.security_fee, 0), 0) > 0
          AND v_prev.security_fee_released_at IS NULL THEN
      PERFORM public._release_bid_security_fee(v_prev, p_listing_id);
    END IF;
  END IF;

  SELECT
    COALESCE(pr.wallet_balance, 0),
    COALESCE(pr.locked_balance, 0)
  INTO v_wb, v_lb
  FROM public.profiles pr
  WHERE pr.id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile missing in public.profiles — log out and log in again';
  END IF;

  IF v_wb < v_lock_amount THEN
    RAISE EXCEPTION '%',
      format(
        'Insufficient wallet balance. Need Rs. %s; you have Rs. %s.',
        v_lock_amount,
        v_wb
      )
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.profiles pr
  SET
    wallet_balance = COALESCE(pr.wallet_balance, 0) - v_lock_amount,
    locked_balance = COALESCE(pr.locked_balance, 0) + v_lock_amount,
    updated_at = now()
  WHERE pr.id = v_uid;

  SELECT
    COALESCE(
      nullif(trim(pr.username::text), ''),
      nullif(trim(pr.full_name::text), ''),
      split_part(COALESCE(pr.email::text, ''), '@', 1),
      'Bidder'
    )
  INTO v_label
  FROM public.profiles pr
  WHERE pr.id = v_uid;

  IF v_label IS NULL OR trim(v_label) = '' THEN
    v_label := 'Bidder';
  END IF;

  INSERT INTO public.bids (
    listing_id,
    bidder_id,
    amount,
    bid_amount,
    bidder_display_name,
    wallet_hold_applied,
    locked_amount,
    locked_released_at,
    security_fee,
    security_fee_released_at
  )
  VALUES (
    p_listing_id,
    v_uid,
    v_lock_amount,
    v_lock_amount,
    v_label,
    0,
    v_lock_amount,
    NULL,
    0,
    NULL
  )
  RETURNING *
  INTO v_bid;

  PERFORM public._wallet_ledger_append(
    v_uid,
    'bid_lock'::public.wallet_ledger_entry_type,
    -v_lock_amount,
    p_listing_id,
    v_bid.id,
    format('bid_lock:%s', v_bid.id),
    jsonb_build_object(
      'reason', 'Bid hold for listing',
      'listing_id', p_listing_id,
      'bid_id', v_bid.id,
      'bid_amount', v_lock_amount
    )
  );

  UPDATE public.listings
  SET
    current_bid = v_lock_amount,
    updated_at = now()
  WHERE id = p_listing_id;

  RETURN v_bid;
END;
$$;

REVOKE ALL ON FUNCTION public.place_bid_with_wallet_lock(uuid, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.place_bid_with_wallet_lock(uuid, numeric, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.place_bid_with_wallet_lock(uuid, numeric, numeric) TO service_role;

NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- Quick test (replace UUIDs):
--   SELECT public.execute_order_completion('<order-uuid>'::uuid, '123456');
--   SELECT public.verify_delivery_otp('<order-uuid>'::uuid, '123456');
-- =============================================================================
