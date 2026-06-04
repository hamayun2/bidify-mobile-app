-- =============================================================================
-- Admin "Return to Buyer" — refund seller listing fee (Rs. 500)
-- =============================================================================
-- Run once in Supabase SQL Editor.
--
-- Fixes: admin refund returns escrow to buyer but seller listing_activation_fee
--        was not credited back.
--
-- Does NOT change execute_order_completion / verify_delivery_otp (OTP success path).
-- Uses separate idempotency key: auction_listing_fee_refund:admin_cancelled:{listing_id}
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Internal helper — idempotent listing fee refund on admin cancel / return
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._refund_listing_activation_fee_admin_cancelled(
  p_listing_id uuid,
  p_seller_id uuid,
  p_order_id uuid DEFAULT NULL,
  p_win_bid_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_fee numeric;
  v_idem text;
BEGIN
  IF p_listing_id IS NULL OR p_seller_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'refunded', false, 'reason', 'missing_listing_or_seller');
  END IF;

  v_idem := format('auction_listing_fee_refund:admin_cancelled:%s', p_listing_id);

  IF EXISTS (
    SELECT 1 FROM public.wallet_ledger wl WHERE wl.idempotency_key = v_idem
  ) THEN
    RETURN jsonb_build_object(
      'ok', true, 'refunded', false, 'reason', 'already_refunded', 'idempotency_key', v_idem
    );
  END IF;

  -- OTP success path already refunded — do not double-credit seller
  IF EXISTS (
    SELECT 1 FROM public.wallet_ledger wl
    WHERE wl.idempotency_key = format('auction_listing_fee_refund:completed:%s', p_listing_id)
  ) THEN
    RETURN jsonb_build_object('ok', true, 'refunded', false, 'reason', 'already_refunded_on_otp_completion');
  END IF;

  SELECT coalesce(
    nullif(l.listing_activation_fee, 0),
    public.calculate_auction_listing_fee(l.price)
  )
  INTO v_fee
  FROM public.listings l
  WHERE l.id = p_listing_id;

  IF coalesce(v_fee, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'refunded', false, 'reason', 'no_fee');
  END IF;

  PERFORM public.ensure_profile_wallet(p_seller_id, NULL);

  PERFORM 1 FROM public.profiles pr WHERE pr.id = p_seller_id FOR UPDATE;

  UPDATE public.profiles pr
  SET
    wallet_balance = coalesce(pr.wallet_balance, 0) + v_fee,
    updated_at = now()
  WHERE pr.id = p_seller_id;

  PERFORM public._wallet_ledger_append(
    p_seller_id,
    'auction_listing_fee'::public.wallet_ledger_entry_type,
    v_fee,
    p_listing_id,
    p_win_bid_id,
    v_idem,
    jsonb_build_object(
      'reason', 'Listing Fee Refund - Admin Cancelled',
      'description', 'Listing Fee Refund - Admin Cancelled',
      'listing_id', p_listing_id,
      'order_id', p_order_id,
      'fee', v_fee,
      'trigger', 'admin_return_to_buyer'
    ),
    p_order_id
  );

  RETURN jsonb_build_object(
    'ok', true,
    'refunded', true,
    'fee', v_fee,
    'seller_id', p_seller_id,
    'idempotency_key', v_idem
  );
END;
$$;

