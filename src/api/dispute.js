import client, { isAuxiliaryApiConfigured } from './client';

function unwrapErr(error, fallback) {
  const data = error?.response?.data;
  if (data && typeof data === 'object' && data.message) return data;
  if (typeof data === 'string' && data.trim()) return { message: data };
  if (error?.message) return { message: error.message };
  return { message: fallback };
}

/**
 * POST /api/dispute/raise
 * @param {string} orderId
 * @param {string} reason
 */
export async function raiseOrderDisputeViaApi(orderId, reason) {
  if (!isAuxiliaryApiConfigured()) {
    throw new Error('Dispute API not configured (EXPO_PUBLIC_API_URL).');
  }
  const id = orderId != null ? String(orderId).trim() : '';
  if (!id) throw new Error('Order not found.');
  try {
    const { data } = await client.post(
      '/dispute/raise',
      { orderId: id, reason: String(reason ?? '').trim() },
      { timeout: 20_000 }
    );
    return data != null && typeof data === 'object' ? data : { ok: true };
  } catch (e) {
    throw unwrapErr(e, 'Could not raise dispute.');
  }
}
