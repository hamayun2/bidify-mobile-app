/**
 * Admin: list registered users for the admin panel (Supabase or Express API).
 */

import client, { isAuxiliaryApiConfigured } from './client';
import { isSupabaseConfigured } from '../config/supabase';
import { fetchAdminUsersSupabase } from '../services/supabase/adminUsers';

function parseResponseJson(body) {
  if (body == null) return body;
  if (typeof body === 'string') {
    const t = body.trim();
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch {
      return body;
    }
  }
  return body;
}

function unwrap(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== 'object') return [];
  for (const k of ['users', 'data', 'results', 'items', 'rows']) {
    if (Array.isArray(payload[k])) return payload[k];
  }
  return [];
}

/**
 * Returns an array of:
 *  { id, email, fullName, phone, cnic, role,
 *    cnicFrontUrl, cnicBackUrl, cnicVerifiedAt,
 *    createdAt, walletBalance }
 */
export async function getAdminUsersAPI() {
  if (isSupabaseConfigured()) {
    try {
      console.log('[Bidify/Admin] getAdminUsersAPI — Supabase');
      return await fetchAdminUsersSupabase();
    } catch (e) {
      console.warn('[Bidify/Admin] Supabase users failed, trying Express', e?.message || e);
    }
  }
  if (!isAuxiliaryApiConfigured()) {
    if (isSupabaseConfigured()) return [];
    throw new Error('Could not load users — configure Supabase or EXPO_PUBLIC_API_URL.');
  }
  try {
    const response = await client.get('/admin/users', { timeout: 8000 });
    const payload = parseResponseJson(response.data);
    return unwrap(payload);
  } catch (e) {
    if (e?.message?.includes('Network') || e?.message?.includes('timeout')) {
      return [];
    }
    const msg = e?.response?.data?.message || e?.message;
    throw new Error(
      msg ||
        'Could not load users. Ensure EXPO_PUBLIC_API_URL is set, the API is running, and you are signed in as admin.'
    );
  }
}
