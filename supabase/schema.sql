-- Run this in Supabase → SQL Editor (once per project).
-- Then create buckets listing_images (public) and cnic_images (private) if not inserted below.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- public.profiles — profile row keyed by auth.users.id (profileService.js)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  username text,
  phone_number text,
  cnic text,
  cnic_front_url text,
  cnic_back_url text,
  cnic_verified_at timestamptz,
  role text not null default 'user' check (role in ('user', 'admin')),
  profile_completed boolean not null default false,
  profile_image text,
  email_verified boolean not null default false,
  wallet_balance numeric not null default 0,
  held_balance numeric not null default 0,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create or replace function public.current_user_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select (p.role = 'admin' or p.is_admin = true) from public.profiles p where p.id = auth.uid()),
    false
  );
$$;

revoke all on function public.current_user_is_admin() from public;
grant execute on function public.current_user_is_admin() to anon, authenticated;

drop policy if exists "profiles_select_self_or_admin" on public.profiles;
create policy "profiles_select_self_or_admin" on public.profiles
  for select using (auth.uid() = id or public.current_user_is_admin());

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id and role = 'user');

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- public.listings
-- ---------------------------------------------------------------------------
create table if not exists public.listings (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  description text,
  price numeric not null,
  type text not null check (type in ('auction', 'standard')),
  category text,
  duration_days int,
  buy_now_price numeric,
  image_urls jsonb not null default '[]'::jsonb,
  moderation_status text not null default 'pending',
  current_bid numeric,
  end_time timestamptz,
  seller_name text,
  user_email text,
  username text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  rejection_reason text,
  rejected_at timestamptz,
  approved_at timestamptz
);

create index if not exists listings_seller_id_idx on public.listings (seller_id);
create index if not exists listings_moderation_idx on public.listings (moderation_status);

alter table public.listings enable row level security;

drop policy if exists "listings_select" on public.listings;
create policy "listings_select" on public.listings
  for select using (
    moderation_status = 'approved'
    or seller_id = auth.uid()
    or public.current_user_is_admin()
  );

drop policy if exists "listings_insert_own" on public.listings;
create policy "listings_insert_own" on public.listings
  for insert with check (seller_id = auth.uid());

drop policy if exists "listings_update_own_or_admin" on public.listings;
create policy "listings_update_own_or_admin" on public.listings
  for update
  using (
    seller_id = auth.uid()
    or public.current_user_is_admin()
  )
  with check (
    seller_id = auth.uid()
    or public.current_user_is_admin()
  );

-- ---------------------------------------------------------------------------
-- Storage buckets + policies
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('listing_images', 'listing_images', true)
on conflict (id) do update set public = excluded.public;

insert into storage.buckets (id, name, public)
values ('cnic_images', 'cnic_images', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists "listing_images_public_read" on storage.objects;
create policy "listing_images_public_read" on storage.objects
  for select using (bucket_id = 'listing_images');

drop policy if exists "listing_images_auth_insert" on storage.objects;
create policy "listing_images_auth_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'listing_images'
    and name like auth.uid()::text || '/%'
  );

drop policy if exists "cnic_images_public_read" on storage.objects;
create policy "cnic_images_public_read" on storage.objects
  for select using (bucket_id = 'cnic_images');

drop policy if exists "cnic_images_owner_insert" on storage.objects;
create policy "cnic_images_owner_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'cnic_images'
    and name like auth.uid()::text || '/%'
  );

drop policy if exists "cnic_images_owner_update" on storage.objects;
create policy "cnic_images_owner_update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'cnic_images'
    and name like auth.uid()::text || '/%'
  );

-- Idempotent column adds (safe if you already ran an older version of this file)
alter table public.listings add column if not exists rejection_reason text;
alter table public.listings add column if not exists rejected_at timestamptz;
alter table public.listings add column if not exists approved_at timestamptz;

-- ---------------------------------------------------------------------------
-- Pre-check: email already present in auth.users (Register step 1, before CNIC).
-- SECURITY DEFINER exposes only a boolean; run once in SQL Editor after deploy.
-- ---------------------------------------------------------------------------
create or replace function public.auth_email_exists(p_email text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from auth.users u
    where lower(coalesce(u.email, '')) = lower(trim(coalesce(p_email, '')))
  );
$$;

revoke all on function public.auth_email_exists(text) from public;
grant execute on function public.auth_email_exists(text) to anon;
grant execute on function public.auth_email_exists(text) to authenticated;
