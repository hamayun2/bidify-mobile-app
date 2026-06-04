-- =============================================================================
-- Bidify — Demo data (run AFTER CLEAN_SLATE_SCHEMA.sql)
-- No service_role needed. Uses public image URLs.
-- Requires admin@bidify.com in auth.users (run CREATE_ADMIN_AND_SEED_LISTINGS.sql first
-- or sign up once in the app).
-- =============================================================================

do $$
declare
  v_admin_id uuid;
begin
  select id into v_admin_id
  from auth.users
  where lower(email) = 'admin@bidify.com'
  limit 1;

  if v_admin_id is null then
    raise exception 'admin@bidify.com not in auth.users. Run CREATE_ADMIN_AND_SEED_LISTINGS.sql or register admin first.';
  end if;

  perform public.promote_builtin_admin('admin@bidify.com', v_admin_id);

  delete from public.listings
  where title in (
    'Project Schedule Gantt Chart — Live Auction',
    'UI / Streaming Layout Reference — Buy Now'
  );

  insert into public.listings (
    seller_id, title, description, category, image_url, price,
    listing_type, status, current_bid, auction_end_time
  ) values (
    v_admin_id,
    'Project Schedule Gantt Chart — Live Auction',
    'Live auction — place bids before the timer ends. Gantt roadmap demo listing.',
    'Arts',
    'https://images.unsplash.com/photo-1523170335258-f5ed11844a49?w=1200&q=80',
    85000,
    'auction',
    'active',
    85000,
    now() + interval '7 days'
  );

  insert into public.listings (
    seller_id, title, description, category, image_url, price,
    listing_type, status
  ) values (
    v_admin_id,
    'UI / Streaming Layout Reference — Buy Now',
    'Standard fixed-price listing. Chat with seller — no bidding.',
    'Arts',
    'https://images.unsplash.com/photo-1541961017774-22349e4a1262?w=1200&q=80',
    12000,
    'standard',
    'active'
  );

  raise notice 'Demo listings seeded for admin %', v_admin_id;
end $$;

select id, title, listing_type, status, price, image_url from public.listings order by created_at desc limit 5;
