/**
 * Redirect URL for Supabase email confirmation / recovery links.
 * Must be listed in Supabase Dashboard → Authentication → URL Configuration → Redirect URLs.
 *
 * Examples to allow:
 *   - bidify://auth/callback
 *   - exp://127.0.0.1:8081/--/auth/callback  (Expo Go dev)
 *   - http://localhost:8081/--/auth/callback (Expo web)
 */
import * as Linking from 'expo-linking';

export function getSupabaseAuthRedirectUrl() {
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
  if (typeof window === 'undefined' || !window.location?.origin) {
    return getSupabaseAuthRedirectUrl();
  }
  const origin = window.location.origin.replace(/\/$/, '');
  return `${origin}/login`;
}

/** Log redirect URLs to whitelist in Supabase → Authentication → URL Configuration. */
export function logSupabaseRedirectAllowListHints() {
  const hints = [getSupabaseAuthRedirectUrl()];
  if (typeof window !== 'undefined' && window.location?.origin) {
    const origin = window.location.origin.replace(/\/$/, '');
    hints.push(getWebOAuthRedirectUrl());
    hints.push(`${origin}/login`);
    hints.push(`${origin}/login/`);
    hints.push(`${origin}/`);
    hints.push(origin);
  }
  const unique = [...new Set(hints.filter(Boolean))];
  console.log('[Bidify/auth] Add these Redirect URLs in Supabase Dashboard:', unique);
  return unique;
}
