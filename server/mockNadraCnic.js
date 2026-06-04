/**
 * Mock NADRA CNIC range check (FYP demo).
 * Approved range: 3650123031300 – 3650123031399 (100 CNICs).
 * After 5 minutes, profiles move to verified or failed (rejected in UI).
 */
const { isAdminProfile } = require('./utils/adminProfile');

const CNIC_RANGE_START = 3650123031300n;
const CNIC_RANGE_END = 3650123031399n;

const FIVE_MINUTES_MS = 5 * 60 * 1000;

/** Override for local testing: MOCK_NADRA_DELAY_MS=10000 */
const MOCK_NADRA_DELAY_MS = Number(process.env.MOCK_NADRA_DELAY_MS) || FIVE_MINUTES_MS;

/** @type {Map<string, NodeJS.Timeout>} */
const pendingTimers = new Map();

function normalizeCnicDigits(cnic) {
  const digits = String(cnic || '').replace(/\D/g, '');
  if (digits.length !== 13) return null;
  try {
    return BigInt(digits);
  } catch {
    return null;
  }
}

/**
 * Returns true when CNIC (13 digits) is inside the approved mock NADRA range.
 * @param {string|number} cnic
 */
function isCnicValid(cnic) {
  const value = normalizeCnicDigits(cnic);
  if (value == null) return false;
  return value >= CNIC_RANGE_START && value <= CNIC_RANGE_END;
}

function extractCnicFromProfile(row) {
  return row?.cnic_number || row?.cnic || row?.id_card || null;
}

function parseSubmittedAt(row) {
  const raw =
    row?.verification_submitted_at ||
    row?.verificationSubmittedAt ||
    row?.updated_at ||
    row?.created_at ||
    null;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

function reviewWindowElapsed(profileRow) {
  const submittedMs = parseSubmittedAt(profileRow);
  if (submittedMs == null) return false;
  return Date.now() - submittedMs >= MOCK_NADRA_DELAY_MS;
}

/**
 * Apply mock NADRA result when review window has passed (cron + sync + timer).
 * @returns {Promise<object|null>}
 */
async function processMockNadraReview(admin, profileRow) {
  if (!admin || !profileRow?.id) return profileRow;
  if (isAdminProfile(profileRow)) return profileRow;
  if (profileRow.verification_status !== 'under_review') return profileRow;
  if (!reviewWindowElapsed(profileRow)) return profileRow;

  const cnic = extractCnicFromProfile(profileRow);
  const valid = isCnicValid(cnic);
  const nextStatus = valid ? 'verified' : 'rejected';

  async function applyStatus(statusValue) {
    return admin
      .from('profiles')
      .update({
        verification_status: statusValue,
        updated_at: new Date().toISOString(),
      })
      .eq('id', profileRow.id)
      .eq('verification_status', 'under_review')
      .select('*')
      .single();
  }

  let { data, error } = await applyStatus(nextStatus);

  if (error && nextStatus === 'rejected') {
    console.warn('[mockNadra] rejected update failed — retrying as failed', error.message);
    ({ data, error } = await applyStatus('failed'));
  }

  if (error) {
    console.error('[mockNadra] status update failed', error.message);
    return profileRow;
  }

  console.log(
    `[mockNadra] ${valid ? 'VERIFIED' : 'REJECTED'} user ${profileRow.id} — CNIC ${cnic || '(missing)'} (after ${Math.round(MOCK_NADRA_DELAY_MS / 1000)}s)`
  );
  return data || profileRow;
}

/**
 * Schedule 5-minute timer after KYC submit.
 */
function scheduleMockNadraVerification(admin, profileRow) {
  if (!admin || !profileRow?.id) return;
  if (isAdminProfile(profileRow)) {
    console.log('[mockNadra] skipped — admin account excluded from auto-verification');
    return;
  }

  const userId = String(profileRow.id);
  const existing = pendingTimers.get(userId);
  if (existing) clearTimeout(existing);

  const cnic = extractCnicFromProfile(profileRow);
  const willVerify = isCnicValid(cnic);

  console.log(
    `[mockNadra] Scheduled 5-min review for ${userId} — CNIC ${cnic || '(missing)'} → expected ${willVerify ? 'verified' : 'rejected'}`
  );

  const timer = setTimeout(async () => {
    pendingTimers.delete(userId);
    try {
      const { data: fresh } = await admin
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();
      if (fresh?.verification_status === 'under_review') {
        await processMockNadraReview(admin, fresh);
      }
    } catch (e) {
      console.warn('[mockNadra] scheduled review error', e?.message || e);
    }
  }, MOCK_NADRA_DELAY_MS);

  pendingTimers.set(userId, timer);
}

async function sweepMockNadraUnderReview(admin) {
  if (!admin) return { checked: 0, updated: 0 };

  const { data: rows, error } = await admin
    .from('profiles')
    .select('*')
    .eq('verification_status', 'under_review')
    .limit(200);

  if (error) {
    console.error('[mockNadra] sweep select failed', error.message);
    return { checked: 0, updated: 0 };
  }

  let updated = 0;
  let eligible = 0;
  for (const row of rows || []) {
    if (isAdminProfile(row)) continue;
    if (!reviewWindowElapsed(row)) continue;
    eligible += 1;
    const before = row.verification_status;
    const result = await processMockNadraReview(admin, row);
    if (result?.verification_status !== before) updated += 1;
  }

  return { checked: eligible, updated };
}

module.exports = {
  CNIC_RANGE_START,
  CNIC_RANGE_END,
  FIVE_MINUTES_MS,
  MOCK_NADRA_DELAY_MS,
  isCnicValid,
  normalizeCnicDigits,
  extractCnicFromProfile,
  scheduleMockNadraVerification,
  processMockNadraReview,
  sweepMockNadraUnderReview,
};
