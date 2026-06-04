-- =============================================================================
-- Ended auctions remain readable in the marketplace feed (no row deletes).
-- Run once in Supabase SQL Editor after fix_listings_rls.sql / BIDIFY_COMPLETE_SYNC.
-- =============================================================================

ALTER TABLE public.listings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "listings_select" ON public.listings;
DROP POLICY IF EXISTS "listings_select_active_or_owner" ON public.listings;

CREATE POLICY "listings_select" ON public.listings
  FOR SELECT TO authenticated
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

NOTIFY pgrst, 'reload schema';
