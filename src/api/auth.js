import client, { isAuxiliaryApiConfigured } from './client';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { isSupabaseConfigured, getSupabase } from '../services/supabaseClient';
import { logSupabaseError } from '../services/supabaseErrors';
import { loginWithSupabase } from '../services/authService';
import {
  signInWithGoogle,
  isGoogleSignInConfigured,
  completeGoogleOAuthFromCallback,
} from '../services/googleAuthService';
import { registerWithSupabase } from '../services/registrationService';
import { requestSupabasePasswordReset } from '../services/supabase/authBridge';
import { fetchUserProfileById, mapUsersRowToAppUser } from '../services/profileService';

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

export const loginWithGoogleAPI = async () => {
  if (!isSupabaseConfigured()) {
    throw new Error('Google Sign-In requires Supabase. Configure EXPO_PUBLIC_SUPABASE_URL and anon key.');
  }
  if (!isGoogleSignInConfigured()) {
    throw new Error('Google Sign-In requires Supabase to be configured.');
  }
  try {
    console.log('[Bidify/Auth] loginWithGoogleAPI — Supabase OAuth (google)');
    const result = await signInWithGoogle();
    if (result?.redirecting) return { redirecting: true };
    return result;
  } catch (e) {
    console.error('[Bidify/Auth] loginWithGoogleAPI FAILED', {
      message: e?.message,
      code: e?.code,
    });
    throw e;
  }
};

/** Mobile web: finish OAuth when Google redirects back with ?code= or #access_token= */
export const completeGoogleOAuthIfPendingAPI = async () => {
  if (!isSupabaseConfigured()) return null;
  try {
    return await completeGoogleOAuthFromCallback();
  } catch (e) {
    console.error('[Bidify/Auth] completeGoogleOAuthIfPendingAPI FAILED', {
      message: e?.message,
      code: e?.code,
    });
    throw e;
  }
};

export const loginAPI = async (email, password) => {
  if (isSupabaseConfigured()) {
    try {
      console.log('[Bidify/Auth] loginAPI — using Supabase');
      return await loginWithSupabase(email, password);
    } catch (e) {
      console.error('[Bidify/Auth] loginAPI Supabase FAILED', {
        email: String(email || '').trim(),
        message: e?.message,
        name: e?.name,
      });
      throw e;
    }
  }
  try {
    const response = await client.post('/auth/login', { email, password });
    return response.data;
  } catch (error) {
    const apiMsg = error?.response?.data?.message;
    const isNetwork =
      !apiMsg &&
      (error?.message === 'Network Error' ||
        (typeof error?.message === 'string' &&
          (error.message.includes('Network') || error.message.includes('timeout'))));

    if (isNetwork) {
      console.log('[Bidify/Auth] Backend not connected; using local mock store for login.');
      await delay(300);

      const usersStr = await AsyncStorage.getItem('mockUsers');
      const users = usersStr ? JSON.parse(usersStr) : [];

      const user = users.find((u) => u.email.toLowerCase() === email.toLowerCase());

      if (!user) {
        throw new Error(
          'Could not reach the server, and no local account matches this email. Make sure the API is running and your device is on the same Wi-Fi.'
        );
      }

      if (user.password !== password) {
        throw new Error('Incorrect password');
      }

      const { password: _p, ...safeUser } = user;
      const adminEmail = email.toLowerCase() === 'admin@bidify.com';
      return {
        token: `fake-jwt-token-${user.id}`,
        user: {
          ...safeUser,
          role: safeUser.role || (adminEmail ? 'admin' : 'user'),
        },
      };
    }
    if (apiMsg) throw new Error(apiMsg);
    throw new Error(error?.message || 'Login failed.');
  }
};

function buildCnicFormData(userData) {
  const fd = new FormData();
  const stringFields = ['fullName', 'name', 'email', 'password', 'phone', 'cnic'];
  for (const k of stringFields) {
    if (userData[k] != null && userData[k] !== '') fd.append(k, String(userData[k]));
  }
  const attach = (field, uri) => {
    if (!uri) return;
    const ext = (uri.split('.').pop() || 'jpg').split('?')[0].toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    fd.append(field, { uri, name: `${field}.${ext}`, type: mime });
  };
  attach('cnicFront', userData.cnicFrontUri);
  attach('cnicBack', userData.cnicBackUri);
  return fd;
}

