import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSupabase, isSupabaseConfigured } from '../services/supabaseClient';
import { mapUsersRowToAppUser } from '../services/profileService';
import { setKycReviewLock, KYC_STATUS_KEY, KYC_STATUS_UNDER_REVIEW } from './kycBidLockStorage';
import { saveKycLocalProfileSnapshot } from './kycLocalProfileCache';
import { normalizeVerificationStatus } from './kycVerification';

const AUTH_USER_KEY = 'authUser';
const AUTH_TOKEN_KEY = 'authToken';

/** Audited primary app entry — AppStack initial route (see AppStack.js). */
export const MAIN_APP_ROUTE = 'MainTabs';

/**
 * Normalize session JWT from submit-kyc / auth API shapes (token key mismatch guard).
 */
export function extractKycSessionToken(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const direct =
    payload.token ||
    payload.accessToken ||
    payload.access_token ||
    null;
  if (direct && typeof direct === 'string' && direct.length > 8) {
    return direct.trim();
  }
  const nested =
    payload.session?.access_token ||
    payload.data?.session?.access_token ||
    payload.auth?.session?.access_token ||
    null;
  if (nested && typeof nested === 'string') return nested.trim();
  return null;
}

/** Let React + RootNavigator commit auth state before leaving onboarding screens. */
export function waitForAuthStateCommit(extraMs = 120) {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        setTimeout(resolve, 280 + extraMs);
      });
    } else {
      setTimeout(resolve, 300 + extraMs);
    }
  });
}

/** Bind Supabase client session so onAuthStateChange and guards align with storage. */
export async function establishSupabaseSessionFromTokens({ accessToken, refreshToken }) {
  if (!isSupabaseConfigured() || !accessToken) return false;
  const supabase = getSupabase();
  if (refreshToken) {
    const { error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (error) {
      console.warn('[kycPostSubmitAuth] setSession', error.message);
      return false;
    }
    return true;
  }
  return false;
}

async function readStoredAuthUser() {
  if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
    const raw = localStorage.getItem(AUTH_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  }
  const raw = await AsyncStorage.getItem(AUTH_USER_KEY);
  return raw ? JSON.parse(raw) : null;
}

async function readStoredAuthToken() {
  if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  }
  return AsyncStorage.getItem(AUTH_TOKEN_KEY);
}

/**
 * Poll until AuthContext.login() persisted user + token (avoids first-click onboarding loop).
 */
export async function waitForAuthHydration(expectedEmail, maxMs = 5000) {
  const email = String(expectedEmail || '').trim().toLowerCase();
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const token = await readStoredAuthToken();
    const user = await readStoredAuthUser();
    const status = String(
      user?.verification_status || user?.verificationStatus || ''
    ).toLowerCase();
    const em = String(user?.email || '').trim().toLowerCase();
    if (token && user?.id) {
      if (!email || em === email) return { user, token };
    }
    await new Promise((r) => setTimeout(r, 90));
  }
  return null;
}

export async function persistKycUnderReviewLock() {
  const now = Date.now().toString();
  if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
    localStorage.setItem('kyc_status', KYC_STATUS_UNDER_REVIEW);
    localStorage.setItem('kyc_verification_timestamp', now);
    localStorage.setItem('kyc_start_time', now);
  }
  await setKycReviewLock();
}

/**
 * Write token + user to storage before navigation so RootNavigator guards pass.
 */
export async function persistOnboardingAuthToStorage({ token, appUser }) {
  const user = {
    ...appUser,
    verification_status: 'under_review',
    verificationStatus: 'under_review',
  };
  const apiToken = String(token || '').trim();
  if (!apiToken || !user?.id) {
    throw new Error('Cannot persist onboarding session without token and user id.');
  }

  if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
    localStorage.setItem(AUTH_TOKEN_KEY, apiToken);
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
    localStorage.setItem(KYC_STATUS_KEY, KYC_STATUS_UNDER_REVIEW);
  }

  await AsyncStorage.setItem(AUTH_TOKEN_KEY, apiToken);
  await AsyncStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
  await AsyncStorage.setItem(KYC_STATUS_KEY, KYC_STATUS_UNDER_REVIEW);
  await persistKycUnderReviewLock();

  return { user, token: apiToken };
}

/**
 * Poll until AuthContext reflects authenticated + non-unverified KYC (RootNavigator → AppStack).
 */
export async function waitForAuthContextReady({ getSnapshot, expectedEmail, maxMs = 10000 }) {
  const email = String(expectedEmail || '').trim().toLowerCase();
  const started = Date.now();

  while (Date.now() - started < maxMs) {
    const snap = typeof getSnapshot === 'function' ? getSnapshot() : null;
    const isAuthenticated = !!snap?.isAuthenticated;
    const user = snap?.user || null;
    const status = normalizeVerificationStatus(user);
    const em = String(user?.email || '').trim().toLowerCase();

    if (isAuthenticated && user?.id && (!email || em === email)) {
      const storedToken = await readStoredAuthToken();
      return { ready: true, user, token: storedToken || null };
    }

    const storedToken = await readStoredAuthToken();
    const storedUser = await readStoredAuthUser();
    const storedEm = String(storedUser?.email || '').trim().toLowerCase();
    if (storedToken && storedUser?.id && (!email || storedEm === email)) {
      return { ready: true, user: storedUser, token: storedToken };
    }

    await new Promise((r) => setTimeout(r, 60));
  }

  return { ready: false, user: null, token: null };
}

