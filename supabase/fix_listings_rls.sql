-- =============================================================================
-- Fix: "new row violates row-level security policy for table listings"
-- Run in Supabase SQL Editor (safe, no data loss)
-- =============================================================================

alter table public.listings enable row level security;

drop policy if exists "listings_select" on public.listings;
drop policy if exists "listings_select_active_or_owner" on public.listings;
drop policy if exists "listings_insert_own" on public.listings;
drop policy if exists "listings_insert_authenticated" on public.listings;
drop policy if exists "listings_update_own_or_admin" on public.listings;
drop policy if exists "listings_update_owner_or_admin" on public.listings;

create policy "listings_select" on public.listings
  for select to authenticated
  using (
    lower(nullif(trim(moderation_status::text), '')) = 'approved'
    or lower(nullif(trim(status::text), '')) in (
      'active',
      'ended',
      'sold',
      'expired',
      'approved'
    )
    or seller_id = auth.uid()
    or public.current_user_is_admin()
  );

create policy "listings_insert_own" on public.listings
  for insert to authenticated
  with check (seller_id = auth.uid());

create policy "listings_update_own_or_admin" on public.listings
  for update to authenticated
  using (seller_id = auth.uid() or public.current_user_is_admin())
  with check (seller_id = auth.uid() or public.current_user_is_admin());

notify pgrst, 'reload schema';
