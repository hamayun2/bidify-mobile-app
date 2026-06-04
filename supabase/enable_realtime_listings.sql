-- Run once in Supabase SQL Editor so the mobile app can subscribe to listing changes
-- (Home screen refreshes when rows are inserted/updated, e.g. new bids).

alter publication supabase_realtime add table public.listings;