async function buildCnicFormDataWeb(userData) {
  const fd = new FormData();
  const stringFields = ['fullName', 'name', 'email', 'password', 'phone', 'cnic'];
  for (const k of stringFields) {
    if (userData[k] != null && userData[k] !== '') fd.append(k, String(userData[k]));
  }
  const attach = async (field, uri) => {
    if (!uri) return;
    try {
      const res = await fetch(uri);
      const blob = await res.blob();
      const ext = (blob.type && blob.type.split('/').pop()) || 'jpg';
      fd.append(field, blob, `${field}.${ext}`);
    } catch (_) {
      /* ignore */
    }
  };
  await attach('cnicFront', userData.cnicFrontUri);
  await attach('cnicBack', userData.cnicBackUri);
  return fd;
}

export const registerAPI = async (userData) => {
  const hasCnicImages = !!(userData?.cnicFrontUri && userData?.cnicBackUri);

  if (isSupabaseConfigured()) {
    try {
      console.log('[Bidify/Auth] registerAPI — using Supabase', { hasCnicImages });
      const result = await registerWithSupabase(userData);
      if (__DEV__) {
        console.log('[Bidify/Auth] registerAPI — Supabase result keys', result && typeof result === 'object' ? Object.keys(result) : result);
      }
      if (result?.pendingEmailVerification) return result;
      if (
        result &&
        typeof result === 'object' &&
        !result.token &&
        (result.authUserId || result.user?.id) &&
        (result.email || userData.email)
      ) {
        console.log('[Bidify/Auth] registerAPI — coercing to pendingEmailVerification (no session after signUp)');
        return {
          ...result,
          pendingEmailVerification: true,
          authUserId: result.authUserId || result.user?.id,
          email: result.email || userData.email,
        };
      }
      return result;
    } catch (e) {
      console.error('[Bidify/Auth] registerAPI Supabase error', e?.message || e);
      throw e;
    }
  }

  try {
    let response;
    if (hasCnicImages) {
      const fd =
        Platform.OS === 'web'
          ? await buildCnicFormDataWeb(userData)
          : buildCnicFormData(userData);
      response = await client.post('/auth/register-cnic', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 30000,
      });
    } else {
      response = await client.post('/auth/register', userData);
    }
    return response.data;
  } catch (error) {
    const apiMsg = error?.response?.data?.message;
    const isNetwork =
      !apiMsg &&
      (error?.message === 'Network Error' ||
        (typeof error?.message === 'string' &&
          (error.message.includes('Network') || error.message.includes('timeout'))));

    if (isNetwork) {
      console.log('[Bidify/Auth] Backend not connected; saving registration to local mock store.');
      await delay(300);

      const usersStr = await AsyncStorage.getItem('mockUsers');
      const users = usersStr ? JSON.parse(usersStr) : [];

      const existingUser = users.find((u) => u.email.toLowerCase() === userData.email.toLowerCase());
      if (existingUser) {
        throw new Error('This email is already registered');
      }

      const isAdminEmail = String(userData.email || '').toLowerCase() === 'admin@bidify.com';
      const newUser = {
        id: Date.now(),
        ...userData,
        role: isAdminEmail ? 'admin' : 'user',
        verification_status: isAdminEmail ? 'verified' : 'unverified',
        verificationStatus: isAdminEmail ? 'verified' : 'unverified',
      };
      users.push(newUser);
      await AsyncStorage.setItem('mockUsers', JSON.stringify(users));

      const { password: _rp, ...safeNew } = newUser;
      return {
        token: `fake-jwt-token-reg-${newUser.id}`,
        user: { ...safeNew },
      };
    }
    if (apiMsg) throw new Error(apiMsg);
    throw new Error(error?.message || 'Registration failed.');
  }
};

/**
 * @returns {{ ok: true, message?: string, devOtp?: string }}
 */
export const requestPasswordOtpAPI = async ({ email }) => {
  const trimmed = String(email || '').trim();
  if (!trimmed) throw new Error('Please enter your email address.');

  if (isSupabaseConfigured()) {
    try {
      console.log('[Bidify/Auth] requestPasswordOtpAPI — Supabase email reset link');
      const res = await requestSupabasePasswordReset(trimmed);
      return { ...res, emailLinkFlow: true };
    } catch (e) {
      console.error('[Bidify/Auth] requestPasswordOtpAPI Supabase', e?.message || e);
      throw e;
    }
  }

  try {
    const res = await client.post(
      '/auth/password/request-otp',
      { email: trimmed },
      { timeout: 8000 }
    );
    return res?.data || { ok: true, message: 'OTP sent.' };
  } catch (error) {
    const msg = error?.response?.data?.message;
    if (msg) throw new Error(msg);
    if (error?.message?.includes('Network') || error?.message?.includes('timeout')) {
      throw new Error('Could not reach the server. Make sure the API is running and your device is on the same Wi-Fi.');
    }
    throw new Error(error?.message || 'Could not send OTP. Try again.');
  }
};

