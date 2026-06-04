/**
 * =============================================================================
 * AUDITED FRONTEND KEYS → SQL (run in Supabase SQL Editor)
 * See: supabase/kyc_frontend_audited_columns.sql
 *
 * registration | signupPayload:
 *   firstName→first_name, lastName→last_name, fullName|name→full_name,
 *   email→email, phoneNumber|phone→phone_number, password→Auth only
 * scanData | kycPayload:
 *   name, fatherName→father_name, cnic|cnicNumber→cnic_number,
 *   dob, address, cnicFrontUri/cnicBackUri→cnic_*_url (multipart upload)
 * isRealFace→is_real_face, verification_status, verification_submitted_at
 * =============================================================================
 */

const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const {
  scheduleMockNadraVerification,
  processMockNadraReview,
  isCnicValid,
  MOCK_NADRA_DELAY_MS,
  extractCnicFromProfile,
} = require('../mockNadraCnic');
const { isAdminProfile, isAdminEmail } = require('../utils/adminProfile');
const { JWT_SECRET, findUserById } = require('../authMiddleware');
const {
  buildProfileUpsertRow,
  safeUpsertProfile,
  findProfileIdByEmailOrPhone,
  splitDisplayName,
} = require('../utils/profileRowMapper');
const {
  parseSubmitKycRequest,
  hasAuditedSignupCredentials,
  buildKycFieldsFromAuditedBundle,
  extractSignupCredentialsFromBody,
  sanitizeBodyForLog,
} = require('../utils/kycSubmitPayload');
const { uploadCnicBuffer } = require('../utils/cnicStorage');
const { assertRegistrationFieldsUnique } = require('../utils/profileUniqueness');
const {
  logIncomingKycRequest,
  logSupabaseRootCause,
  logAuthRootCause,
} = require('../utils/kycDiagnostics');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  '';
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

