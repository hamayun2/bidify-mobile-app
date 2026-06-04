import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { formatPakistaniCnic } from './cnicFormat';
import {
  KYC_STATUS_KEY,
  KYC_STATUS_UNDER_REVIEW,
} from './kycBidLockStorage';

export const KYC_LOCAL_PROFILE_KEY = 'kyc_local_profile_v1';

const DEMO_CNIC = '34101-1234567-1';

async function setItem(key, value) {
  if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
    localStorage.setItem(key, value);
    return;
  }
  await AsyncStorage.setItem(key, value);
}

async function getItem(key) {
  if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
    return localStorage.getItem(key);
  }
  return AsyncStorage.getItem(key);
}

export async function isKycUnderReviewFromStorage() {
  const status = await getItem(KYC_STATUS_KEY);
  return status === KYC_STATUS_UNDER_REVIEW;
}

/**
 * Persist KYC fields for Profile screen when Supabase profile row is sparse (FYP demo).
 */
export async function saveKycLocalProfileSnapshot({ signupPayload, scanData, profileRow } = {}) {
  const firstName = String(signupPayload?.firstName || '').trim();
  const lastName = String(signupPayload?.lastName || '').trim();
  const fullName =
    String(scanData?.name || '').trim() ||
    [firstName, lastName].filter(Boolean).join(' ').trim() ||
    String(signupPayload?.fullName || signupPayload?.name || '').trim() ||
    'Bidify User';
  const cnicRaw =
    scanData?.cnicNumber ||
    scanData?.cnic ||
    profileRow?.cnic_number ||
    profileRow?.cnic ||
    DEMO_CNIC;
  const snapshot = {
    firstName: firstName || fullName.split(/\s+/)[0] || 'User',
    lastName: lastName || fullName.split(/\s+/).slice(1).join(' '),
    fullName,
    cnic: formatPakistaniCnic(cnicRaw) || DEMO_CNIC,
    phoneNumber:
      signupPayload?.phoneNumber ||
      signupPayload?.phone ||
      profileRow?.phone_number ||
      '',
    verificationStatus: 'under_review',
    savedAt: new Date().toISOString(),
  };
  await setItem(KYC_LOCAL_PROFILE_KEY, JSON.stringify(snapshot));
  return snapshot;
}

export async function readKycLocalProfileSnapshot() {
  try {
    const raw = await getItem(KYC_LOCAL_PROFILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      ...parsed,
      cnic: formatPakistaniCnic(parsed.cnic || DEMO_CNIC) || DEMO_CNIC,
      fullName: String(parsed.fullName || '').trim() || 'Bidify User',
    };
  } catch {
    return null;
  }
}

export function readKycLocalProfileSnapshotSync() {
  if (Platform.OS !== 'web' || typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(KYC_LOCAL_PROFILE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function clearKycLocalProfileSnapshot() {
  if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
    localStorage.removeItem(KYC_LOCAL_PROFILE_KEY);
    return;
  }
  await AsyncStorage.removeItem(KYC_LOCAL_PROFILE_KEY);
}
