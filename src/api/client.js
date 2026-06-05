import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSupabase, isSupabaseConfigured } from '../services/supabaseClient';
import {
  API_URL,
  getApiPublicRoot,
  getTunnelBypassHeaders,
  isAuxiliaryApiConfigured,
} from '../config/apiBase';
import {
  isLikelyOffline,
  markOffline,
  markOnline,
  syntheticOfflineError,
  isNetworkError,
} from './networkStatus';

export { API_URL, getApiPublicRoot, isAuxiliaryApiConfigured };

const client = axios.create({
  baseURL: API_URL || undefined,
  timeout: 6000,
  headers: {
    'Content-Type': 'application/json',
    ...getTunnelBypassHeaders(),
  },
});

client.interceptors.request.use(
  async (config) => {
    const tunnelHeaders = getTunnelBypassHeaders();
    if (Object.keys(tunnelHeaders).length) {
      config.headers = config.headers || {};
      Object.assign(config.headers, tunnelHeaders);
    }
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
    if (config.data && typeof config.data.append === 'function') {
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

  if (!API_URL) return '/api/account/delete';
  const base = API_URL.replace(/\/$/, '');
  if (base.endsWith('/api')) {
    return `${base}/account/delete`;
  }
  return `${base}/api/account/delete`;
}

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