/**
 * After successful submit-kyc: Supabase sign-in (if needed), AuthContext login,
 * queue MainTabs for PostLoginDeepLink when RootNavigator swaps AuthStack → AppStack.
 */
export async function completeAuthAfterKycSubmit({
  data,
  signupPayload,
  registration,
  scanData,
  login,
  queuePendingRoute,
}) {
  const profileRow = data?.user || data?.profile || {};
  const appUser = mapUsersRowToAppUser(
    {
      ...profileRow,
      verification_status: data?.verification_status || profileRow?.verification_status || 'under_review',
      verification_submitted_at:
        data?.verification_submitted_at || profileRow?.verification_submitted_at,
    },
    { id: profileRow.id, email: profileRow.email || signupPayload?.email || registration?.email }
  );

  const email = String(
    signupPayload?.email || registration?.email || appUser?.email || ''
  ).trim();
  const password = String(signupPayload?.password || registration?.password || '');

  const enrichedUser = {
    ...appUser,
    verification_status:
      data?.verification_status ||
      profileRow?.verification_status ||
      'under_review',
    verificationStatus:
      data?.verification_status ||
      profileRow?.verification_status ||
      'under_review',
  };

  await saveKycLocalProfileSnapshot({
    signupPayload: signupPayload || registration,
    scanData,
    profileRow,
  });

  /** KYC lock BEFORE signIn so onAuthStateChange hydrates as under_review, not unverified. */
  await persistKycUnderReviewLock();

  let sessionToken = extractKycSessionToken(data);
  let refreshToken = null;

  if (isSupabaseConfigured() && email && password) {
    const supabase = getSupabase();
    const { data: signIn, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      console.warn('[kycPostSubmitAuth] signInWithPassword', error.message);
    } else if (signIn?.session?.access_token) {
      sessionToken = signIn.session.access_token;
      refreshToken = signIn.session.refresh_token || null;
      await establishSupabaseSessionFromTokens({
        accessToken: sessionToken,
        refreshToken,
      });
    }
  }

  if (!sessionToken) {
    throw new Error('No session token available after KYC submit.');
  }

  await persistOnboardingAuthToStorage({
    token: sessionToken,
    appUser: enrichedUser,
  });

  queuePendingRoute(MAIN_APP_ROUTE);

  if (__DEV__) {
    console.log('[kycPostSubmitAuth] Current User:', enrichedUser);
  }

  await login(sessionToken, enrichedUser, {
    showKycUnderReviewModal: false,
    kycSubmitComplete: true,
  });

  await waitForAuthStateCommit(80);
  const hydrated = await waitForAuthHydration(email, 8000);

  return {
    appUser: hydrated?.user || enrichedUser,
    token: hydrated?.token || sessionToken,
  };
}

/**
 * Logged-in KYC retry — update profile only; keep existing Supabase session (no sign-up/login).
 */
export async function completeKycRetrySubmit({ data, scanData, login, existingUser }) {
  const profileRow = data?.user || data?.profile || {};
  const appUser = mapUsersRowToAppUser(
    {
      ...profileRow,
      verification_status:
        data?.verification_status || profileRow?.verification_status || 'under_review',
      verification_submitted_at:
        data?.verification_submitted_at || profileRow?.verification_submitted_at,
    },
    existingUser || { id: profileRow.id, email: profileRow.email }
  );

  const enrichedUser = {
    ...appUser,
    verification_status: 'under_review',
    verificationStatus: 'under_review',
  };

  await saveKycLocalProfileSnapshot({
    signupPayload: existingUser,
    scanData,
    profileRow,
  });

  await persistKycUnderReviewLock();

  let sessionToken = extractKycSessionToken(data);

  if (isSupabaseConfigured()) {
    const supabase = getSupabase();
    const { data: sessionData } = await supabase.auth.getSession();
    sessionToken = sessionData?.session?.access_token || sessionToken;
  }

  if (!sessionToken) {
    sessionToken = await readStoredAuthToken();
  }

  if (!sessionToken) {
    throw new Error('Your session expired. Sign in again, then retry KYC.');
  }

  await persistOnboardingAuthToStorage({
    token: sessionToken,
    appUser: enrichedUser,
  });

  await login(sessionToken, enrichedUser, {
    showKycUnderReviewModal: false,
    kycSubmitComplete: true,
  });

  await waitForAuthStateCommit(80);

  return {
    appUser: enrichedUser,
    token: sessionToken,
  };
}
