-- =============================================================================
-- Bidify — Fix wallet history: wallet_ledger FK + RLS + listings read for embeds
-- =============================================================================
-- Run once in Supabase Dashboard → SQL Editor.
-- Safe to re-run (idempotent drops + IF NOT EXISTS / DO blocks).
--
-- Fixes:
--   1) FK wallet_ledger.listing_id → listings.id (PostgREST embed + referential integrity)
--   2) RLS: authenticated users can SELECT their own wallet_ledger rows
--   3) RLS: users can read listing title/row when linked from their wallet_ledger
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0) Admin helper (required by policies below; no-op if already deployed)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_user_is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    (SELECT p.role = 'admin' FROM public.profiles p WHERE p.id = auth.uid()),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.current_user_is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_is_admin() TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1) Foreign key: wallet_ledger.listing_id → listings.id
-- ---------------------------------------------------------------------------
-- Null out orphan listing_id values so FK can be applied cleanly.
UPDATE public.wallet_ledger wl
SET listing_id = NULL
WHERE wl.listing_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.listings l WHERE l.id = wl.listing_id
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'wallet_ledger'
      AND c.contype = 'f'
      AND pg_get_constraintdef(c.oid) LIKE '%FOREIGN KEY (listing_id)%REFERENCES listings%'
  ) THEN
    ALTER TABLE public.wallet_ledger
      ADD CONSTRAINT wallet_ledger_listing_id_fkey
      FOREIGN KEY (listing_id)
      REFERENCES public.listings (id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- Helpful index for user history queries (if missing)
CREATE INDEX IF NOT EXISTS wallet_ledger_user_created_idx
  ON public.wallet_ledger (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS wallet_ledger_listing_idx
  ON public.wallet_ledger (listing_id)
  WHERE listing_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2) wallet_ledger — RLS: users read only their own rows
-- ---------------------------------------------------------------------------
ALTER TABLE public.wallet_ledger ENABLE ROW LEVEL SECURITY;

-- Remove stale / duplicate policy names from older migrations
DROP POLICY IF EXISTS wallet_ledger_select_own ON public.wallet_ledger;
DROP POLICY IF EXISTS wallet_ledger_select_admin ON public.wallet_ledger;
DROP POLICY IF EXISTS "wallet_ledger_select_own" ON public.wallet_ledger;
DROP POLICY IF EXISTS wallet_ledger_select_authenticated_own ON public.wallet_ledger;

CREATE POLICY wallet_ledger_select_own
  ON public.wallet_ledger
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR public.current_user_is_admin()
  );

-- Authenticated clients must have table-level SELECT (RLS still filters rows)
GRANT SELECT ON public.wallet_ledger TO authenticated;
GRANT SELECT ON public.wallet_ledger TO service_role;

-- ---------------------------------------------------------------------------
-- 3) listings — allow reading titles for marketplace + wallet-linked rows
-- ---------------------------------------------------------------------------
ALTER TABLE public.listings ENABLE ROW LEVEL SECURITY;

-- Marketplace / seller visibility (aligned with fix_listings_rls.sql)
DROP POLICY IF EXISTS "listings_select" ON public.listings;
DROP POLICY IF EXISTS listings_select ON public.listings;
DROP POLICY IF EXISTS "listings_select_active_or_owner" ON public.listings;

CREATE POLICY "listings_select"
  ON public.listings
  FOR SELECT
  TO authenticated
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

-- Extra policy: read listing row when it appears on YOUR wallet_ledger (embed / join)
DROP POLICY IF EXISTS listings_select_wallet_ledger_linked ON public.listings;

CREATE POLICY listings_select_wallet_ledger_linked
  ON public.listings
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.wallet_ledger wl
      WHERE wl.listing_id = listings.id
        AND wl.user_id = auth.uid()
    )
  );

GRANT SELECT ON public.listings TO authenticated;
GRANT SELECT ON public.listings TO anon;

-- ---------------------------------------------------------------------------
-- 4) Refresh PostgREST schema cache (required after FK / policy changes)
-- ---------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- 5) Quick verification (run manually; optional)
-- ---------------------------------------------------------------------------
-- SELECT policyname, cmd, roles, qual
-- FROM pg_policies
-- WHERE schemaname = 'public' AND tablename IN ('wallet_ledger', 'listings')
-- ORDER BY tablename, policyname;
--
-- As signed-in user in SQL editor (set role) or from app:
-- SELECT count(*) FROM public.wallet_ledger WHERE user_id = auth.uid();