function getServiceClient() {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  return createClient(String(SUPABASE_URL).replace(/\/$/, ''), SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function getAnonClient() {
  if (!SUPABASE_URL || !ANON_KEY) return null;
  return createClient(String(SUPABASE_URL).replace(/\/$/, ''), ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function resolveUserFromBearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return { user: null, token: null };

  const token = m[1].trim();
  const anon = getAnonClient();
  if (anon) {
    const { data, error } = await anon.auth.getUser(token);
    if (!error && data?.user?.id) {
      return { user: data.user, token };
    }
  }

  const expressProfileId = resolveProfileIdFromExpressBearer(req);
  if (expressProfileId) {
    return { user: { id: expressProfileId }, token };
  }

  return { user: null, token: null };
}

function resolveSessionProfileId(req, authUser) {
  const fromAuth = authUser?.id || resolveProfileIdFromExpressBearer(req);
  if (fromAuth) return String(fromAuth);

  const sessionFlag =
    String(req.body?.sessionKyc || req.body?.session_kyc || '').toLowerCase() === 'true';
  const bodyId = String(req.body?.profileUserId || req.body?.profile_user_id || '').trim();
  if (sessionFlag && bodyId) return bodyId;

  return null;
}

function resolveProfileIdFromExpressBearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  try {
    const payload = jwt.verify(m[1].trim(), JWT_SECRET);
    const storeUser = findUserById(payload.sub);
    if (storeUser?.supabaseUserId) return String(storeUser.supabaseUserId);
    return null;
  } catch {
    return null;
  }
}

/**
 * Upload multipart CNIC images (fields cnicFront/cnicBack) or http URLs from scan.cnicFrontUri.
 */
async function resolveCnicUrls(admin, userId, files, scan) {
  let cnicFrontUrl = null;
  let cnicBackUrl = null;
  const frontUri = scan?.cnicFrontUri;
  const backUri = scan?.cnicBackUri;
  if (frontUri && String(frontUri).startsWith('http')) cnicFrontUrl = String(frontUri);
  if (backUri && String(backUri).startsWith('http')) cnicBackUrl = String(backUri);

  if (files?.cnicFront?.buffer) {
    cnicFrontUrl = await uploadCnicBuffer(admin, userId, 'front', files.cnicFront);
  }
  if (files?.cnicBack?.buffer) {
    cnicBackUrl = await uploadCnicBuffer(admin, userId, 'back', files.cnicBack);
  }

  return { cnicFrontUrl, cnicBackUrl };
}

function isDuplicateAuthError(message) {
  const m = String(message || '').toLowerCase();
  return (
    m.includes('already') ||
    m.includes('exists') ||
    m.includes('registered') ||
    m.includes('duplicate')
  );
}

/** Extract JWT from Supabase Auth client responses (signUp / signIn). */
function extractSessionToken(authPayload) {
  if (!authPayload) return null;
  return (
    authPayload.session?.access_token ||
    authPayload?.data?.session?.access_token ||
    null
  );
}

function extractAuthUser(authPayload) {
  if (!authPayload) return null;
  return authPayload.user || authPayload?.data?.user || null;
}

/**
 * Step 1: client `supabase.auth.signUp` (anon) — NOT admin.createUser.
 * Idempotent: duplicate email → signInWithPassword.
 */
async function signUpOrSignInAuth(signup) {
  const anon = getAnonClient();
  if (!anon) {
    const err = new Error('Supabase anon client is not configured.');
    err.statusCode = 503;
    throw err;
  }

  const email = String(signup.email || '').trim().toLowerCase();
  const password = String(signup.password || '');

  if (!email || !password) {
    const err = new Error(
      'email and password are required for Supabase Auth signUp (check signupPayload JSON field).'
    );
    err.statusCode = 400;
    throw err;
  }

  const fullName =
    [signup.firstName, signup.lastName].filter(Boolean).join(' ').trim() ||
    String(signup.fullName || signup.name || '').trim() ||
    'Bidify User';

  const { data: authData, error: authError } = await anon.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: fullName,
        first_name: signup.firstName || null,
        last_name: signup.lastName || null,
      },
    },
  });

  const signUpData = authData;
  const signUpErr = authError;

  console.log('Supabase Auth Raw Data:', JSON.stringify(signUpData));

  if (authError) {
    console.error('❌ SUPABASE AUTH SIGNUP CRASHED:', authError.message);
    console.error('❌ SUPABASE AUTH SIGNUP DETAILS:', JSON.stringify(authError, null, 2));
  }

  const signUpUser = extractAuthUser(signUpData);
  let sessionToken =
    extractSessionToken(signUpData) ||
    signUpData?.session?.access_token ||
    signUpData?.data?.session?.access_token ||
    null;

  if (!signUpErr && signUpUser?.id) {
    console.log('[submit-kyc] signUp OK — forcing signInWithPassword for session');
    const { data: signInData, error: signInErr } = await anon.auth.signInWithPassword({
      email,
      password,
    });
    if (signInErr) {
      logAuthRootCause(signInErr, 'auth.signInWithPassword (post-signUp)');
    } else {
      console.log('Supabase Auth Raw Data (signIn):', JSON.stringify(signInData));
    }
    const signInToken =
      extractSessionToken(signInData) ||
      signInData?.session?.access_token ||
      signInData?.data?.session?.access_token ||
      null;
    sessionToken = signInToken || sessionToken;

    console.log('[submit-kyc] auth.signUp OK user id:', signUpUser.id, 'token:', !!sessionToken);
    return {
      userId: signUpUser.id,
      sessionToken,
      authUser: signUpUser,
    };
  }

  if (signUpErr && !isDuplicateAuthError(signUpErr.message)) {
    logAuthRootCause(signUpErr, 'auth.signUp');
    const err = new Error(signUpErr.message || 'Could not create account.');
    err.statusCode = 400;
    err.auth = signUpErr;
    throw err;
  }

  if (signUpErr && isDuplicateAuthError(signUpErr.message)) {
    logAuthRootCause(signUpErr, 'auth.signUp (duplicate — will signIn)');
    console.log('[submit-kyc] signUp duplicate — signInWithPassword');
    const { data: signInData, error: signErr } = await anon.auth.signInWithPassword({
      email,
      password,
    });
    if (signErr) {
      console.error('❌ SUPABASE AUTH SIGNIN CRASHED:', signErr.message);
      logAuthRootCause(signErr, 'auth.signInWithPassword (after duplicate signUp)');
      const err = new Error(signErr.message || 'Could not sign in existing account.');
      err.statusCode = 400;
      err.auth = signErr;
      throw err;
    }
    console.log('Supabase Auth Raw Data (signIn):', JSON.stringify(signInData));
    const signInUser = extractAuthUser(signInData);
    if (signInUser?.id) {
      return {
        userId: signInUser.id,
        sessionToken:
          extractSessionToken(signInData) ||
          signInData?.session?.access_token ||
          signInData?.data?.session?.access_token ||
          null,
        authUser: signInUser,
      };
    }
  }

  const err = new Error('Account creation failed — no user id from Supabase Auth signUp.');
  err.statusCode = 500;
  throw err;
}

