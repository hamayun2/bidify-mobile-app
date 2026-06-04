/**
 * Maps audited signup + scan payloads onto public.profiles (see kycSubmitPayload.js).
 * Upsert onConflict: 'id' — idempotent demo retries (no strict insert / 400 duplicate).
 */

const { logSupabaseRootCause } = require('./kycDiagnostics');

function formatPakistaniCnic(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length !== 13) return String(value || '').trim();
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
}

function splitDisplayName(scanData, signupPayload) {
  const firstFromSignup = String(signupPayload?.firstName || '').trim();
  const lastFromSignup = String(signupPayload?.lastName || '').trim();

  if (firstFromSignup || lastFromSignup) {
    const fullName = [firstFromSignup, lastFromSignup].filter(Boolean).join(' ').trim();
    return {
      firstName: firstFromSignup || 'User',
      lastName: lastFromSignup,
      fullName: fullName || 'Bidify User',
    };
  }

  const raw = String(
    scanData?.name || signupPayload?.fullName || signupPayload?.name || ''
  ).trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  const firstName = parts[0] || 'User';
  const lastName = parts.slice(1).join(' ');
  return {
    firstName,
    lastName,
    fullName: raw || [firstName, lastName].filter(Boolean).join(' ') || 'Bidify User',
  };
}

function buildKycFieldsFromBodies(req, signupPayload, scanData) {
  const reg = signupPayload || {};
  const scan = scanData || {};
  const names = splitDisplayName(scan, reg);
  return {
    name:
      String(req.body?.name || '').trim() ||
      String(scan.name || '').trim() ||
      names.fullName,
    firstName: names.firstName,
    lastName: names.lastName,
    fullName: names.fullName,
    fatherName: String(req.body?.fatherName || scan.fatherName || reg.fatherName || '').trim(),
    cnic: String(
      req.body?.cnic ||
        scan.cnic ||
        scan.cnicNumber ||
        reg.cnic ||
        ''
    ).trim(),
    dob: String(req.body?.dob || scan.dob || reg.dob || '').trim(),
    address: String(req.body?.address || scan.address || reg.address || '').trim(),
    phone: String(
      reg.phone ||
        reg.phoneNumber ||
        scan.phone ||
        req.body?.phone ||
        ''
    ).trim(),
  };
}

/**
 * Build upsert row for profiles — includes split + legacy name columns.
 */
function buildProfileUpsertRow({
  id,
  email,
  signupPayload,
  scanData,
  kycFields,
  cnicUrls = {},
  isRealFace = true,
}) {
  const submittedAt = new Date().toISOString();
  const names = splitDisplayName(scanData, signupPayload);
  const cnicRaw = kycFields?.cnicNumber || kycFields?.cnic || '';
  const cnicDigits = String(cnicRaw).replace(/\D/g, '');
  const phoneDigits = String(
    kycFields?.phoneNumber || kycFields?.phone || ''
  ).replace(/\D/g, '');

  const row = {
    id,
    email: String(email || kycFields?.email || signupPayload?.email || '').trim(),
    first_name: String(kycFields?.firstName || names.firstName || 'User').trim(),
    last_name: String(kycFields?.lastName || names.lastName || '').trim(),
    full_name: String(kycFields?.name || kycFields?.fullName || names.fullName).trim(),
    verification_status: 'under_review',
    verification_submitted_at: submittedAt,
    is_real_face: isRealFace !== false,
    updated_at: submittedAt,
  };

  if (phoneDigits) row.phone_number = phoneDigits;
  if (cnicDigits) {
    row.cnic_number = formatPakistaniCnic(cnicDigits);
    row.cnic = cnicDigits;
    row.id_card = cnicDigits;
  }
  const frontUrl =
    cnicUrls.cnicFrontUrl ||
    scanData?.cnicFrontUri ||
    scanData?.cnicFrontUrl ||
    scanData?.cnic_front_url ||
    null;
  const backUrl =
    cnicUrls.cnicBackUrl ||
    scanData?.cnicBackUri ||
    scanData?.cnicBackUrl ||
    scanData?.cnic_back_url ||
    null;
  if (frontUrl && String(frontUrl).startsWith('http')) row.cnic_front_url = String(frontUrl);
  if (backUrl && String(backUrl).startsWith('http')) row.cnic_back_url = String(backUrl);
  if (kycFields?.fatherName) row.father_name = kycFields.fatherName;
  if (kycFields?.dob) row.dob = kycFields.dob;
  if (kycFields?.address) row.address = kycFields.address;

  return row;
}

