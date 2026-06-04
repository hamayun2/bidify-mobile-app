/**
 * Periodic sweep: under_review → verified after 5-minute window (see kycAutoVerify.js).
 */
const { createClient } = require('@supabase/supabase-js');
const { MOCK_NADRA_DELAY_MS, sweepMockNadraUnderReview } = require('./mockNadraCnic');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  '';

let sweepTimer = null;

function getAdmin() {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  return createClient(String(SUPABASE_URL).replace(/\/$/, ''), SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function startKycAutoVerifyCron(intervalMs = 30 * 1000) {
  if (sweepTimer) return;
  const admin = getAdmin();
  if (!admin) {
    console.warn('[kycAutoVerifyCron] skipped — Supabase admin not configured');
    return;
  }

  console.log(
    `[kycAutoVerifyCron] ACTIVE — Mock NADRA sweep every ${intervalMs / 1000}s, delay ${Math.round(MOCK_NADRA_DELAY_MS / 1000)}s`
  );

  const tick = async () => {
    try {
      const result = await sweepMockNadraUnderReview(admin);
      if (result.updated > 0) {
        console.log(
          `[kycAutoVerifyCron] updated ${result.updated} profile(s) (checked ${result.checked})`
        );
      }
    } catch (e) {
      console.warn('[kycAutoVerifyCron] tick error', e?.message || e);
    }
  };

  void tick();
  sweepTimer = setInterval(tick, intervalMs);
}

function stopKycAutoVerifyCron() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

module.exports = { startKycAutoVerifyCron, stopKycAutoVerifyCron };
