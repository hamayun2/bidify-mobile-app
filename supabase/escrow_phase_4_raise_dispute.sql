-- =============================================================================
-- Bidify — Escrow Phase 4: raise_order_dispute + freeze disputed orders
-- =============================================================================
-- Prerequisites: escrow_phase_a through phase_3 (incl. buyer_reveal_otp)
-- Run once in Supabase SQL Editor.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- raise_order_dispute — buyer flags pending_delivery order; funds stay frozen
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.raise_order_dispute(
  p_order_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.auction_orders;
  v_caller uuid;
  v_reason text;
  v_ticket_id uuid;
  v_existing uuid;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  v_reason := nullif(trim(coalesce(p_reason, '')), '');
  IF v_reason IS NULL OR length(v_reason) < 10 THEN
    RAISE EXCEPTION 'Please describe the issue (at least 10 characters).';
  END IF;

  SELECT o.*
  INTO v_order
  FROM public.auction_orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF v_order.status IS DISTINCT FROM 'pending_delivery'::public.auction_order_status THEN
    RAISE EXCEPTION 'Disputes can only be raised while the order is awaiting delivery';
  END IF;

  IF v_caller IS DISTINCT FROM v_order.buyer_id
     AND NOT coalesce(public.current_user_is_admin(), false) THEN
    RAISE EXCEPTION 'Only the buyer can raise a dispute on this order';
  END IF;

  SELECT t.id INTO v_existing
  FROM public.support_tickets t
  WHERE t.order_id = p_order_id
    AND t.status IN ('open'::public.support_ticket_status, 'under_review'::public.support_ticket_status)
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'A dispute is already open for this order';
  END IF;

  UPDATE public.auction_orders o
  SET
    status = 'disputed'::public.auction_order_status,
    disputed_at = now(),
    disputed_by = 'buyer'::public.support_ticket_opened_by,
    delivery_otp_hash = NULL,
    updated_at = now()
  WHERE o.id = p_order_id;

  INSERT INTO public.support_tickets (
    order_id,
    opened_by,
    opened_by_user_id,
    status,
    subject,
    reason
  )
  VALUES (
    p_order_id,
    'buyer'::public.support_ticket_opened_by,
    v_order.buyer_id,
    'open'::public.support_ticket_status,
    'Delivery dispute',
    v_reason
  )
  RETURNING id INTO v_ticket_id;

  INSERT INTO public.support_ticket_messages (
    ticket_id,
    sender_id,
    body,
    is_admin_message
  )
  VALUES (
    v_ticket_id,
    v_order.buyer_id,
    v_reason,
    false
  );

  RETURN jsonb_build_object(
    'ok', true,
    'order_id', p_order_id,
    'ticket_id', v_ticket_id,
    'status', 'disputed',
    'message', 'Dispute opened. Funds remain frozen until admin review.'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.raise_order_dispute(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.raise_order_dispute(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.raise_order_dispute(uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- Phase 3 patch: block OTP verify on disputed orders (funds frozen)
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

  IF v_win_bid_id IS NOT NULL THEN
    UPDATE public.bids b
    SET locked_released_at = coalesce(b.locked_released_at, now())
    WHERE b.id = v_win_bid_id
      AND b.locked_released_at IS NULL;
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

-- ---------------------------------------------------------------------------
-- Phase 3 patch: block buyer OTP reveal on disputed orders
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reveal_buyer_delivery_otp(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.auction_orders;
  v_otp text;
  v_hash text;
  v_expires timestamptz;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  SELECT o.*
  INTO v_order
  FROM public.auction_orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF auth.uid() IS DISTINCT FROM v_order.buyer_id
     AND NOT coalesce(public.current_user_is_admin(), false) THEN
    RAISE EXCEPTION 'Only the buyer can view the delivery OTP';
  END IF;

  IF v_order.status = 'disputed'::public.auction_order_status THEN
    RAISE EXCEPTION 'This order is under dispute. Delivery OTP is not available.';
  END IF;

  IF v_order.status IS DISTINCT FROM 'pending_delivery'::public.auction_order_status THEN
    RAISE EXCEPTION 'Delivery OTP is only available while order is pending delivery';
  END IF;

  v_otp := lpad((100000 + floor(random() * 900000))::text, 6, '0');
  v_hash := public._hash_delivery_otp(v_otp);
  v_expires := now() + interval '7 days';

  UPDATE public.auction_orders o
  SET
    delivery_otp_hash = v_hash,
    delivery_otp_expires_at = v_expires,
    updated_at = now()
  WHERE o.id = p_order_id;

  RETURN jsonb_build_object(
    'ok', true,
    'order_id', p_order_id,
    'otp', v_otp,
    'expires_at', v_expires,
    'note', 'Share this code with the seller only after you receive the item.'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reveal_buyer_delivery_otp(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reveal_buyer_delivery_otp(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reveal_buyer_delivery_otp(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
