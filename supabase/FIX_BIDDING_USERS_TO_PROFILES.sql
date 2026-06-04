-- =============================================================================
-- Bidify — COMPLETE FIX: public.users → public.profiles (bidding + views)
-- =============================================================================
-- Run once in Supabase → SQL Editor when Place Bid fails with:
--   relation "public.users" does not exist
--
-- Fixes:
--   • DROP broken public.user_profiles view (was SELECT … FROM public.users)
--   • Recreate view over public.profiles
--   • current_user_is_admin, promote_builtin_admin, handle_new_user (auth trigger)
--   • place_bid + escrow/hold helpers (profiles only — zero public.users refs)
--   • resolve_auction / resolve_expired_auctions
--
-- Hold tiers (PKR): bid >10k→2000, >5k→1000, >1k→500, else 0
-- =============================================================================

create extension if not exists "pgcrypto";

-- =============================================================================
-- 1) Broken compatibility view (often breaks PostgREST / RPC chain)
-- =============================================================================
alter table if exists public.profiles add column if not exists phone_number text;
alter table if exists public.profiles add column if not exists cnic text;
alter table if exists public.profiles add column if not exists cnic_front_url text;
alter table if exists public.profiles add column if not exists cnic_back_url text;
alter table if exists public.profiles add column if not exists email_verified boolean not null default false;
alter table if exists public.profiles add column if not exists created_at timestamptz not null default now();

drop view if exists public.user_profiles cascade;

create view public.user_profiles
with (security_invoker = true)
as
select
  p.id,
  p.id as auth_user_id,
  p.full_name,
  p.email,
  p.phone_number,
  p.cnic as cnic_number,
  p.cnic_front_url,
  p.cnic_back_url,
  coalesce(p.email_verified, false) as email_verified,
  p.created_at
from public.profiles p;

comment on view public.user_profiles is
  'Read-only projection of public.profiles (replaces legacy public.users view).';

grant select on public.user_profiles to authenticated;
grant select on public.user_profiles to service_role;

-- =============================================================================
-- 2) Shared helpers — must use public.profiles (never public.users)
-- =============================================================================
create or replace function public.current_user_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.role = 'admin' from public.profiles p where p.id = auth.uid()),
    false
  );
$$;

revoke all on function public.current_user_is_admin() from public;
grant execute on function public.current_user_is_admin() to anon, authenticated;

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
  if em = '' then
    return;
  end if;

  uid := coalesce(
    p_user_id,
    (select u.id from auth.users u where lower(coalesce(u.email, '')) = em limit 1)
  );

  if uid is null then
    return;
  end if;

  insert into public.profiles (
    id,
    email,
    full_name,
    username,
    role,
    profile_completed,
    email_verified,
    wallet_balance
  )
  values (
    uid,
    trim(p_email),
    'Bidify Admin',
    'bidify_admin',
    'admin',
    true,
    true,
    0
  )
  on conflict (id) do update
  set
    role = 'admin',
    email = excluded.email,
    full_name = coalesce(public.profiles.full_name, excluded.full_name),
    email_verified = true,
    updated_at = now();
end;
$$;

revoke all on function public.promote_builtin_admin(text, uuid) from public;
grant execute on function public.promote_builtin_admin(text, uuid) to anon, authenticated, service_role;

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
  set
    email = excluded.email,
    updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =============================================================================
-- 3) Schema — wallet + escrow columns
-- =============================================================================
alter table if exists public.profiles add column if not exists wallet_balance numeric not null default 0;
alter table if exists public.profiles add column if not exists held_balance numeric not null default 0;
alter table if exists public.profiles add column if not exists updated_at timestamptz default now();
update public.profiles set wallet_balance = 0 where wallet_balance is null;
update public.profiles set held_balance = 0 where held_balance is null;

alter table if exists public.listings add column if not exists auction_resolved_at timestamptz;
alter table if exists public.listings add column if not exists winner_bidder_id uuid;
alter table if exists public.listings add column if not exists winning_bid_id uuid;

alter table if exists public.bids add column if not exists bid_amount numeric;
alter table if exists public.bids add column if not exists amount numeric;
alter table if exists public.bids add column if not exists bidder_display_name text;
alter table if exists public.bids add column if not exists wallet_hold_applied numeric not null default 0;
alter table if exists public.bids add column if not exists wallet_hold_released_at timestamptz;

update public.bids set bid_amount = amount where bid_amount is null and amount is not null;
update public.bids set amount = bid_amount where amount is null and bid_amount is not null;

