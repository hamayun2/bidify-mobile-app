-- Add 'rejected' to verification_status (Mock NADRA failed CNIC range)
-- Safe to re-run. Run after kyc_verification_profiles.sql

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS cnic_number text,
  ADD COLUMN IF NOT EXISTS phone_number text,
  ADD COLUMN IF NOT EXISTS verification_submitted_at timestamptz;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_verification_status_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_verification_status_check
  CHECK (
    verification_status IN (
      'unverified',
      'under_review',
      'verified',
      'rejected',
      'failed'
    )
  );

COMMENT ON COLUMN public.profiles.cnic_number IS 'CNIC from KYC — used for Mock NADRA range check';
COMMENT ON COLUMN public.profiles.verification_submitted_at IS
  'KYC submit time — 5-minute auto-verify timer starts here';
