import { getSupabase } from './supabaseClient';
import { logPostgrestError, logSupabaseError } from './supabaseErrors';
import { throwProfileError } from '../utils/profileErrors';
import { deleteAccountAPI } from '../api/account';
import { buildAccountDeleteUrl, isAuxiliaryApiConfigured } from '../api/client';
import { formatProfileDisplayName, resolveCnicFromRow } from '../utils/profileDisplay';
import { resolveEffectiveVerificationStatus } from '../utils/kycVerification';

/**
 * User profile rows in `public.profiles` (see supabase/rename_users_table_to_profiles.sql).
 */
const PROFILE_TABLE = 'profiles';

function rowIsAdmin(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.is_admin === true) return true;
  return String(row.role || '').toLowerCase() === 'admin';
}

export function mapProfileRowToAppUser(row, authUser) {
  const id = row?.id || authUser?.id;
  if (!id) return null;
  const email = row?.email || authUser?.email || '';
  const firstName =
    row?.first_name != null ? String(row.first_name).trim() : '';
  const lastName = row?.last_name != null ? String(row.last_name).trim() : '';
  const fullName = row?.full_name ? String(row.full_name).trim() : '';
  const display =
    formatProfileDisplayName({ ...row, first_name: firstName, last_name: lastName, full_name: fullName, email }) ||
    (email ? email.split('@')[0] : '') ||
    '';
  const admin = rowIsAdmin(row);
  const cnicDone = !!(row?.cnic_front_url && row?.cnic_back_url);
  const username = row?.username != null && String(row.username).trim() !== '' ? String(row.username).trim() : '';
  const cnicRaw = resolveCnicFromRow(row);
  const cnicVerifiedAt = row?.cnic_verified_at ?? row?.cnicVerifiedAt ?? null;
  const verificationStatus = resolveEffectiveVerificationStatus(row);
  const fatherName = row?.father_name != null ? String(row.father_name).trim() : '';
  const dob = row?.dob != null ? String(row.dob).trim() : '';
  const address = row?.address != null ? String(row.address).trim() : '';
  const isRealFace = row?.is_real_face === true;
  const verificationSubmittedAt = row?.verification_submitted_at ?? null;
  const phoneRaw =
    row?.phone_number != null && String(row.phone_number).trim() !== ''
      ? String(row.phone_number).trim()
      : '';

  return {
    id,
    uid: id,
    email,
    firstName,
    lastName,
    name: display,
    fullName: fullName || display,
    username,
    phoneNumber: phoneRaw,
    phone: phoneRaw,
    cnic: cnicRaw,
    cnicFrontUrl: row?.cnic_front_url ?? null,
    cnicBackUrl: row?.cnic_back_url ?? null,
    cnicVerifiedAt,
    verificationStatus,
    verification_status: verificationStatus,
    fatherName,
    father_name: fatherName,
    dob,
    address,
    isRealFace,
    is_real_face: isRealFace,
    verificationSubmittedAt,
    verification_submitted_at: verificationSubmittedAt,
    profileImage: row?.profile_image || '',
    profileCompleted: !!(row?.profile_completed === true || cnicDone),
    role: admin ? 'admin' : 'user',
    isAdmin: admin,
    walletBalance: Number(row?.wallet_balance ?? 0) || 0,
    heldBalance: Number(row?.held_balance ?? 0) || 0,
    emailVerified: !!(authUser?.email_confirmed_at || row?.email_verified),
    createdAt: row?.created_at,
  };
}

export async function fetchProfileById(userId) {
  const supabase = getSupabase();
  console.log('[Bidify/profileService] fetchProfileById', userId);
  const { data, error } = await supabase.from(PROFILE_TABLE).select('*').eq('id', userId).maybeSingle();
  if (error) {
    logPostgrestError(`${PROFILE_TABLE}.select`, error, { userId });
    throw new Error(error.message || 'Could not load profile.');
  }
  return data;
}

