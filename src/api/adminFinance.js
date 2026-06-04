import AsyncStorage from '@react-native-async-storage/async-storage';
import client from './client';

const STORAGE_KEY = 'bidifyAdminPaymentLog';

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

function unwrapPaymentsPayload(payload) {
  if (payload == null) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== 'object') return [];
  for (const k of ['payments', 'data', 'transactions', 'results', 'items', 'rows']) {
    const v = payload[k];
    if (Array.isArray(v)) return v;
  }
  if (payload.data && typeof payload.data === 'object' && Array.isArray(payload.data.payments)) {
    return payload.data.payments;
  }
  return [];
}

/**
 * Persist marketplace money movement for the admin panel (offline log + optional server sync).
 * @param {{ kind: 'buy_now' | 'auction_bid', listingId: string, amount: number, listingTitle?: string, buyerId?: string, buyerName?: string, status?: string }} entry
 */
export async function recordPaymentActivity(entry) {
  const row = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    createdAt: new Date().toISOString(),
    status: entry.status || (entry.kind === 'buy_now' ? 'completed' : 'logged'),
    ...entry,
  };
  try {
    const str = await AsyncStorage.getItem(STORAGE_KEY);
    const arr = str ? JSON.parse(str) : [];
    arr.unshift(row);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(arr.slice(0, 500)));
  } catch (e) {
    console.warn('recordPaymentActivity', e);
  }
  return row;
}

/** Admin: payment & bid activity. Uses GET /admin/payments when online; otherwise local log. */
export async function getAdminPaymentsAPI() {
  const p =
    typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_ADMIN_PAYMENTS_PATH != null
      ? String(process.env.EXPO_PUBLIC_ADMIN_PAYMENTS_PATH).trim()
      : '/admin/payments';
  const path = p.startsWith('/') ? p : `/${p}`;
  try {
    const response = await client.get(path, { timeout: 6000 });
    const payload = parseResponseJson(response.data);
    const rows = unwrapPaymentsPayload(payload);
    if (Array.isArray(rows) && rows.length > 0) return rows;
  } catch (_) {
    /* fall back */
  }
  try {
    const str = await AsyncStorage.getItem(STORAGE_KEY);
    const local = str ? JSON.parse(str) : [];
    return Array.isArray(local) ? local : [];
  } catch {
    return [];
  }
}
