import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { getSupabase, isSupabaseConfigured } from '../services/supabaseClient';
import {
  isLikelyOffline,
  markOffline,
  markOnline,
  syntheticOfflineError,
  isNetworkError,
} from './networkStatus';

/**
 * Resolve the API base URL from `.env`.
 *
 * When `EXPO_PUBLIC_API_URL` is empty, axios has no baseURL and auxiliary
 * features (chat, hosted payments, wallet API) stay in local/mock mode.
 *
 * Host mapping:
 *   - Web: uses `window.location.hostname` (Expo web on same PC).
 *   - Android emulator: localhost → 10.0.2.2 (host machine).
 *   - Physical phone (iOS/Android): set EXPO_PUBLIC_API_DEV_HOST to your PC
 *     LAN IP (e.g. 192.168.1.3) OR put that IP directly in EXPO_PUBLIC_API_URL.
 *     localhost on a real device always means the phone itself — Stripe/wallet fail.
 */
function resolveApiBaseUrl() {
  const env = process.env.EXPO_PUBLIC_API_URL;
  let raw = env && env.trim() ? env.trim() : '';
  const devHost = String(process.env.EXPO_PUBLIC_API_DEV_HOST || '').trim();

  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location) {
    if (!raw) return '';
    try {
      const u = new URL(raw);
      const host = window.location.hostname || u.hostname;
      u.hostname = host;
      return u.toString().replace(/\/$/, '');
    } catch (_) {
      return raw;
    }
  }

  if (!raw) return '';

  try {
    const u = new URL(raw);
    const isLoopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1';

    if (Platform.OS === 'android' && isLoopback) {
      u.hostname = '10.0.2.2';
      return u.toString().replace(/\/$/, '');
    }

    if (Platform.OS !== 'web' && isLoopback && devHost) {
      u.hostname = devHost;
      if (__DEV__) {
        console.log(
          '[Bidify] EXPO_PUBLIC_API_DEV_HOST applied — API base URL for device:',
          u.toString().replace(/\/$/, '')
        );
      }
      return u.toString().replace(/\/$/, '');
    }

    if (Platform.OS !== 'web' && isLoopback && __DEV__) {
      console.warn(
        '[Bidify] EXPO_PUBLIC_API_URL uses localhost — a physical phone cannot reach your PC. ' +
          'Set EXPO_PUBLIC_API_URL=http://YOUR_PC_LAN_IP:4000/api or EXPO_PUBLIC_API_DEV_HOST=YOUR_PC_LAN_IP then restart with npx expo start --clear.'
      );
    }

    return u.toString().replace(/\/$/, '');
  } catch (_) {
    return raw;
  }
}

const API_URL = resolveApiBaseUrl();

if (typeof console !== 'undefined') {
  if (API_URL) {
    console.log('[Bidify] Auxiliary API base URL ->', API_URL);
  } else {
    console.log(
      '[Bidify] No EXPO_PUBLIC_API_URL — auxiliary API calls use mocks or clear errors until you set a base URL and run npm run api.'
    );
  }
}

const client = axios.create({
  baseURL: API_URL || undefined,
  timeout: 6000,
  headers: {
    'Content-Type': 'application/json',
  },
});

client.interceptors.request.use(
  async (config) => {
    try {
      if (config.__skipAuth) {
        delete config.headers.Authorization;
        delete config.headers.authorization;
        return config;
      }
      const existingAuth = config.headers?.Authorization || config.headers?.authorization;
      if (existingAuth) {
        return config;
      }
      // Escrow/OTP/dispute routes need Supabase JWT (auth.uid() in RPCs).
      if (isSupabaseConfigured()) {
        try {
          const supabase = getSupabase();
          const {
            data: { session },
          } = await supabase.auth.getSession();
          if (session?.access_token) {
            config.headers.Authorization = `Bearer ${session.access_token}`;
            return config;
          }
        } catch (e) {
          if (__DEV__) console.warn('[Bidify/API] getSession for Authorization failed', e?.message);
        }
      }
      const token = await AsyncStorage.getItem('authToken');
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    } catch (error) {
      console.error('Error fetching token', error);
    }
    if (
      config.data &&
      typeof config.data.append === 'function'
    ) {
      delete config.headers['Content-Type'];
    }
    if (isLikelyOffline() && !config.__bypassOfflineCache) {
      return Promise.reject(syntheticOfflineError());
    }
    return config;
  },
  (error) => Promise.reject(error)
);

client.interceptors.response.use(
  (response) => {
    markOnline();
    if (__DEV__) {
      const url = response.config?.url || '';
      if (
        /\/escrow\/|\/otp\/|\/dispute\/|\/bid|\/bids\//i.test(url) ||
        response.config?.__logResponse
      ) {
        console.log('[Bidify/API] response OK', {
          method: response.config?.method,
          url: `${response.config?.baseURL || ''}${url}`,
          status: response.status,
          data: response.data,
        });
      }
    }
    return response;
  },
  (error) => {
    if (error?.code !== 'OFFLINE_CACHED' && isNetworkError(error)) {
      markOffline();
    }
    const cfg = error?.config;
    const url = cfg?.url || '';
    if (
      __DEV__ &&
      (error?.response || /\/escrow\/|\/otp\/|\/dispute\/|\/bid|\/bids\//i.test(url))
    ) {
      console.error('[Bidify/API] response ERROR', {
        method: cfg?.method,
        url: `${cfg?.baseURL || ''}${url}`,
        status: error?.response?.status,
        statusText: error?.response?.statusText,
        data: error?.response?.data,
        message: error?.message,
      });
    }
    return Promise.reject(error);
  }
);

/** True when `EXPO_PUBLIC_API_URL` is set (Express auxiliary API for chat, payments, bid tokens). */
export function isAuxiliaryApiConfigured() {
  return typeof API_URL === 'string' && API_URL.length > 0;
}

/** Express server origin without `/api` — Stripe return URLs and hosted checkout redirects. */
export function getApiPublicRoot() {
  if (!API_URL) return 'http://localhost:4000';
  return API_URL.replace(/\/api\/?$/i, '').replace(/\/$/, '') || 'http://localhost:4000';
}

export { API_URL };

/**
 * Absolute URL for POST account deletion (must match server POST /api/account/delete).
 * - EXPO_PUBLIC_API_URL=http://host:4000/api → http://host:4000/api/account/delete
 * - EXPO_PUBLIC_API_URL=http://host:4000 → http://host:4000/api/account/delete
 */
export function buildAccountDeleteUrl() {
  const custom =
    typeof process !== 'undefined' ? process.env?.EXPO_PUBLIC_ACCOUNT_DELETE_PATH : null;
  if (custom && String(custom).trim()) {
    const t = String(custom).trim();
    if (/^https?:\/\//i.test(t)) return t.replace(/\/$/, '');
    const base = (API_URL || '').replace(/\/$/, '');
    const path = t.startsWith('/') ? t : `/${t}`;
    return base ? `${base}${path}` : path;
  }

  const base = (API_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
  if (base.endsWith('/api')) {
    return `${base}/account/delete`;
  }
  return `${base}/api/account/delete`;
}

/** @deprecated use buildAccountDeleteUrl — relative path for logging only */
export function getAccountDeletePath() {
  const url = buildAccountDeleteUrl();
  if (!API_URL) {
    try {
      return new URL(url).pathname;
    } catch (_) {
      return '/api/account/delete';
    }
  }
  const base = API_URL.replace(/\/$/, '');
  return url.startsWith(base) ? url.slice(base.length) || '/account/delete' : url;
}

export default client;
