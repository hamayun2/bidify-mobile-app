-- =============================================================================
-- Bidify — Escrow Phase 2: resolve_auction → auction_orders + OTP + escrow ledger
-- =============================================================================
-- Prerequisites:
--   • escrow_phase_a_migration.sql
--   • escrow_phase_1_place_bid_rpc.sql
--   • escrow_fix_stuck_refunds_and_ledger.sql (recommended)
--
-- Run once in Supabase SQL Editor. Does NOT modify frontend code.
--
-- Phase 2 behaviour:
--   • Creates auction_orders (status = pending_delivery) when there is a winner
--   • Generates a random 6-digit delivery OTP; stores SHA-256 hash only
--   • Winner funds stay in profiles.locked_balance (NOT paid to seller yet)
--   • wallet_ledger escrow_lock row ties funds to the new order_id
--   • Releases ALL legacy tier holds + full bid locks for losing bidders
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- Error log when resolve_auction / order INSERT fails (inspect in Dashboard)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.auction_resolve_errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid REFERENCES public.listings (id) ON DELETE SET NULL,
  error_message text,
  error_detail text,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auction_resolve_errors_listing_idx
  ON public.auction_resolve_errors (listing_id, created_at DESC);

ALTER TABLE public.auction_resolve_errors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS auction_resolve_errors_admin ON public.auction_resolve_errors;
CREATE POLICY auction_resolve_errors_admin
  ON public.auction_resolve_errors
  FOR SELECT
  TO authenticated
  USING (coalesce(public.current_user_is_admin(), false));

-- ---------------------------------------------------------------------------
-- wallet_ledger append — optional order_id (Phase 2+)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public._wallet_ledger_append(
  uuid, public.wallet_ledger_entry_type, numeric, uuid, uuid, text, jsonb
);

