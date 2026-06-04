import client, { isAuxiliaryApiConfigured } from './client';

function apiError(error, fallback) {
  const payload = error?.response?.data;
  const err = new Error(
    (payload && typeof payload === 'object' && payload.message) ||
      error?.message ||
      fallback
  );
  if (payload?.invalidOtp) err.invalidOtp = true;
  return err;
}

/** POST /api/otp/verify — seller verifies buyer delivery code */
export async function verifyDeliveryOtpViaOtpApi(orderId, otp) {
  if (!isAuxiliaryApiConfigured()) {
    throw new Error('OTP API not configured (EXPO_PUBLIC_API_URL).');
  }
  const id = orderId != null ? String(orderId).trim() : '';
  const code = String(otp ?? '').trim();
  if (!id) throw new Error('Order not found.');
  if (!code) throw new Error('Enter the 6-digit delivery OTP.');
  try {
    const { data } = await client.post(
      '/otp/verify',
      { orderId: id, otp: code },
      { timeout: 20_000 }
    );
    return data != null && typeof data === 'object' ? data : { ok: true };
  } catch (e) {
    throw apiError(e, 'Could not verify delivery OTP.');
  }
}

/** GET /api/otp/reveal/:orderId — buyer reveals delivery OTP */
export async function revealBuyerDeliveryOtpViaOtpApi(orderId) {
  if (!isAuxiliaryApiConfigured()) {
    throw new Error('OTP API not configured (EXPO_PUBLIC_API_URL).');
  }
  const id = orderId != null ? String(orderId).trim() : '';
  if (!id) throw new Error('Order not found.');
  try {
    const { data } = await client.get(`/otp/reveal/${encodeURIComponent(id)}`, {
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
    throw apiError(e, 'Could not load delivery OTP.');
  }
}
