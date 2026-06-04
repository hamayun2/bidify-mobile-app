-- =============================================================================
-- Bidify — CLEAN SLATE (run entire script in Supabase SQL Editor)
-- WARNING: Drops all app tables and data. Auth users in auth.users are kept.
-- =============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- DROP (dependency order)
-- ---------------------------------------------------------------------------
drop table if exists public.bids cascade;
drop table if exists public.transactions cascade;
drop table if exists public.listings cascade;
drop table if exists public.profiles cascade;
drop table if exists public.wallet_transactions cascade;
drop table if exists public.users cascade;

drop type if exists public.listing_type cascade;
drop type if exists public.listing_status cascade;
drop type if exists public.transaction_kind cascade;

drop function if exists public.handle_new_user() cascade;
drop function if exists public.current_user_is_admin() cascade;
drop function if exists public.auth_email_exists(text) cascade;
drop function if exists public.promote_builtin_admin(text, uuid) cascade;

-- ---------------------------------------------------------------------------
-- ENUMS
-- ---------------------------------------------------------------------------
create type public.listing_type as enum ('auction', 'standard');
create type public.listing_status as enum ('active', 'sold', 'expired');
create type public.transaction_kind as enum (
  'topup',
  'withdrawal',
  'bid_hold',
  'bid_refund',
  'purchase',
  'stripe_topup'
);

-- ---------------------------------------------------------------------------
-- profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  phone_number text,
  cnic_front_url text,
  cnic_back_url text,
  wallet_balance numeric not null default 0 check (wallet_balance >= 0),
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index profiles_email_idx on public.profiles (lower(email));

-- ---------------------------------------------------------------------------
-- listings
-- ---------------------------------------------------------------------------
create table public.listings (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.profiles (id) on delete cascade,
  title text not null,
  description text,
  category text,
  image_url text,
  price numeric not null check (price > 0),
  current_bid numeric,
  listing_type public.listing_type not null default 'standard',
  status public.listing_status not null default 'active',
  auction_end_time timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint auction_end_when_auction check (
    listing_type <> 'auction' or auction_end_time is not null
  )
);

create index listings_seller_id_idx on public.listings (seller_id);
create index listings_status_idx on public.listings (status);
create index listings_type_idx on public.listings (listing_type);
create index listings_active_idx on public.listings (status) where status = 'active';

-- ---------------------------------------------------------------------------
-- bids
-- ---------------------------------------------------------------------------
create table public.bids (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings (id) on delete cascade,
  bidder_id uuid not null references public.profiles (id) on delete cascade,
  bid_amount numeric not null check (bid_amount > 0),
  created_at timestamptz not null default now()
);

create index bids_listing_id_idx on public.bids (listing_id);
create index bids_bidder_id_idx on public.bids (bidder_id);

-- ---------------------------------------------------------------------------
-- transactions (wallet / Stripe history)
-- ---------------------------------------------------------------------------
create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind public.transaction_kind not null,
  amount numeric not null check (amount >= 0),
  currency text not null default 'PKR',
  provider text,
  stripe_payment_id text,
  stripe_session_id text,
  note text,
  balance_after numeric,
  created_at timestamptz not null default now()
);

create index transactions_user_id_idx on public.transactions (user_id);
create index transactions_created_at_idx on public.transactions (created_at desc);

-- ---------------------------------------------------------------------------
-- Admin helper (no RLS recursion)
-- ---------------------------------------------------------------------------
create or replace function public.current_user_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.is_admin from public.profiles p where p.id = auth.uid()),
    false
  );
$$;

revoke all on function public.current_user_is_admin() from public;
grant execute on function public.current_user_is_admin() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Auth signup → auto profile row
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'full_name', '')
  )
  on conflict (id) do update
  set email = excluded.email,
      updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Email exists check (registration step 1)
-- ---------------------------------------------------------------------------
create or replace function public.auth_email_exists(p_email text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from auth.users u
    where lower(coalesce(u.email, '')) = lower(trim(coalesce(p_email, '')))
  );
$$;

revoke all on function public.auth_email_exists(text) from public;
grant execute on function public.auth_email_exists(text) to anon, authenticated;

