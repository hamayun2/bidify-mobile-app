-- =============================================================================
-- Admin dispute settlement: service-role + Express API support
-- Run after escrow_phase_4_admin_panel.sql
-- =============================================================================

CREATE OR REPLACE FUNCTION public._admin_assert_caller(p_admin_user_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF coalesce(public.current_user_is_admin(), false) THEN
    RETURN;
  END IF;

  IF p_admin_user_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = p_admin_user_id
      AND p.role = 'admin'
  ) THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'Admin only';
END;
$$;

REVOKE ALL ON FUNCTION public._admin_assert_caller(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._admin_assert_caller(uuid) TO authenticated, service_role;

-- Unified settle entry (Express service role or authenticated admin)
CREATE OR REPLACE FUNCTION public.settle_order_dispute(
  p_order_id uuid,
  p_action text,
  p_note text DEFAULT NULL,
  p_admin_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_action text;
BEGIN
  PERFORM set_config('row_security', 'off', true);
  PERFORM public._admin_assert_caller(p_admin_user_id);

  v_action := lower(trim(coalesce(p_action, '')));
  IF v_action IN ('release_seller', 'release', 'seller', 'complete') THEN
    RETURN public.admin_resolve_dispute_release_seller(p_order_id, p_note, p_admin_user_id);
  ELSIF v_action IN ('refund_buyer', 'refund', 'buyer') THEN
    RETURN public.admin_resolve_dispute_refund_buyer(p_order_id, p_note, p_admin_user_id);
  ELSE
    RAISE EXCEPTION 'Invalid action. Use release_seller or refund_buyer';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_order_dispute(uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.settle_order_dispute(uuid, text, text, uuid) TO authenticated, service_role;

-- Patch release seller (optional p_admin_user_id for service role)
CREATE OR REPLACE FUNCTION public.admin_resolve_dispute_release_seller(
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
  v_release numeric;
  v_buyer_lb numeric;
  v_win_bid_id uuid;
  v_admin_id uuid;
BEGIN
  PERFORM set_config('row_security', 'off', true);
  PERFORM public._admin_assert_caller(p_admin_user_id);

  v_admin_id := coalesce(auth.uid(), p_admin_user_id);

  SELECT * INTO v_order FROM public.auction_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF v_order.status IS DISTINCT FROM 'disputed'::public.auction_order_status THEN
    RAISE EXCEPTION 'Order is not in disputed status';
  END IF;

  v_escrow := floor(coalesce(v_order.escrow_amount, 0));
  IF v_escrow <= 0 THEN
    RAISE EXCEPTION 'Invalid escrow amount';
  END IF;

  v_win_bid_id := v_order.winning_bid_id;

  SELECT coalesce(pr.locked_balance, 0) INTO v_buyer_lb
  FROM public.profiles pr WHERE pr.id = v_order.buyer_id FOR UPDATE;

  v_release := least(v_escrow, v_buyer_lb);
  IF v_release < v_escrow THEN
    RAISE EXCEPTION 'Buyer locked balance insufficient for escrow release';
  END IF;

  UPDATE public.profiles pr
  SET locked_balance = greatest(0, coalesce(pr.locked_balance, 0) - v_release), updated_at = now()
  WHERE pr.id = v_order.buyer_id;

  UPDATE public.profiles pr
  SET wallet_balance = coalesce(pr.wallet_balance, 0) + v_release, updated_at = now()
  WHERE pr.id = v_order.seller_id;

  IF v_win_bid_id IS NOT NULL THEN
    UPDATE public.bids b SET locked_released_at = coalesce(b.locked_released_at, now())
    WHERE b.id = v_win_bid_id AND b.locked_released_at IS NULL;
  END IF;

  PERFORM public._wallet_ledger_append(
    v_order.buyer_id, 'escrow_release'::public.wallet_ledger_entry_type, -v_release,
    v_order.listing_id, v_win_bid_id, format('admin_escrow_release:buyer:order:%s', p_order_id),
    jsonb_build_object('reason', coalesce(p_note, 'Admin released escrow to seller'), 'order_id', p_order_id, 'role', 'buyer'),
    p_order_id
  );

  PERFORM public._wallet_ledger_append(
    v_order.seller_id, 'escrow_release'::public.wallet_ledger_entry_type, v_release,
    v_order.listing_id, v_win_bid_id, format('admin_escrow_release:seller:order:%s', p_order_id),
    jsonb_build_object('reason', coalesce(p_note, 'Admin released escrow to seller'), 'order_id', p_order_id, 'role', 'seller'),
    p_order_id
  );

  UPDATE public.auction_orders o
  SET
    status = 'completed'::public.auction_order_status,
    completed_at = now(),
    otp_verified_at = coalesce(o.otp_verified_at, now()),
    otp_verified_by = v_admin_id,
    delivery_otp_hash = NULL,
    updated_at = now()
  WHERE o.id = p_order_id
  RETURNING * INTO v_order;

  PERFORM public._admin_close_order_support_tickets(
    p_order_id,
    'release_seller'::public.support_ticket_resolution,
    p_note
  );

  RETURN jsonb_build_object(
    'ok', true,
    'order_id', p_order_id,
    'status', v_order.status,
    'escrow_released', v_release,
    'resolution', 'release_seller',
    'message', 'Funds released to seller successfully'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_resolve_dispute_release_seller(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_resolve_dispute_release_seller(uuid, text, uuid) TO authenticated, service_role;

-- Patch refund buyer
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
DECLARE
  v_order public.auction_orders;
  v_escrow numeric;
  v_refund numeric;
  v_buyer_lb numeric;
  v_win_bid_id uuid;
BEGIN
  PERFORM set_config('row_security', 'off', true);
  PERFORM public._admin_assert_caller(p_admin_user_id);

  SELECT * INTO v_order FROM public.auction_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF v_order.status IS DISTINCT FROM 'disputed'::public.auction_order_status THEN
    RAISE EXCEPTION 'Order is not in disputed status';
  END IF;

  v_escrow := floor(coalesce(v_order.escrow_amount, 0));
  IF v_escrow <= 0 THEN
    RAISE EXCEPTION 'Invalid escrow amount';
  END IF;

  v_win_bid_id := v_order.winning_bid_id;

  SELECT coalesce(pr.locked_balance, 0) INTO v_buyer_lb
  FROM public.profiles pr WHERE pr.id = v_order.buyer_id FOR UPDATE;

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
    UPDATE public.bids b SET locked_released_at = coalesce(b.locked_released_at, now())
    WHERE b.id = v_win_bid_id AND b.locked_released_at IS NULL;
  END IF;

  PERFORM public._wallet_ledger_append(
    v_order.buyer_id, 'escrow_refund'::public.wallet_ledger_entry_type, v_refund,
    v_order.listing_id, v_win_bid_id, format('admin_escrow_refund:buyer:order:%s', p_order_id),
    jsonb_build_object('reason', coalesce(p_note, 'Admin refunded escrow to buyer'), 'order_id', p_order_id, 'role', 'buyer'),
    p_order_id
  );

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
    'message', 'Funds refunded to buyer successfully'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_resolve_dispute_refund_buyer(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_resolve_dispute_refund_buyer(uuid, text, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