REVOKE ALL ON FUNCTION public._refund_listing_activation_fee_admin_cancelled(uuid, uuid, uuid, uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- return_to_buyer — canonical admin RPC (refund buyer + seller listing fee)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.return_to_buyer(
  p_order_id uuid,
  p_note text DEFAULT NULL,
  p_admin_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.auction_orders;
  v_escrow numeric;
  v_refund numeric;
  v_buyer_lb numeric;
  v_win_bid_id uuid;
  v_listing_fee_refund jsonb;
BEGIN
  PERFORM set_config('row_security', 'off', true);
  PERFORM public._admin_assert_caller(p_admin_user_id);

  SELECT * INTO v_order
  FROM public.auction_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF v_order.status IS DISTINCT FROM 'disputed'::public.auction_order_status
     AND v_order.status IS DISTINCT FROM 'pending_delivery'::public.auction_order_status THEN
    RAISE EXCEPTION 'Order cannot be returned to buyer (status: %)', v_order.status;
  END IF;

  v_escrow := floor(coalesce(v_order.escrow_amount, 0));
  IF v_escrow <= 0 THEN
    RAISE EXCEPTION 'Invalid escrow amount';
  END IF;

  v_win_bid_id := v_order.winning_bid_id;

  SELECT coalesce(pr.locked_balance, 0)
  INTO v_buyer_lb
  FROM public.profiles pr
  WHERE pr.id = v_order.buyer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Buyer profile not found';
  END IF;

  v_refund := least(v_escrow, v_buyer_lb);
  IF v_refund < v_escrow THEN
    RAISE EXCEPTION 'Buyer locked balance insufficient for refund';
  END IF;

  UPDATE public.profiles pr
  SET
    locked_balance = greatest(0, coalesce(pr.locked_balance, 0) - v_refund),
    wallet_balance = coalesce(pr.wallet_balance, 0) + v_refund,
    updated_at = now()
  WHERE pr.id = v_order.buyer_id;

  IF v_win_bid_id IS NOT NULL THEN
    UPDATE public.bids b
    SET locked_released_at = coalesce(b.locked_released_at, now())
    WHERE b.id = v_win_bid_id
      AND b.locked_released_at IS NULL;
  END IF;

  PERFORM public._wallet_ledger_append(
    v_order.buyer_id,
    'escrow_refund'::public.wallet_ledger_entry_type,
    v_refund,
    v_order.listing_id,
    v_win_bid_id,
    format('return_to_buyer:buyer:order:%s', p_order_id),
    jsonb_build_object(
      'reason', coalesce(p_note, 'Admin returned escrow to buyer'),
      'order_id', p_order_id,
      'role', 'buyer'
    ),
    p_order_id
  );

  -- Seller listing fee refund (Rs. 500) when listing is linked to order
  v_listing_fee_refund := jsonb_build_object('ok', true, 'refunded', false);
  IF v_order.listing_id IS NOT NULL AND v_order.seller_id IS NOT NULL THEN
    v_listing_fee_refund := public._refund_listing_activation_fee_admin_cancelled(
      v_order.listing_id,
      v_order.seller_id,
      p_order_id,
      v_win_bid_id
    );
  END IF;

  UPDATE public.auction_orders o
  SET
    status = 'refunded'::public.auction_order_status,
    refunded_at = now(),
    delivery_otp_hash = NULL,
    updated_at = now()
  WHERE o.id = p_order_id
  RETURNING * INTO v_order;

  PERFORM public._admin_close_order_support_tickets(
    p_order_id,
    'refund_buyer'::public.support_ticket_resolution,
    p_note
  );

  RETURN jsonb_build_object(
    'ok', true,
    'order_id', p_order_id,
    'status', v_order.status,
    'refunded_amount', v_refund,
    'resolution', 'refund_buyer',
    'listing_fee_refund', v_listing_fee_refund,
    'message', 'Funds refunded to buyer; seller listing fee restored when applicable'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.return_to_buyer(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.return_to_buyer(uuid, text, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Patch admin_resolve_dispute_refund_buyer (service role + admin JWT)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_resolve_dispute_refund_buyer(
  p_order_id uuid,
  p_note text DEFAULT NULL,
  p_admin_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.return_to_buyer(p_order_id, p_note, p_admin_user_id);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_resolve_dispute_refund_buyer(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_resolve_dispute_refund_buyer(uuid, text, uuid) TO authenticated, service_role;

-- 2-arg overload (Supabase dashboard / older clients)
CREATE OR REPLACE FUNCTION public.admin_resolve_dispute_refund_buyer(
  p_order_id uuid,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.return_to_buyer(p_order_id, p_note, NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_resolve_dispute_refund_buyer(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_resolve_dispute_refund_buyer(uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Patch atomic_settle_dispute — REFUND_TO_BUYER branch (+ listing fee)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.atomic_settle_dispute(
  p_order_id uuid,
  p_resolution_action text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_action text;
  v_order public.auction_orders;
  v_escrow numeric;
  v_amount numeric;
  v_buyer_lb numeric;
  v_win_bid_id uuid;
  v_admin_id uuid;
  v_ticket_resolution public.support_ticket_resolution;
  v_listing_fee_refund jsonb;
BEGIN
  BEGIN
    PERFORM set_config('row_security', 'off', true);

    IF coalesce(public.current_user_is_admin(), false) THEN
      v_admin_id := auth.uid();
    ELSIF coalesce(auth.role(), '') = 'service_role' THEN
      v_admin_id := NULL;
    ELSE
      RAISE EXCEPTION 'Admin only';
    END IF;

    v_action := upper(trim(coalesce(p_resolution_action, '')));

    IF v_action NOT IN ('RELEASE_TO_SELLER', 'REFUND_TO_BUYER') THEN
      IF v_action IN ('RELEASE_SELLER', 'RELEASE', 'SELLER', 'COMPLETE', 'COMPLETED') THEN
        v_action := 'RELEASE_TO_SELLER';
      ELSIF v_action IN ('REFUND_BUYER', 'REFUND', 'BUYER') THEN
        v_action := 'REFUND_TO_BUYER';
      ELSIF lower(trim(coalesce(p_resolution_action, ''))) IN ('release_seller', 'release', 'seller', 'complete') THEN
        v_action := 'RELEASE_TO_SELLER';
      ELSIF lower(trim(coalesce(p_resolution_action, ''))) IN ('refund_buyer', 'refund', 'buyer', 'return_to_buyer') THEN
        v_action := 'REFUND_TO_BUYER';
      ELSE
        RAISE EXCEPTION 'Invalid p_resolution_action. Use RELEASE_TO_SELLER or REFUND_TO_BUYER';
      END IF;
    END IF;

    SELECT * INTO v_order
    FROM public.auction_orders
    WHERE id = p_order_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Order not found';
    END IF;

    IF v_order.status IS DISTINCT FROM 'disputed'::public.auction_order_status THEN
      RAISE EXCEPTION 'Order is not in disputed status (current: %)', v_order.status;
    END IF;

    IF v_order.buyer_id IS NULL OR v_order.seller_id IS NULL THEN
      RAISE EXCEPTION 'Order is missing buyer_id or seller_id';
    END IF;

    v_escrow := floor(
      greatest(
        coalesce(v_order.escrow_amount, 0),
        coalesce(v_order.winning_bid_amount, 0)
      )
    );

    IF v_escrow <= 0 THEN
      RAISE EXCEPTION 'Invalid escrow amount';
    END IF;

    v_win_bid_id := v_order.winning_bid_id;
    v_listing_fee_refund := jsonb_build_object('ok', true, 'refunded', false);

    SELECT coalesce(pr.locked_balance, 0)
    INTO v_buyer_lb
    FROM public.profiles pr
    WHERE pr.id = v_order.buyer_id
    FOR UPDATE;

    v_amount := least(v_escrow, v_buyer_lb);
    IF v_amount < v_escrow THEN
      RAISE EXCEPTION 'Buyer locked balance insufficient for escrow settlement (need %, have %)', v_escrow, v_buyer_lb;
    END IF;

    IF v_action = 'RELEASE_TO_SELLER' THEN
      v_ticket_resolution := 'release_seller'::public.support_ticket_resolution;

      UPDATE public.profiles pr
      SET
        locked_balance = greatest(0, coalesce(pr.locked_balance, 0) - v_amount),
        updated_at = now()
      WHERE pr.id = v_order.buyer_id;

      UPDATE public.profiles pr
      SET
        wallet_balance = coalesce(pr.wallet_balance, 0) + v_amount,
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
        -v_amount,
        v_order.listing_id,
        v_win_bid_id,
        format('atomic_settle:buyer:order:%s', p_order_id),
        jsonb_build_object('order_id', p_order_id, 'action', v_action, 'role', 'buyer'),
        p_order_id
      );

      PERFORM public._wallet_ledger_append(
        v_order.seller_id,
        'escrow_release'::public.wallet_ledger_entry_type,
        v_amount,
        v_order.listing_id,
        v_win_bid_id,
        format('atomic_settle:seller:order:%s', p_order_id),
        jsonb_build_object('order_id', p_order_id, 'action', v_action, 'role', 'seller'),
        p_order_id
      );

      UPDATE public.auction_orders o
      SET
        status = 'completed'::public.auction_order_status,
        completed_at = now(),
        otp_verified_at = coalesce(o.otp_verified_at, now()),
        otp_verified_by = coalesce(v_admin_id, o.otp_verified_by),
        delivery_otp_hash = NULL,
        updated_at = now()
      WHERE o.id = p_order_id
      RETURNING * INTO v_order;

    ELSIF v_action = 'REFUND_TO_BUYER' THEN
      v_ticket_resolution := 'refund_buyer'::public.support_ticket_resolution;

      UPDATE public.profiles pr
      SET
        locked_balance = greatest(0, coalesce(pr.locked_balance, 0) - v_amount),
        wallet_balance = coalesce(pr.wallet_balance, 0) + v_amount,
        updated_at = now()
      WHERE pr.id = v_order.buyer_id;

      IF v_win_bid_id IS NOT NULL THEN
        UPDATE public.bids b
        SET locked_released_at = coalesce(b.locked_released_at, now())
        WHERE b.id = v_win_bid_id
          AND b.locked_released_at IS NULL;
      END IF;

      PERFORM public._wallet_ledger_append(
        v_order.buyer_id,
        'escrow_refund'::public.wallet_ledger_entry_type,
        v_amount,
        v_order.listing_id,
        v_win_bid_id,
        format('atomic_settle:buyer:order:%s', p_order_id),
        jsonb_build_object('order_id', p_order_id, 'action', v_action, 'role', 'buyer'),
        p_order_id
      );

      IF v_order.listing_id IS NOT NULL AND v_order.seller_id IS NOT NULL THEN
        v_listing_fee_refund := public._refund_listing_activation_fee_admin_cancelled(
          v_order.listing_id,
          v_order.seller_id,
          p_order_id,
          v_win_bid_id
        );
      END IF;

      UPDATE public.auction_orders o
      SET
        status = 'refunded'::public.auction_order_status,
        refunded_at = now(),
        delivery_otp_hash = NULL,
        updated_at = now()
      WHERE o.id = p_order_id
      RETURNING * INTO v_order;

    END IF;

    UPDATE public.support_tickets t
    SET
      status = 'resolved'::public.support_ticket_status,
      resolution = v_ticket_resolution,
      resolution_note = format('atomic_settle_dispute:%s', v_action),
      resolved_at = now(),
      is_human_required = false,
      updated_at = now()
    WHERE t.order_id = p_order_id
      AND t.status NOT IN (
        'closed'::public.support_ticket_status,
        'resolved'::public.support_ticket_status
      );

    RETURN jsonb_build_object(
      'ok', true,
      'order_id', p_order_id,
      'status', v_order.status,
      'resolution_action', v_action,
      'resolution', CASE
        WHEN v_action = 'RELEASE_TO_SELLER' THEN 'release_seller'
        ELSE 'refund_buyer'
      END,
      'escrow_amount', v_escrow,
      'settled_amount', v_amount,
      'escrow_released', CASE WHEN v_action = 'RELEASE_TO_SELLER' THEN v_amount ELSE NULL END,
      'refunded_amount', CASE WHEN v_action = 'REFUND_TO_BUYER' THEN v_amount ELSE NULL END,
      'listing_fee_refund', v_listing_fee_refund,
      'buyer_id', v_order.buyer_id,
      'seller_id', v_order.seller_id,
      'message', CASE
        WHEN v_action = 'RELEASE_TO_SELLER' THEN 'Funds released to seller successfully'
        ELSE 'Funds refunded to buyer successfully'
      END
    );

  EXCEPTION
    WHEN OTHERS THEN
      RAISE;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.atomic_settle_dispute(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.atomic_settle_dispute(uuid, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- Test (disputed order):
--   SELECT public.return_to_buyer('<order-uuid>'::uuid, 'Admin test', NULL);
--   SELECT public.atomic_settle_dispute('<order-uuid>'::uuid, 'REFUND_TO_BUYER');
-- Verify seller ledger:
--   SELECT * FROM public.wallet_ledger
--   WHERE metadata->>'description' = 'Listing Fee Refund - Admin Cancelled'
--   ORDER BY created_at DESC LIMIT 5;
-- =============================================================================
