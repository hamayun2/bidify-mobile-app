import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const KYC_VERIFICATION_TIMESTAMP_KEY = 'kyc_verification_timestamp';
export const KYC_START_TIME_KEY = 'kyc_start_time';
export const KYC_STATUS_KEY = 'kyc_status';
export const KYC_STATUS_UNDER_REVIEW = 'UNDER_REVIEW';

/** 5-minute client restriction window after KYC submission (FYP testing sandbox). */
export const KYC_DURATION_MS = 5 * 60 * 1000;
export const KYC_BID_LOCK_MS = KYC_DURATION_MS;

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

async function removeItem(key) {
  if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
    localStorage.removeItem(key);
    return;
  }
  await AsyncStorage.removeItem(key);
}

function parseStartMs(raw) {
  if (raw == null || raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Persist global 5-minute review lock (web localStorage + native AsyncStorage). */
export async function setKycReviewLock() {
  const now = String(Date.now());
  await setItem(KYC_START_TIME_KEY, now);
  await setItem(KYC_VERIFICATION_TIMESTAMP_KEY, now);
  await setItem(KYC_STATUS_KEY, KYC_STATUS_UNDER_REVIEW);
}

export async function clearKycReviewLock() {
  await removeItem(KYC_START_TIME_KEY);
  await removeItem(KYC_VERIFICATION_TIMESTAMP_KEY);
  await removeItem(KYC_STATUS_KEY);
}

function submittedAtMs(user) {
  const raw =
    user?.verification_submitted_at ??
    user?.verificationSubmittedAt ??
    null;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

function normalizeUserUnderReview(user) {
  const s = String(
    user?.verification_status ?? user?.verificationStatus ?? ''
  )
    .trim()
    .toLowerCase();
  return s === 'under_review';
}

/**
 * Core gate: UNDER_REVIEW + within 5-minute window from kyc_start_time.
 */
export function evaluateKycUnderReview(kycStatus, kycStartTime) {
  if (kycStatus !== KYC_STATUS_UNDER_REVIEW) return false;
  const startMs = parseStartMs(kycStartTime);
  if (startMs == null) return true;
  return Date.now() - Number(startMs) < KYC_DURATION_MS;
}

/** Synchronous read for web first paint (optional). */
export function readKycUnderReviewGateSync() {
  if (Platform.OS !== 'web' || typeof localStorage === 'undefined') {
    return false;
  }
  const status = localStorage.getItem(KYC_STATUS_KEY);
  const start =
    localStorage.getItem(KYC_START_TIME_KEY) ||
    localStorage.getItem(KYC_VERIFICATION_TIMESTAMP_KEY);
  return evaluateKycUnderReview(status, start);
}

/**
 * Remaining restriction milliseconds.
 * @returns {Promise<number>}
 */
export async function getKycBidLockRemainingMs(user) {
  const status = await getItem(KYC_STATUS_KEY);
  let startMs = null;

  if (status === KYC_STATUS_UNDER_REVIEW) {
    const startRaw =
      (await getItem(KYC_START_TIME_KEY)) ||
      (await getItem(KYC_VERIFICATION_TIMESTAMP_KEY));
    if (!evaluateKycUnderReview(status, startRaw)) {
      return 0;
    }
    startMs = parseStartMs(startRaw);
  }

  if (startMs == null && user && normalizeUserUnderReview(user)) {
    startMs = submittedAtMs(user);
  }

  if (startMs == null) return 0;

  const remaining = KYC_BID_LOCK_MS - (Date.now() - startMs);
  return remaining > 0 ? remaining : 0;
}

export async function isKycUnderReviewGateActive(user) {
  const remaining = await getKycBidLockRemainingMs(user);
  if (remaining > 0) return true;

  const status = await getItem(KYC_STATUS_KEY);
  if (status === KYC_STATUS_UNDER_REVIEW) {
    return false;
  }
  return false;
}

export async function isKycBidLockActive(user) {
  const remaining = await getKycBidLockRemainingMs(user);
  return remaining > 0;
}

export function formatBidLockRemainingMinutes(remainingMs) {
  if (remainingMs <= 0) return 0;
  return Math.max(1, Math.ceil(remainingMs / 60000));
}
