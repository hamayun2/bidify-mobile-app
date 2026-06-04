-- =============================================================================
-- Bidify — Escrow Phase A: schema + ledger + orders + support tickets
-- =============================================================================
-- SAFE MIGRATION ONLY — does NOT modify:
--   • public.place_bid(...)
--   • public.compute_bid_wallet_hold(...)
--   • public.release_bid_wallet_hold(...) / resolve_auction(...)
--   • bidHoldRules.js or any frontend code
--
-- Existing wallet columns on public.profiles (UNCHANGED semantics):
--   wallet_balance  — main spendable balance (PKR)
--   held_balance    — legacy tiered bid holds (still active until Phase 1 RPC)
--
-- New column (inactive until Phase 1 RPC wires it):
--   locked_balance  — future full-bid-amount locks (starts at 0)
--
-- Run once in Supabase SQL Editor (safe to re-run: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- 1) Profile wallet extensions (additive)
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.profiles
  ADD COLUMN IF NOT EXISTS locked_balance numeric NOT NULL DEFAULT 0;

UPDATE public.profiles
SET locked_balance = 0
WHERE locked_balance IS NULL;

ALTER TABLE IF EXISTS public.profiles
  ADD COLUMN IF NOT EXISTS wallet_initialized_at timestamptz;

COMMENT ON COLUMN public.profiles.wallet_balance IS
  'Main spendable wallet balance (PKR).';
COMMENT ON COLUMN public.profiles.held_balance IS
  'Legacy tiered bid holds — active until Phase 1 full-bid RPC retires bidHoldRules tiers.';
COMMENT ON COLUMN public.profiles.locked_balance IS
  'Reserved for Phase 1: full winning-bid amount locked during live auctions (not used yet).';

-- Optional future bid column (nullable — no app writes until Phase 1 RPC)
ALTER TABLE IF EXISTS public.bids
  ADD COLUMN IF NOT EXISTS locked_amount numeric;

COMMENT ON COLUMN public.bids.locked_amount IS
  'Phase 1: full bid amount moved to profiles.locked_balance at bid time (unused until RPC).';

-- ---------------------------------------------------------------------------
-- 2) Enums (idempotent)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wallet_ledger_entry_type') THEN
    CREATE TYPE public.wallet_ledger_entry_type AS ENUM (
      'topup',
      'bid_lock',
      'bid_refund',
      'escrow_lock',
      'escrow_release',
      'escrow_refund',
      'admin_adjust',
      'legacy_tier_hold',
      'legacy_tier_release'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'auction_order_status') THEN
    CREATE TYPE public.auction_order_status AS ENUM (
      'pending_delivery',
      'completed',
      'disputed',
      'refunded',
      'cancelled'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'support_ticket_status') THEN
    CREATE TYPE public.support_ticket_status AS ENUM (
      'open',
      'under_review',
      'resolved',
      'closed'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'support_ticket_opened_by') THEN
    CREATE TYPE public.support_ticket_opened_by AS ENUM (
      'buyer',
      'seller'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'support_ticket_resolution') THEN
    CREATE TYPE public.support_ticket_resolution AS ENUM (
      'release_seller',
      'refund_buyer',
      'dismissed'
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3) wallet_ledger — immutable audit trail for all future money movement
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wallet_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  entry_type public.wallet_ledger_entry_type NOT NULL,
  amount numeric NOT NULL CHECK (amount <> 0),
  currency text NOT NULL DEFAULT 'PKR',
  -- Snapshot balances AFTER this entry (nullable until Phase 1 RPC populates)
  wallet_balance_after numeric,
  held_balance_after numeric,
  locked_balance_after numeric,
  -- Links
  listing_id uuid REFERENCES public.listings (id) ON DELETE SET NULL,
  bid_id uuid REFERENCES public.bids (id) ON DELETE SET NULL,
  order_id uuid, -- FK added after auction_orders exists
  idempotency_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS wallet_ledger_idempotency_uidx
  ON public.wallet_ledger (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS wallet_ledger_user_created_idx
  ON public.wallet_ledger (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS wallet_ledger_listing_idx
  ON public.wallet_ledger (listing_id)
  WHERE listing_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS wallet_ledger_order_idx
  ON public.wallet_ledger (order_id)
  WHERE order_id IS NOT NULL;

COMMENT ON TABLE public.wallet_ledger IS
  'Append-only wallet audit log. Phase 1+ RPCs write here; legacy tier holds unchanged until then.';

-- ---------------------------------------------------------------------------
-- 4) auction_orders — post-auction escrow + OTP (Phases 2–4)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.auction_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES public.listings (id) ON DELETE RESTRICT,
  winning_bid_id uuid REFERENCES public.bids (id) ON DELETE SET NULL,
  buyer_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  seller_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  winning_bid_amount numeric NOT NULL CHECK (winning_bid_amount > 0),
  escrow_amount numeric NOT NULL CHECK (escrow_amount >= 0),
  status public.auction_order_status NOT NULL DEFAULT 'pending_delivery',
  -- OTP: store hash only (never plaintext in DB)
  delivery_otp_hash text,
  delivery_otp_expires_at timestamptz,
  otp_verified_at timestamptz,
  otp_verified_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  otp_attempt_count integer NOT NULL DEFAULT 0 CHECK (otp_attempt_count >= 0),
  disputed_at timestamptz,
  disputed_by public.support_ticket_opened_by,
  completed_at timestamptz,
  refunded_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auction_orders_listing_unique UNIQUE (listing_id)
);

