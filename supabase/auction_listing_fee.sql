-- =============================================================================
-- Seller auction listing activation fee (deducted from profiles.wallet_balance)
-- Run in Supabase SQL Editor after escrow_phase_1_place_bid_rpc.sql
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'wallet_ledger_entry_type'
      AND e.enumlabel = 'auction_listing_fee'
  ) THEN
    ALTER TYPE public.wallet_ledger_entry_type ADD VALUE 'auction_listing_fee';
  END IF;
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END $$;

ALTER TABLE IF EXISTS public.listings
  ADD COLUMN IF NOT EXISTS listing_activation_fee numeric;

COMMENT ON COLUMN public.listings.listing_activation_fee IS
  'One-time PKR fee charged to seller when publishing an auction listing.';

-- ---------------------------------------------------------------------------
-- Tier calculator (mirrors src/constants/auctionListingFee.js)
-- ---------------------------------------------------------------------------
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

REVOKE ALL ON FUNCTION public.calculate_auction_listing_fee(numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.calculate_auction_listing_fee(numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_auction_listing_fee(numeric) TO service_role;

-- ---------------------------------------------------------------------------
-- Charge seller wallet before listing insert (caller = authenticated seller)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.charge_auction_listing_fee(
  p_starting_bid numeric,
  p_listing_id uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid;
  v_fee numeric;
  v_wb numeric;
  v_idem text;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_fee := public.calculate_auction_listing_fee(p_starting_bid);
  IF v_fee <= 0 THEN
    RAISE EXCEPTION 'Invalid starting bid for auction listing fee';
  END IF;

  PERFORM public.ensure_profile_wallet(v_uid, NULL);

  SELECT COALESCE(pr.wallet_balance, 0)
  INTO v_wb
  FROM public.profiles pr
  WHERE pr.id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Seller profile not found';
  END IF;

  IF v_wb < v_fee THEN
    RAISE EXCEPTION '%',
      format(
        'Insufficient wallet balance to pay the required Auction Listing Fee of %s Rs.',
        to_char(v_fee, 'FM999,999,999')
      )
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.profiles pr
  SET
    wallet_balance = COALESCE(pr.wallet_balance, 0) - v_fee,
    updated_at = now()
  WHERE pr.id = v_uid;

  v_idem := nullif(trim(COALESCE(p_idempotency_key, '')), '');
  IF v_idem IS NULL THEN
    v_idem := format('auction_listing_fee:%s', gen_random_uuid()::text);
  END IF;

  PERFORM public._wallet_ledger_append(
    v_uid,
    'auction_listing_fee'::public.wallet_ledger_entry_type,
    -v_fee,
    p_listing_id,
    NULL,
    v_idem,
    jsonb_build_object(
      'reason', 'Auction listing activation fee',
      'starting_bid', p_starting_bid,
      'fee', v_fee,
      'listing_id', p_listing_id,
      'idempotency_key', v_idem
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'fee', v_fee,
    'wallet_balance_after', v_wb - v_fee,
    'idempotency_key', v_idem
  );
END;
$$;

REVOKE ALL ON FUNCTION public.charge_auction_listing_fee(numeric, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.charge_auction_listing_fee(numeric, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.charge_auction_listing_fee(numeric, uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';
