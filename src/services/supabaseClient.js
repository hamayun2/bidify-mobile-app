import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { webPkceStorage } from './supabase/webPkceStorage';
import { isWebRuntime } from './supabase/ssrCookies';

function readEnv(name) {
  try {
    const v = process.env[name];
    return typeof v === 'string' ? v.trim() : '';
  } catch {
    return '';
  }
}

function readExpoExtra(key) {
  try {
    const Constants = require('expo-constants');
    const extra = Constants?.expoConfig?.extra ?? Constants?.manifest?.extra;
    return typeof extra?.[key] === 'string' ? extra[key].trim() : '';
  } catch {
    return '';
  }
}

export function normalizeSupabaseUrl(raw) {
  let u = String(raw || '').trim().replace(/\/rest\/v1\/?$/i, '').replace(/\/$/, '');
  return u;
}

export function getSupabaseUrl() {
  return (
    normalizeSupabaseUrl(readEnv('EXPO_PUBLIC_SUPABASE_URL') || readEnv('SUPABASE_URL')) ||
    readExpoExtra('supabaseUrl')
  );
}

export function getSupabaseAnonKey() {
  return (
    readEnv('EXPO_PUBLIC_SUPABASE_ANON_KEY') ||
    readEnv('SUPABASE_ANON_KEY') ||
    readExpoExtra('supabaseAnonKey')
  );
}

export function isSupabaseConfigured() {
  const key = getSupabaseAnonKey();
  const k = String(key || '').trim();
  const keyOk = k.startsWith('eyJ') || k.startsWith('sb_publishable_');
  return !!(getSupabaseUrl() && k && !k.includes('YOUR_') && keyOk);
}

let _client;

export function getSupabase() {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase not configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.');
  }
  if (_client) return _client;
  const url = getSupabaseUrl();
  const key = getSupabaseAnonKey();
  if (__DEV__) {
    const k = String(key || '');
    const keyLabel = k.startsWith('eyJ')
      ? 'anon_jwt'
      : k.startsWith('sb_publishable_')
        ? 'publishable'
        : k.startsWith('sb_secret_')
          ? 'WRONG_SERVICE_KEY_ON_CLIENT'
          : 'unknown';
    console.log('[Bidify/services/supabaseClient] createClient', {
      host: new URL(url).host,
      keyKind: keyLabel,
    });
    if (keyLabel === 'WRONG_SERVICE_KEY_ON_CLIENT') {
      console.error(
        '[Bidify] EXPO_PUBLIC_SUPABASE_ANON_KEY looks like a service role key. Use the anon/publishable key from Supabase Dashboard → API.'
      );
    }
  }
  const isWeb = isWebRuntime();
  if (isWeb) {
    // Expo web SPA (incl. ngrok): localStorage PKCE survives same-origin OAuth on mobile Safari.
    _client = createClient(url, key, {
      auth: {
        storage: webPkceStorage,
        autoRefreshToken: true,
        persistSession: true,
        flowType: 'pkce',
        detectSessionInUrl: false,
      },
    });
  } else {
    _client = createClient(url, key, {
      auth: {
        storage: AsyncStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
        flowType: 'pkce',
      },
    });
  }
  return _client;
}

export const BUCKET_LISTING_IMAGES = 'listing_images';
export const BUCKET_CNIC_IMAGES = 'cnic_images';
