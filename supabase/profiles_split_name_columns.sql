-- =============================================================================
-- KYC profile columns — run in Supabase SQL Editor if submit-kyc logs 42703 /
-- "column does not exist". Safe to re-run (IF NOT EXISTS).
-- Also run: supabase/kyc_verification_profiles.sql
-- =============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS first_name text;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS last_name text;

-- Phone is stored as phone_number (frontend signupPayload.phone → phone_number)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS phone_number text;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'unverified';

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS verification_submitted_at timestamptz;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_real_face boolean NOT NULL DEFAULT false;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS father_name text;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS dob text;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS address text;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_verification_status_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_verification_status_check
  CHECK (
    verification_status IN (
      'unverified',
      'under_review',
      'verified',
      'failed'
    )
  );

COMMENT ON COLUMN public.profiles.first_name IS 'Given name from signup or CNIC OCR';
COMMENT ON COLUMN public.profiles.last_name IS 'Family name from signup or CNIC OCR';
COMMENT ON COLUMN public.profiles.phone_number IS 'E.164 / local digits — maps from signupPayload.phone';
