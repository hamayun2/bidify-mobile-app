-- =============================================================================
-- KYC verification columns on public.profiles (Phase 1)
-- Run once in Supabase → SQL Editor. Safe to re-run (IF NOT EXISTS).
-- Does not alter existing columns, RLS, or auth structures.
-- =============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'unverified';

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_real_face boolean NOT NULL DEFAULT false;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS verification_submitted_at timestamptz;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS father_name text;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS dob text;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS address text;

-- Allowed values: unverified | under_review | verified | failed
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

COMMENT ON COLUMN public.profiles.verification_status IS
  'KYC lifecycle: unverified, under_review, verified, failed';

COMMENT ON COLUMN public.profiles.is_real_face IS
  'Set when liveness / face match passes (Phase 2+)';

COMMENT ON COLUMN public.profiles.verification_submitted_at IS
  'When the user submitted KYC documents for review';

COMMENT ON COLUMN public.profiles.father_name IS
  'Father name from CNIC OCR or manual entry';

COMMENT ON COLUMN public.profiles.dob IS
  'Date of birth from CNIC OCR or manual entry (text as on card)';

COMMENT ON COLUMN public.profiles.address IS
  'Permanent address from CNIC OCR or manual entry';
