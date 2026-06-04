-- =============================================================================
-- Bidify — align DB columns with app services (listingsService, profileService)
-- =============================================================================
-- Safe to run multiple times: only ADD COLUMN IF NOT EXISTS.
-- No DROP / DELETE. Skips tables that do not exist (ALTER TABLE IF EXISTS).
--
-- Profile data: the app uses public.profiles (see profileService.js).
-- Legacy public.users is not used after rename_users_table_to_profiles.sql.
--
-- After run: Supabase PostgREST usually reloads within ~1 minute, or use
-- Dashboard → API → restart; optional: NOTIFY below.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- public.listings — reads/writes from listingsService.js (+ legacy columns)
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.listings
  ADD COLUMN IF NOT EXISTS seller_id uuid,
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS price numeric,
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS location text,
  ADD COLUMN IF NOT EXISTS listing_type text,
  ADD COLUMN IF NOT EXISTS type text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS moderation_status text,
  ADD COLUMN IF NOT EXISTS image_url text,
  ADD COLUMN IF NOT EXISTS image_urls jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS current_bid numeric,
  ADD COLUMN IF NOT EXISTS auction_end_time timestamptz,
  ADD COLUMN IF NOT EXISTS end_time timestamptz,
  ADD COLUMN IF NOT EXISTS duration_days integer,
  ADD COLUMN IF NOT EXISTS buy_now_price numeric,
  ADD COLUMN IF NOT EXISTS seller_name text,
  ADD COLUMN IF NOT EXISTS user_email text,
  ADD COLUMN IF NOT EXISTS username text,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS auction_resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS winner_bidder_id uuid,
  ADD COLUMN IF NOT EXISTS winning_bid_id uuid,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- ---------------------------------------------------------------------------
-- public.profiles — profileService.js + profileWalletService.js
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.profiles
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS full_name text,
  ADD COLUMN IF NOT EXISTS username text,
  ADD COLUMN IF NOT EXISTS phone_number text,
  ADD COLUMN IF NOT EXISTS cnic text,
  ADD COLUMN IF NOT EXISTS cnic_front_url text,
  ADD COLUMN IF NOT EXISTS cnic_back_url text,
  ADD COLUMN IF NOT EXISTS cnic_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS profile_completed boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS profile_image text,
  ADD COLUMN IF NOT EXISTS email_verified boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS wallet_balance numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS held_balance numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS role text DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS is_admin boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- ---------------------------------------------------------------------------
-- public.bids — escrow columns (wallet_hold_lifecycle.sql)
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.bids
  ADD COLUMN IF NOT EXISTS wallet_hold_applied numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wallet_hold_released_at timestamptz,
  ADD COLUMN IF NOT EXISTS bidder_display_name text;

-- Optional: bump PostgREST schema cache
NOTIFY pgrst, 'reload schema';
