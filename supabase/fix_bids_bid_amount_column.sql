-- =============================================================================
-- Sync public.bids.amount ↔ public.bids.bid_amount (run in Supabase SQL Editor)
-- =============================================================================
-- Use after: legacy table has NOT NULL `amount` only, or only `bid_amount`, or both.

alter table if exists public.bids drop column if exists "bid_amount ";
alter table if exists public.bids add column if not exists bid_amount numeric;
alter table if exists public.bids add column if not exists amount numeric;

update public.bids set bid_amount = amount where bid_amount is null and amount is not null;
update public.bids set amount = bid_amount where amount is null and bid_amount is not null;

-- Re-apply function body (or run full supabase/place_bid_rpc.sql from the "place_bid" section)
-- so inserts populate both columns. Easiest: run the entire place_bid_rpc.sql file again.

notify pgrst, 'reload schema';