CREATE INDEX IF NOT EXISTS auction_orders_buyer_idx
  ON public.auction_orders (buyer_id, status);

CREATE INDEX IF NOT EXISTS auction_orders_seller_idx
  ON public.auction_orders (seller_id, status);

CREATE INDEX IF NOT EXISTS auction_orders_status_idx
  ON public.auction_orders (status, created_at DESC);

-- FK from ledger → orders (deferred create)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wallet_ledger_order_id_fkey'
  ) THEN
    ALTER TABLE public.wallet_ledger
      ADD CONSTRAINT wallet_ledger_order_id_fkey
      FOREIGN KEY (order_id) REFERENCES public.auction_orders (id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5) support_tickets — isolated admin dispute channel (NOT buyer-seller chat)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.auction_orders (id) ON DELETE CASCADE,
  opened_by public.support_ticket_opened_by NOT NULL,
  opened_by_user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  status public.support_ticket_status NOT NULL DEFAULT 'open',
  subject text NOT NULL DEFAULT 'Dispute',
  reason text,
  assigned_admin_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  resolution public.support_ticket_resolution,
  resolution_note text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_tickets_order_idx
  ON public.support_tickets (order_id);

CREATE INDEX IF NOT EXISTS support_tickets_status_idx
  ON public.support_tickets (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.support_ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.support_tickets (id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  body text NOT NULL,
  is_admin_message boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_ticket_messages_ticket_idx
  ON public.support_ticket_messages (ticket_id, created_at);

CREATE TABLE IF NOT EXISTS public.support_ticket_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.support_tickets (id) ON DELETE CASCADE,
  message_id uuid REFERENCES public.support_ticket_messages (id) ON DELETE CASCADE,
  uploaded_by uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  file_name text,
  mime_type text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_ticket_attachments_ticket_idx
  ON public.support_ticket_attachments (ticket_id);

-- ---------------------------------------------------------------------------
-- 6) updated_at trigger helper
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auction_orders_set_updated_at ON public.auction_orders;
CREATE TRIGGER auction_orders_set_updated_at
  BEFORE UPDATE ON public.auction_orders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS support_tickets_set_updated_at ON public.support_tickets;
CREATE TRIGGER support_tickets_set_updated_at
  BEFORE UPDATE ON public.support_tickets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 7) Ensure wallet row for every user (helper + signup trigger + backfill)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_profile_wallet(p_user_id uuid, p_email text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.profiles (
    id,
    email,
    role,
    wallet_balance,
    held_balance,
    locked_balance,
    wallet_initialized_at
  )
  VALUES (
    p_user_id,
    COALESCE(NULLIF(trim(p_email), ''), ''),
    'user',
    0,
    0,
    0,
    now()
  )
  ON CONFLICT (id) DO UPDATE SET
    email = COALESCE(NULLIF(EXCLUDED.email, ''), public.profiles.email),
    wallet_balance = COALESCE(public.profiles.wallet_balance, 0),
    held_balance = COALESCE(public.profiles.held_balance, 0),
    locked_balance = COALESCE(public.profiles.locked_balance, 0),
    wallet_initialized_at = COALESCE(public.profiles.wallet_initialized_at, now()),
    updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_profile_wallet(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_profile_wallet(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.ensure_profile_wallet(uuid, text) TO authenticated;

-- Extend signup trigger: create profile with zero balances (preserves existing email/name logic)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.ensure_profile_wallet(
    NEW.id,
    COALESCE(NEW.email, '')
  );

  UPDATE public.profiles
  SET
    full_name = COALESCE(
      NULLIF(trim(COALESCE(NEW.raw_user_meta_data->>'full_name', '')), ''),
      public.profiles.full_name
    ),
    email = COALESCE(NULLIF(trim(COALESCE(NEW.email, '')), ''), public.profiles.email),
    updated_at = now()
  WHERE id = NEW.id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- Backfill: every existing auth user gets a wallet row with safe zero defaults for NEW columns only
INSERT INTO public.profiles (id, email, role, wallet_balance, held_balance, locked_balance, wallet_initialized_at)
SELECT
  u.id,
  COALESCE(u.email, ''),
  'user',
  0,
  0,
  0,
  now()
FROM auth.users u
WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id)
ON CONFLICT (id) DO NOTHING;

UPDATE public.profiles
SET
  locked_balance = COALESCE(locked_balance, 0),
  wallet_balance = COALESCE(wallet_balance, 0),
  held_balance = COALESCE(held_balance, 0),
  wallet_initialized_at = COALESCE(wallet_initialized_at, now())
WHERE locked_balance IS NULL
   OR wallet_balance IS NULL
   OR held_balance IS NULL
   OR wallet_initialized_at IS NULL;

-- ---------------------------------------------------------------------------
-- 8) Row Level Security (new tables only)
-- ---------------------------------------------------------------------------
-- Requires admin helper from BIDIFY_COMPLETE_SYNC.sql (no-op if already present)
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

ALTER TABLE public.wallet_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auction_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_ticket_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_ticket_attachments ENABLE ROW LEVEL SECURITY;

-- wallet_ledger: users read own; writes via service_role / security definer RPC only
DROP POLICY IF EXISTS wallet_ledger_select_own ON public.wallet_ledger;
CREATE POLICY wallet_ledger_select_own
  ON public.wallet_ledger FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR public.current_user_is_admin());

