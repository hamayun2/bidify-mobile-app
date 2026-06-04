-- =============================================================================
-- refund_auction_listing_fee — listing fee after auction END / EXPIRE only
-- =============================================================================
-- Business rules (no listing DELETE — listings are permanently locked in the app):
--   • Auction has ended/expired AND zero bids  → refund Rs. 500 listing fee to seller
--   • Auction has ended/expired AND has bids   → no refund (fee held for order/OTP pipeline)
--
-- Prerequisites: auction_listing_fee.sql, ensure_profile_wallet, _wallet_ledger_append
-- Run in Supabase SQL Editor, then: NOTIFY pgrst, 'reload schema';
-- =============================================================================

CREATE OR REPLACE FUNCTION public.calculate_auction_listing_fee(p_starting_bid numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN COALESCE(p_starting_bid, 0) <= 0 THEN 0::numeric
    ELSE 500::numeric
  END;
$$;

CREATE OR REPLACE FUNCTION public.refund_auction_listing_fee(p_listing_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.listings%ROWTYPE;
  v_fee numeric;
  v_idem text;
  v_seller uuid;
  v_bid_count bigint;
  v_ended boolean;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  SELECT * INTO v_row
  FROM public.listings
  WHERE id = p_listing_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Listing not found';
  END IF;

  v_seller := v_row.seller_id;
  IF v_seller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'refunded', false, 'reason', 'no_seller');
  END IF;

  IF auth.uid() IS NOT NULL
     AND auth.uid() IS DISTINCT FROM v_seller
     AND NOT coalesce(public.current_user_is_admin(), false) THEN
    RAISE EXCEPTION 'Not allowed to refund listing fee for this listing';
  END IF;

  IF lower(nullif(trim(coalesce(v_row.listing_type::text, v_row.type::text)), '')) IS DISTINCT FROM 'auction' THEN
    RETURN jsonb_build_object('ok', true, 'refunded', false, 'reason', 'not_auction');
  END IF;

  v_ended :=
    lower(nullif(trim(v_row.status::text), '')) IN ('ended', 'expired', 'sold')
    OR v_row.auction_resolved_at IS NOT NULL
    OR (
      coalesce(v_row.auction_end_time, v_row.end_time) IS NOT NULL
      AND coalesce(v_row.auction_end_time, v_row.end_time) <= now()
    );

  IF NOT v_ended THEN
    RETURN jsonb_build_object('ok', true, 'refunded', false, 'reason', 'auction_not_ended');
  END IF;

  SELECT count(*)::bigint INTO v_bid_count
  FROM public.bids b
  WHERE b.listing_id = p_listing_id;

  IF v_bid_count > 0 THEN
    RETURN jsonb_build_object(
      'ok', true,
      'refunded', false,
      'reason', 'has_bids_fee_retained',
      'bid_count', v_bid_count,
      'message', 'Listing fee is retained; release is handled by order completion (OTP) pipeline.'
    );
  END IF;

  v_fee := COALESCE(
    NULLIF(v_row.listing_activation_fee, 0),
    public.calculate_auction_listing_fee(v_row.price)
  );
  IF v_fee <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'refunded', false, 'reason', 'no_fee');
  END IF;

  v_idem := format('auction_listing_fee_refund:ended_no_bids:%s', p_listing_id::text);
  IF EXISTS (
    SELECT 1 FROM public.wallet_ledger wl WHERE wl.idempotency_key = v_idem
  ) THEN
    RETURN jsonb_build_object('ok', true, 'refunded', false, 'reason', 'already_refunded');
  END IF;

  PERFORM public.ensure_profile_wallet(v_seller, NULL);

  UPDATE public.profiles pr
  SET
    wallet_balance = COALESCE(pr.wallet_balance, 0) + v_fee,
    updated_at = now()
  WHERE pr.id = v_seller;

  PERFORM public._wallet_ledger_append(
    v_seller,
    'auction_listing_fee'::public.wallet_ledger_entry_type,
    v_fee,
    p_listing_id,
    NULL,
    v_idem,
    jsonb_build_object(
      'reason', 'Auction ended with no bids — listing fee refunded',
      'listing_id', p_listing_id,
      'fee', v_fee
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'refunded', true,
    'fee', v_fee,
    'seller_id', v_seller,
    'bid_count', 0
  );
END;
$$;

REVOKE ALL ON FUNCTION public.refund_auction_listing_fee(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refund_auction_listing_fee(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.refund_auction_listing_fee(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
