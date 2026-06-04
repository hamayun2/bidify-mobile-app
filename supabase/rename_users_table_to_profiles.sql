-- =============================================================================
-- Optional: rename public.users → public.profiles (matches app targeting "profiles")
-- =============================================================================
-- Use this ONLY if you want the physical table named `profiles` instead of renaming
-- the app code. Prerequisites:
--   - Table public.users exists and is keyed by auth.users.id
--   - No conflicting table named public.profiles (drop or migrate it first).
-- =============================================================================

alter table if exists public.users rename to profiles;

-- Admin helper — must reference the renamed table
create or replace function public.current_user_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select u.role = 'admin' from public.profiles u where u.id = auth.uid()),
    false
  );
$$;

revoke all on function public.current_user_is_admin() from public;
grant execute on function public.current_user_is_admin() to anon, authenticated;

-- Seed / admin bootstrap — same logic as builtin_admin.sql, table name updated
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

-- PostgREST: reload schema (Supabase usually picks this up within ~1 min, or restart project)
notify pgrst, 'reload schema';
