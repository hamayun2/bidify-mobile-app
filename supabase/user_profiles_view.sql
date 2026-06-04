-- =============================================================================
-- public.user_profiles — compatibility VIEW over public.users
-- =============================================================================
-- The Bidify app stores profiles in public.profiles (id = auth.users.id).
-- If you need a table-shaped name "user_profiles" for SQL / BI / docs, run this
-- once in Supabase → SQL Editor.
--
-- Columns match the requested shape (cnic_number maps from users.cnic).
-- =============================================================================

drop view if exists public.user_profiles;

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
  'Read-only projection of public.profiles. App uses public.profiles directly; this view is optional for reporting.';

grant select on public.user_profiles to authenticated;
grant select on public.user_profiles to service_role;

-- If "security_invoker" errors on older Postgres, use instead:
--   create view public.user_profiles as select ... ;
