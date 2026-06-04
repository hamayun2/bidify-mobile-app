-- Allow sellers to DELETE their own listings (client-side delete + RLS)
-- Run in Supabase SQL Editor once.

ALTER TABLE public.listings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS listings_delete_own ON public.listings;

CREATE POLICY listings_delete_own
  ON public.listings
  FOR DELETE
  TO authenticated
  USING (seller_id = auth.uid() OR public.current_user_is_admin());

COMMENT ON POLICY listings_delete_own ON public.listings IS
  'Seller may permanently delete own listings; admins may delete any.';

NOTIFY pgrst, 'reload schema';