export async function upsertProfile(payload) {
  const supabase = getSupabase();
  const {
    data: { user: jwtUser },
    error: jwtErr,
  } = await supabase.auth.getUser();
  if (jwtErr) logSupabaseError('auth.getUser', jwtErr);
  if (!jwtUser?.id) throw new Error('Not authenticated — cannot save profile.');
  if (String(jwtUser.id) !== String(payload.id)) {
    throw new Error('Profile id must match signed-in user.');
  }

  console.log('[Bidify/profileService] upsertProfile', payload.id);
  const front = payload.cnic_front_url ?? null;
  const back = payload.cnic_back_url ?? null;
  const phoneRaw = payload.phone_number != null ? String(payload.phone_number).trim() : '';
  const cnicRaw = payload.cnic != null ? String(payload.cnic).replace(/\D/g, '').trim() : '';
  const idCardRaw =
    payload.id_card != null
      ? String(payload.id_card).replace(/\D/g, '').trim()
      : cnicRaw;
  const row = {
    id: payload.id,
    email: payload.email,
    full_name: payload.full_name ?? null,
    phone_number: phoneRaw || null,
    username: payload.username != null && String(payload.username).trim() !== '' ? String(payload.username).trim() : null,
    cnic: cnicRaw || idCardRaw || null,
    id_card: idCardRaw || cnicRaw || null,
    cnic_front_url: front,
    cnic_back_url: back,
    updated_at: new Date().toISOString(),
  };
  if (payload.father_name != null) row.father_name = String(payload.father_name).trim() || null;
  if (payload.dob != null) row.dob = String(payload.dob).trim() || null;
  if (payload.address != null) row.address = String(payload.address).trim() || null;
  if (payload.verification_status != null) {
    row.verification_status = String(payload.verification_status).trim() || 'unverified';
  }
  if (payload.verification_submitted_at != null) {
    row.verification_submitted_at = payload.verification_submitted_at;
  }
  if (payload.is_real_face != null) row.is_real_face = !!payload.is_real_face;
  if (front && back) {
    row.profile_completed = true;
    row.cnic_verified_at = new Date().toISOString();
  }

  const { data, error } = await supabase.from(PROFILE_TABLE).upsert(row, { onConflict: 'id' }).select('*').single();
  if (error) {
    logPostgrestError(`${PROFILE_TABLE}.upsert`, error);
    throw new Error(error.message || 'Could not save profile.');
  }
  console.log('[Bidify/profileService] upsertProfile OK');
  return data;
}

export async function updateProfile(userId, partial) {
  const supabase = getSupabase();
  const patch = { updated_at: new Date().toISOString() };
  if (partial.fullName != null) patch.full_name = partial.fullName;
  if (partial.phoneNumber != null || partial.phone != null) {
    const p = String(partial.phoneNumber ?? partial.phone ?? '').trim();
    patch.phone_number = p || null;
  }
  if (partial.username != null) patch.username = String(partial.username).trim() || null;
  if (partial.cnic != null) {
    const c = String(partial.cnic).replace(/\D/g, '').trim();
    patch.cnic = c || null;
    patch.id_card = c || null;
  }
  if (partial.cnicFrontUrl !== undefined) patch.cnic_front_url = partial.cnicFrontUrl;
  if (partial.cnicBackUrl !== undefined) patch.cnic_back_url = partial.cnicBackUrl;
  if (partial.cnicVerifiedAt !== undefined) patch.cnic_verified_at = partial.cnicVerifiedAt;
  if (partial.fatherName != null) patch.father_name = String(partial.fatherName).trim() || null;
  if (partial.dob != null) patch.dob = String(partial.dob).trim() || null;
  if (partial.address != null) patch.address = String(partial.address).trim() || null;
  if (partial.verificationStatus != null) {
    patch.verification_status = String(partial.verificationStatus).trim() || 'unverified';
  }
  if (partial.verificationSubmittedAt != null) {
    patch.verification_submitted_at = partial.verificationSubmittedAt;
  }
  if (partial.isRealFace != null) patch.is_real_face = !!partial.isRealFace;

  console.log('[Bidify/profileService] updateProfile', userId, Object.keys(patch));
  const { data, error } = await supabase.from(PROFILE_TABLE).update(patch).eq('id', userId).select('*').single();
  if (error) {
    logPostgrestError(`${PROFILE_TABLE}.update`, error);
    throwProfileError(error, 'Could not update profile.');
  }
  return data;
}

/**
 * Permanently delete account: storage wipe, DB cascade, auth user removal.
 * @param {string} accessToken — Supabase session access_token (required for Express delete route).
 */
export async function deleteMyAccount(accessToken) {
  const token = String(accessToken || '').trim();
  if (!token) {
    throw new Error('You are not signed in.');
  }
  if (__DEV__ && isAuxiliaryApiConfigured()) {
    console.log('[Bidify/profileService] deleteMyAccount POST', buildAccountDeleteUrl());
  }
  return deleteAccountAPI(token);
}

export async function fetchAdminProfiles() {
  const supabase = getSupabase();
  console.log('[Bidify/profileService] fetchAdminProfiles');
  const { data, error } = await supabase
    .from(PROFILE_TABLE)
    .select('*')
    .order('created_at', { ascending: false });
  if (error) {
    logPostgrestError(`${PROFILE_TABLE}.select admin`, error);
    throw new Error(error.message || 'Could not load users.');
  }
  return Array.isArray(data) ? data : [];
}

/** Legacy alias — same as mapProfileRowToAppUser */
export { mapProfileRowToAppUser as mapUsersRowToAppUser };
