-- Accurate public seller ad count (bypasses RLS for COUNT only).
-- Run in Supabase SQL Editor, then: NOTIFY pgrst, 'reload schema';

CREATE OR REPLACE FUNCTION public.count_seller_listings(p_seller_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::bigint
  FROM public.listings
  WHERE seller_id = p_seller_id;
$$;

COMMENT ON FUNCTION public.count_seller_listings(uuid) IS
  'Total listings published by seller (all statuses). Used on seller profile card.';

GRANT EXECUTE ON FUNCTION public.count_seller_listings(uuid) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
