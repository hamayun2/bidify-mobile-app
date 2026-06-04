-- Dynamic seller ad count on profiles (synced from listings table).
-- Run in Supabase SQL Editor after seller_listings_count.sql

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS total_ads integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.profiles.total_ads IS
  'Cached count of listings.seller_id = profiles.id; kept in sync via trigger/RPC.';

CREATE OR REPLACE FUNCTION public.sync_profile_total_ads(p_seller_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_seller_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT COUNT(*)::integer
  INTO v_count
  FROM public.listings
  WHERE seller_id = p_seller_id;

  UPDATE public.profiles
  SET total_ads = COALESCE(v_count, 0)
  WHERE id = p_seller_id;

  RETURN COALESCE(v_count, 0);
END;
$$;

COMMENT ON FUNCTION public.sync_profile_total_ads(uuid) IS
  'Recompute profiles.total_ads from listings COUNT for one seller.';

GRANT EXECUTE ON FUNCTION public.sync_profile_total_ads(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trg_listings_sync_profile_total_ads()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.seller_id IS NOT NULL THEN
    PERFORM public.sync_profile_total_ads(OLD.seller_id);
  ELSIF TG_OP = 'INSERT' AND NEW.seller_id IS NOT NULL THEN
    PERFORM public.sync_profile_total_ads(NEW.seller_id);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS listings_sync_profile_total_ads ON public.listings;
CREATE TRIGGER listings_sync_profile_total_ads
  AFTER INSERT OR DELETE ON public.listings
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_listings_sync_profile_total_ads();

NOTIFY pgrst, 'reload schema';