async function signInAccessToken(email, password) {
  const anon = getAnonClient();
  if (!anon) return null;
  const { data: signInData, error: signErr } = await anon.auth.signInWithPassword({
    email,
    password,
  });
  if (signErr) {
    console.warn('[submit-kyc] signIn', signErr.message);
    return null;
  }
  return (
    extractSessionToken(signInData) ||
    signInData?.session?.access_token ||
    signInData?.data?.session?.access_token ||
    null
  );
}

/**
 * Atomic public register-with-KYC: signUp → profile upsert (auth user id) → session token.
 */
async function registerWithKycBundle(signup, scan, kycFields, files, isRealFace) {
  const admin = getServiceClient();
  if (!admin) {
    const err = new Error('Supabase service role is not configured on the server.');
    err.statusCode = 503;
    throw err;
  }

  const email = String(signup.email || '').trim().toLowerCase();
  const password = String(signup.password || '');

  await assertRegistrationFieldsUnique(admin, {
    phoneNumber:
      signup.phoneNumber || signup.phone || kycFields?.phoneNumber || kycFields?.phone,
    cnic: kycFields?.cnic || kycFields?.cnicNumber || scan?.cnic || scan?.cnicNumber,
  });

  const auth = await signUpOrSignInAuth(signup);
  const userId = auth.userId;
  let sessionToken = auth.sessionToken;
  const authUser = auth.authUser;

  if (!userId) {
    const err = new Error('Supabase Auth did not return a user id — profile upsert aborted.');
    err.statusCode = 500;
    throw err;
  }

  console.log('[submit-kyc] verified auth.users id for profile upsert:', userId);

  const cnicUrls = await resolveCnicUrls(admin, userId, files, scan);

  const row = buildProfileUpsertRow({
    id: userId,
    email,
    signupPayload: signup,
    scanData: scan,
    kycFields,
    cnicUrls,
    isRealFace,
  });

  row.verification_status = 'under_review';
  row.verification_submitted_at = new Date().toISOString();

  const profile = await safeUpsertProfile(admin, row);

  if (!sessionToken) {
    sessionToken = await signInAccessToken(email, password);
  }

  if (!sessionToken) {
    const err = new Error('Supabase Auth did not return a session access_token.');
    err.statusCode = 500;
    throw err;
  }

  return { profile, accessToken: sessionToken, userId, authUser };
}

/** Session KYC update — CNIC + selfie only; phone/email/password live on the existing profile. */
function assertMandatoryKycIdentityFields(kycFields, scan) {
  const cnicDigits = String(kycFields?.cnic || scan?.cnic || scan?.cnicNumber || '').replace(
    /\D/g,
    ''
  );

  if (cnicDigits.length !== 13) {
    const err = new Error('CNIC number is required (13 digits).');
    err.statusCode = 400;
    throw err;
  }
}

async function updateProfileKyc(admin, userId, signup, scan, kycFields, files, isRealFace) {
  let email = signup.email;
  if (!email) {
    const { data: existing } = await admin
      .from('profiles')
      .select('email')
      .eq('id', userId)
      .maybeSingle();
    email = existing?.email || '';
  }

  await assertRegistrationFieldsUnique(admin, {
    phoneNumber:
      signup.phoneNumber || signup.phone || kycFields?.phoneNumber || kycFields?.phone,
    cnic: kycFields?.cnic || kycFields?.cnicNumber || scan?.cnic || scan?.cnicNumber,
    excludeUserId: userId,
  });

  const cnicUrls = await resolveCnicUrls(admin, userId, files, scan);

  const row = buildProfileUpsertRow({
    id: userId,
    email,
    signupPayload: signup,
    scanData: scan,
    kycFields,
    cnicUrls,
    isRealFace,
  });

  row.verification_status = 'under_review';
  row.verification_submitted_at = new Date().toISOString();

  return safeUpsertProfile(admin, row);
}

