/**
 * Google Sign-In via Supabase OAuth (web + iOS + Android).
 */
import { Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { getSupabase, isSupabaseConfigured } from './supabaseClient';
import { getSupabaseAuthRedirectUrl, getWebOAuthRedirectUrl, logSupabaseRedirectAllowListHints } from './supabase/authRedirect';
import {
  applySupabaseAuthUrl,
  getOAuthErrorFromBrowserLocation,
  processWebAuthCallbackFromLocation,
  stripAuthParamsFromBrowserUrl,
  urlLooksLikeSupabaseAuthCallback,
} from './supabase/deepLinkSession';
import { logSupabaseError } from './supabaseErrors';
import { fetchProfileById, mapProfileRowToAppUser } from './profileService';
import { finalizePendingRegistration } from './registrationService';
import { resolvePostAuthNavigation } from '../utils/postAuthNavigation';

WebBrowser.maybeCompleteAuthSession();

export function isGoogleSignInConfigured() {
  return isSupabaseConfigured();
}

function getGoogleOAuthRedirectUrl() {
  if (Platform.OS === 'web') {
    return getWebOAuthRedirectUrl();
  }
  return getSupabaseAuthRedirectUrl();
}

function logGoogleOAuthStart(redirectTo) {
  logSupabaseRedirectAllowListHints();
  console.log('[Bidify/googleAuth] OAuth start', {
    platform: Platform.OS,
    redirectTo,
  });
}

function formatGoogleOAuthError(error, context = 'google_oauth') {
  const msg = String(error?.message || error || 'Google sign-in failed');
  const code = error?.code || error?.error || null;
  const onErrorPayload = {
    message: msg,
    code,
    status: error?.status,
    context,
    platform: Platform.OS,
  };
  console.error(`[Bidify/googleAuth] ${context} FAILED`, onErrorPayload);
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('bidify:google-oauth-error', { detail: onErrorPayload }));
  }
  const err = new Error(msg);
  if (code) err.code = code;
  if (error?.topUpRequired) err.topUpRequired = true;
  return err;
}

async function sessionToLoginResult(session) {
  const authUser = session?.user;
  if (!session?.access_token || !authUser) {
    throw new Error('Google sign-in succeeded but no session was returned.');
  }

  let profileRow = await fetchProfileById(authUser.id).catch(() => null);
  if (!profileRow) {
    const fin = await finalizePendingRegistration().catch(() => null);
    if (fin?.appUser) profileRow = await fetchProfileById(authUser.id).catch(() => null);
  }

  const appUser =
    mapProfileRowToAppUser(profileRow, authUser) || mapProfileRowToAppUser({}, authUser);

  const navigation = resolvePostAuthNavigation(appUser, profileRow);
  console.log('[Bidify/googleAuth] OAuth sign-in OK', appUser?.email, '→', navigation?.name);
  return { token: session.access_token, user: appUser, navigation };
}

/**
 * Complete OAuth after mobile browser redirects back (call on Login mount / app boot).
 */
export async function completeGoogleOAuthFromCallback() {
  if (!isSupabaseConfigured()) return null;
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;

  const preErr = getOAuthErrorFromBrowserLocation();
  if (preErr) {
    throw new Error(preErr.message);
  }

  const href = window.location.href;
  if (!urlLooksLikeSupabaseAuthCallback(href)) return null;

  const supabase = getSupabase();
  console.log('[Bidify/googleAuth] completing OAuth from browser URL');

  await processWebAuthCallbackFromLocation(supabase);

  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError) {
    throw formatGoogleOAuthError(sessionError, 'getSession_after_web_callback');
  }

  if (!session?.access_token) {
    throw new Error(
      'Google sign-in returned to the app but no access_token was found. Check Supabase Redirect URLs for this domain.'
    );
  }

  stripAuthParamsFromBrowserUrl();
  return sessionToLoginResult(session);
}

/**
 * @returns {Promise<{ token: string, user: object, navigation?: object } | { redirecting: true } | null>}
 */
export async function signInWithGoogle() {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured. Add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.');
  }

  const supabase = getSupabase();
  const redirectTo = getGoogleOAuthRedirectUrl();
  logGoogleOAuthStart(redirectTo);

  const oauthOptions = {
    redirectTo,
    skipBrowserRedirect: Platform.OS !== 'web',
    queryParams: {
      access_type: 'offline',
      prompt: 'consent',
    },
  };

  if (Platform.OS === 'web') {
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: oauthOptions,
      });
      if (error) {
        throw formatGoogleOAuthError(error, 'signInWithOAuth_web');
      }
      const authUrl = data?.url;
      if (!authUrl) {
        throw new Error('Could not start Google sign-in (no OAuth URL returned).');
      }
      if (typeof window !== 'undefined') {
        window.location.assign(authUrl);
      }
      return { redirecting: true };
    } catch (e) {
      throw formatGoogleOAuthError(e, 'signInWithOAuth_web');
    }
  }

  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: oauthOptions,
    });

    if (error) {
      throw formatGoogleOAuthError(error, 'signInWithOAuth_native');
    }

    if (!data?.url) {
      throw new Error('Could not open Google sign-in.');
    }

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);

    if (result.type === 'cancel' || result.type === 'dismiss') {
      throw new Error('Google sign-in was cancelled.');
    }

    if (result.type === 'success' && result.url) {
      try {
        await applySupabaseAuthUrl(supabase, result.url);
      } catch (applyErr) {
        throw formatGoogleOAuthError(applyErr, 'applyAuthUrl_native');
      }
    } else if (result.type === 'success' && !result.url) {
      console.warn('[Bidify/googleAuth] openAuthSession success but no result.url');
    }

    const {
      data: { session },
      error: sessionError,
    } = await supabase.auth.getSession();

    if (sessionError) {
      throw formatGoogleOAuthError(sessionError, 'getSession_native');
    }

    return sessionToLoginResult(session);
  } catch (e) {
    if (e?.message?.includes('cancelled')) throw e;
    throw formatGoogleOAuthError(e, 'signInWithGoogle_native');
  }
}

export async function signOutGoogleIfNeeded() {
  /* OAuth session is cleared via Supabase signOut */
}
