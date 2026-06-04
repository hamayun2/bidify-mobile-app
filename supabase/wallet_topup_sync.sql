-- =============================================================================
-- Bidify — Credit wallet top-ups to public.profiles (idempotent)
-- =============================================================================
-- Included in BIDIFY_COMPLETE_SYNC.sql. Called from Express server via service role.

create table if not exists public.wallet_topup_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  amount numeric not null check (amount > 0),
  idempotency_key text not null,
  provider text,
  created_at timestamptz not null default now(),
  unique (idempotency_key)
);

create index if not exists wallet_topup_ledger_user_id_idx on public.wallet_topup_ledger (user_id);

alter table public.wallet_topup_ledger enable row level security;

-- Ledger is server-only (service role bypasses RLS)
drop policy if exists "wallet_topup_ledger_deny_all" on public.wallet_topup_ledger;
create policy "wallet_topup_ledger_deny_all"
  on public.wallet_topup_ledger for all
  using (false);

-- ---------------------------------------------------------------------------
-- Credit spendable balance (idempotent per idempotency_key)
-- ---------------------------------------------------------------------------
create or replace function public.credit_profile_wallet_topup(
  p_user_id uuid,
  p_amount numeric,
  p_idempotency_key text,
  p_provider text default 'stripe'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric;
  v_key text;
  v_wb numeric;
  v_existing uuid;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;

  v_amount := floor(coalesce(p_amount, 0));
  if v_amount <= 0 then
    raise exception 'p_amount must be positive';
  end if;

  v_key := nullif(trim(coalesce(p_idempotency_key, '')), '');
  if v_key is null then
    raise exception 'p_idempotency_key is required';
  end if;

  select l.id into v_existing
  from public.wallet_topup_ledger l
  where l.idempotency_key = v_key;

  if found then
    select coalesce(pr.wallet_balance, 0) into v_wb
    from public.profiles pr where pr.id = p_user_id;
    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'user_id', p_user_id,
      'wallet_balance', coalesce(v_wb, 0)
    );
  end if;

  if not exists (select 1 from public.profiles pr where pr.id = p_user_id) then
    raise exception 'Profile not found for user % — complete registration in the app first.', p_user_id;
  end if;

  update public.profiles pr
  set
    wallet_balance = coalesce(pr.wallet_balance, 0) + v_amount,
    updated_at = now()
  where pr.id = p_user_id
  returning pr.wallet_balance into v_wb;

  if not found then
    raise exception 'Profile not found for user %', p_user_id;
  end if;

  insert into public.wallet_topup_ledger (user_id, amount, idempotency_key, provider)
  values (p_user_id, v_amount, v_key, nullif(trim(p_provider), ''));

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'user_id', p_user_id,
    'credited', v_amount,
    'wallet_balance', v_wb,
    'provider', p_provider
  );
end;
$$;

revoke all on function public.credit_profile_wallet_topup(uuid, numeric, text, text) from public;
grant execute on function public.credit_profile_wallet_topup(uuid, numeric, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Reconcile profiles.wallet_balance up to Express ledger (login / one-time sync)
-- ---------------------------------------------------------------------------
create or replace function public.reconcile_profile_wallet_balance(
  p_user_id uuid,
  p_target_balance numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target numeric;
  v_wb numeric;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;

  v_target := greatest(0, floor(coalesce(p_target_balance, 0)));

  if not exists (select 1 from public.profiles pr where pr.id = p_user_id) then
    raise exception 'Profile not found for user % — complete registration in the app first.', p_user_id;
  end if;

  update public.profiles pr
  set
    wallet_balance = greatest(coalesce(pr.wallet_balance, 0), v_target),
    updated_at = now()
  where pr.id = p_user_id
  returning pr.wallet_balance into v_wb;

  return jsonb_build_object(
    'ok', true,
    'user_id', p_user_id,
    'wallet_balance', coalesce(v_wb, 0)
  );
end;
$$;

revoke all on function public.reconcile_profile_wallet_balance(uuid, numeric) from public;
grant execute on function public.reconcile_profile_wallet_balance(uuid, numeric) to service_role;

notify pgrst, 'reload schema';
