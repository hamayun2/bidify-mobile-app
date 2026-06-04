-- =============================================================================
-- Public onboarding / register-with-KYC columns on public.profiles
-- Run once in Supabase → SQL Editor. Safe to re-run (IF NOT EXISTS).
-- Also run: supabase/kyc_verification_profiles.sql
-- =============================================================================

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_name text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone_number text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS cnic_number text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS cnic_front_url text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS cnic_back_url text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS verification_status text DEFAULT 'unverified';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS verification_submitted_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_real_face boolean NOT NULL DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS father_name text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS dob text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS address text;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_verification_status_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_verification_status_check
  CHECK (
    verification_status IN ('unverified', 'under_review', 'verified', 'failed')
  );

COMMENT ON COLUMN public.profiles.cnic_number IS 'Formatted CNIC from OCR or manual entry';
COMMENT ON COLUMN public.profiles.cnic_front_url IS 'Storage URL for CNIC front image';
COMMENT ON COLUMN public.profiles.cnic_back_url IS 'Storage URL for CNIC back image';
