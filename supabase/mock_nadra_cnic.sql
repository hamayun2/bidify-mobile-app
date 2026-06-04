-- Mock NADRA demo: ensure profiles has cnic_number + verification columns
-- Approved CNIC range (app logic): 3650123031300 – 3650123031399

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS cnic_number text,
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS verification_submitted_at timestamptz;

COMMENT ON COLUMN public.profiles.cnic_number IS
  'CNIC from KYC OCR; used by Mock NADRA range check on the API server';

-- verification_status: unverified | under_review | verified | failed