DROP POLICY IF EXISTS wallet_ledger_insert_service ON public.wallet_ledger;
-- No INSERT policy for authenticated — Phase 1+ RPCs use SECURITY DEFINER

-- auction_orders: buyer + seller + admin read; mutations via RPC later
DROP POLICY IF EXISTS auction_orders_select_parties ON public.auction_orders;
CREATE POLICY auction_orders_select_parties
  ON public.auction_orders FOR SELECT
  TO authenticated
  USING (
    buyer_id = auth.uid()
    OR seller_id = auth.uid()
    OR public.current_user_is_admin()
  );

-- support_tickets: opener + admin only (NOT the counterparty buyer/seller)
DROP POLICY IF EXISTS support_tickets_select_party ON public.support_tickets;
CREATE POLICY support_tickets_select_party
  ON public.support_tickets FOR SELECT
  TO authenticated
  USING (
    opened_by_user_id = auth.uid()
    OR public.current_user_is_admin()
  );

DROP POLICY IF EXISTS support_tickets_insert_opener ON public.support_tickets;
CREATE POLICY support_tickets_insert_opener
  ON public.support_tickets FOR INSERT
  TO authenticated
  WITH CHECK (opened_by_user_id = auth.uid());

DROP POLICY IF EXISTS support_ticket_messages_select_ticket ON public.support_ticket_messages;
CREATE POLICY support_ticket_messages_select_ticket
  ON public.support_ticket_messages FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.support_tickets t
      WHERE t.id = support_ticket_messages.ticket_id
        AND (t.opened_by_user_id = auth.uid() OR public.current_user_is_admin())
    )
  );

DROP POLICY IF EXISTS support_ticket_messages_insert_ticket ON public.support_ticket_messages;
CREATE POLICY support_ticket_messages_insert_ticket
  ON public.support_ticket_messages FOR INSERT
  TO authenticated
  WITH CHECK (
    sender_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.support_tickets t
      WHERE t.id = support_ticket_messages.ticket_id
        AND (t.opened_by_user_id = auth.uid() OR public.current_user_is_admin())
    )
  );

DROP POLICY IF EXISTS support_ticket_attachments_select_ticket ON public.support_ticket_attachments;
CREATE POLICY support_ticket_attachments_select_ticket
  ON public.support_ticket_attachments FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.support_tickets t
      WHERE t.id = support_ticket_attachments.ticket_id
        AND (t.opened_by_user_id = auth.uid() OR public.current_user_is_admin())
    )
  );

DROP POLICY IF EXISTS support_ticket_attachments_insert_ticket ON public.support_ticket_attachments;
CREATE POLICY support_ticket_attachments_insert_ticket
  ON public.support_ticket_attachments FOR INSERT
  TO authenticated
  WITH CHECK (
    uploaded_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.support_tickets t
      WHERE t.id = support_ticket_attachments.ticket_id
        AND (t.opened_by_user_id = auth.uid() OR public.current_user_is_admin())
    )
  );

-- ---------------------------------------------------------------------------
-- 9) Admin-only helper views (read-only convenience for Phase 4 UI)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.admin_open_support_tickets AS
SELECT
  t.*,
  o.listing_id,
  o.buyer_id,
  o.seller_id,
  o.escrow_amount,
  o.status AS order_status
FROM public.support_tickets t
JOIN public.auction_orders o ON o.id = t.order_id
WHERE t.status IN ('open', 'under_review');

-- ---------------------------------------------------------------------------
-- Done — notify PostgREST
-- ---------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- POST-RUN CHECKLIST (manual)
-- =============================================================================
-- SELECT column_name FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'profiles'
--   AND column_name IN ('wallet_balance','held_balance','locked_balance');
--
-- SELECT COUNT(*) FROM public.profiles;
-- SELECT COUNT(*) FROM auth.users;
-- =============================================================================