CREATE OR REPLACE FUNCTION public._wallet_ledger_append(
  p_user_id uuid,
  p_entry_type public.wallet_ledger_entry_type,
  p_amount numeric,
  p_listing_id uuid DEFAULT NULL,
  p_bid_id uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_order_id uuid DEFAULT NULL
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
    order_id,
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
    p_order_id,
    p_idempotency_key,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public._wallet_ledger_append(
  uuid, public.wallet_ledger_entry_type, numeric, uuid, uuid, text, jsonb, uuid
) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Internal: hash a 6-digit delivery OTP (never store plaintext in DB)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._hash_delivery_otp(p_otp text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, extensions
AS $$
  SELECT encode(
    extensions.digest(trim(coalesce(p_otp, ''))::text, 'sha256'::text),
    'hex'::text
  );
$$;

REVOKE ALL ON FUNCTION public._hash_delivery_otp(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._hash_delivery_otp(text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Internal: ensure winner has full escrow in locked_balance (no seller payout)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._secure_winner_escrow_balance(
  p_buyer_id uuid,
  p_escrow_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_escrow numeric;
  v_wb numeric;
  v_lb numeric;
  v_gap numeric;
  v_moved numeric := 0;
BEGIN
  v_escrow := floor(coalesce(p_escrow_amount, 0));
  IF v_escrow <= 0 OR p_buyer_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'secured', 0, 'required', 0);
  END IF;

  SELECT
    coalesce(pr.wallet_balance, 0),
    coalesce(pr.locked_balance, 0)
  INTO v_wb, v_lb
  FROM public.profiles pr
  WHERE pr.id = p_buyer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Winner profile not found';
  END IF;

  -- Winner bid row may already hold the full amount in locked_balance via place_bid_with_wallet_lock
  IF v_lb >= v_escrow THEN
    RETURN jsonb_build_object(
      'ok', true,
      'secured', v_escrow,
      'required', v_escrow,
      'locked_balance', v_lb,
      'moved_from_wallet', 0,
      'source', 'profile_locked_balance'
    );
  END IF;

  v_gap := v_escrow - v_lb;
  IF v_wb < v_gap THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'insufficient_funds_for_escrow',
      'required', v_escrow,
      'locked_balance', v_lb,
      'wallet_balance', v_wb,
      'shortfall', v_gap - v_wb
    );
  END IF;

  v_moved := v_gap;

  UPDATE public.profiles pr
  SET
    wallet_balance = coalesce(pr.wallet_balance, 0) - v_moved,
    locked_balance = coalesce(pr.locked_balance, 0) + v_moved,
    updated_at = now()
  WHERE pr.id = p_buyer_id
  RETURNING pr.locked_balance INTO v_lb;

  RETURN jsonb_build_object(
    'ok', true,
    'secured', v_escrow,
    'required', v_escrow,
    'locked_balance', v_lb,
    'moved_from_wallet', v_moved
  );
END;
$$;

REVOKE ALL ON FUNCTION public._secure_winner_escrow_balance(uuid, numeric) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Refund seller listing fee when auction ends with zero bids (cron / resolve_auction)
-- ---------------------------------------------------------------------------
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

  IF EXISTS (
    SELECT 1 FROM public.bids b WHERE b.listing_id = p_listing_id LIMIT 1
  ) THEN
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

  RETURN jsonb_build_object('ok', true, 'refunded', true, 'fee', v_fee, 'seller_id', v_seller);
END;
$$;

REVOKE ALL ON FUNCTION public.refund_auction_listing_fee_no_bids(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refund_auction_listing_fee_no_bids(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Internal: INSERT auction_orders + OTP for winning bid (idempotent per listing)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._insert_auction_order_for_winner(
  p_listing_id uuid,
  p_listing public.listings,
  p_win_bid public.bids
)
RETURNS public.auction_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.auction_orders;
  v_escrow_amount numeric;
  v_otp text;
  v_otp_hash text;
  v_otp_expires timestamptz;
  v_secure jsonb;
  v_listing_title text;
  v_bid_locked numeric;
BEGIN
  IF p_win_bid.id IS NULL OR p_win_bid.bidder_id IS NULL OR p_listing.seller_id IS NULL THEN
    RAISE EXCEPTION 'Cannot create auction order — missing winner or seller';
  END IF;

  SELECT o.* INTO v_order
  FROM public.auction_orders o
  WHERE o.listing_id = p_listing_id;

  IF FOUND THEN
    RETURN v_order;
  END IF;

  v_escrow_amount := floor(greatest(
    coalesce(nullif(p_win_bid.bid_amount, 0), nullif(p_win_bid.amount, 0), 0),
    coalesce(nullif(p_listing.current_bid, 0), 0),
    1
  ));

  v_bid_locked := floor(coalesce(nullif(p_win_bid.locked_amount, 0), 0));

  v_secure := public._secure_winner_escrow_balance(p_win_bid.bidder_id, v_escrow_amount);

  IF coalesce((v_secure->>'ok')::boolean, false) IS NOT TRUE
     AND p_win_bid.locked_released_at IS NULL
     AND v_bid_locked >= v_escrow_amount THEN
    v_secure := jsonb_build_object(
      'ok', true,
      'secured', v_escrow_amount,
      'required', v_escrow_amount,
      'source', 'winning_bid_locked_amount',
      'bid_locked_amount', v_bid_locked
    );
  ELSIF coalesce((v_secure->>'ok')::boolean, false) IS NOT TRUE THEN
    INSERT INTO public.auction_resolve_errors (listing_id, error_message, context)
    VALUES (
      p_listing_id,
      'Winner escrow secure failed',
      jsonb_build_object(
        'buyer_id', p_win_bid.bidder_id,
        'escrow_amount', v_escrow_amount,
        'secure', v_secure,
        'bid_locked_amount', v_bid_locked
      )
    );
    RAISE EXCEPTION '%',
      format(
        'Winner has insufficient funds to secure escrow (need Rs. %s).',
        v_escrow_amount
      );
  END IF;

  v_otp := lpad((100000 + floor(random() * 900000))::text, 6, '0');
  v_otp_hash := public._hash_delivery_otp(v_otp);
  v_otp_expires := now() + interval '7 days';
  v_listing_title := nullif(trim(coalesce(p_listing.title::text, '')), '');

  BEGIN
    INSERT INTO public.auction_orders (
      listing_id,
      winning_bid_id,
      buyer_id,
      seller_id,
      winning_bid_amount,
      escrow_amount,
      status,
      delivery_otp_hash,
      delivery_otp_expires_at,
      metadata
    )
    VALUES (
      p_listing_id,
      p_win_bid.id,
      p_win_bid.bidder_id,
      p_listing.seller_id,
      v_escrow_amount,
      v_escrow_amount,
      'pending_delivery'::public.auction_order_status,
      v_otp_hash,
      v_otp_expires,
      jsonb_build_object(
        'listing_title', coalesce(v_listing_title, 'Auction listing'),
        'phase', 2,
        'secured_at_resolve', v_secure
      )
    )
    RETURNING * INTO v_order;
  EXCEPTION
    WHEN OTHERS THEN
      INSERT INTO public.auction_resolve_errors (listing_id, error_message, error_detail, context)
      VALUES (
        p_listing_id,
        SQLERRM,
        SQLSTATE,
        jsonb_build_object('winning_bid_id', p_win_bid.id, 'buyer_id', p_win_bid.bidder_id)
      );
      RAISE;
  END;

  PERFORM public._wallet_ledger_append(
    p_win_bid.bidder_id,
    'escrow_lock'::public.wallet_ledger_entry_type,
    v_escrow_amount,
    p_listing_id,
    p_win_bid.id,
    format('escrow_lock:order:%s', v_order.id),
    jsonb_build_object(
      'reason', 'Auction won — funds held in order escrow until delivery OTP',
      'order_id', v_order.id,
      'listing_id', p_listing_id,
      'listing_title', coalesce(v_listing_title, 'Auction listing'),
      'escrow_amount', v_escrow_amount
    ),
    v_order.id
  );

  RETURN v_order;
END;
$$;

REVOKE ALL ON FUNCTION public._insert_auction_order_for_winner(uuid, public.listings, public.bids) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Phase 2: resolve_auction — orders, OTP, escrow ledger, loser refunds
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_auction(
  p_listing_id uuid,
  p_force boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_listing public.listings;
  v_end timestamptz;
  v_kind text;
  v_win_bid public.bids;
  v_win_amount numeric;
  v_escrow_amount numeric;
  v_bid_id uuid;
  v_bidder_id uuid;
  v_lose_bid public.bids;
  v_released_count int := 0;
  v_full_lock_released_count int := 0;
  v_released_total numeric := 0;
  v_one jsonb;
  v_caller uuid := auth.uid();
  v_order public.auction_orders;
  v_order_id uuid;
  v_otp text;
  v_otp_hash text;
  v_otp_expires timestamptz;
  v_secure jsonb;
  v_listing_title text;
  v_listing_fee_refund jsonb;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  SELECT * INTO v_listing
  FROM public.listings l
  WHERE l.id = p_listing_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Listing not found';
  END IF;

  IF v_listing.auction_resolved_at IS NOT NULL THEN
    SELECT o.* INTO v_order
    FROM public.auction_orders o
    WHERE o.listing_id = p_listing_id;

    IF NOT FOUND THEN
      IF v_listing.winning_bid_id IS NOT NULL THEN
        SELECT b.* INTO v_win_bid
        FROM public.bids b
        WHERE b.id = v_listing.winning_bid_id;
      END IF;

      IF v_win_bid.id IS NULL THEN
        SELECT b.*
        INTO v_win_bid
        FROM public.bids b
        WHERE b.listing_id = p_listing_id
        ORDER BY coalesce(b.bid_amount, b.amount) DESC NULLS LAST, b.created_at DESC
        LIMIT 1;
      END IF;

      IF v_win_bid.id IS NOT NULL THEN
        v_order := public._insert_auction_order_for_winner(p_listing_id, v_listing, v_win_bid);
      END IF;
    END IF;

    RETURN jsonb_build_object(
      'ok', true,
      'already_resolved', true,
      'listing_id', p_listing_id,
      'resolved_at', v_listing.auction_resolved_at,
      'order_id', v_order.id,
      'order_status', v_order.status,
      'order_backfilled', (v_order.id IS NOT NULL)
    );
  END IF;

  v_kind := lower(nullif(trim(coalesce(v_listing.listing_type::text, v_listing.type::text)), ''));
  IF v_kind IS DISTINCT FROM 'auction' THEN
    RAISE EXCEPTION 'Not an auction listing';
  END IF;

  v_end := coalesce(v_listing.auction_end_time, v_listing.end_time);
  IF NOT p_force AND v_end IS NOT NULL AND v_end > now() THEN
    RAISE EXCEPTION 'Auction has not ended yet';
  END IF;

  IF NOT p_force AND v_caller IS NOT NULL THEN
    IF v_caller IS DISTINCT FROM v_listing.seller_id
       AND NOT coalesce(public.current_user_is_admin(), false)
       AND NOT EXISTS (
         SELECT 1
         FROM public.bids b
         WHERE b.listing_id = p_listing_id
           AND b.bidder_id = v_caller
       ) THEN
      RAISE EXCEPTION 'Not allowed to resolve this auction';
    END IF;
  END IF;

  SELECT b.*
  INTO v_win_bid
  FROM public.bids b
  WHERE b.listing_id = p_listing_id
  ORDER BY
    coalesce(b.bid_amount, b.amount) DESC NULLS LAST,
    b.created_at DESC
  LIMIT 1;

  IF v_win_bid.id IS NOT NULL THEN
    v_win_amount := coalesce(
      nullif(v_win_bid.bid_amount, 0),
      nullif(v_win_bid.amount, 0),
      nullif(v_listing.current_bid, 0),
      0
    );
    v_escrow_amount := floor(greatest(v_win_amount, 1));
  ELSE
    v_win_amount := 0;
    v_escrow_amount := 0;
  END IF;

  -- -------------------------------------------------------------------------
  -- No bids at expiry: refund flat listing activation fee (Rs. 500) to seller
  -- If there is a highest bid, listing fee stays charged (not refunded here).
  -- -------------------------------------------------------------------------
  v_listing_fee_refund := NULL;
  IF v_win_bid.id IS NULL AND v_listing.seller_id IS NOT NULL THEN
    v_listing_fee_refund := public.refund_auction_listing_fee_no_bids(p_listing_id);
  END IF;

  -- -------------------------------------------------------------------------
  -- 4) Refund losing bidders — legacy tier holds (all bids except winner row)
  -- -------------------------------------------------------------------------
  FOR v_bid_id IN
    SELECT b.id
    FROM public.bids b
    WHERE b.listing_id = p_listing_id
      AND b.wallet_hold_released_at IS NULL
      AND coalesce(b.wallet_hold_applied, 0) > 0
      AND (
        v_win_bid.id IS NULL
        OR b.id IS DISTINCT FROM v_win_bid.id
      )
    ORDER BY b.created_at ASC
    FOR UPDATE OF b
  LOOP
    v_one := public.release_bid_wallet_hold(v_bid_id);
    v_released_count := v_released_count + 1;
    v_released_total := v_released_total + coalesce((v_one->>'released')::numeric, 0);
  END LOOP;

  -- Release all legacy holds per losing bidder on this listing
  FOR v_bidder_id IN
    SELECT DISTINCT b.bidder_id
    FROM public.bids b
    WHERE b.listing_id = p_listing_id
      AND b.bidder_id IS NOT NULL
      AND (
        v_win_bid.id IS NULL
        OR b.bidder_id IS DISTINCT FROM v_win_bid.bidder_id
      )
  LOOP
    PERFORM public.release_bidder_listing_holds(p_listing_id, v_bidder_id);
  END LOOP;

  -- Release full Phase-1 bid locks for every non-winning bid
  FOR v_lose_bid IN
    SELECT b.*
    FROM public.bids b
    WHERE b.listing_id = p_listing_id
      AND (
        v_win_bid.id IS NULL
        OR b.id IS DISTINCT FROM v_win_bid.id
      )
      AND coalesce(nullif(b.locked_amount, 0), 0) > 0
      AND b.locked_released_at IS NULL
    ORDER BY b.created_at ASC
    FOR UPDATE OF b
  LOOP
    v_released_total := v_released_total
      + coalesce(public._release_full_bid_lock(v_lose_bid, p_listing_id), 0);
    v_full_lock_released_count := v_full_lock_released_count + 1;
  END LOOP;

  v_order_id := NULL;
  v_otp_hash := NULL;
  v_otp_expires := NULL;

  -- -------------------------------------------------------------------------
  -- 1–3) Winner: auction_orders + OTP + escrow_lock ledger (funds stay locked)
  -- -------------------------------------------------------------------------
  IF v_win_bid.id IS NOT NULL
     AND v_win_bid.bidder_id IS NOT NULL
     AND v_escrow_amount > 0
     AND v_listing.seller_id IS NOT NULL THEN

    v_order := public._insert_auction_order_for_winner(p_listing_id, v_listing, v_win_bid);
    v_order_id := v_order.id;
    v_otp_hash := v_order.delivery_otp_hash;
    v_otp_expires := v_order.delivery_otp_expires_at;
    v_secure := v_order.metadata->'secured_at_resolve';

    -- Winner legacy tier hold on winning row (if any) — release tiny tier hold only;
    -- full bid amount must stay locked via locked_amount / locked_balance
    IF coalesce(v_win_bid.wallet_hold_applied, 0) > 0
       AND v_win_bid.wallet_hold_released_at IS NULL THEN
      v_one := public.release_bid_wallet_hold(v_win_bid.id);
      v_released_total := v_released_total + coalesce((v_one->>'released')::numeric, 0);
    END IF;
  END IF;

  UPDATE public.listings
  SET
    status = CASE
      WHEN lower(nullif(trim(status::text), '')) IN ('sold', 'ended') THEN status
      ELSE 'ended'
    END,
    auction_resolved_at = now(),
    winner_bidder_id = v_win_bid.bidder_id,
    winning_bid_id = v_win_bid.id,
    current_bid = CASE
      WHEN v_escrow_amount > 0 THEN v_escrow_amount
      ELSE current_bid
    END,
    updated_at = now()
  WHERE id = p_listing_id;

  RETURN jsonb_build_object(
    'ok', true,
    'listing_id', p_listing_id,
    'winner_bidder_id', v_win_bid.bidder_id,
    'winning_bid_id', v_win_bid.id,
    'winning_amount', v_win_amount,
    'escrow_amount', v_escrow_amount,
    'order_id', v_order_id,
    'order_status', CASE WHEN v_order_id IS NOT NULL THEN 'pending_delivery' ELSE NULL END,
    'delivery_otp_expires_at', v_otp_expires,
    'escrow_secured', v_secure,
    'losers_tier_released_count', v_released_count,
    'losers_full_lock_released_count', v_full_lock_released_count,
    'losers_released_total', v_released_total,
    'otp_generated', (v_otp_hash IS NOT NULL),
    'listing_fee_refund', v_listing_fee_refund,
    'had_bids', (v_win_bid.id IS NOT NULL)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_auction(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_auction(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_auction(uuid, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- Batch resolve expired auctions (unchanged entry point; uses Phase 2 logic)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_expired_auctions(p_limit int DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_listing_id uuid;
  v_results jsonb := '[]'::jsonb;
  v_one jsonb;
  v_count int := 0;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  FOR v_listing_id IN
    SELECT l.id
    FROM public.listings l
    WHERE lower(nullif(trim(coalesce(l.listing_type::text, l.type::text)), '')) = 'auction'
      AND l.auction_resolved_at IS NULL
      AND coalesce(l.auction_end_time, l.end_time) IS NOT NULL
      AND coalesce(l.auction_end_time, l.end_time) <= now()
    ORDER BY coalesce(l.auction_end_time, l.end_time) ASC
    LIMIT greatest(1, least(coalesce(p_limit, 50), 500))
  LOOP
    v_one := public.resolve_auction(v_listing_id, true);
    v_results := v_results || jsonb_build_array(v_one);
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'resolved_count', v_count,
    'results', v_results
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_expired_auctions(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_expired_auctions(int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_expired_auctions(int) TO service_role;

NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- VERIFICATION (manual)
-- =============================================================================
-- SELECT public.resolve_auction('<listing-uuid>'::uuid, true);
--
-- SELECT id, status, buyer_id, seller_id, escrow_amount,
--        delivery_otp_hash IS NOT NULL AS has_otp,
--        delivery_otp_expires_at
-- FROM public.auction_orders WHERE listing_id = '<listing-uuid>';
--
-- SELECT entry_type, amount, order_id, metadata
-- FROM public.wallet_ledger
-- WHERE listing_id = '<listing-uuid>'
-- ORDER BY created_at DESC;
--
-- SELECT wallet_balance, held_balance, locked_balance
-- FROM public.profiles WHERE id = '<winner-uuid>';
-- =============================================================================
