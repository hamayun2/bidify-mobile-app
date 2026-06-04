-- =============================================================================
-- Reset wallet for a fresh start (public.profiles)
-- =============================================================================
-- Run in Supabase SQL Editor. Pick ONE block below.

-- A) Reset YOUR row when logged into Supabase SQL Editor as that user:
update public.profiles
set
  wallet_balance = 0,
  held_balance = 0,
  updated_at = now()
where id = auth.uid();

-- B) Reset by email (replace with your account email):
-- update public.profiles
-- set wallet_balance = 0, held_balance = 0, updated_at = now()
-- where lower(trim(email)) = lower(trim('you@example.com'));

-- C) Reset by auth user UUID:
-- update public.profiles
-- set wallet_balance = 0, held_balance = 0, updated_at = now()
-- where id = '00000000-0000-0000-0000-000000000000'::uuid;

-- Optional: clear top-up idempotency ledger so Stripe can credit again in tests:
-- delete from public.wallet_topup_ledger
-- where user_id = auth.uid();

-- Verify:
-- select id, email, wallet_balance, held_balance from public.profiles where id = auth.uid();

notify pgrst, 'reload schema';