function buildProfileResponse(profileRow, signup, scan, kycFields) {
  const submittedAt =
    profileRow?.verification_submitted_at || new Date().toISOString();
  const names = splitDisplayName(scan, signup);

  return {
    id: profileRow?.id || signup?.supabaseUserId || null,
    email: profileRow?.email || signup?.email || null,
    first_name: profileRow?.first_name || kycFields?.firstName || names.firstName,
    last_name: profileRow?.last_name || kycFields?.lastName || names.lastName,
    full_name:
      profileRow?.full_name ||
      kycFields?.name ||
      names.fullName ||
      null,
    phone_number: profileRow?.phone_number || kycFields?.phoneNumber || null,
    cnic_number: profileRow?.cnic_number || null,
    cnic_front_url: profileRow?.cnic_front_url || null,
    cnic_back_url: profileRow?.cnic_back_url || null,
    verification_status: profileRow?.verification_status || 'under_review',
    verification_submitted_at: submittedAt,
    is_real_face: profileRow?.is_real_face !== false,
  };
}

function buildMockNadraMeta(profileRow, kycFields, scan) {
  const cnic =
    profileRow?.cnic_number ||
    profileRow?.cnic ||
    kycFields?.cnic ||
    scan?.cnicNumber ||
    scan?.cnic ||
    null;
  const inRange = isCnicValid(cnic);
  return {
    cnic,
    cnicInRange: inRange,
    reviewDelayMs: MOCK_NADRA_DELAY_MS,
    reviewDelaySec: Math.round(MOCK_NADRA_DELAY_MS / 1000),
    expectedStatusAfterReview: inRange ? 'verified' : 'rejected',
  };
}

function buildSuccessJson(profileRow, signup, scan, kycFields, accessToken, authUser) {
  const submittedAt =
    profileRow?.verification_submitted_at || new Date().toISOString();
  const profileUser = buildProfileResponse(profileRow, signup, scan, kycFields);
  const user = {
    ...profileUser,
    id: profileUser.id || authUser?.id || null,
    email: profileUser.email || authUser?.email || signup?.email || null,
  };

  const token = accessToken || null;
  const mockNadra = buildMockNadraMeta(profileRow, kycFields, scan);

  return {
    success: true,
    token,
    accessToken: token,
    access_token: token,
    user,
    message: 'Profile successfully shifted to under_review phase',
    verification_status: user.verification_status || 'under_review',
    verification_submitted_at: submittedAt,
    profile: user,
    mockNadra,
  };
}

/**
 * POST /api/profile/submit-kyc — 100% public onboarding gateway (no auth guard).
 */
