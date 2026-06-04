-- =============================================================================
-- Bidify — SINGLE SOURCE OF TRUTH (run once in Supabase SQL Editor)
-- =============================================================================
-- SAFE: No DROP TABLE. No DELETE. No wallet balance resets.
--       CREATE OR REPLACE functions, ALTER ADD COLUMN, DROP broken VIEW only.
--
-- Synced with app:
--   profileService.js      → public.profiles
--   profileWalletService.js → wallet_balance, held_balance
--   bidsService.js         → rpc place_bid(p_listing_id, p_amount)
--   auctionEscrowService.js → resolve_auction, resolve_expired_auctions
--   bidHoldRules.js        → compute_bid_wallet_hold tiers
--   server/supabaseWallet.js → credit_profile_wallet_topup
--   listingsService.js     → public.listings columns
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- PART 1 — Tables: add missing columns only (never drop data)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE
);

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS full_name text,
  ADD COLUMN IF NOT EXISTS username text,
  ADD COLUMN IF NOT EXISTS phone_number text,
  ADD COLUMN IF NOT EXISTS cnic text,
  ADD COLUMN IF NOT EXISTS cnic_front_url text,
  ADD COLUMN IF NOT EXISTS cnic_back_url text,
  ADD COLUMN IF NOT EXISTS cnic_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS profile_completed boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS profile_image text,
  ADD COLUMN IF NOT EXISTS email_verified boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS wallet_balance numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS held_balance numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS role text DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS is_admin boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

UPDATE public.profiles SET wallet_balance = COALESCE(wallet_balance, 0) WHERE wallet_balance IS NULL;
UPDATE public.profiles SET held_balance = COALESCE(held_balance, 0) WHERE held_balance IS NULL;

-- Ensure every auth user has a profile row (does NOT overwrite balances)
INSERT INTO public.profiles (id, email, role, wallet_balance, held_balance)
SELECT u.id, COALESCE(u.email, ''), 'user', 0, 0
FROM auth.users u
WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE IF EXISTS public.listings
  ADD COLUMN IF NOT EXISTS seller_id uuid,
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS price numeric,
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS listing_type text,
  ADD COLUMN IF NOT EXISTS type text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS moderation_status text,
  ADD COLUMN IF NOT EXISTS image_url text,
  ADD COLUMN IF NOT EXISTS image_urls jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS current_bid numeric,
  ADD COLUMN IF NOT EXISTS auction_end_time timestamptz,
  ADD COLUMN IF NOT EXISTS end_time timestamptz,
  ADD COLUMN IF NOT EXISTS duration_days integer,
  ADD COLUMN IF NOT EXISTS buy_now_price numeric,
  ADD COLUMN IF NOT EXISTS seller_name text,
  ADD COLUMN IF NOT EXISTS user_email text,
  ADD COLUMN IF NOT EXISTS username text,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS auction_resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS winner_bidder_id uuid,
  ADD COLUMN IF NOT EXISTS winning_bid_id uuid,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

ALTER TABLE IF EXISTS public.bids
  ADD COLUMN IF NOT EXISTS amount numeric,
  ADD COLUMN IF NOT EXISTS bid_amount numeric,
  ADD COLUMN IF NOT EXISTS bidder_display_name text,
  ADD COLUMN IF NOT EXISTS wallet_hold_applied numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wallet_hold_released_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

UPDATE public.bids SET bid_amount = amount WHERE bid_amount IS NULL AND amount IS NOT NULL;
UPDATE public.bids SET amount = bid_amount WHERE amount IS NULL AND bid_amount IS NOT NULL;

-- Fix bidder_id FK if it still points at dropped public.users
DO $$
DECLARE cname text;
BEGIN
  SELECT con.conname INTO cname
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  JOIN pg_class frel ON frel.oid = con.confrelid
  JOIN pg_namespace fnsp ON fnsp.oid = frel.relnamespace
  WHERE nsp.nspname = 'public' AND rel.relname = 'bids' AND con.contype = 'f'
    AND fnsp.nspname = 'public' AND frel.relname = 'users'
  LIMIT 1;
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.bids DROP CONSTRAINT %I', cname);
    ALTER TABLE public.bids
      ADD CONSTRAINT bids_bidder_id_auth_fkey
      FOREIGN KEY (bidder_id) REFERENCES auth.users (id) ON DELETE CASCADE;
  END IF;
