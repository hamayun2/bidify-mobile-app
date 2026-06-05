import { Platform } from 'react-native';
import { isTunnelWebHost } from '../services/supabase/authRedirect';

/** Normalize env URL — adds https:// when scheme omitted (e.g. Railway hostnames). */
export function normalizeApiUrlString(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

export function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

function readTunnelApiUrl() {
  return normalizeApiUrlString(process.env.EXPO_PUBLIC_API_TUNNEL_URL);
}

/**
 * Resolve the Express auxiliary API base URL (usually ends with `/api`).
 *
 * Web via ngrok / mobile Safari:
 *   - Uses EXPO_PUBLIC_API_URL when it is a public host (Railway, etc.)
 *   - When .env still has localhost, prefers EXPO_PUBLIC_API_TUNNEL_URL (second ngrok on :4000)
 *     then EXPO_PUBLIC_API_DEV_HOST (LAN — same Wi‑Fi only)
 *
 * Native devices:
 *   - localhost → EXPO_PUBLIC_API_DEV_HOST or 10.0.2.2 (Android emulator)
 */
export function resolveApiBaseUrl() {
  const tunnelApi = readTunnelApiUrl();
  const env = process.env.EXPO_PUBLIC_API_URL;
  let raw = env && env.trim() ? normalizeApiUrlString(env.trim()) : '';
  const devHost = String(process.env.EXPO_PUBLIC_API_DEV_HOST || '').trim();

  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location) {
    const pageHost = window.location.hostname || '';
    const pageIsLoopback = isLoopbackHost(pageHost);
    const pageIsTunnel = isTunnelWebHost(pageHost);

    if (!raw) return '';

    try {
      const u = new URL(raw);
      const apiIsLoopback = isLoopbackHost(u.hostname);

      if (pageIsTunnel) {
        if (tunnelApi) {
          return tunnelApi.replace(/\/$/, '');
        }
        if (apiIsLoopback && devHost) {
          u.protocol = 'http:';
          u.hostname = devHost;
          if (!u.port || u.port === '80' || u.port === '443') {
            u.port = '4000';
          }
          if (__DEV__) {
            console.log(
              '[Bidify/apiBase] ngrok web + localhost API env → LAN host:',
              u.toString().replace(/\/$/, '')
            );
          }
          return u.toString().replace(/\/$/, '');
        }
        if (!apiIsLoopback) {
          return u.toString().replace(/\/$/, '');
        }
        if (__DEV__) {
          console.warn(
            '[Bidify/apiBase] ngrok web cannot reach localhost API. Set EXPO_PUBLIC_API_URL to your deployed API ' +
              '(Railway) or run a second tunnel: ngrok http 4000 and set EXPO_PUBLIC_API_TUNNEL_URL=https://….ngrok-free.dev/api'
          );
        }
        return u.toString().replace(/\/$/, '');
      }

      if (pageIsLoopback && apiIsLoopback) {
        u.hostname = pageHost;
      }
      return u.toString().replace(/\/$/, '');
    } catch (_) {
      return raw;
    }
  }

  if (!raw) return '';

  try {
    const u = new URL(raw);
    const isLoopback = isLoopbackHost(u.hostname);

    if (Platform.OS === 'android' && isLoopback) {
      u.hostname = '10.0.2.2';
      return u.toString().replace(/\/$/, '');
    }

    if (Platform.OS !== 'web' && isLoopback && devHost) {
      u.protocol = 'http:';
      u.hostname = devHost;
      if (!u.port || u.port === '80' || u.port === '443') {
        u.port = '4000';
      }
      if (__DEV__) {
        console.log(
          '[Bidify/apiBase] EXPO_PUBLIC_API_DEV_HOST applied:',
          u.toString().replace(/\/$/, '')
        );
      }
      return u.toString().replace(/\/$/, '');
    }

    if (Platform.OS !== 'web' && isLoopback && __DEV__) {
      console.warn(
        '[Bidify/apiBase] EXPO_PUBLIC_API_URL uses localhost — set EXPO_PUBLIC_API_DEV_HOST or use a public API URL.'
      );
    }

    return u.toString().replace(/\/$/, '');
  } catch (_) {
    return raw;
  }
}

const API_URL = resolveApiBaseUrl();

if (typeof console !== 'undefined' && __DEV__) {
  if (API_URL) {
    console.log('[Bidify/apiBase] Auxiliary API base URL ->', API_URL);
  }
}

/** Origin without `/api` — uploads, Stripe return URLs, media rewrite target. */
export function getApiOrigin() {
  if (!API_URL) return '';
  try {
    const u = new URL(API_URL);
    return `${u.protocol}//${u.host}`;
  } catch {
    return String(API_URL).replace(/\/api\/?$/i, '').replace(/\/$/, '');
  }
}

/** Express server root (no `/api` suffix). */
export function getApiPublicRoot() {
  const origin = getApiOrigin();
  return origin || '';
}

export function isAuxiliaryApiConfigured() {
  return typeof API_URL === 'string' && API_URL.length > 0;
}

/** localtunnel serves HTTP 511 HTML unless this header is sent (mobile CNIC scan, etc.). */
export function usesLocaltunnelApi() {
  const candidates = [
    API_URL,
    readTunnelApiUrl(),
    process.env.EXPO_PUBLIC_API_TUNNEL_URL,
  ];
  return candidates.some((raw) => /\.loca\.lt/i.test(String(raw || '')));
}

export function getLocaltunnelBypassHeaders() {
  if (!usesLocaltunnelApi()) return {};
  return { 'Bypass-Tunnel-Reminder': 'true' };
}

function usesNgrokApi() {
  const candidates = [
    API_URL,
    readTunnelApiUrl(),
    process.env.EXPO_PUBLIC_API_TUNNEL_URL,
    process.env.EXPO_PUBLIC_WEB_APP_URL,
  ];
  return candidates.some((raw) => /ngrok-free\.(dev|app)/i.test(String(raw || '')));
}

export function getNgrokBypassHeaders() {
  if (!usesNgrokApi()) return {};
  return { 'ngrok-skip-browser-warning': 'true' };
}

export function getTunnelBypassHeaders() {
  return { ...getLocaltunnelBypassHeaders(), ...getNgrokBypassHeaders() };
}

export { API_URL };