-- =============================================================================
-- 4) Hold tier
-- =============================================================================
create or replace function public.compute_bid_wallet_hold(p_amount numeric)
returns numeric
language sql
immutable
as $$
  select case
    when coalesce(p_amount, 0) > 10000 then 2000::numeric
    when coalesce(p_amount, 0) > 5000 then 1000::numeric
    when coalesce(p_amount, 0) > 1000 then 500::numeric
    else 0::numeric
  end;
$$;

revoke all on function public.compute_bid_wallet_hold(numeric) from public;
grant execute on function public.compute_bid_wallet_hold(numeric) to authenticated, service_role;

-- =============================================================================
-- 5) Escrow release (public.profiles only)
-- =============================================================================
create or replace function public.release_bid_wallet_hold(p_bid_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bid public.bids;
  v_hold numeric;
  v_release numeric;
begin
  select * into v_bid from public.bids b where b.id = p_bid_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'bid_not_found');
  end if;

  if v_bid.wallet_hold_released_at is not null then
    return jsonb_build_object('ok', true, 'skipped', true, 'bid_id', p_bid_id);
  end if;

  v_hold := coalesce(v_bid.wallet_hold_applied, 0);
  if v_hold <= 0 then
    update public.bids set wallet_hold_released_at = now() where id = p_bid_id;
    return jsonb_build_object('ok', true, 'released', 0, 'bid_id', p_bid_id);
  end if;

  select least(v_hold, coalesce(p.held_balance, 0))
  into v_release
  from public.profiles p
  where p.id = v_bid.bidder_id
  for update;

  if not found then
    raise exception 'Bidder profile not found for bid % (public.profiles)', p_bid_id;
  end if;

  v_release := coalesce(v_release, 0);
  if v_release > 0 then
    update public.profiles pr
    set
      held_balance = greatest(0, coalesce(pr.held_balance, 0) - v_release),
      wallet_balance = coalesce(pr.wallet_balance, 0) + v_release,
      updated_at = now()
    where pr.id = v_bid.bidder_id;
  end if;

  update public.bids set wallet_hold_released_at = now() where id = p_bid_id;

  return jsonb_build_object(
    'ok', true,
    'bid_id', p_bid_id,
    'bidder_id', v_bid.bidder_id,
    'released', v_release,
    'requested', v_hold
  );
end;
$$;

revoke all on function public.release_bid_wallet_hold(uuid) from public;
grant execute on function public.release_bid_wallet_hold(uuid) to service_role;

