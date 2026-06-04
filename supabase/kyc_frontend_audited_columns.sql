-- =============================================================================
-- AUDITED frontend keys → public.profiles columns
-- Source: RegisterScreen, KycScanScreen, KycSelfieScreen, src/api/kyc.js
-- Run once in Supabase SQL Editor (safe to re-run).
-- =============================================================================
--
-- signupPayload / registration:
--   firstName        → first_name
--   lastName         → last_name
--   fullName | name  → full_name
--   email            → email (unique lookup for upsert)
--   phoneNumber|phone→ phone_number
--   password         → Supabase Auth only (NOT stored on profiles)
--
-- scanData / kycPayload:
--   name             → full_name (when signup names empty)
--   fatherName       → father_name
--   cnic|cnicNumber  → cnic_number, cnic, id_card
--   dob              → dob
--   address          → address
--   cnicFrontUri     → cnic_front_url (via multipart cnicFront upload)
--   cnicBackUri      → cnic_back_url (via multipart cnicBack upload)
--
-- isRealFace         → is_real_face
-- verification       → verification_status, verification_submitted_at
-- =============================================================================

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_name text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS full_name text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone_number text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS father_name text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS dob text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS cnic_number text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS cnic text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS id_card text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS cnic_front_url text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS cnic_back_url text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS verification_status text DEFAULT 'unverified';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS verification_submitted_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_real_face boolean NOT NULL DEFAULT false;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_verification_status_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_verification_status_check
  CHECK (
    verification_status IN ('unverified', 'under_review', 'verified', 'failed')
  );
