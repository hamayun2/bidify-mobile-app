/**
 * Terminal diagnostics for KYC / submit-kyc pipeline.
 *
 * If you see PG error 42703 (undefined_column), run BOTH SQL files in Supabase SQL Editor:
 *   1. supabase/kyc_verification_profiles.sql
 *   2. supabase/profiles_split_name_columns.sql
 *
 * Or paste this block:
 * ---------------------------------------------------------------------------
 * ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS first_name text;
 * ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_name text;
 * ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone_number text;
 * ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'unverified';
 * ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS verification_submitted_at timestamptz;
 * ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_real_face boolean NOT NULL DEFAULT false;
 * ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS father_name text;
 * ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS dob text;
 * ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS address text;
 * ---------------------------------------------------------------------------
 */

const REQUIRED_KYC_SQL_FILES = [
  'supabase/kyc_verification_profiles.sql',
  'supabase/profiles_split_name_columns.sql',
];

function logIncomingKycRequest(req, extras = {}) {
  console.log('📥 RECEIVED FRONTEND BODY KEYS:', Object.keys(req.body || {}));
  console.log('📥 MULTER FILE:', req.file ? `selfie (${req.file.size} bytes, ${req.file.mimetype})` : 'none');
  if (extras.signupPayload) {
    console.log('📥 signupPayload keys:', Object.keys(extras.signupPayload));
    console.log('📥 signupPayload.email:', extras.signupPayload.email || '(missing)');
    console.log('📥 signupPayload.firstName:', extras.signupPayload.firstName || '(missing)');
    console.log('📥 signupPayload.lastName:', extras.signupPayload.lastName || '(missing)');
  }
  if (extras.scanData) {
    console.log('📥 scanData keys:', Object.keys(extras.scanData));
    console.log('📥 scanData.name:', extras.scanData.name || '(missing)');
  }
  if (extras.kycFields) {
    console.log('📥 mapped kycFields:', {
      name: extras.kycFields.name,
      firstName: extras.kycFields.firstName,
      lastName: extras.kycFields.lastName,
      cnic: extras.kycFields.cnic ? '***' : '',
      phone: extras.kycFields.phone ? '***' : '',
    });
  }
}

function logSupabaseRootCause(error, context = 'submit-kyc') {
  console.log('================ 🚨 DB ROOT CAUSE ERROR STACK ================');
  console.error('Context:', context);
  console.error('Supabase Error Code:', error?.code);
  console.error('Supabase Error Message:', error?.message);
  console.error('Supabase Error Details:', error?.details);
  console.error('Supabase Error Hint:', error?.hint);
  if (error?.stack) {
    console.error('Stack:', error.stack);
  }
  console.log('==============================================================');

  const msg = String(error?.message || '').toLowerCase();
  const isColumnIssue =
    error?.code === '42703' ||
    msg.includes('column') ||
    msg.includes('does not exist') ||
    msg.includes('schema cache');

  if (isColumnIssue) {
    logSchemaMigrationHint();
  }
}

function logSchemaMigrationHint() {
  console.warn(`
⚠️  KYC COLUMN MISMATCH — run these in Supabase → SQL Editor (project root):
   - ${REQUIRED_KYC_SQL_FILES.join('\n   - ')}

Or execute:

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_name text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone_number text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'unverified';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS verification_submitted_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_real_face boolean NOT NULL DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS father_name text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS dob text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS address text;
`);
}

function logAuthRootCause(error, context = 'auth.admin.createUser') {
  console.log('================ 🚨 AUTH ROOT CAUSE ERROR STACK ================');
  console.error('Context:', context);
  console.error('Auth Error Code:', error?.code);
  console.error('Auth Error Message:', error?.message);
  console.error('Auth Error Status:', error?.status);
  console.log('==============================================================');
}

module.exports = {
  logIncomingKycRequest,
  logSupabaseRootCause,
  logAuthRootCause,
  logSchemaMigrationHint,
  REQUIRED_KYC_SQL_FILES,
};
