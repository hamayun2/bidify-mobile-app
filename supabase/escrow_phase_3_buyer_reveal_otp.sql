-- =============================================================================
-- Bidify — Phase 3 companion: buyer views delivery OTP (pending_delivery only)
-- =============================================================================
-- Phase 2 stores delivery_otp_hash only. This RPC lets the buyer retrieve a
-- 6-digit OTP to share with the seller. If no viewable OTP exists, a fresh OTP
-- is generated and the order hash is updated (seller must use the latest code).
--
-- Run after escrow_phase_3_verify_delivery_otp.sql
-- =============================================================================

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
