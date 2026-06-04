import client, { isAuxiliaryApiConfigured } from './client';

function unwrapErr(error, fallback) {
  const data = error?.response?.data;
  if (data && typeof data === 'object' && data.message) return data;
  if (typeof data === 'string' && data.trim()) return { message: data };
  if (error?.message) return { message: error.message };
  return { message: fallback };
}

/** GET /api/escrow/bundle — balance + ledger + wallet_transactions */
export async function fetchEscrowWalletBundleViaApi() {
  if (!isAuxiliaryApiConfigured()) {
    throw new Error('Escrow API not configured (EXPO_PUBLIC_API_URL).');
  }
  const { data } = await client.get('/escrow/bundle', { timeout: 12_000 });
  return data;
}

/** POST /api/escrow/buy — lock bid/buy amount in wallet escrow */
export async function escrowBuyViaApi(listingId, amount) {
  if (!isAuxiliaryApiConfigured()) {
    throw new Error('Escrow API not configured (EXPO_PUBLIC_API_URL).');
  }
  const id = listingId != null ? String(listingId).trim() : '';
  const n = Number(amount);
  if (!id) throw new Error('Listing not found.');
  if (!Number.isFinite(n) || n <= 0) throw new Error('Enter a valid amount.');
  try {
    const { data } = await client.post('/escrow/buy', { listingId: id, amount: n }, { timeout: 20_000 });
    return data;
  } catch (e) {
    throw unwrapErr(e, 'Could not lock funds in escrow.');
  }
}

/** GET /api/escrow/orders */
export async function fetchEscrowOrdersViaApi() {
  if (!isAuxiliaryApiConfigured()) {
    throw new Error('Escrow API not configured (EXPO_PUBLIC_API_URL).');
  }
  const { data } = await client.get('/escrow/orders', { timeout: 12_000 });
  return Array.isArray(data?.orders) ? data.orders : [];
}

/** POST /api/escrow/resolve/:listingId */
export async function resolveAuctionViaApi(listingId, opts = {}) {
  if (!isAuxiliaryApiConfigured()) {
    throw new Error('Escrow API not configured (EXPO_PUBLIC_API_URL).');
  }
  const id = listingId != null ? String(listingId).trim() : '';
  if (!id) throw new Error('Listing not found.');
  const { data } = await client.post(
    `/escrow/resolve/${encodeURIComponent(id)}`,
    { force: !!opts.force },
    { timeout: 30_000 }
  );
  return data;
}

/** POST /api/escrow/resolve-expired */
export async function resolveExpiredAuctionsViaEscrowApi(limit = 50) {
  if (!isAuxiliaryApiConfigured()) {
    throw new Error('Escrow API not configured (EXPO_PUBLIC_API_URL).');
  }
  const { data } = await client.post('/escrow/resolve-expired', { limit }, { timeout: 30_000 });
  return data;
}

/** POST /api/escrow/orders/:orderId/verify-otp */
export async function verifyDeliveryOtpViaApi(orderId, otp) {
  if (!isAuxiliaryApiConfigured()) {
    throw new Error('Escrow API not configured (EXPO_PUBLIC_API_URL).');
  }
  const id = orderId != null ? String(orderId).trim() : '';
  const code = String(otp ?? '').trim();
  if (!id) throw new Error('Order not found.');
  if (!code) throw new Error('Enter the 6-digit delivery OTP.');
  try {
    const { data } = await client.post(
      `/escrow/orders/${encodeURIComponent(id)}/verify-otp`,
      { otp: code },
      { timeout: 20_000 }
    );
    return data != null && typeof data === 'object' ? data : { ok: true };
  } catch (e) {
    const payload = e?.response?.data;
    const err = new Error(
      (payload && typeof payload === 'object' && payload.message) ||
        e?.message ||
        'Could not verify delivery OTP.'
    );
    if (payload?.invalidOtp) err.invalidOtp = true;
    throw err;
  }
}

/** GET /api/escrow/orders/:orderId/reveal-otp */
export async function revealBuyerDeliveryOtpViaApi(orderId) {
  if (!isAuxiliaryApiConfigured()) {
    throw new Error('Escrow API not configured (EXPO_PUBLIC_API_URL).');
  }
  const id = orderId != null ? String(orderId).trim() : '';
  if (!id) throw new Error('Order not found.');
  try {
    const { data } = await client.get(`/escrow/orders/${encodeURIComponent(id)}/reveal-otp`, {
      timeout: 12_000,
    });
    const row = data != null && typeof data === 'object' ? data : {};
    const otp =
      row.otp != null
        ? String(row.otp).trim()
        : row.delivery_otp != null
          ? String(row.delivery_otp).trim()
          : '';
    return { ...row, otp };
  } catch (e) {
    throw unwrapErr(e, 'Could not load delivery OTP.');
  }
}

export async function fetchEscrowLedgerViaApi(limit = 80) {
  if (!isAuxiliaryApiConfigured()) throw new Error('Escrow API not configured.');
  try {
    const { data } = await client.get('/escrow/ledger', { params: { limit }, timeout: 12_000 });
    return Array.isArray(data?.ledger) ? data.ledger : [];
  } catch (e) {
    throw unwrapErr(e, 'Could not load wallet ledger');
  }
}

export async function fetchEscrowTransactionsViaApi(limit = 80) {
  if (!isAuxiliaryApiConfigured()) throw new Error('Escrow API not configured.');
  try {
    const { data } = await client.get('/escrow/transactions', { params: { limit }, timeout: 12_000 });
    return Array.isArray(data?.transactions) ? data.transactions : [];
  } catch (e) {
    throw unwrapErr(e, 'Could not load wallet transactions');
  }
}
