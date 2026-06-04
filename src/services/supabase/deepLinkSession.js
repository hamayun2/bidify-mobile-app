/**
 * Parse Supabase auth redirect URLs (implicit hash or PKCE query) and apply to the client.
 * Used when email confirmation / magic links open the app via custom scheme or universal link.
 */

import { logSupabaseError } from './postgrestErrors';

function parseQueryOrHashParams(url) {
  const out = {};
  const addFrom = (segment) => {
    if (!segment) return;
    const q = new URLSearchParams(segment);
    q.forEach((v, k) => {
      out[k] = v;
    });
  };
  const hashIdx = url.indexOf('#');
  if (hashIdx >= 0) addFrom(url.slice(hashIdx + 1));
  const qIdx = url.indexOf('?');
  if (qIdx >= 0) {
    const after = url.slice(qIdx + 1);
    const end = after.indexOf('#');
    addFrom(end >= 0 ? after.slice(0, end) : after);
  }
  return out;
}

/**
 * @param {string} url
 * @returns {boolean}
 */
export function urlLooksLikeSupabaseAuthCallback(url) {
  if (!url || typeof url !== 'string') return false;
  return (
    url.includes('access_token=') ||
    url.includes('refresh_token=') ||
    /[?&#]code=/.test(url)
  );
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} url
 */
/**
 * OAuth error params Google/Supabase may return (?error=access_denied&error_description=...)
 */
export function parseOAuthErrorFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const params = parseQueryOrHashParams(url);
  const err = params.error || params.error_code;
  if (!err) return null;
  const desc = params.error_description ? decodeURIComponent(String(params.error_description).replace(/\+/g, ' ')) : '';
  const code = String(err);
  let friendly = desc || code;
  if (/redirect_uri_mismatch/i.test(desc) || code === 'redirect_uri_mismatch') {
    friendly =
      'Redirect URI mismatch — add this site URL under Supabase → Authentication → URL Configuration → Redirect URLs.';
  } else if (/invalid_client/i.test(desc) || code === 'invalid_client') {
    friendly = 'Google OAuth client misconfigured (invalid_client). Check Supabase Google provider settings.';
  } else if (code === 'access_denied') {
    friendly = 'Google sign-in was denied or cancelled.';
  }
  return { code, description: desc, message: friendly };
}

export function getOAuthErrorFromBrowserLocation() {
  if (typeof window === 'undefined' || !window.location?.href) return null;
  return parseOAuthErrorFromUrl(window.location.href);
}

/**
 * Remove tokens from the address bar after session is stored (avoids blank re-load on mobile web).
 */
const OAUTH_ERROR_STORAGE_KEY = 'bidify_oauth_error';

export function stashOAuthErrorForLoginScreen(message) {
  if (!message || typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(OAUTH_ERROR_STORAGE_KEY, String(message));
  } catch (e) {
    console.warn('[Bidify/auth-callback] stashOAuthErrorForLoginScreen', e?.message);
  }
}

export function consumeOAuthErrorFromStorage() {
  if (typeof window === 'undefined') return null;
  try {
    const msg = sessionStorage.getItem(OAUTH_ERROR_STORAGE_KEY);
    if (msg) sessionStorage.removeItem(OAUTH_ERROR_STORAGE_KEY);
    return msg || null;
  } catch {
    return null;
  }
}

export function stripAuthParamsFromBrowserUrl() {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  try {
    const origin = window.location.origin;
    const path = window.location.pathname || '/';
    const clean =
      path === '/' || path === ''
        ? `${origin}/login`
        : `${origin}${path}`;
    window.history.replaceState({}, document.title, clean);
  } catch (e) {
    console.warn('[Bidify/auth-callback] stripAuthParamsFromBrowserUrl', e?.message);
  }
}

/** Prevents parallel PKCE exchanges when AuthContext and LoginScreen both boot with ?code= */
let webAuthCallbackPromise = null;

/**
 * Apply OAuth callback from current browser URL (mobile web return from Google).
 * @returns {Promise<boolean>} true if URL contained auth payload
 */
export async function processWebAuthCallbackFromLocation(supabase) {
  if (!supabase || typeof window === 'undefined') return false;
  const href = window.location.href;
  const oauthErr = parseOAuthErrorFromUrl(href);
  if (oauthErr) {
    console.error('[Bidify/auth-callback] OAuth error in URL', oauthErr);
    stashOAuthErrorForLoginScreen(oauthErr.message);
    throw new Error(oauthErr.message);
  }
  if (!urlLooksLikeSupabaseAuthCallback(href)) return false;

  if (webAuthCallbackPromise) {
    return webAuthCallbackPromise;
  }

  webAuthCallbackPromise = (async () => {
    try {
      await applySupabaseAuthUrl(supabase, href);
      stripAuthParamsFromBrowserUrl();
      return true;
    } finally {
      webAuthCallbackPromise = null;
    }
  })();

  return webAuthCallbackPromise;
}

export async function applySupabaseAuthUrl(supabase, url) {
  if (!supabase || !url) return;
  const oauthErr = parseOAuthErrorFromUrl(url);
  if (oauthErr) {
    console.error('[Bidify/auth-callback] applySupabaseAuthUrl — OAuth error', oauthErr);
    stashOAuthErrorForLoginScreen(oauthErr.message);
    throw new Error(oauthErr.message);
  }
  console.log('[Bidify/auth-callback] applySupabaseAuthUrl — parsing', url.split('?')[0].slice(0, 80));
  try {
    const params = parseQueryOrHashParams(url);
    const code = params.code;
    if (code) {
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        logSupabaseError('applySupabaseAuthUrl.exchangeCodeForSession', error);
        throw formatAuthCallbackError(error);
      }
      console.log('[Bidify/auth-callback] PKCE exchange OK', !!data?.session);
      return;
    }
    const access_token = params.access_token;
    const refresh_token = params.refresh_token;
    if (access_token && refresh_token) {
      const { data, error } = await supabase.auth.setSession({ access_token, refresh_token });
      if (error) {
        logSupabaseError('applySupabaseAuthUrl.setSession', error);
        throw formatAuthCallbackError(error);
      }
      console.log('[Bidify/auth-callback] setSession OK', !!data?.session, data?.session?.user?.email);
    } else {
      console.warn('[Bidify/auth-callback] no tokens or code in URL fragment/query');
    }
  } catch (e) {
    if (e?.message && !e?.code) throw e;
    logSupabaseError('applySupabaseAuthUrl', e);
    throw formatAuthCallbackError(e);
  }
}

function formatAuthCallbackError(error) {
  const msg = String(error?.message || error || 'Auth callback failed');
  const err = new Error(msg);
  if (/redirect_uri/i.test(msg)) {
    err.code = 'redirect_uri_mismatch';
  } else if (/invalid_client/i.test(msg)) {
    err.code = 'invalid_client';
  }
  console.error('[Bidify/auth-callback] FAILED', {
    message: msg,
    code: err.code,
  });
  stashOAuthErrorForLoginScreen(msg);
  return err;
}
