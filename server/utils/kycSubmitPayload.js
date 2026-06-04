/**
 * Audited frontend → POST /api/profile/submit-kyc → public.profiles
 *
 * RegisterScreen.registration (JSON: registration | signupPayload):
 *   firstName, lastName, fullName, name, email, phoneNumber, phone, password, confirmPassword
 *
 * KycScanScreen.kycPayload / scanData JSON:
 *   name, fatherName, cnic, cnicNumber, dob, address, cnicFrontUri, cnicBackUri
 *
 * Multipart file fields (src/api/kyc.js):
 *   selfie, cnicFront, cnicBack
 *
 * Additional body fields:
 *   isRealFace ('true' | 'false')
 *   Flat duplicates: name, fatherName, cnic, dob, address
 */

function parseJsonField(raw) {
  if (raw == null || raw === '') return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

/**
 * Email/password from multipart root OR nested registration | signupPayload (JSON string or object).
 */
function extractSignupCredentialsFromBody(body = {}) {
  const parsedSignupPayload = parseJsonField(body.signupPayload) || {};
  const parsedRegistration = parseJsonField(body.registration) || {};
  const nested =
    parsedSignupPayload && typeof parsedSignupPayload === 'object'
      ? { ...parsedRegistration, ...parsedSignupPayload }
      : { ...parsedRegistration };

  const email = String(
    body.email ||
      nested.email ||
      nested.Email ||
      parsedSignupPayload?.email ||
      parsedRegistration?.email ||
      ''
  )
    .trim()
    .toLowerCase();

  const password = String(
    body.password ||
      nested.password ||
      nested.Password ||
      parsedSignupPayload?.password ||
      parsedRegistration?.password ||
      ''
  );

  return { email, password, nested, parsedSignupPayload, parsedRegistration };
}

/** Log multipart body without leaking raw passwords. */
function sanitizeBodyForLog(body = {}) {
  const clone = { ...body };
  if (clone.password) clone.password = `[REDACTED len=${String(clone.password).length}]`;
  for (const key of ['signupPayload', 'registration']) {
    if (clone[key] == null) continue;
    try {
      const parsed = typeof clone[key] === 'string' ? JSON.parse(clone[key]) : { ...clone[key] };
      if (parsed.password) {
        parsed.password = `[REDACTED len=${String(parsed.password).length}]`;
      }
      clone[key] = parsed;
    } catch {
      clone[key] = '[unparseable]';
    }
  }
  return clone;
}

/**
 * @param {import('express').Request} req
 */
function extractKycFiles(req) {
  return {
    selfie: req.files?.selfie?.[0] || req.file || null,
    cnicFront: req.files?.cnicFront?.[0] || null,
    cnicBack: req.files?.cnicBack?.[0] || null,
  };
}

/**
 * Parse the full submit-kyc HTTP bundle using only audited frontend key names.
 * @returns {{ signup: object, scan: object, files: object, isRealFace: boolean }}
 */
function parseSubmitKycRequest(req) {
  const body = req.body || {};
  const creds = extractSignupCredentialsFromBody(body);
  const rawRegistration = creds.nested || {};
  const rawScan = parseJsonField(body.scanData) || {};

  const signup = {
    firstName: String(rawRegistration.firstName || rawRegistration.first_name || '').trim(),
    lastName: String(rawRegistration.lastName || rawRegistration.last_name || '').trim(),
    fullName: String(rawRegistration.fullName || rawRegistration.name || '').trim(),
    name: String(rawRegistration.name || rawRegistration.fullName || '').trim(),
    email: creds.email,
    phoneNumber: String(
      rawRegistration.phoneNumber || rawRegistration.phone_number || rawRegistration.phone || ''
    ).replace(/\D/g, ''),
    phone: String(
      rawRegistration.phone || rawRegistration.phoneNumber || rawRegistration.phone_number || ''
    ).replace(/\D/g, ''),
    password: creds.password,
    confirmPassword: String(
      rawRegistration.confirmPassword || creds.password || ''
    ),
  };

  const scan = {
    name: String(rawScan.name || req.body?.name || '').trim(),
    fatherName: String(rawScan.fatherName || req.body?.fatherName || '').trim(),
    cnic: String(
      rawScan.cnic ||
        rawScan.cnicNumber ||
        rawScan.cnic_number ||
        req.body?.cnic ||
        req.body?.cnicNumber ||
        ''
    ).trim(),
    cnicNumber: String(
      rawScan.cnicNumber ||
        rawScan.cnic ||
        rawScan.cnic_number ||
        req.body?.cnic ||
        req.body?.cnicNumber ||
        ''
    ).trim(),
    dob: String(rawScan.dob || req.body?.dob || '').trim(),
    address: String(rawScan.address || req.body?.address || '').trim(),
    phoneNumber: String(
      rawScan.phoneNumber ||
        rawScan.phone_number ||
        rawScan.phone ||
        rawRegistration.phoneNumber ||
        rawRegistration.phone ||
        ''
    ).replace(/\D/g, ''),
    phone: String(
      rawScan.phone ||
        rawScan.phoneNumber ||
        rawRegistration.phone ||
        rawRegistration.phoneNumber ||
        ''
    ).replace(/\D/g, ''),
    cnicFrontUri: rawScan.cnicFrontUri || null,
    cnicBackUri: rawScan.cnicBackUri || null,
  };

  const isRealFace = String(req.body?.isRealFace ?? 'true').toLowerCase() !== 'false';
  const files = extractKycFiles(req);

  return { signup, scan, files, isRealFace };
}

function hasAuditedSignupCredentials(signup) {
  return !!(signup?.email && signup?.password);
}

/**
 * Map audited signup + scan objects → normalized KYC field bag for DB row builder.
 */
function buildKycFieldsFromAuditedBundle({ signup, scan, sessionUpdate = false }) {
  const phoneDigits = sessionUpdate
    ? ''
    : String(
        scan.phoneNumber || scan.phone || signup.phoneNumber || signup.phone || ''
      ).replace(/\D/g, '');
  const fields = {
    firstName: signup.firstName,
    lastName: signup.lastName,
    fullName: signup.fullName || signup.name,
    name: scan.name || signup.fullName || signup.name,
    fatherName: scan.fatherName,
    cnic: scan.cnicNumber || scan.cnic,
    cnicNumber: scan.cnicNumber || scan.cnic,
    dob: scan.dob,
    address: scan.address,
    email: signup.email,
  };
  if (phoneDigits) {
    fields.phoneNumber = phoneDigits;
    fields.phone = phoneDigits;
  }
  return fields;
}

module.exports = {
  parseSubmitKycRequest,
  extractKycFiles,
  extractSignupCredentialsFromBody,
  sanitizeBodyForLog,
  hasAuditedSignupCredentials,
  buildKycFieldsFromAuditedBundle,
};
