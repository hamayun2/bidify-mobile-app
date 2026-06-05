/**
 * Redirect URL for Supabase email confirmation / recovery links.
 * Must be listed in Supabase Dashboard → Authentication → URL Configuration → Redirect URLs.
 *
 * Examples to allow:
 *   - bidify://auth/callback
 *   - exp://127.0.0.1:8081/--/auth/callback  (Expo Go dev)
 *   - http://localhost:8081/--/auth/callback (Expo web)
 *   - https://your-subdomain.ngrok-free.dev/login (ngrok / tunnel web testing)
 */
import * as Linking from 'expo-linking';
import { Platform } from 'react-native';

/** True when the hostname is a public tunnel (ngrok, localtunnel, etc.). */
export function isTunnelWebHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return (
    h.includes('ngrok') ||
    h.endsWith('.loca.lt') ||
    h.endsWith('.trycloudflare.com')
  );
}

/**
 * Live browser origin (ngrok, localhost, production host).
 * Optional override: EXPO_PUBLIC_WEB_APP_URL=https://your-tunnel.ngrok-free.dev
 */
export function getPublicWebOrigin() {
  if (typeof window !== 'undefined' && window.location?.origin) {
    const live = window.location.origin.replace(/\/$/, '');
    const env = String(process.env.EXPO_PUBLIC_WEB_APP_URL || '').trim();
    if (env && __DEV__) {
      try {
        const envOrigin = new URL(/^https?:\/\//i.test(env) ? env : `https://${env}`).origin.replace(
          /\/$/,
          ''
        );
        if (envOrigin !== live) {
          console.warn(
            '[Bidify/auth] EXPO_PUBLIC_WEB_APP_URL differs from browser origin — OAuth uses live origin:',
            live,
            '(update .env or Supabase Redirect URLs if ngrok URL changed)'
          );
        }
      } catch {
        /* ignore */
      }
    }
    return live;
  }
  const env = String(process.env.EXPO_PUBLIC_WEB_APP_URL || '').trim();
  if (!env) return null;
  try {
    const withProto = /^https?:\/\//i.test(env) ? env : `https://${env}`;
    return new URL(withProto).origin;
  } catch {
    return null;
  }
}

function getWebAuthReturnUrl() {
  const origin = getPublicWebOrigin();
  return origin ? `${origin}/auth/callback` : null;
}

export function getSupabaseAuthRedirectUrl() {
  if (Platform.OS === 'web') {
    const webReturn = getWebAuthReturnUrl();
    if (webReturn) return webReturn;
  }
  try {
    return Linking.createURL('auth/callback');
  } catch {
    return 'bidify://auth/callback';
  }
}

/**
 * OAuth return URL for mobile / desktop browsers (must be whitelisted in Supabase Dashboard).
 * Uses a stable /login path so Redirect URLs do not depend on the current screen.
 */
export function getWebOAuthRedirectUrl() {
  const webReturn = getWebAuthReturnUrl();
  if (webReturn) return webReturn;
  return getSupabaseAuthRedirectUrl();
}

/** Log redirect URLs to whitelist in Supabase → Authentication → URL Configuration. */
export function logSupabaseRedirectAllowListHints() {
  const hints = [getSupabaseAuthRedirectUrl(), getWebOAuthRedirectUrl()];
  const origin = getPublicWebOrigin();
  if (origin) {
    hints.push(`${origin}/auth/callback`);
    hints.push(`${origin}/auth/callback/`);
    hints.push(`${origin}/login`);
    hints.push(`${origin}/login/`);
    hints.push(`${origin}/`);
    hints.push(origin);
    if (isTunnelWebHost(new URL(origin).hostname)) {
      hints.push(`${origin}/**`);
    }
  }
  const unique = [...new Set(hints.filter(Boolean))];
  console.log('[Bidify/auth] Add these Redirect URLs in Supabase Dashboard:', unique);
  return unique;
}
