-- =============================================================================
-- Fix: auction_orders SELECT RLS (idempotent — safe if policies already exist)
-- Run in Supabase SQL Editor as postgres / service role.
-- After run: NOTIFY pgrst, 'reload schema';
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0) Inspect current policies (read-only; check Results tab)
-- ---------------------------------------------------------------------------
SELECT
  policyname,
  cmd,
  permissive,
  roles,
  qual AS using_expression,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'auction_orders'
ORDER BY policyname;

-- ---------------------------------------------------------------------------
-- 1) Drop ALL existing SELECT / ALL policies on auction_orders (fixes 42710)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'auction_orders'
      AND (cmd = 'SELECT' OR cmd = 'ALL')
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.auction_orders',
      pol.policyname
    );
    RAISE NOTICE 'Dropped policy: %', pol.policyname;
  END LOOP;
END $$;

-- Known names (in case pg_policies catalog is stale)
DROP POLICY IF EXISTS auction_orders_select_parties ON public.auction_orders;
DROP POLICY IF EXISTS "auction_orders_select_parties" ON public.auction_orders;
DROP POLICY IF EXISTS auction_orders_select_admin ON public.auction_orders;
DROP POLICY IF EXISTS auction_orders_select_own ON public.auction_orders;
DROP POLICY IF EXISTS auction_orders_select_buyer ON public.auction_orders;
DROP POLICY IF EXISTS auction_orders_select_seller ON public.auction_orders;

ALTER TABLE public.auction_orders ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2) Buyer + seller can SELECT their orders (required for My Orders app)
-- ---------------------------------------------------------------------------
CREATE POLICY auction_orders_select_parties
  ON public.auction_orders
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() = buyer_id
    OR auth.uid() = seller_id
  );

-- ---------------------------------------------------------------------------
-- 3) Admins can SELECT all orders (optional; needs current_user_is_admin())
-- ---------------------------------------------------------------------------
CREATE POLICY auction_orders_select_admin
  ON public.auction_orders
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (coalesce(public.current_user_is_admin(), false));

-- ---------------------------------------------------------------------------
-- 4) Table grants (anon key + JWT must use role authenticated)
-- ---------------------------------------------------------------------------
GRANT SELECT ON public.auction_orders TO authenticated;
GRANT SELECT ON public.auction_orders TO service_role;

-- ---------------------------------------------------------------------------
-- 5) listings: buyer/seller on an order can read listing for order cards
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS listings_select_order_party ON public.listings;

CREATE POLICY listings_select_order_party
  ON public.listings
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.auction_orders o
      WHERE o.listing_id = listings.id
        AND (auth.uid() = o.buyer_id OR auth.uid() = o.seller_id)
    )
  );

GRANT SELECT ON public.listings TO authenticated;

-- ---------------------------------------------------------------------------
-- 6) Verify policies were recreated
-- ---------------------------------------------------------------------------
SELECT
  policyname,
  cmd,
  permissive,
  qual AS using_expression
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'auction_orders'
ORDER BY policyname;

NOTIFY pgrst, 'reload schema';
