-- =============================================================================
-- Auction expiry: refund Rs. 500 listing fee when there are NO bids
-- Run in Supabase SQL Editor AFTER auction_listing_fee.sql / listing_fee_500_refund.sql
--
-- Also re-run the updated public.resolve_auction from escrow_phase_2_resolve_auction.sql
-- (it calls refund_auction_listing_fee_no_bids when highest bid is missing).
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

CREATE OR REPLACE FUNCTION public.refund_auction_listing_fee_no_bids(p_listing_id uuid)
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
BEGIN
  PERFORM set_config('row_security', 'off', true);

  SELECT * INTO v_row
  FROM public.listings
  WHERE id = p_listing_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'listing_not_found');
  END IF;

  v_seller := v_row.seller_id;
  IF v_seller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_seller');
  END IF;

  IF lower(nullif(trim(coalesce(v_row.listing_type::text, v_row.type::text)), '')) IS DISTINCT FROM 'auction' THEN
    RETURN jsonb_build_object('ok', true, 'refunded', false, 'reason', 'not_auction');
  END IF;

  IF EXISTS (SELECT 1 FROM public.bids b WHERE b.listing_id = p_listing_id LIMIT 1) THEN
    RETURN jsonb_build_object('ok', true, 'refunded', false, 'reason', 'has_bids');
  END IF;

  v_fee := COALESCE(
    NULLIF(v_row.listing_activation_fee, 0),
    public.calculate_auction_listing_fee(v_row.price)
  );
  IF v_fee <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'refunded', false, 'reason', 'no_fee');
  END IF;

  v_idem := format('auction_listing_fee_refund:no_bids:%s', p_listing_id::text);
  IF EXISTS (SELECT 1 FROM public.wallet_ledger wl WHERE wl.idempotency_key = v_idem) THEN
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

  RETURN jsonb_build_object('ok', true, 'refunded', true, 'fee', v_fee, 'seller_id', v_seller);
END;
$$;

REVOKE ALL ON FUNCTION public.refund_auction_listing_fee_no_bids(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refund_auction_listing_fee_no_bids(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

-- Deploy updated resolve_auction (includes no-bid refund call) from:
--   supabase/escrow_phase_2_resolve_auction.sql
