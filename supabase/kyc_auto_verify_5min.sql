-- KYC auto-verify: 5-minute review window (aligned with app KYC_DURATION_MS and server kycAutoVerify.js)
-- Run in Supabase SQL Editor. Safe to re-run (IF NOT EXISTS / idempotent updates).

-- 1) Ensure columns exist on profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS verification_status text DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS verification_submitted_at timestamptz;

COMMENT ON COLUMN public.profiles.verification_status IS
  'unverified | under_review | verified | pending | failed';
COMMENT ON COLUMN public.profiles.verification_submitted_at IS
  'When user submitted CNIC + selfie; used for 5-minute auto-verify';

-- 2) Backfill: users stuck under_review with submitted_at older than 5 minutes
UPDATE public.profiles
SET
  verification_status = 'verified',
  updated_at = now()
WHERE verification_status = 'under_review'
  AND verification_submitted_at IS NOT NULL
  AND verification_submitted_at <= (now() - interval '5 minutes');

-- 3) Optional: pg_cron job (enable pg_cron extension first in Dashboard → Database → Extensions)
-- SELECT cron.schedule(
--   'kyc-auto-verify-5min',
--   '* * * * *',
--   $$
--   UPDATE public.profiles
--   SET verification_status = 'verified', updated_at = now()
--   WHERE verification_status = 'under_review'
--     AND verification_submitted_at IS NOT NULL
--     AND verification_submitted_at <= (now() - interval '5 minutes');
--   $$
-- );

-- 4) Inspect pending reviews
-- SELECT id, email, verification_status, verification_submitted_at,
--        now() - verification_submitted_at AS elapsed
-- FROM public.profiles
-- WHERE verification_status = 'under_review'
-- ORDER BY verification_submitted_at ASC;
