-- =============================================================================
-- Built-in admin + wallet transaction tables (run once in Supabase SQL Editor)
-- =============================================================================
-- After running:
--   1) Authentication → Providers → Email → disable "Confirm email" for dev
--      OR confirm admin@bidify.com manually once.
--   2) Set app env: EXPO_PUBLIC_BUILTIN_ADMIN_EMAIL / PASSWORD (optional)
--   3) Restart app — ensureBuiltinAdmin runs on boot.
-- =============================================================================

-- Promote / upsert admin row (SECURITY DEFINER — bypasses users_insert_own role=user check)
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
    is_admin = true,
    email = excluded.email,
    full_name = coalesce(public.profiles.full_name, excluded.full_name),
    email_verified = true,
    updated_at = now();
end;
$$;

revoke all on function public.promote_builtin_admin(text, uuid) from public;
grant execute on function public.promote_builtin_admin(text, uuid) to anon, authenticated, service_role;

-- Optional: wallet transaction log (app still uses Express store when API_URL set;
-- this table supports future Supabase-native wallet sync)
create table if not exists public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null default 'topup',
  amount numeric not null check (amount >= 0),
  currency text not null default 'PKR',
  payment_status text not null default 'pending',
  provider text,
  stripe_payment_id text,
  stripe_session_id text,
  note text,
  balance_after numeric,
  created_at timestamptz not null default now()
);

create index if not exists wallet_transactions_user_id_idx on public.wallet_transactions (user_id);
create index if not exists wallet_transactions_created_at_idx on public.wallet_transactions (created_at desc);

alter table public.wallet_transactions enable row level security;

drop policy if exists "wallet_tx_select_own" on public.wallet_transactions;
create policy "wallet_tx_select_own" on public.wallet_transactions
  for select using (auth.uid() = user_id or public.current_user_is_admin());

drop policy if exists "wallet_tx_insert_own" on public.wallet_transactions;
create policy "wallet_tx_insert_own" on public.wallet_transactions
  for insert with check (auth.uid() = user_id);

drop policy if exists "wallet_tx_admin_all" on public.wallet_transactions;
create policy "wallet_tx_admin_all" on public.wallet_transactions
  for all using (public.current_user_is_admin())
  with check (public.current_user_is_admin());
