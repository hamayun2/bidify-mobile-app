import { Platform } from 'react-native';

/** True when running in a browser (Expo web). */
export function isWebRuntime() {
  return Platform.OS === 'web' && typeof window !== 'undefined';
}

/**
 * Cookie options for createBrowserClient (Expo web).
 * SameSite=None + Secure keeps the PKCE verifier through the Google → Supabase → ngrok
 * redirect chain on mobile Safari (Lax can drop cookies on cross-site OAuth returns).
 * Do not set `domain` — cookies bind to the current host (ngrok subdomain, production, etc.).
 */
export function getSupabaseCookieOptions() {
  const onHttps =
    isWebRuntime() &&
    typeof window.location?.protocol === 'string' &&
    window.location.protocol === 'https:';

  if (onHttps) {
    return {
      path: '/',
      sameSite: 'none',
      secure: true,
    };
  }

  // Local http:// dev (non-tunnel) — Secure cookies cannot be set without HTTPS.
  return {
    path: '/',
    sameSite: 'lax',
  };
}