export const verifyPasswordOtpAPI = async ({ email, code }) => {
  if (isSupabaseConfigured()) {
    throw new Error('Use the password reset link from your email (Supabase). OTP verification is not used in Supabase mode.');
  }
  try {
    const res = await client.post(
      '/auth/password/verify-otp',
      { email: String(email || '').trim(), code: String(code || '').trim() },
      { timeout: 8000 }
    );
    return res?.data || {};
  } catch (error) {
    const msg = error?.response?.data?.message;
    if (msg) throw new Error(msg);
    if (error?.message?.includes('Network') || error?.message?.includes('timeout')) {
      throw new Error('Could not reach the server. Make sure the API is running and your device is on the same Wi-Fi.');
    }
    throw new Error(error?.message || 'Invalid OTP.');
  }
};

export const resetPasswordWithTokenAPI = async ({ email, resetToken, newPassword }) => {
  if (isSupabaseConfigured()) {
    throw new Error('Complete password reset from the email link (Supabase). This screen is for the legacy API only.');
  }
  try {
    const res = await client.post(
      '/auth/password/reset',
      {
        email: String(email || '').trim(),
        resetToken: String(resetToken || '').trim(),
        newPassword: String(newPassword || ''),
      },
      { timeout: 8000 }
    );
    return res?.data || {};
  } catch (error) {
    const msg = error?.response?.data?.message;
    if (msg) throw new Error(msg);
    if (error?.message?.includes('Network') || error?.message?.includes('timeout')) {
      throw new Error('Could not reach the server. Make sure the API is running and your device is on the same Wi-Fi.');
    }
    throw new Error(error?.message || 'Password reset failed.');
  }
};

export const getProfileAPI = async () => {
  if (isSupabaseConfigured()) {
    try {
      const supabase = getSupabase();
      console.log('[Bidify/Auth] getProfileAPI — Supabase');
      const {
        data: { session },
        error: sessionErr,
      } = await supabase.auth.getSession();
      if (sessionErr) {
        logSupabaseError('getProfileAPI auth.getSession', sessionErr);
      }
      if (!session?.user) {
        console.log('[Bidify/Auth] getProfileAPI — no session');
        return null;
      }
      let row = await fetchUserProfileById(session.user.id);
      if (isAuxiliaryApiConfigured()) {
        try {
          const { syncVerificationStatusAPI } = await import('./kyc');
          const synced = await syncVerificationStatusAPI();
          if (synced?.verification_status) {
            row = await fetchUserProfileById(session.user.id);
          }
        } catch (syncErr) {
          if (__DEV__) console.warn('[getProfileAPI] verification-sync', syncErr?.message);
        }
      }
      return mapUsersRowToAppUser(row, session.user);
    } catch (e) {
      logSupabaseError('getProfileAPI Supabase', e);
      return null;
    }
  }

  try {
    const response = await client.get('/auth/profile');
    return response.data;
  } catch (error) {
    if (error.message === 'Network Error' || error.message.includes('Network') || error.message.includes('timeout')) {
      try {
        const token = await AsyncStorage.getItem('authToken');
        if (token && token.startsWith('fake-jwt-token')) {
          const idStr = token.replace(/^fake-jwt-token-reg-|^fake-jwt-token-/, '');
          const id = Number(idStr);
          if (!Number.isNaN(id)) {
            const usersStr = await AsyncStorage.getItem('mockUsers');
            const users = usersStr ? JSON.parse(usersStr) : [];
            const u = users.find((x) => x.id === id);
            if (u) {
              const { password: _pp, ...pub } = u;
              const adminEmail = String(u.email || '').toLowerCase() === 'admin@bidify.com';
              return {
                id: u.id,
                name: u.name,
                email: u.email,
                phone: u.phone,
                cnic: u.cnic,
                role: pub.role || (adminEmail ? 'admin' : 'user'),
              };
            }
          }
        }
      } catch (e) {
        console.log('Mock profile fallback failed', e);
      }
      return null;
    }
    throw error.response?.data || { message: 'Network error occurred while fetching profile' };
  }
};