-- Promote built-in admin
create or replace function public.promote_builtin_admin(p_email text, p_user_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  uid uuid;
  em text := lower(trim(coalesce(p_email, '')));
begin
  if em = '' then return; end if;
  uid := coalesce(
    p_user_id,
    (select u.id from auth.users u where lower(coalesce(u.email, '')) = em limit 1)
  );
  if uid is null then return; end if;
  insert into public.profiles (id, email, full_name, is_admin)
  values (uid, trim(p_email), 'Bidify Admin', true)
  on conflict (id) do update
  set is_admin = true,
      email = excluded.email,
      full_name = coalesce(public.profiles.full_name, excluded.full_name),
      updated_at = now();
end;
$$;

revoke all on function public.promote_builtin_admin(text, uuid) from public;
grant execute on function public.promote_builtin_admin(text, uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS — profiles
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

create policy "profiles_select_own_or_admin"
  on public.profiles for select
  using (auth.uid() = id or public.current_user_is_admin());

create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id and is_admin = false);

create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- RLS — listings
-- ---------------------------------------------------------------------------
alter table public.listings enable row level security;

create policy "listings_select_active_or_owner"
  on public.listings for select
  using (
    status = 'active'
    or seller_id = auth.uid()
    or public.current_user_is_admin()
  );

create policy "listings_insert_authenticated"
  on public.listings for insert
  with check (auth.uid() = seller_id);

create policy "listings_update_owner_or_admin"
  on public.listings for update
  using (seller_id = auth.uid() or public.current_user_is_admin())
  with check (seller_id = auth.uid() or public.current_user_is_admin());

-- ---------------------------------------------------------------------------
-- RLS — bids
-- ---------------------------------------------------------------------------
alter table public.bids enable row level security;

create policy "bids_select_all"
  on public.bids for select
  using (true);

create policy "bids_insert_authenticated"
  on public.bids for insert
  with check (auth.uid() = bidder_id);

-- ---------------------------------------------------------------------------
-- RLS — transactions
-- ---------------------------------------------------------------------------
alter table public.transactions enable row level security;

create policy "transactions_select_own_or_admin"
  on public.transactions for select
  using (auth.uid() = user_id or public.current_user_is_admin());

create policy "transactions_insert_own"
  on public.transactions for insert
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Storage buckets
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
  with check (bucket_id = 'listing_images' and name like auth.uid()::text || '/%');

drop policy if exists "cnic_images_public_read" on storage.objects;
create policy "cnic_images_public_read" on storage.objects
  for select using (bucket_id = 'cnic_images');

drop policy if exists "cnic_images_owner_insert" on storage.objects;
create policy "cnic_images_owner_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'cnic_images' and name like auth.uid()::text || '/%');

-- ---------------------------------------------------------------------------
-- Realtime (Home feed live updates)
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.listings;
alter publication supabase_realtime add table public.bids;

-- ---------------------------------------------------------------------------
-- Place bid (atomic: insert bid + bump listing current_bid)
-- ---------------------------------------------------------------------------
create or replace function public.place_bid(p_listing_id uuid, p_amount numeric)
returns public.bids
language plpgsql
security definer
set search_path = public
as $$
declare
  v_listing public.listings;
  v_bid public.bids;
  v_min numeric;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_listing from public.listings where id = p_listing_id for update;
  if not found then raise exception 'Listing not found'; end if;
  if v_listing.listing_type <> 'auction' then raise exception 'Not an auction listing'; end if;
  if v_listing.status <> 'active' then raise exception 'Auction is not active'; end if;
  if v_listing.auction_end_time is not null and v_listing.auction_end_time < now() then
    raise exception 'Auction has ended';
  end if;

  v_min := coalesce(v_listing.current_bid, v_listing.price);
  if p_amount <= v_min then
    raise exception 'Bid must be higher than current bid';
  end if;

  insert into public.bids (listing_id, bidder_id, bid_amount)
  values (p_listing_id, auth.uid(), p_amount)
  returning * into v_bid;

  update public.listings
  set current_bid = p_amount, updated_at = now()
  where id = p_listing_id;

  return v_bid;
end;
$$;

grant execute on function public.place_bid(uuid, numeric) to authenticated;
