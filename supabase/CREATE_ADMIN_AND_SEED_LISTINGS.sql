-- =============================================================================
-- Bidify — Admin account + 2 demo listings (run in Supabase → SQL Editor)
-- =============================================================================
-- Creates / resets:
--   Email:    admin@bidify.com
--   Password: admin1234
--   Role:     admin (public.users)
--   Email:    confirmed (login works immediately)
--
-- Seeds:
--   1) Auction listing  (type = auction)
--   2) Buy Now listing  (type = standard)
--
-- Prerequisites: run supabase/schema.sql and supabase/builtin_admin.sql first.
-- =============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- 1) Auth user + identity (bcrypt password via pgcrypto)
-- ---------------------------------------------------------------------------
do $$
declare
  v_email text := 'admin@bidify.com';
  v_password text := 'admin1234';
  v_user_id uuid;
  v_encrypted_pw text;
begin
  v_encrypted_pw := crypt(v_password, gen_salt('bf'));

  select id into v_user_id
  from auth.users
  where lower(email) = lower(v_email)
  limit 1;

  if v_user_id is null then
    v_user_id := gen_random_uuid();

    insert into auth.users (
      instance_id,
      id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      confirmation_token,
      recovery_token,
      email_change_token_new,
      email_change,
      last_sign_in_at,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at,
      is_super_admin,
      is_sso_user,
      is_anonymous
    ) values (
      '00000000-0000-0000-0000-000000000000',
      v_user_id,
      'authenticated',
      'authenticated',
      v_email,
      v_encrypted_pw,
      now(),
      '',
      '',
      '',
      '',
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"full_name":"Bidify Admin","username":"bidify_admin"}'::jsonb,
      now(),
      now(),
      false,
      false,
      false
    );

    insert into auth.identities (
      id,
      user_id,
      provider_id,
      identity_data,
      provider,
      last_sign_in_at,
      created_at,
      updated_at
    ) values (
      gen_random_uuid(),
      v_user_id,
      v_user_id::text,
      jsonb_build_object(
        'sub', v_user_id::text,
        'email', v_email,
        'email_verified', true,
        'phone_verified', false
      ),
      'email',
      now(),
      now(),
      now()
    );

    raise notice 'Created auth user % (id %)', v_email, v_user_id;
  else
    update auth.users
    set
      encrypted_password = v_encrypted_pw,
      email_confirmed_at = coalesce(email_confirmed_at, now()),
      updated_at = now(),
      raw_app_meta_data = coalesce(
        raw_app_meta_data,
        '{"provider":"email","providers":["email"]}'::jsonb
      )
    where id = v_user_id;

    raise notice 'Updated password + confirmed email for % (id %)', v_email, v_user_id;
  end if;

  perform public.promote_builtin_admin(v_email, v_user_id);
end $$;

-- ---------------------------------------------------------------------------
-- 2) Demo listings (approved — visible on home for all users)
-- ---------------------------------------------------------------------------
do $$
declare
  v_seller_id uuid;
  v_watch_id uuid;
  v_art_id uuid;
begin
  select id into v_seller_id
  from auth.users
  where lower(email) = 'admin@bidify.com'
  limit 1;

  if v_seller_id is null then
    raise exception 'admin@bidify.com not found in auth.users — run section 1 first.';
  end if;

  -- Remove previous seed rows so re-running this script is idempotent
  delete from public.listings
  where title in (
    'Vintage Omega Seamaster — Live Auction',
    'Original Abstract Canvas — Buy Now'
  );

  insert into public.listings (
    seller_id,
    title,
    description,
    price,
    type,
    category,
    duration_days,
    buy_now_price,
    image_urls,
    moderation_status,
    current_bid,
    end_time,
    seller_name,
    user_email,
    username,
    approved_at
  ) values (
    v_seller_id,
    'Vintage Omega Seamaster — Live Auction',
    'Classic 1960s dress watch in excellent condition. Steel case, original dial, serviced movement. Bidding starts low — collectors item.',
    125000,
    'auction',
    'Watches',
    7,
    250000,
    '["https://images.unsplash.com/photo-1523170335258-f5ed11844a49?w=1200&q=80","https://images.unsplash.com/photo-1524592094714-0f0654e20314?w=1200&q=80"]'::jsonb,
    'approved',
    125000,
    now() + interval '7 days',
    'Bidify Admin',
    'admin@bidify.com',
    'bidify_admin',
    now()
  )
  returning id into v_watch_id;

  insert into public.listings (
    seller_id,
    title,
    description,
    price,
    type,
    category,
    buy_now_price,
    image_urls,
    moderation_status,
    seller_name,
    user_email,
    username,
    approved_at
  ) values (
    v_seller_id,
    'Original Abstract Canvas — Buy Now',
    'Large acrylic on canvas (36×48 in). Signed by the artist. Ready to hang — fixed price, instant purchase.',
    45000,
    'standard',
    'Art',
    45000,
    '["https://images.unsplash.com/photo-1541961017774-22349e4a1262?w=1200&q=80","https://images.unsplash.com/photo-1579783902614-a3fb3927b6a5?w=1200&q=80"]'::jsonb,
    'approved',
    'Bidify Admin',
    'admin@bidify.com',
    'bidify_admin',
    now()
  )
  returning id into v_art_id;

  raise notice 'Seeded auction listing % and buy-now listing %', v_watch_id, v_art_id;
end $$;

-- Quick verify
select u.id, u.email, u.email_confirmed_at, p.role, p.email_verified
from auth.users u
left join public.users p on p.id = u.id
where lower(u.email) = 'admin@bidify.com';

select id, title, type, moderation_status, price, image_urls
from public.listings
where title like 'Vintage Omega%' or title like 'Original Abstract%'
order by created_at desc;
