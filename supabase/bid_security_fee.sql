-- =============================================================================
-- Bid security / commitment fee (100 | 500 | 1000 PKR) on top of full bid lock
-- Run in Supabase SQL Editor after escrow_phase_1_place_bid_rpc.sql
-- =============================================================================

ALTER TABLE IF EXISTS public.bids
  ADD COLUMN IF NOT EXISTS security_fee numeric NOT NULL DEFAULT 100;

ALTER TABLE IF EXISTS public.bids
  ADD COLUMN IF NOT EXISTS security_fee_released_at timestamptz;

COMMENT ON COLUMN public.bids.security_fee IS
  'Commitment fee (PKR) held in profiles.held_balance while bid is active; released on outbid.';
COMMENT ON COLUMN public.bids.security_fee_released_at IS
  'When set, security_fee was returned from held_balance to wallet_balance.';

-- ---------------------------------------------------------------------------
-- Release security fee when a bid is superseded (held_balance → wallet_balance)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._release_bid_security_fee(
  p_bid public.bids,
  p_listing_id uuid
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_fee numeric;
  v_release numeric;
  v_wb numeric;
  v_hb numeric;
BEGIN
  IF p_bid.id IS NULL OR p_bid.security_fee_released_at IS NOT NULL THEN
    RETURN 0;
  END IF;

  v_fee := COALESCE(NULLIF(p_bid.security_fee, 0), 0);
  IF v_fee <= 0 THEN
    RETURN 0;
  END IF;

  SELECT
    COALESCE(pr.wallet_balance, 0),
    COALESCE(pr.held_balance, 0)
  INTO v_wb, v_hb
  FROM public.profiles pr
  WHERE pr.id = p_bid.bidder_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  v_release := LEAST(v_fee, v_hb);

  IF v_release > 0 THEN
    UPDATE public.profiles pr
    SET
      held_balance = GREATEST(0, COALESCE(pr.held_balance, 0) - v_release),
      wallet_balance = COALESCE(pr.wallet_balance, 0) + v_release,
      updated_at = now()
    WHERE pr.id = p_bid.bidder_id;

    PERFORM public._wallet_ledger_append(
      p_bid.bidder_id,
      'bid_refund'::public.wallet_ledger_entry_type,
      v_release,
      p_listing_id,
      p_bid.id,
      format('bid_security_refund:%s', p_bid.id),
      jsonb_build_object(
        'reason', 'security_fee_release',
        'listing_id', p_listing_id,
        'bid_id', p_bid.id,
        'security_fee', v_fee,
        'released', v_release
      )
    );
  END IF;

  UPDATE public.bids b
  SET security_fee_released_at = now()
  WHERE b.id = p_bid.id
    AND b.security_fee_released_at IS NULL;

  RETURN v_release;
END;
$$;

REVOKE ALL ON FUNCTION public._release_bid_security_fee(public.bids, uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Extend full-bid lock release to also release security fee
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._release_full_bid_lock(
  p_bid public.bids,
  p_listing_id uuid
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_amount numeric;
  v_release numeric;
  v_wb numeric;
  v_lb numeric;
  v_sec_release numeric;
BEGIN
  IF p_bid.id IS NULL THEN
    RETURN 0;
  END IF;

  IF p_bid.locked_released_at IS NOT NULL THEN
    v_sec_release := public._release_bid_security_fee(p_bid, p_listing_id);
    RETURN v_sec_release;
  END IF;

  v_amount := COALESCE(NULLIF(p_bid.locked_amount, 0), 0);
  IF v_amount <= 0 THEN
    PERFORM public._release_bid_security_fee(p_bid, p_listing_id);
    RETURN 0;
  END IF;

  SELECT
    COALESCE(pr.wallet_balance, 0),
    COALESCE(pr.locked_balance, 0)
  INTO v_wb, v_lb
  FROM public.profiles pr
  WHERE pr.id = p_bid.bidder_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bidder profile not found for bid %', p_bid.id;
  END IF;

  v_release := LEAST(v_amount, v_lb);

  IF v_release > 0 THEN
    UPDATE public.profiles pr
    SET
      locked_balance = GREATEST(0, COALESCE(pr.locked_balance, 0) - v_release),
      wallet_balance = COALESCE(pr.wallet_balance, 0) + v_release,
      updated_at = now()
    WHERE pr.id = p_bid.bidder_id;

    PERFORM public._wallet_ledger_append(
      p_bid.bidder_id,
      'bid_refund'::public.wallet_ledger_entry_type,
      v_release,
      p_listing_id,
      p_bid.id,
      format('bid_refund:%s', p_bid.id),
      jsonb_build_object(
        'reason', 'outbid_or_self_rebid',
        'listing_id', p_listing_id,
        'bid_id', p_bid.id,
        'released', v_release,
        'requested', v_amount
      )
    );
  END IF;

  UPDATE public.bids b
  SET locked_released_at = now()
  WHERE b.id = p_bid.id
    AND b.locked_released_at IS NULL;

  v_sec_release := public._release_bid_security_fee(p_bid, p_listing_id);

  RETURN v_release + COALESCE(v_sec_release, 0);
END;
$$;

-- ---------------------------------------------------------------------------
-- place_bid_with_wallet_lock — bid amount lock + security commitment fee
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.place_bid_with_wallet_lock(uuid, numeric);

CREATE OR REPLACE FUNCTION public.place_bid_with_wallet_lock(
  p_listing_id uuid,
  p_amount numeric,
  p_security_fee numeric DEFAULT 100
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
  v_hb numeric;
  v_label text;
  v_bid public.bids;
  v_lock_amount numeric;
  v_security_fee numeric;
  v_total_required numeric;
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

  v_security_fee := COALESCE(p_security_fee, 100);
  IF v_security_fee NOT IN (100, 500, 1000) THEN
    RAISE EXCEPTION 'Security fee must be 100, 500, or 1000 PKR';
  END IF;

  v_total_required := v_lock_amount + v_security_fee;

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
    COALESCE(pr.locked_balance, 0),
    COALESCE(pr.held_balance, 0)
  INTO v_wb, v_lb, v_hb
  FROM public.profiles pr
  WHERE pr.id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile missing in public.profiles — log out and log in again';
  END IF;

  IF v_wb < v_total_required THEN
    RAISE EXCEPTION '%',
      format(
        'Insufficient wallet balance. Need Rs. %s (bid Rs. %s + security fee Rs. %s); you have Rs. %s.',
        v_total_required,
        v_lock_amount,
        v_security_fee,
        v_wb
      )
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.profiles pr
  SET
    wallet_balance = COALESCE(pr.wallet_balance, 0) - v_total_required,
    locked_balance = COALESCE(pr.locked_balance, 0) + v_lock_amount,
    held_balance = COALESCE(pr.held_balance, 0) + v_security_fee,
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
    v_security_fee,
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
      'bid_amount', v_lock_amount,
      'security_fee', v_security_fee,
      'total_debited', v_total_required
    )
  );

  PERFORM public._wallet_ledger_append(
    v_uid,
    'bid_lock'::public.wallet_ledger_entry_type,
    -v_security_fee,
    p_listing_id,
    v_bid.id,
    format('bid_security:%s', v_bid.id),
    jsonb_build_object(
      'reason', 'Bid security commitment fee',
      'listing_id', p_listing_id,
      'bid_id', v_bid.id,
      'security_fee', v_security_fee
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