END $$;

-- =============================================================================
-- PART 2 — Drop broken view + replace RPCs (functions only, not tables)
-- =============================================================================

DROP VIEW IF EXISTS public.user_profiles;

DROP FUNCTION IF EXISTS public.place_bid(uuid, numeric) CASCADE;
DROP FUNCTION IF EXISTS public.release_bidder_listing_holds(uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.release_bid_wallet_hold(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.compute_bid_wallet_hold(numeric) CASCADE;
DROP FUNCTION IF EXISTS public.resolve_auction(uuid, boolean) CASCADE;
DROP FUNCTION IF EXISTS public.resolve_expired_auctions(integer) CASCADE;
DROP FUNCTION IF EXISTS public.current_user_is_admin() CASCADE;
DROP FUNCTION IF EXISTS public.promote_builtin_admin(text, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.auth_email_exists(text) CASCADE;
DROP FUNCTION IF EXISTS public.credit_profile_wallet_topup(uuid, numeric, text, text) CASCADE;
DROP FUNCTION IF EXISTS public.reconcile_profile_wallet_balance(uuid, numeric) CASCADE;

-- =============================================================================
-- PART 3 — Helpers (public.profiles only — never public.users)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.current_user_is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT (p.role = 'admin' OR p.is_admin = true) FROM public.profiles p WHERE p.id = auth.uid()),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.current_user_is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_is_admin() TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.promote_builtin_admin(p_email text, p_user_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE uid uuid;
  em text := lower(trim(COALESCE(p_email, '')));
BEGIN
  IF em = '' THEN RETURN; END IF;
  uid := COALESCE(p_user_id, (SELECT u.id FROM auth.users u WHERE lower(COALESCE(u.email, '')) = em LIMIT 1));
  IF uid IS NULL THEN RETURN; END IF;
  INSERT INTO public.profiles (id, email, full_name, username, role, profile_completed, email_verified, wallet_balance)
  VALUES (uid, trim(p_email), 'Bidify Admin', 'bidify_admin', 'admin', true, true, 0)
  ON CONFLICT (id) DO UPDATE SET
    role = 'admin', is_admin = true, email = EXCLUDED.email, email_verified = true, updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.promote_builtin_admin(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.promote_builtin_admin(text, uuid) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.auth_email_exists(p_email text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.users u
    WHERE lower(COALESCE(u.email, '')) = lower(trim(COALESCE(p_email, '')))
  );
$$;

REVOKE ALL ON FUNCTION public.auth_email_exists(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_email_exists(text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (new.id, COALESCE(new.email, ''), COALESCE(new.raw_user_meta_data->>'full_name', ''))
  ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, updated_at = now();
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =============================================================================
-- PART 4 — Stripe wallet top-up (server/supabaseWallet.js)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.wallet_topup_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  amount numeric NOT NULL CHECK (amount > 0),
  idempotency_key text NOT NULL,
  provider text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key)
);

ALTER TABLE public.wallet_topup_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wallet_topup_ledger_deny_all" ON public.wallet_topup_ledger;
CREATE POLICY "wallet_topup_ledger_deny_all" ON public.wallet_topup_ledger FOR ALL USING (false);

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
DECLARE v_amount numeric; v_key text; v_wb numeric; v_existing uuid;
BEGIN
  PERFORM set_config('row_security', 'off', true);
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'p_user_id is required'; END IF;
  v_amount := floor(COALESCE(p_amount, 0));
  IF v_amount <= 0 THEN RAISE EXCEPTION 'p_amount must be positive'; END IF;
  v_key := nullif(trim(COALESCE(p_idempotency_key, '')), '');
  IF v_key IS NULL THEN RAISE EXCEPTION 'p_idempotency_key is required'; END IF;

  SELECT l.id INTO v_existing FROM public.wallet_topup_ledger l WHERE l.idempotency_key = v_key;
  IF FOUND THEN
    SELECT COALESCE(pr.wallet_balance, 0) INTO v_wb FROM public.profiles pr WHERE pr.id = p_user_id;
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'user_id', p_user_id, 'wallet_balance', COALESCE(v_wb, 0));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = p_user_id) THEN
    RAISE EXCEPTION 'Profile not found in public.profiles';
  END IF;

  UPDATE public.profiles pr
  SET wallet_balance = COALESCE(pr.wallet_balance, 0) + v_amount, updated_at = now()
  WHERE pr.id = p_user_id
  RETURNING pr.wallet_balance INTO v_wb;

  INSERT INTO public.wallet_topup_ledger (user_id, amount, idempotency_key, provider)
  VALUES (p_user_id, v_amount, v_key, nullif(trim(COALESCE(p_provider, '')), ''));

  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'user_id', p_user_id, 'credited', v_amount, 'wallet_balance', v_wb);
END;
$$;

REVOKE ALL ON FUNCTION public.credit_profile_wallet_topup(uuid, numeric, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.credit_profile_wallet_topup(uuid, numeric, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.reconcile_profile_wallet_balance(p_user_id uuid, p_target_balance numeric)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_target numeric; v_wb numeric;
BEGIN
  PERFORM set_config('row_security', 'off', true);
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'p_user_id is required'; END IF;
  v_target := greatest(0, floor(COALESCE(p_target_balance, 0)));
  IF NOT EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = p_user_id) THEN
    RAISE EXCEPTION 'Profile not found in public.profiles';
  END IF;
  UPDATE public.profiles pr
  SET wallet_balance = greatest(COALESCE(pr.wallet_balance, 0), v_target), updated_at = now()
  WHERE pr.id = p_user_id
  RETURNING pr.wallet_balance INTO v_wb;
  RETURN jsonb_build_object('ok', true, 'user_id', p_user_id, 'wallet_balance', COALESCE(v_wb, 0));
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_profile_wallet_balance(uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_profile_wallet_balance(uuid, numeric) TO service_role;

-- =============================================================================
-- PART 5 — Bid holds + place_bid (bidHoldRules.js / bidsService.js)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.compute_bid_wallet_hold(p_amount numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN COALESCE(p_amount, 0) > 10000 THEN 2000::numeric
    WHEN COALESCE(p_amount, 0) > 5000 THEN 1000::numeric
    WHEN COALESCE(p_amount, 0) > 1000 THEN 500::numeric
    ELSE 0::numeric
  END;
$$;

GRANT EXECUTE ON FUNCTION public.compute_bid_wallet_hold(numeric) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.release_bid_wallet_hold(p_bid_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_bid public.bids; v_hold numeric; v_release numeric;
BEGIN
  PERFORM set_config('row_security', 'off', true);
  SELECT * INTO v_bid FROM public.bids b WHERE b.id = p_bid_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'bid_not_found'); END IF;
  IF v_bid.wallet_hold_released_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'skipped', true, 'bid_id', p_bid_id);
  END IF;
  v_hold := COALESCE(v_bid.wallet_hold_applied, 0);
  IF v_hold <= 0 THEN
    UPDATE public.bids SET wallet_hold_released_at = now() WHERE id = p_bid_id;
    RETURN jsonb_build_object('ok', true, 'released', 0, 'bid_id', p_bid_id);
  END IF;
  SELECT least(v_hold, COALESCE(p.held_balance, 0)) INTO v_release
  FROM public.profiles p WHERE p.id = v_bid.bidder_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bidder profile not found in public.profiles'; END IF;
  v_release := COALESCE(v_release, 0);
  IF v_release > 0 THEN
    UPDATE public.profiles pr SET
      held_balance = greatest(0, COALESCE(pr.held_balance, 0) - v_release),
      wallet_balance = COALESCE(pr.wallet_balance, 0) + v_release,
      updated_at = now()
    WHERE pr.id = v_bid.bidder_id;
  END IF;
  UPDATE public.bids SET wallet_hold_released_at = now() WHERE id = p_bid_id;
  RETURN jsonb_build_object('ok', true, 'bid_id', p_bid_id, 'released', v_release, 'requested', v_hold);
END;
$$;

GRANT EXECUTE ON FUNCTION public.release_bid_wallet_hold(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.release_bidder_listing_holds(p_listing_id uuid, p_bidder_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_bid_id uuid; v_total numeric := 0; v_one jsonb; v_results jsonb := '[]'::jsonb;
BEGIN
  PERFORM set_config('row_security', 'off', true);
  FOR v_bid_id IN
    SELECT b.id FROM public.bids b
    WHERE b.listing_id = p_listing_id AND b.bidder_id = p_bidder_id
      AND b.wallet_hold_released_at IS NULL AND COALESCE(b.wallet_hold_applied, 0) > 0
    ORDER BY b.created_at ASC FOR UPDATE OF b
  LOOP
    v_one := public.release_bid_wallet_hold(v_bid_id);
    v_results := v_results || jsonb_build_array(v_one);
    v_total := v_total + COALESCE((v_one->>'released')::numeric, 0);
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'listing_id', p_listing_id, 'bidder_id', p_bidder_id, 'total_released', v_total, 'details', v_results);
END;
$$;

GRANT EXECUTE ON FUNCTION public.release_bidder_listing_holds(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.place_bid(p_listing_id uuid, p_amount numeric)
RETURNS public.bids
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seller_id uuid; v_kind text; v_status text; v_mod text;
  v_price numeric; v_current numeric; v_end timestamptz; v_resolved_at timestamptz;
  v_bid public.bids; v_min numeric; v_wb numeric; v_hold numeric := 0; v_label text;
BEGIN
  PERFORM set_config('row_security', 'off', true);
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT l.seller_id,
    lower(nullif(trim(COALESCE(l.listing_type::text, l.type::text)), '')),
    lower(nullif(trim(l.status::text), '')),
    lower(nullif(trim(l.moderation_status::text), '')),
    l.price, l.current_bid, COALESCE(l.auction_end_time, l.end_time), l.auction_resolved_at
  INTO v_seller_id, v_kind, v_status, v_mod, v_price, v_current, v_end, v_resolved_at
  FROM public.listings l WHERE l.id = p_listing_id FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Listing not found'; END IF;
  IF v_resolved_at IS NOT NULL THEN RAISE EXCEPTION 'Auction has ended and been resolved'; END IF;
  IF v_seller_id = auth.uid() THEN RAISE EXCEPTION 'You cannot bid on your own listing'; END IF;
  IF v_kind IS DISTINCT FROM 'auction' THEN RAISE EXCEPTION 'Not an auction listing'; END IF;
  IF NOT (v_status = 'active' OR v_mod = 'approved') THEN RAISE EXCEPTION 'Auction is not active'; END IF;
  IF v_end IS NOT NULL AND v_end < now() THEN RAISE EXCEPTION 'Auction has ended'; END IF;

  v_min := COALESCE(v_current, v_price);
  IF p_amount <= v_min THEN RAISE EXCEPTION 'Bid must be higher than current bid'; END IF;

  v_hold := public.compute_bid_wallet_hold(p_amount);
  PERFORM public.release_bidder_listing_holds(p_listing_id, auth.uid());

  SELECT COALESCE(pr.wallet_balance, 0) INTO v_wb FROM public.profiles pr WHERE pr.id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile missing in public.profiles — log out and log in again'; END IF;

  IF v_hold > 0 AND v_wb < v_hold THEN
    RAISE EXCEPTION USING
      MESSAGE = format('Insufficient wallet balance for hold. Need Rs. %s; you have Rs. %s.', v_hold, v_wb),
      ERRCODE = 'P0001';
  END IF;

  IF v_hold > 0 THEN
    UPDATE public.profiles pr SET
      wallet_balance = COALESCE(pr.wallet_balance, 0) - v_hold,
      held_balance = COALESCE(pr.held_balance, 0) + v_hold,
      updated_at = now()
    WHERE pr.id = auth.uid();
  END IF;

  SELECT COALESCE(nullif(trim(pr.username::text), ''), nullif(trim(pr.full_name::text), ''),
    split_part(COALESCE(pr.email::text, ''), '@', 1), 'Bidder')
  INTO v_label FROM public.profiles pr WHERE pr.id = auth.uid();
  IF v_label IS NULL OR trim(v_label) = '' THEN v_label := 'Bidder'; END IF;

  INSERT INTO public.bids (listing_id, bidder_id, amount, bid_amount, bidder_display_name, wallet_hold_applied)
  VALUES (p_listing_id, auth.uid(), p_amount, p_amount, v_label, v_hold)
  RETURNING * INTO v_bid;

  UPDATE public.listings SET current_bid = p_amount, updated_at = now() WHERE id = p_listing_id;
  RETURN v_bid;
END;
$$;

REVOKE ALL ON FUNCTION public.place_bid(uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.place_bid(uuid, numeric) TO authenticated, service_role;

-- =============================================================================
-- PART 6 — Auction resolution (auctionEscrowService.js)
-- =============================================================================
-- WARNING: The stub below does NOT insert into public.auction_orders.
-- For escrow orders + delivery OTP you MUST run:
--   supabase/escrow_phase_2_resolve_auction.sql (full file)
-- then optionally: supabase/fix_resolve_auction_create_orders.sql
-- =============================================================================

CREATE OR REPLACE FUNCTION public.resolve_auction(p_listing_id uuid, p_force boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_listing public.listings; v_end timestamptz; v_kind text; v_win_bid public.bids;
  v_bid_id uuid; v_released_count int := 0; v_released_total numeric := 0; v_one jsonb;
BEGIN
  PERFORM set_config('row_security', 'off', true);
  SELECT * INTO v_listing FROM public.listings l WHERE l.id = p_listing_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Listing not found'; END IF;
  IF v_listing.auction_resolved_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_resolved', true, 'listing_id', p_listing_id);
  END IF;
  v_kind := lower(nullif(trim(COALESCE(v_listing.listing_type::text, v_listing.type::text)), ''));
  IF v_kind IS DISTINCT FROM 'auction' THEN RAISE EXCEPTION 'Not an auction listing'; END IF;
  v_end := COALESCE(v_listing.auction_end_time, v_listing.end_time);
  IF NOT p_force AND v_end IS NOT NULL AND v_end > now() THEN
    RAISE EXCEPTION 'Auction has not ended yet';
  END IF;

  SELECT b.* INTO v_win_bid FROM public.bids b WHERE b.listing_id = p_listing_id
  ORDER BY COALESCE(b.bid_amount, b.amount) DESC NULLS LAST, b.created_at DESC LIMIT 1;

  FOR v_bid_id IN
    SELECT b.id FROM public.bids b WHERE b.listing_id = p_listing_id
      AND b.wallet_hold_released_at IS NULL AND COALESCE(b.wallet_hold_applied, 0) > 0
      AND (v_win_bid.id IS NULL OR b.id IS DISTINCT FROM v_win_bid.id)
    ORDER BY b.created_at ASC FOR UPDATE OF b
  LOOP
    v_one := public.release_bid_wallet_hold(v_bid_id);
    v_released_count := v_released_count + 1;
    v_released_total := v_released_total + COALESCE((v_one->>'released')::numeric, 0);
  END LOOP;

  UPDATE public.listings SET
    status = CASE WHEN lower(nullif(trim(status::text), '')) IN ('sold', 'ended') THEN status ELSE 'ended' END,
    auction_resolved_at = now(),
    winner_bidder_id = v_win_bid.bidder_id,
    winning_bid_id = v_win_bid.id,
    updated_at = now()
  WHERE id = p_listing_id;

  RETURN jsonb_build_object('ok', true, 'listing_id', p_listing_id, 'winner_bidder_id', v_win_bid.bidder_id,
    'losers_released_count', v_released_count, 'losers_released_total', v_released_total);
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_auction(uuid, boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_expired_auctions(p_limit int DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_listing_id uuid; v_results jsonb := '[]'::jsonb; v_one jsonb; v_count int := 0;
BEGIN
  PERFORM set_config('row_security', 'off', true);
  FOR v_listing_id IN
    SELECT l.id FROM public.listings l
    WHERE lower(nullif(trim(COALESCE(l.listing_type::text, l.type::text)), '')) = 'auction'
      AND l.auction_resolved_at IS NULL
      AND COALESCE(l.auction_end_time, l.end_time) IS NOT NULL
      AND COALESCE(l.auction_end_time, l.end_time) <= now()
    ORDER BY COALESCE(l.auction_end_time, l.end_time) ASC
    LIMIT greatest(1, least(COALESCE(p_limit, 50), 500))
  LOOP
    v_one := public.resolve_auction(v_listing_id, true);
    v_results := v_results || jsonb_build_array(v_one);
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'resolved_count', v_count, 'results', v_results);
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_expired_auctions(int) TO service_role;

-- =============================================================================
-- PART 7 — RLS (profiles + listings + bids)
-- =============================================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users_select_self_or_admin" ON public.profiles;
DROP POLICY IF EXISTS "users_insert_own" ON public.profiles;
DROP POLICY IF EXISTS "users_update_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_select_self_or_admin" ON public.profiles;
DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;

CREATE POLICY "profiles_select_self_or_admin" ON public.profiles FOR SELECT
  USING (auth.uid() = id OR public.current_user_is_admin());
CREATE POLICY "profiles_insert_own" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE
  USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

ALTER TABLE public.listings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "listings_select" ON public.listings;
DROP POLICY IF EXISTS "listings_select_active_or_owner" ON public.listings;
DROP POLICY IF EXISTS "listings_insert_own" ON public.listings;
DROP POLICY IF EXISTS "listings_insert_authenticated" ON public.listings;
DROP POLICY IF EXISTS "listings_update_own_or_admin" ON public.listings;
DROP POLICY IF EXISTS "listings_update_owner_or_admin" ON public.listings;

CREATE POLICY "listings_select" ON public.listings FOR SELECT TO authenticated
  USING (
    lower(nullif(trim(moderation_status::text), '')) = 'approved'
    OR lower(nullif(trim(status::text), '')) IN (
      'active',
      'ended',
      'sold',
      'expired',
      'approved'
    )
    OR seller_id = auth.uid()
    OR public.current_user_is_admin()
  );

CREATE POLICY "listings_insert_own" ON public.listings FOR INSERT TO authenticated
  WITH CHECK (seller_id = auth.uid());

CREATE POLICY "listings_update_own_or_admin" ON public.listings FOR UPDATE TO authenticated
  USING (seller_id = auth.uid() OR public.current_user_is_admin())
  WITH CHECK (seller_id = auth.uid() OR public.current_user_is_admin());

ALTER TABLE public.bids ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bids_select_own_or_seller" ON public.bids;
DROP POLICY IF EXISTS "bids_select_visible_listings" ON public.bids;
DROP POLICY IF EXISTS "bids_select_all" ON public.bids;
DROP POLICY IF EXISTS "bids_insert_authenticated" ON public.bids;

CREATE POLICY "bids_select_visible_listings" ON public.bids FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.listings l WHERE l.id = bids.listing_id
      AND (public.current_user_is_admin() OR l.seller_id = auth.uid() OR bids.bidder_id = auth.uid()
        OR lower(nullif(trim(l.moderation_status::text), '')) = 'approved'
        OR lower(nullif(trim(l.status::text), '')) IN ('active', 'ended'))
  ));

-- =============================================================================
-- PART 8 — Optional reporting view (app uses table profiles directly)
-- =============================================================================

CREATE OR REPLACE VIEW public.user_profiles AS
SELECT p.id, p.id AS auth_user_id, p.full_name, p.email, p.phone_number,
  p.cnic AS cnic_number, p.cnic_front_url, p.cnic_back_url,
  COALESCE(p.email_verified, false) AS email_verified, p.created_at
FROM public.profiles p;

GRANT SELECT ON public.user_profiles TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