async function submitKyc(req, res) {
  console.log(
    '🚨 RAW REGISTRATION PAYLOAD RECEIVED:',
    JSON.stringify(sanitizeBodyForLog(req.body || {}))
  );

  const { signup, scan, files, isRealFace } = parseSubmitKycRequest(req);

  const bodyCreds = extractSignupCredentialsFromBody(req.body || {});
  console.log('[submit-kyc] resolved signup credentials:', {
    email: bodyCreds.email || '(missing)',
    hasPassword: Boolean(bodyCreds.password),
    passwordLength: bodyCreds.password ? bodyCreds.password.length : 0,
    parsedFrom: bodyCreds.email
      ? bodyCreds.parsedSignupPayload?.email
        ? 'signupPayload'
        : bodyCreds.parsedRegistration?.email
          ? 'registration'
          : req.body?.email
            ? 'req.body root'
            : 'merged'
      : 'none',
  });

  if (!files.selfie?.buffer) {
    return res.status(400).json({
      success: false,
      message: 'Live selfie image is required (field: selfie).',
    });
  }

  const { user: authUser, token: bearerToken } = await resolveUserFromBearer(req);
  const sessionProfileId = resolveSessionProfileId(req, authUser);
  const isSessionKyc = !!sessionProfileId;

  const kycFields = buildKycFieldsFromAuditedBundle({
    signup,
    scan,
    sessionUpdate: isSessionKyc,
  });

  try {
    assertMandatoryKycIdentityFields(kycFields, scan);
  } catch (identityErr) {
    return res.status(identityErr.statusCode || 400).json({
      success: false,
      error: identityErr.message,
      message: identityErr.message,
    });
  }

  if (!isSessionKyc && !hasAuditedSignupCredentials(signup)) {
    return res.status(401).json({
      success: false,
      error: 'Sign in required to submit KYC, or provide signup email and password for new registration.',
      message: 'Sign in required to submit KYC, or provide signup email and password for new registration.',
    });
  }

  logIncomingKycRequest(req, {
    signupPayload: isSessionKyc ? null : signup,
    scanData: scan,
    kycFields,
    isRealFace,
    sessionUserId: sessionProfileId || null,
  });

  let accessToken = null;
  let createdAuthUser = null;

  try {
    const admin = getServiceClient();
    if (!admin) {
      throw new Error('Supabase service role is not configured on the server.');
    }

    let profileRow = null;

    if (isSessionKyc) {
      const { data: prior } = await admin
        .from('profiles')
        .select('verification_status, email, phone_number')
        .eq('id', sessionProfileId)
        .maybeSingle();
      const wasRejected =
        String(prior?.verification_status || '').toLowerCase() === 'rejected' ||
        String(prior?.verification_status || '').toLowerCase() === 'failed';

      const sessionSignup = {
        email: prior?.email || authUser?.email || signup?.email || '',
        phoneNumber: prior?.phone_number || signup?.phoneNumber || '',
        phone: prior?.phone_number || signup?.phone || '',
      };

      profileRow = await updateProfileKyc(
        admin,
        sessionProfileId,
        sessionSignup,
        scan,
        kycFields,
        files,
        isRealFace
      );

      if (wasRejected) {
        console.log('[submit-kyc] KYC retry — profile updated, under_review, 5-min timer restarted');
      } else {
        console.log('[submit-kyc] KYC session submit — profile updated for', sessionProfileId);
      }

      accessToken = bearerToken || null;
      const bearer = req.headers.authorization || '';
      const m = /^Bearer\s+(.+)$/i.exec(bearer);
      if (!accessToken && m) accessToken = m[1].trim();
      createdAuthUser = authUser;
    } else if (hasAuditedSignupCredentials(signup)) {
      if (process.env.NODE_ENV !== 'production') {
        console.log('[submit-kyc] public register-with-KYC for', signup.email);
      }
      const created = await registerWithKycBundle(signup, scan, kycFields, files, isRealFace);
      profileRow = created.profile;
      accessToken = created.accessToken;
      createdAuthUser = created.authUser;
    }

    if (profileRow && admin) {
      try {
        const cnicForCheck =
          profileRow.cnic_number ||
          profileRow.cnic ||
          kycFields?.cnic ||
          scan?.cnicNumber ||
          scan?.cnic ||
          null;
        const phoneSaved =
          profileRow.phone_number || kycFields?.phoneNumber || kycFields?.phone || null;
        const skipAutoVerify =
          isAdminProfile(profileRow) || isAdminEmail(signup?.email || profileRow?.email);

        const inRange = isCnicValid(cnicForCheck);
        console.log('[submit-kyc] IMMEDIATE CNIC CHECK (Mock NADRA range 3650123031300–3650123031399):', {
          userId: profileRow.id,
          cnic: cnicForCheck,
          phone: phoneSaved,
          cnicInRange: inRange,
          outcomeAfter5Min: inRange ? 'verified' : 'rejected',
          reviewDelaySec: Math.round(MOCK_NADRA_DELAY_MS / 1000),
          autoVerifyScheduled: !skipAutoVerify,
        });

        if (!skipAutoVerify) {
          scheduleMockNadraVerification(admin, profileRow);
        }
      } catch (autoErr) {
        console.warn('[submit-kyc] Mock NADRA schedule skipped:', autoErr.message);
      }
    }

    return res
      .status(200)
      .json(
        buildSuccessJson(
          profileRow,
          signup,
          scan,
          kycFields,
          accessToken,
          createdAuthUser
        )
      );
  } catch (error) {
    if (error?.supabase) {
      logSupabaseRootCause(error.supabase, 'submitKyc outer catch');
    } else if (error?.auth) {
      logAuthRootCause(error.auth, 'submitKyc outer catch');
    } else {
      logSupabaseRootCause(error, 'submitKyc outer catch (generic)');
    }

    let status = error.statusCode || (error.auth ? 400 : 500);
    let message =
      error.message ||
      (error.auth && error.auth.message) ||
      'KYC registration failed.';
    let code = error.code || null;
    let field = error.field || null;

    const pgCode = error.supabase?.code || error.code;
    if (pgCode === '23505') {
      const hay = [
        error.supabase?.message,
        error.supabase?.details,
        error.supabase?.hint,
        error.message,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      status = 409;
      if (hay.includes('phone_number')) {
        message = 'Phone number already registered';
        code = 'PHONE_ALREADY_REGISTERED';
        field = 'phoneNumber';
      } else if (hay.includes('cnic') || hay.includes('id_card')) {
        message = 'CNIC already registered';
        code = 'CNIC_ALREADY_REGISTERED';
        field = 'cnic';
      }
    }

    if (error.auth) {
      console.error('❌ SUPABASE AUTH SIGNUP CRASHED:', error.auth.message || message);
    } else {
      console.error('❌ SUBMIT-KYC FAILED (no fake success):', message);
    }

    return res.status(status).json({
      success: false,
      error: message,
      message,
      code,
      field,
    });
  }
}

/**
 * GET /api/profile/verification-sync
 */
async function syncVerificationStatus(req, res) {
  try {
    const { user } = await resolveUserFromBearer(req);
    if (!user?.id) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const admin = getServiceClient();
    if (!admin) {
      return res.status(503).json({ success: false, message: 'Supabase not configured.' });
    }

    let { data: row, error } = await admin
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();

    if (error) {
      console.error('[verification-sync] select', error.message);
      return res.status(500).json({ success: false, message: 'Could not load profile.' });
    }

    if (row) {
      const status = String(row.verification_status || 'unverified').toLowerCase();
      const cnic = extractCnicFromProfile(row);
      const hasCnic = cnic && String(cnic).replace(/\D/g, '').length === 13;
      const hasKyc =
        !!row.verification_submitted_at || !!(row.cnic_front_url && row.cnic_back_url);

      if (status === 'unverified' && hasCnic && hasKyc) {
        const submittedAt = row.verification_submitted_at || new Date().toISOString();
        const { data: repaired, error: repairErr } = await admin
          .from('profiles')
          .update({
            verification_status: 'under_review',
            verification_submitted_at: submittedAt,
            updated_at: new Date().toISOString(),
          })
          .eq('id', user.id)
          .eq('verification_status', 'unverified')
          .select('*')
          .maybeSingle();
        if (!repairErr && repaired) {
          row = repaired;
          console.log('[verification-sync] repaired stuck unverified → under_review', user.id);
        }
      }

      if (status === 'unverified' && hasCnic && isCnicValid(cnic) && !hasKyc) {
        const { data: fastVerified, error: fastErr } = await admin
          .from('profiles')
          .update({
            verification_status: 'verified',
            verification_submitted_at: row.verification_submitted_at || new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', user.id)
          .eq('verification_status', 'unverified')
          .select('*')
          .maybeSingle();
        if (!fastErr && fastVerified) {
          row = fastVerified;
          console.log('[verification-sync] CNIC in range — set verified', user.id, cnic);
        }
      }
    }

    const updated = await processMockNadraReview(admin, row);
    const cnic = extractCnicFromProfile(updated) || updated?.cnic_number || updated?.cnic || null;

    return res.json({
      success: true,
      verification_status: updated?.verification_status || 'unverified',
      verification_submitted_at: updated?.verification_submitted_at || null,
      is_real_face: updated?.is_real_face === true,
      mockNadra: {
        cnic,
        cnicInRange: isCnicValid(cnic),
        reviewDelayMs: MOCK_NADRA_DELAY_MS,
        reviewWindowElapsed: true,
      },
    });
  } catch (err) {
    console.error('[verification-sync] error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
}

module.exports = {
  submitKyc,
  syncVerificationStatus,
};