/** Drop dedicated CNIC URL/number columns when schema is behind migration. */
function stripCnicUrlColumns(row) {
  const next = { ...row };
  delete next.cnic_number;
  delete next.cnic_front_url;
  delete next.cnic_back_url;
  return next;
}

/** Strip split-name columns (legacy DB without first_name/last_name). */
function toLegacyNameRow(row) {
  const next = { ...row };
  delete next.first_name;
  delete next.last_name;
  if (!next.full_name) {
    next.full_name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || 'Bidify User';
  }
  return next;
}

/** Minimal columns guaranteed on most profiles deployments. */
function toMinimalProfileRow(row) {
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name || [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Bidify User',
    verification_status: 'under_review',
    verification_submitted_at: row.verification_submitted_at,
    is_real_face: true,
    updated_at: row.updated_at,
  };
}

/**
 * Upsert with fallbacks: full row → legacy (no split names) → minimal.
 * Always onConflict: 'id' — never strict insert (prevents duplicate 400 on retry).
 */
async function safeUpsertProfile(admin, row, context = 'profiles.upsert') {
  const attempts = [
    { label: 'full-row', payload: row },
    { label: 'legacy-no-cnic-urls', payload: toLegacyNameRow(stripCnicUrlColumns(row)) },
    { label: 'legacy-names-only', payload: toLegacyNameRow(row) },
    { label: 'minimal-core', payload: toMinimalProfileRow(row) },
  ];

  let lastError = null;
  for (const { label, payload } of attempts) {
    console.log(`[profileRowMapper] upsert attempt "${label}" for id=${payload.id}`);
    const { data, error } = await admin
      .from('profiles')
      .upsert(payload, { onConflict: 'id' })
      .select('*')
      .single();

    if (!error) {
      console.log(`[profileRowMapper] upsert OK (${label}) profile id=${data?.id}`);
      return data;
    }
    lastError = error;
    logSupabaseRootCause(error, `${context} [${label}]`);
  }

  const err = new Error(lastError?.message || 'Could not upsert profile.');
  err.statusCode = 500;
  err.supabase = lastError;
  throw err;
}

/**
 * Resolve existing profile id by email or phone (no req.user).
 */
async function findProfileIdByEmailOrPhone(admin, email, phoneDigits) {
  const em = String(email || '').trim();
  if (em) {
    const { data, error } = await admin
      .from('profiles')
      .select('id, email')
      .ilike('email', em)
      .maybeSingle();

    if (error) {
      logSupabaseRootCause(error, 'findProfileIdByEmail');
    } else if (data?.id) {
      console.log('[profileRowMapper] resolved profile by email →', data.id);
      return String(data.id);
    }
  }

  const phone = String(phoneDigits || '').replace(/\D/g, '');
  if (phone) {
    const { data, error } = await admin
      .from('profiles')
      .select('id')
      .eq('phone_number', phone)
      .maybeSingle();

    if (error) {
      logSupabaseRootCause(error, 'findProfileIdByPhone');
    } else if (data?.id) {
      console.log('[profileRowMapper] resolved profile by phone_number →', data.id);
      return String(data.id);
    }
  }

  return null;
}

module.exports = {
  formatPakistaniCnic,
  splitDisplayName,
  buildKycFieldsFromBodies,
  buildProfileUpsertRow,
  safeUpsertProfile,
  findProfileIdByEmailOrPhone,
  toLegacyNameRow,
  toMinimalProfileRow,
  stripCnicUrlColumns,
};
