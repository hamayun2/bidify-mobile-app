-- =============================================================================
-- Bidify — Wallet hold & release lifecycle (Supabase / PostgreSQL)
-- =============================================================================
-- DEPRECATED for production fixes — use supabase/BIDIFY_COMPLETE_SYNC.sql instead.
-- Profile / wallet table: public.profiles (id = auth.users.id)
--
-- Run in Supabase SQL Editor after alter_app_schema_sync.sql.
-- Mirrors: src/constants/bidHoldRules.js
--
-- Hold tiers (PKR):
--   bid > 10,000  → 2,000
--   bid >  5,000  → 1,000
--   bid >  1,000  →   500
--   else          →     0
-- =============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Admin helper — must read public.profiles (not users)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Schema: wallet columns on profiles + escrow tracking on bids/listings
-- ---------------------------------------------------------------------------
alter table if exists public.profiles add column if not exists wallet_balance numeric not null default 0;
alter table if exists public.profiles add column if not exists held_balance numeric not null default 0;
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

create table if not exists public.bids (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings (id) on delete cascade,
  bidder_id uuid not null references auth.users (id) on delete cascade,
  amount numeric not null check (amount > 0),
  bid_amount numeric not null check (bid_amount > 0),
  bidder_display_name text,
  wallet_hold_applied numeric not null default 0,
  wallet_hold_released_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists bids_listing_id_idx on public.bids (listing_id);
create index if not exists bids_bidder_id_idx on public.bids (bidder_id);
create index if not exists bids_listing_unreleased_idx
  on public.bids (listing_id, bidder_id)
  where wallet_hold_released_at is null and wallet_hold_applied > 0;

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

-- ---------------------------------------------------------------------------
-- Shared hold tier (keep in sync with src/constants/bidHoldRules.js)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Release one bid's escrow (idempotent) — credits public.profiles
-- ---------------------------------------------------------------------------
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

  update public.bids
  set wallet_hold_released_at = now()
  where id = p_bid_id;

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

-- ---------------------------------------------------------------------------
-- Release all unreleased holds for one bidder on one listing (e.g. before rebid)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Resolve auction: release losers; winner keeps escrow in held_balance
-- ---------------------------------------------------------------------------
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
      and (
        v_win_bid.id is null
        or b.id is distinct from v_win_bid.id
      )
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

-- ---------------------------------------------------------------------------
-- Batch: resolve all auctions whose end time has passed
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- place_bid — wallet hold on public.profiles
-- ---------------------------------------------------------------------------
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
    v_seller_id,
    v_kind,
    v_status,
    v_mod,
    v_price,
    v_current,
    v_end,
    v_resolved_at
  from public.listings l
  where l.id = p_listing_id
  for update;

  if not found then
    raise exception 'Listing not found';
  end if;

  if v_resolved_at is not null then
    raise exception 'Auction has ended and been resolved';
  end if;

  if v_seller_id = auth.uid() then
    raise exception 'You cannot bid on your own listing';
  end if;

  if v_kind is distinct from 'auction' then
    raise exception 'Not an auction listing';
  end if;

  if not (v_status = 'active' or v_mod = 'approved') then
    raise exception 'Auction is not active';
  end if;

  if v_end is not null and v_end < now() then
    raise exception 'Auction has ended';
  end if;

  v_min := coalesce(v_current, v_price);
  if p_amount <= v_min then
    raise exception 'Bid must be higher than current bid';
  end if;

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

-- ---------------------------------------------------------------------------
-- Optional pg_cron:
--   select cron.schedule(
--     'bidify-resolve-expired-auctions',
--     '*/5 * * * *',
--     $$ select public.resolve_expired_auctions(100); $$
--   );
-- ---------------------------------------------------------------------------

notify pgrst, 'reload schema';
