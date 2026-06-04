-- =============================================================================
-- Phase 4: Admin panel RPCs (dashboard, disputes, support chat, resolution)
-- Run after escrow_support_human_handoff.sql
-- =============================================================================

-- Admin read policies (idempotent)
DROP POLICY IF EXISTS support_tickets_select_admin ON public.support_tickets;
CREATE POLICY support_tickets_select_admin
  ON public.support_tickets FOR SELECT
  TO authenticated
  USING (coalesce(public.current_user_is_admin(), false));

DROP POLICY IF EXISTS auction_orders_select_admin ON public.auction_orders;
CREATE POLICY auction_orders_select_admin
  ON public.auction_orders FOR SELECT
  TO authenticated
  USING (coalesce(public.current_user_is_admin(), false));

DROP POLICY IF EXISTS wallet_ledger_select_admin ON public.wallet_ledger;
CREATE POLICY wallet_ledger_select_admin
  ON public.wallet_ledger FOR SELECT
  TO authenticated
  USING (coalesce(public.current_user_is_admin(), false));

-- ---------------------------------------------------------------------------
-- Dashboard metrics
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_dashboard_metrics()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_users bigint;
  v_escrow_locked numeric;
  v_disputes bigint;
  v_open_tickets bigint;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  IF NOT coalesce(public.current_user_is_admin(), false) THEN
    RAISE EXCEPTION 'Admin only';
  END IF;

  SELECT count(*)::bigint INTO v_users FROM public.profiles;

  SELECT coalesce(sum(o.escrow_amount), 0)
  INTO v_escrow_locked
  FROM public.auction_orders o
  WHERE o.status IN (
    'pending_delivery'::public.auction_order_status,
    'disputed'::public.auction_order_status
  );

  SELECT count(*)::bigint
  INTO v_disputes
  FROM public.auction_orders o
  WHERE o.status = 'disputed'::public.auction_order_status;

  SELECT count(*)::bigint
  INTO v_open_tickets
  FROM public.support_tickets t
  WHERE t.is_human_required = true
     OR t.status = 'awaiting_admin'::public.support_ticket_status
     OR t.status IN (
       'open'::public.support_ticket_status,
       'under_review'::public.support_ticket_status
     );

  RETURN jsonb_build_object(
    'ok', true,
    'total_users', v_users,
    'escrow_locked_total', v_escrow_locked,
    'active_disputes', v_disputes,
    'open_support_tickets', v_open_tickets
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_dashboard_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_dashboard_metrics() TO authenticated;

-- ---------------------------------------------------------------------------
-- Disputed orders list
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_disputed_orders()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows jsonb;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  IF NOT coalesce(public.current_user_is_admin(), false) THEN
    RAISE EXCEPTION 'Admin only';
  END IF;

  SELECT coalesce(jsonb_agg(row_to_json(x) ORDER BY x.disputed_at DESC NULLS LAST), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      o.id,
      o.listing_id,
      o.buyer_id,
      o.seller_id,
      o.winning_bid_amount,
      o.escrow_amount,
      o.status,
      o.disputed_at,
      o.disputed_by,
      o.created_at,
      coalesce(l.title, o.metadata->>'listing_title', 'Listing') AS listing_title,
      t.id AS support_ticket_id,
      t.status AS ticket_status,
      t.is_human_required
    FROM public.auction_orders o
    LEFT JOIN public.listings l ON l.id = o.listing_id
    LEFT JOIN public.support_tickets t ON t.order_id = o.id
      AND t.status NOT IN ('resolved'::public.support_ticket_status, 'closed'::public.support_ticket_status)
    WHERE o.status = 'disputed'::public.auction_order_status
  ) x;

  RETURN jsonb_build_object('ok', true, 'orders', v_rows);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_disputed_orders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_list_disputed_orders() TO authenticated;

-- ---------------------------------------------------------------------------
-- Support inbox (human handoff queue)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_support_inbox()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows jsonb;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  IF NOT coalesce(public.current_user_is_admin(), false) THEN
    RAISE EXCEPTION 'Admin only';
  END IF;

  SELECT coalesce(jsonb_agg(row_to_json(x) ORDER BY x.updated_at DESC), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      t.id,
      t.order_id,
      t.status,
      t.subject,
      t.reason,
      t.opened_by,
      t.opened_by_user_id,
      t.is_human_required,
      t.human_requested_at,
      t.created_at,
      t.updated_at,
      o.buyer_id,
      o.seller_id,
      o.escrow_amount,
      o.status AS order_status,
      coalesce(l.title, 'Order') AS listing_title
    FROM public.support_tickets t
    JOIN public.auction_orders o ON o.id = t.order_id
    LEFT JOIN public.listings l ON l.id = o.listing_id
    WHERE t.is_human_required = true
       OR t.status = 'awaiting_admin'::public.support_ticket_status
    ORDER BY t.updated_at DESC
    LIMIT 200
  ) x;

  RETURN jsonb_build_object('ok', true, 'tickets', v_rows);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_support_inbox() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_list_support_inbox() TO authenticated;

-- ---------------------------------------------------------------------------
-- Admin sends message on any ticket
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_send_support_message(
  p_ticket_id uuid,
  p_body text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid;
  v_body text;
  v_msg public.support_ticket_messages;
  v_ticket public.support_tickets;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT coalesce(public.current_user_is_admin(), false) THEN
    RAISE EXCEPTION 'Admin only';
  END IF;

  v_body := nullif(trim(coalesce(p_body, '')), '');
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'Message cannot be empty';
  END IF;

  SELECT * INTO v_ticket FROM public.support_tickets WHERE id = p_ticket_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Support ticket not found';
  END IF;

  INSERT INTO public.support_ticket_messages (
    ticket_id,
    sender_id,
    body,
    is_admin_message,
    is_ai_assistant
  )
  VALUES (
    p_ticket_id,
    v_caller,
    v_body,
    true,
    false
  )
  RETURNING * INTO v_msg;

  UPDATE public.support_tickets
  SET
    assigned_admin_id = v_caller,
    status = CASE
      WHEN status = 'awaiting_admin'::public.support_ticket_status
        THEN 'under_review'::public.support_ticket_status
      ELSE status
    END,
    updated_at = now()
  WHERE id = p_ticket_id;

  RETURN jsonb_build_object('ok', true, 'message', row_to_json(v_msg));
END;
$$;

REVOKE ALL ON FUNCTION public.admin_send_support_message(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_send_support_message(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- User wallet ledger (admin)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_get_user_wallet_ledger(p_user_id uuid, p_limit int DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile jsonb;
  v_ledger jsonb;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  IF NOT coalesce(public.current_user_is_admin(), false) THEN
    RAISE EXCEPTION 'Admin only';
  END IF;

  SELECT row_to_json(p.*) INTO v_profile
  FROM public.profiles p
  WHERE p.id = p_user_id;

  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  SELECT coalesce(jsonb_agg(row_to_json(w) ORDER BY w.created_at DESC), '[]'::jsonb)
  INTO v_ledger
  FROM (
    SELECT *
    FROM public.wallet_ledger w
    WHERE w.user_id = p_user_id
    ORDER BY w.created_at DESC
    LIMIT greatest(1, least(coalesce(p_limit, 100), 500))
  ) w;

  RETURN jsonb_build_object(
    'ok', true,
    'profile', v_profile,
    'ledger', v_ledger
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_user_wallet_ledger(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_get_user_wallet_ledger(uuid, int) TO authenticated;

-- ---------------------------------------------------------------------------
-- Internal: close support tickets for an order after admin resolution
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._admin_close_order_support_tickets(
  p_order_id uuid,
  p_resolution public.support_ticket_resolution,
  p_note text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.support_tickets t
  SET
    status = 'resolved'::public.support_ticket_status,
    resolution = p_resolution,
    resolution_note = nullif(trim(coalesce(p_note, '')), ''),
    resolved_at = now(),
    is_human_required = false,
    updated_at = now()
  WHERE t.order_id = p_order_id
    AND t.status NOT IN ('closed'::public.support_ticket_status, 'resolved'::public.support_ticket_status);
END;
$$;

-- ---------------------------------------------------------------------------
-- Release escrow to seller (disputed order → completed)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_resolve_dispute_release_seller(
  p_order_id uuid,
  p_note text DEFAULT NULL
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
  v_listing_title text;
  v_win_bid_id uuid;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  IF NOT coalesce(public.current_user_is_admin(), false) THEN
    RAISE EXCEPTION 'Admin only';
  END IF;

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

  v_listing_title := nullif(trim(coalesce(v_order.metadata->>'listing_title', '')), '');
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
    jsonb_build_object('reason', 'Admin released escrow to seller', 'order_id', p_order_id, 'role', 'buyer'),
    p_order_id
  );

  PERFORM public._wallet_ledger_append(
    v_order.seller_id, 'escrow_release'::public.wallet_ledger_entry_type, v_release,
    v_order.listing_id, v_win_bid_id, format('admin_escrow_release:seller:order:%s', p_order_id),
    jsonb_build_object('reason', 'Admin released escrow to seller', 'order_id', p_order_id, 'role', 'seller'),
    p_order_id
  );

  UPDATE public.auction_orders o
  SET
    status = 'completed'::public.auction_order_status,
    completed_at = now(),
    otp_verified_at = coalesce(o.otp_verified_at, now()),
    otp_verified_by = auth.uid(),
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
    'resolution', 'release_seller'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_resolve_dispute_release_seller(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_resolve_dispute_release_seller(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Refund escrow to buyer (disputed order → refunded)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_resolve_dispute_refund_buyer(
  p_order_id uuid,
  p_note text DEFAULT NULL
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
  v_listing_title text;
  v_win_bid_id uuid;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  IF NOT coalesce(public.current_user_is_admin(), false) THEN
    RAISE EXCEPTION 'Admin only';
  END IF;

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

  v_listing_title := nullif(trim(coalesce(v_order.metadata->>'listing_title', '')), '');
  v_win_bid_id := v_order.winning_bid_id;

  SELECT coalesce(pr.locked_balance, 0), coalesce(pr.wallet_balance, 0)
  INTO v_buyer_lb, v_refund
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
    jsonb_build_object('reason', 'Admin refunded escrow to buyer', 'order_id', p_order_id, 'role', 'buyer'),
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
    'resolution', 'refund_buyer'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_resolve_dispute_refund_buyer(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_resolve_dispute_refund_buyer(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
