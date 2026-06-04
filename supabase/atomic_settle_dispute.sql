-- =============================================================================
-- Isolated atomic admin dispute settlement (non-destructive migration)
-- Run after: escrow_phase_4_admin_panel.sql, escrow_admin_settle_dispute.sql
-- =============================================================================
-- Does NOT alter tables or replace existing RPCs.
-- New entry point: public.atomic_settle_dispute(p_order_id, p_resolution_action)

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
BEGIN
  -- Entire function body runs in one implicit transaction; explicit block for clarity.
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
      ELSIF lower(trim(coalesce(p_resolution_action, ''))) IN ('refund_buyer', 'refund', 'buyer') THEN
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
