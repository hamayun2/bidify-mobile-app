-- Run in Supabase SQL Editor once. Adds email_verified to public.profiles.
alter table if exists public.profiles add column if not exists email_verified boolean not null default false;
