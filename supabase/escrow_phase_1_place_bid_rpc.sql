-- =============================================================================
-- Bidify — Escrow Phase 1: place_bid_with_wallet_lock (full bid amount lock)
-- =============================================================================
-- SAFE: Does NOT modify public.place_bid(...) — old tiered holds remain until
--       the app calls this RPC instead of place_bid.
--
-- Prerequisites: escrow_phase_a_migration.sql applied successfully.
--
-- Run once in Supabase SQL Editor.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- bids: track full-bid lock lifecycle (additive)
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.bids
  ADD COLUMN IF NOT EXISTS locked_released_at timestamptz;

COMMENT ON COLUMN public.bids.locked_amount IS
  'Full bid amount locked in profiles.locked_balance when placed via place_bid_with_wallet_lock.';
COMMENT ON COLUMN public.bids.locked_released_at IS
  'When set, this bid''s locked_amount was released back to wallet_balance.';

-- ---------------------------------------------------------------------------
-- Internal: append wallet_ledger row (SECURITY DEFINER only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._wallet_ledger_append(
  p_user_id uuid,
  p_entry_type public.wallet_ledger_entry_type,
  p_amount numeric,
  p_listing_id uuid DEFAULT NULL,
  p_bid_id uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_wb numeric;
  v_hb numeric;
  v_lb numeric;
BEGIN
  SELECT
    COALESCE(pr.wallet_balance, 0),
    COALESCE(pr.held_balance, 0),
    COALESCE(pr.locked_balance, 0)
  INTO v_wb, v_hb, v_lb
  FROM public.profiles pr
  WHERE pr.id = p_user_id;

  INSERT INTO public.wallet_ledger (
    user_id,
    entry_type,
    amount,
    wallet_balance_after,
    held_balance_after,
    locked_balance_after,
    listing_id,
    bid_id,
    idempotency_key,
    metadata
  )
  VALUES (
    p_user_id,
    p_entry_type,
    p_amount,
    v_wb,
    v_hb,
    v_lb,
    p_listing_id,
    p_bid_id,
    p_idempotency_key,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public._wallet_ledger_append(uuid, public.wallet_ledger_entry_type, numeric, uuid, uuid, text, jsonb) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Internal: release a bid's full lock (locked_balance → wallet_balance)
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
BEGIN
  IF p_bid.id IS NULL THEN
    RETURN 0;
  END IF;

  IF p_bid.locked_released_at IS NOT NULL THEN
    RETURN 0;
  END IF;

  v_amount := COALESCE(NULLIF(p_bid.locked_amount, 0), 0);
  IF v_amount <= 0 THEN
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

  RETURN v_release;
END;
$$;

REVOKE ALL ON FUNCTION public._release_full_bid_lock(public.bids, uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Phase 1 RPC: full bid lock + refund previous highest + insert bid
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.place_bid_with_wallet_lock(
  p_listing_id uuid,
  p_amount numeric
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
  v_prev_lock numeric;
  v_released numeric;
  v_wb numeric;
  v_lb numeric;
  v_label text;
  v_bid public.bids;
  v_lock_amount numeric;
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

  -- Ensure bidder has a profile / wallet row
  PERFORM public.ensure_profile_wallet(v_uid, NULL);

  -- Lock listing row
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

  -- Current highest bid on this listing (lock row for update)
  SELECT b.*
  INTO v_prev
  FROM public.bids b
  WHERE b.listing_id = p_listing_id
  ORDER BY b.bid_amount DESC, b.created_at DESC
  LIMIT 1
  FOR UPDATE;

  -- Clear this bidder's unreleased legacy tier holds on this listing before new lock
  PERFORM public.release_bidder_listing_holds(p_listing_id, v_uid);

  -- Outbid refund: previous highest bidder — ALL legacy holds + full escrow lock
  IF v_prev.id IS NOT NULL AND v_prev.bidder_id IS NOT NULL THEN
    PERFORM public.release_bidder_listing_holds(p_listing_id, v_prev.bidder_id);

    IF COALESCE(NULLIF(v_prev.locked_amount, 0), 0) > 0
       AND v_prev.locked_released_at IS NULL THEN
      v_released := public._release_full_bid_lock(v_prev, p_listing_id);
    END IF;
  END IF;

  -- Lock bidder wallet: full bid amount
  SELECT
    COALESCE(pr.wallet_balance, 0),
    COALESCE(pr.locked_balance, 0)
  INTO v_wb, v_lb
  FROM public.profiles pr
  WHERE pr.id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile missing in public.profiles — log out and log in again';
  END IF;

  IF v_wb < v_lock_amount THEN
    RAISE EXCEPTION '%',
      format('Insufficient wallet balance. Need Rs. %s; you have Rs. %s.', v_lock_amount, v_wb)
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.profiles pr
  SET
    wallet_balance = COALESCE(pr.wallet_balance, 0) - v_lock_amount,
    locked_balance = COALESCE(pr.locked_balance, 0) + v_lock_amount,
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
    locked_released_at
  )
  VALUES (
    p_listing_id,
    v_uid,
    v_lock_amount,
    v_lock_amount,
    v_label,
    0,
    v_lock_amount,
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
      'note', 'Full bid amount moved wallet_balance → locked_balance'
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

REVOKE ALL ON FUNCTION public.place_bid_with_wallet_lock(uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.place_bid_with_wallet_lock(uuid, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.place_bid_with_wallet_lock(uuid, numeric) TO service_role;

-- ---------------------------------------------------------------------------
-- Optional: smoke-test block (run manually, do not leave enabled in prod)
-- ---------------------------------------------------------------------------
-- SELECT public.place_bid_with_wallet_lock(
--   '<listing-uuid>'::uuid,
--   5500::numeric
-- );

NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- VERIFICATION QUERIES (manual)
-- =============================================================================
-- SELECT proname FROM pg_proc WHERE proname = 'place_bid_with_wallet_lock';
--
-- After test bid:
-- SELECT wallet_balance, held_balance, locked_balance FROM public.profiles WHERE id = auth.uid();
-- SELECT * FROM public.wallet_ledger ORDER BY created_at DESC LIMIT 10;
-- SELECT id, bid_amount, locked_amount, locked_released_at FROM public.bids
--   WHERE listing_id = '<listing-uuid>' ORDER BY created_at DESC;
-- =============================================================================
