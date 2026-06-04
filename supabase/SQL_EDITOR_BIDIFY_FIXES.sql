-- =============================================================================
-- DEPRECATED — use supabase/BIDIFY_COMPLETE_SYNC.sql instead.
-- Bidify — Supabase SQL Editor (legacy)
-- =============================================================================
--
-- MANUAL (Dashboard) — email verify tak login band:
--   1) Supabase → Authentication → Providers → Email
--   2) "Confirm email" ON rakhein (recommended).
--   3) Auth hooks: agar "Confirm email" OFF hai to bhi app ab unverified session
--      ko sign-out karti hai; lekin best practice = ON.
--
-- =============================================================================
-- A) public.users table + RLS (agar pehle se nahi chalaya)
-- =============================================================================
-- Poora schema: isi repo mein `supabase/schema.sql` file ko SQL Editor mein
-- ek dafa run karein. Neeche sirf zaroori tukre hain agar table pehle maujood ho.

create extension if not exists "pgcrypto";

create table if not exists public.users (
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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.users enable row level security;

-- Admin helper (recursion-safe) — schema.sql jaisa
create or replace function public.current_user_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select u.role = 'admin' from public.users u where u.id = auth.uid()),
    false
  );
$$;

revoke all on function public.current_user_is_admin() from public;
grant execute on function public.current_user_is_admin() to anon, authenticated;

drop policy if exists "users_select_self_or_admin" on public.users;
create policy "users_select_self_or_admin" on public.users
  for select using (auth.uid() = id or public.current_user_is_admin());

drop policy if exists "users_insert_own" on public.users;
create policy "users_insert_own" on public.users
  for insert with check (auth.uid() = id and role = 'user');

drop policy if exists "users_update_own" on public.users;
create policy "users_update_own" on public.users
  for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- =============================================================================
-- B) Storage: cnic_images bucket PUBLIC (taake URL browser / Table editor mein khule)
-- =============================================================================
-- Agar bucket "Private" hai to getPublicUrl() ka link bina auth 403 de sakta hai.

insert into storage.buckets (id, name, public)
values ('cnic_images', 'cnic_images', true)
on conflict (id) do update set public = excluded.public;

-- Public read (anon + authenticated) for listing URLs in dashboard
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

-- =============================================================================
-- C) Register pe email check RPC (agar missing ho)
-- =============================================================================
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
