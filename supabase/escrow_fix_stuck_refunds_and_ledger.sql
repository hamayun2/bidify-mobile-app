-- =============================================================================
-- Bidify — CRITICAL FIX: release legacy + escrow holds on outbid; ledger topups
-- =============================================================================
-- Run in Supabase SQL Editor after escrow_phase_a_migration.sql and
-- escrow_phase_1_place_bid_rpc.sql.
--
-- BUG 1: place_bid_with_wallet_lock now releases BOTH locked_balance AND all
--        legacy tier holds (held_balance) for the previous highest bidder.
-- BUG 2: credit_profile_wallet_topup writes wallet_ledger rows for deposits.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Top-ups → wallet_ledger (Stripe / EasyPaisa / manual)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.credit_profile_wallet_topup(
  p_user_id uuid,
  p_amount numeric,
  p_idempotency_key text,
  p_provider text DEFAULT 'stripe'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_amount numeric;
  v_key text;
  v_wb numeric;
  v_existing uuid;
  v_source text;
  v_provider text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;

  v_amount := floor(COALESCE(p_amount, 0));
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'p_amount must be positive';
  END IF;

  v_key := nullif(trim(COALESCE(p_idempotency_key, '')), '');
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'p_idempotency_key is required';
  END IF;

  v_provider := nullif(trim(COALESCE(p_provider, '')), '');

  SELECT l.id INTO v_existing
  FROM public.wallet_topup_ledger l
  WHERE l.idempotency_key = v_key;

  IF FOUND THEN
    SELECT COALESCE(pr.wallet_balance, 0) INTO v_wb
    FROM public.profiles pr
    WHERE pr.id = p_user_id;
    RETURN jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'user_id', p_user_id,
      'wallet_balance', COALESCE(v_wb, 0)
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = p_user_id) THEN
    RAISE EXCEPTION 'Profile not found for user % — complete registration in the app first.', p_user_id;
  END IF;

  UPDATE public.profiles pr
  SET
    wallet_balance = COALESCE(pr.wallet_balance, 0) + v_amount,
    updated_at = now()
  WHERE pr.id = p_user_id
  RETURNING pr.wallet_balance INTO v_wb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found for user %', p_user_id;
  END IF;

  INSERT INTO public.wallet_topup_ledger (user_id, amount, idempotency_key, provider)
  VALUES (p_user_id, v_amount, v_key, v_provider);

  v_source := CASE
    WHEN v_provider IS NULL THEN 'Wallet top-up'
    WHEN lower(v_provider) LIKE '%stripe%' THEN 'Loaded via Stripe'
    WHEN lower(v_provider) LIKE '%easypaisa%' THEN 'Loaded via EasyPaisa'
    WHEN lower(v_provider) = 'manual' THEN 'Manual top-up'
    ELSE format('Loaded via %s', v_provider)
  END;

  PERFORM public._wallet_ledger_append(
    p_user_id,
    'topup'::public.wallet_ledger_entry_type,
    v_amount,
    NULL,
    NULL,
    format('topup:%s', v_key),
    jsonb_build_object(
      'source', v_source,
      'description', v_source,
      'provider', COALESCE(v_provider, 'unknown'),
      'action', 'deposit',
      'idempotency_key', v_key
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'user_id', p_user_id,
    'credited', v_amount,
    'wallet_balance', v_wb,
    'provider', p_provider
  );
END;
$$;

REVOKE ALL ON FUNCTION public.credit_profile_wallet_topup(uuid, numeric, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.credit_profile_wallet_topup(uuid, numeric, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- Legacy tier hold release → wallet_ledger (audit trail)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_bid_wallet_hold(p_bid_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bid public.bids;
  v_hold numeric;
  v_release numeric;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  SELECT * INTO v_bid FROM public.bids b WHERE b.id = p_bid_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bid_not_found');
  END IF;

  IF v_bid.wallet_hold_released_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'skipped', true, 'bid_id', p_bid_id);
  END IF;

  v_hold := COALESCE(v_bid.wallet_hold_applied, 0);
  IF v_hold <= 0 THEN
    UPDATE public.bids SET wallet_hold_released_at = now() WHERE id = p_bid_id;
    RETURN jsonb_build_object('ok', true, 'released', 0, 'bid_id', p_bid_id);
  END IF;

  SELECT least(v_hold, COALESCE(p.held_balance, 0)) INTO v_release
  FROM public.profiles p
  WHERE p.id = v_bid.bidder_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bidder profile not found in public.profiles';
  END IF;

  v_release := COALESCE(v_release, 0);

  IF v_release > 0 THEN
    UPDATE public.profiles pr
    SET
      held_balance = greatest(0, COALESCE(pr.held_balance, 0) - v_release),
      wallet_balance = COALESCE(pr.wallet_balance, 0) + v_release,
      updated_at = now()
    WHERE pr.id = v_bid.bidder_id;

    PERFORM public._wallet_ledger_append(
      v_bid.bidder_id,
      'legacy_tier_release'::public.wallet_ledger_entry_type,
      v_release,
      v_bid.listing_id,
      v_bid.id,
      format('legacy_tier_release:%s', p_bid_id),
      jsonb_build_object(
        'reason', 'Legacy tier hold released',
        'bid_id', p_bid_id,
        'listing_id', v_bid.listing_id,
        'released', v_release,
        'requested', v_hold
      )
    );
  END IF;

  UPDATE public.bids SET wallet_hold_released_at = now() WHERE id = p_bid_id;

  RETURN jsonb_build_object(
    'ok', true,
    'bid_id', p_bid_id,
    'released', v_release,
    'requested', v_hold
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.release_bid_wallet_hold(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- place_bid_with_wallet_lock — outbid refunds: locked_balance AND held_balance
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

  -- Clear this bidder's unreleased legacy tier holds on this listing before new lock
  PERFORM public.release_bidder_listing_holds(p_listing_id, v_uid);

  -- Outbid refund: previous highest bidder — ALL legacy holds on listing + full escrow lock
  IF v_prev.id IS NOT NULL AND v_prev.bidder_id IS NOT NULL THEN
    PERFORM public.release_bidder_listing_holds(p_listing_id, v_prev.bidder_id);

    IF COALESCE(NULLIF(v_prev.locked_amount, 0), 0) > 0
       AND v_prev.locked_released_at IS NULL THEN
      v_released := public._release_full_bid_lock(v_prev, p_listing_id);
    END IF;
  END IF;

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
-- Backfill wallet_ledger for past top-ups (safe to re-run)
-- ---------------------------------------------------------------------------
INSERT INTO public.wallet_ledger (
  user_id,
  entry_type,
  amount,
  wallet_balance_after,
  held_balance_after,
  locked_balance_after,
  idempotency_key,
  metadata,
  created_at
)
SELECT
  w.user_id,
  'topup'::public.wallet_ledger_entry_type,
  w.amount,
  pr.wallet_balance,
  pr.held_balance,
  pr.locked_balance,
  format('topup:%s', w.idempotency_key),
  jsonb_build_object(
    'source',
      CASE
        WHEN w.provider IS NULL THEN 'Wallet top-up'
        WHEN lower(w.provider) LIKE '%stripe%' THEN 'Loaded via Stripe'
        WHEN lower(w.provider) LIKE '%easypaisa%' THEN 'Loaded via EasyPaisa'
        ELSE format('Loaded via %s', w.provider)
      END,
    'description',
      CASE
        WHEN w.provider IS NULL THEN 'Wallet top-up'
        WHEN lower(w.provider) LIKE '%stripe%' THEN 'Loaded via Stripe'
        WHEN lower(w.provider) LIKE '%easypaisa%' THEN 'Loaded via EasyPaisa'
        ELSE format('Loaded via %s', w.provider)
      END,
    'provider', COALESCE(w.provider, 'unknown'),
    'action', 'deposit',
    'backfilled', true
  ),
  w.created_at
FROM public.wallet_topup_ledger w
JOIN public.profiles pr ON pr.id = w.user_id
WHERE NOT EXISTS (
  SELECT 1
  FROM public.wallet_ledger wl
  WHERE wl.idempotency_key = format('topup:%s', w.idempotency_key)
);

NOTIFY pgrst, 'reload schema';