create or replace function public.release_bidder_listing_holds(
  p_listing_id uuid,
  p_bidder_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bid_id uuid;
  v_total numeric := 0;
  v_one jsonb;
  v_results jsonb := '[]'::jsonb;
begin
  for v_bid_id in
    select b.id
    from public.bids b
    where b.listing_id = p_listing_id
      and b.bidder_id = p_bidder_id
      and b.wallet_hold_released_at is null
      and coalesce(b.wallet_hold_applied, 0) > 0
    order by b.created_at asc
    for update of b
  loop
    v_one := public.release_bid_wallet_hold(v_bid_id);
    v_results := v_results || jsonb_build_array(v_one);
    v_total := v_total + coalesce((v_one->>'released')::numeric, 0);
  end loop;

  return jsonb_build_object(
    'ok', true,
    'listing_id', p_listing_id,
    'bidder_id', p_bidder_id,
    'total_released', v_total,
    'details', v_results
  );
end;
$$;

revoke all on function public.release_bidder_listing_holds(uuid, uuid) from public;
grant execute on function public.release_bidder_listing_holds(uuid, uuid) to service_role;

-- =============================================================================
-- 6) Auction resolution
-- =============================================================================
create or replace function public.resolve_auction(
  p_listing_id uuid,
  p_force boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_listing public.listings;
  v_end timestamptz;
  v_kind text;
  v_win_bid public.bids;
  v_win_amount numeric;
  v_bid_id uuid;
  v_released_count int := 0;
  v_released_total numeric := 0;
  v_one jsonb;
  v_caller uuid := auth.uid();
begin
  select * into v_listing from public.listings l where l.id = p_listing_id for update;
  if not found then
    raise exception 'Listing not found';
  end if;

  if v_listing.auction_resolved_at is not null then
    return jsonb_build_object(
      'ok', true,
      'already_resolved', true,
      'listing_id', p_listing_id,
      'resolved_at', v_listing.auction_resolved_at
    );
  end if;

  v_kind := lower(nullif(trim(coalesce(v_listing.listing_type::text, v_listing.type::text)), ''));
  if v_kind is distinct from 'auction' then
    raise exception 'Not an auction listing';
  end if;

  v_end := coalesce(v_listing.auction_end_time, v_listing.end_time);
  if not p_force and v_end is not null and v_end > now() then
    raise exception 'Auction has not ended yet';
  end if;

  if not p_force and v_caller is not null then
    if v_caller is distinct from v_listing.seller_id
       and not public.current_user_is_admin()
       and not exists (
         select 1 from public.bids b
         where b.listing_id = p_listing_id and b.bidder_id = v_caller
       ) then
      raise exception 'Not allowed to resolve this auction';
    end if;
  end if;

  select b.*
  into v_win_bid
  from public.bids b
  where b.listing_id = p_listing_id
  order by
    coalesce(b.bid_amount, b.amount) desc nulls last,
    b.created_at desc
  limit 1;

  if v_win_bid.id is not null then
    v_win_amount := coalesce(v_win_bid.bid_amount, v_win_bid.amount);
  end if;

  for v_bid_id in
    select b.id
    from public.bids b
    where b.listing_id = p_listing_id
      and b.wallet_hold_released_at is null
      and coalesce(b.wallet_hold_applied, 0) > 0
      and (v_win_bid.id is null or b.id is distinct from v_win_bid.id)
    order by b.created_at asc
    for update of b
  loop
    v_one := public.release_bid_wallet_hold(v_bid_id);
    v_released_count := v_released_count + 1;
    v_released_total := v_released_total + coalesce((v_one->>'released')::numeric, 0);
  end loop;

  update public.listings
  set
    status = case
      when lower(nullif(trim(status::text), '')) in ('sold', 'ended') then status
      else 'ended'
    end,
    auction_resolved_at = now(),
    winner_bidder_id = v_win_bid.bidder_id,
    winning_bid_id = v_win_bid.id,
    updated_at = now()
  where id = p_listing_id;

  return jsonb_build_object(
    'ok', true,
    'listing_id', p_listing_id,
    'winner_bidder_id', v_win_bid.bidder_id,
    'winning_bid_id', v_win_bid.id,
    'winning_amount', v_win_amount,
    'winner_hold_kept',
      case when v_win_bid.id is not null then coalesce(v_win_bid.wallet_hold_applied, 0) else 0 end,
    'losers_released_count', v_released_count,
    'losers_released_total', v_released_total
  );
end;
$$;

revoke all on function public.resolve_auction(uuid, boolean) from public;
grant execute on function public.resolve_auction(uuid, boolean) to authenticated;
grant execute on function public.resolve_auction(uuid, boolean) to service_role;

create or replace function public.resolve_expired_auctions(p_limit int default 50)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_listing_id uuid;
  v_results jsonb := '[]'::jsonb;
  v_one jsonb;
  v_count int := 0;
begin
  for v_listing_id in
    select l.id
    from public.listings l
    where lower(nullif(trim(coalesce(l.listing_type::text, l.type::text)), '')) = 'auction'
      and l.auction_resolved_at is null
      and coalesce(l.auction_end_time, l.end_time) is not null
      and coalesce(l.auction_end_time, l.end_time) <= now()
    order by coalesce(l.auction_end_time, l.end_time) asc
    limit greatest(1, least(coalesce(p_limit, 50), 500))
  loop
    v_one := public.resolve_auction(v_listing_id, true);
    v_results := v_results || jsonb_build_array(v_one);
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('ok', true, 'resolved_count', v_count, 'results', v_results);
end;
$$;

revoke all on function public.resolve_expired_auctions(int) from public;
grant execute on function public.resolve_expired_auctions(int) to service_role;

-- =============================================================================
-- 7) place_bid — strictly public.profiles (NO public.users)
-- =============================================================================
create or replace function public.place_bid(p_listing_id uuid, p_amount numeric)
returns public.bids
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seller_id uuid;
  v_kind text;
  v_status text;
  v_mod text;
  v_price numeric;
  v_current numeric;
  v_end timestamptz;
  v_resolved_at timestamptz;
  v_bid public.bids;
  v_min numeric;
  v_wb numeric;
  v_hb numeric;
  v_hold numeric := 0;
  v_label text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select
    l.seller_id,
    lower(nullif(trim(coalesce(l.listing_type::text, l.type::text)), '')),
    lower(nullif(trim(l.status::text), '')),
    lower(nullif(trim(l.moderation_status::text), '')),
    l.price,
    l.current_bid,
    coalesce(l.auction_end_time, l.end_time),
    l.auction_resolved_at
  into
    v_seller_id, v_kind, v_status, v_mod, v_price, v_current, v_end, v_resolved_at
  from public.listings l
  where l.id = p_listing_id
  for update;

  if not found then raise exception 'Listing not found'; end if;
  if v_resolved_at is not null then raise exception 'Auction has ended and been resolved'; end if;
  if v_seller_id = auth.uid() then raise exception 'You cannot bid on your own listing'; end if;
  if v_kind is distinct from 'auction' then raise exception 'Not an auction listing'; end if;
  if not (v_status = 'active' or v_mod = 'approved') then raise exception 'Auction is not active'; end if;
  if v_end is not null and v_end < now() then raise exception 'Auction has ended'; end if;

  v_min := coalesce(v_current, v_price);
  if p_amount <= v_min then raise exception 'Bid must be higher than current bid'; end if;

  v_hold := public.compute_bid_wallet_hold(p_amount);
  perform public.release_bidder_listing_holds(p_listing_id, auth.uid());

  select coalesce(pr.wallet_balance, 0), coalesce(pr.held_balance, 0)
  into v_wb, v_hb
  from public.profiles pr
  where pr.id = auth.uid()
  for update;

  if not found then
    raise exception 'User profile not found — complete registration (public.profiles row missing).';
  end if;

  if v_hold > 0 and v_wb < v_hold then
    raise exception using
      message = format(
        'Insufficient wallet balance for bid hold. Need Rs. %s available; you have Rs. %s.',
        v_hold, v_wb
      ),
      errcode = 'P0001';
  end if;

  if v_hold > 0 then
    update public.profiles pr
    set
      wallet_balance = coalesce(pr.wallet_balance, 0) - v_hold,
      held_balance = coalesce(pr.held_balance, 0) + v_hold,
      updated_at = now()
    where pr.id = auth.uid();
  end if;

  select coalesce(
    nullif(trim(pr.username::text), ''),
    nullif(trim(pr.full_name::text), ''),
    split_part(coalesce(pr.email::text, ''), '@', 1),
    'Bidder'
  )
  into v_label
  from public.profiles pr
  where pr.id = auth.uid();

  if v_label is null or trim(v_label) = '' then
    v_label := 'Bidder';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'bids' and column_name = 'amount'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'bids' and column_name = 'bid_amount'
  ) then
    insert into public.bids (
      listing_id, bidder_id, amount, bid_amount, bidder_display_name, wallet_hold_applied
    )
    values (p_listing_id, auth.uid(), p_amount, p_amount, v_label, v_hold)
    returning * into v_bid;
  elsif exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'bids' and column_name = 'amount'
  ) then
    insert into public.bids (
      listing_id, bidder_id, amount, bidder_display_name, wallet_hold_applied
    )
    values (p_listing_id, auth.uid(), p_amount, v_label, v_hold)
    returning * into v_bid;
  else
    insert into public.bids (
      listing_id, bidder_id, bid_amount, bidder_display_name, wallet_hold_applied
    )
    values (p_listing_id, auth.uid(), p_amount, v_label, v_hold)
    returning * into v_bid;
  end if;

  update public.listings
  set current_bid = p_amount, updated_at = now()
  where id = p_listing_id;

  return v_bid;
end;
$$;

revoke all on function public.place_bid(uuid, numeric) from public;
grant execute on function public.place_bid(uuid, numeric) to authenticated;
grant execute on function public.place_bid(uuid, numeric) to service_role;

-- Bids RLS (uses current_user_is_admin → profiles)
alter table public.bids enable row level security;
drop policy if exists "bids_select_own_or_seller" on public.bids;
drop policy if exists "bids_select_visible_listings" on public.bids;
create policy "bids_select_visible_listings"
  on public.bids for select
  to authenticated
  using (
    exists (
      select 1 from public.listings l
      where l.id = bids.listing_id
        and (
          public.current_user_is_admin()
          or l.seller_id = auth.uid()
          or bids.bidder_id = auth.uid()
          or lower(nullif(trim(l.moderation_status::text), '')) = 'approved'
          or lower(nullif(trim(l.status::text), '')) = 'active'
          or lower(nullif(trim(l.status::text), '')) = 'ended'
        )
    )
  );

-- =============================================================================
-- 8) PostgREST schema cache refresh
-- =============================================================================
notify pgrst, 'reload schema';
