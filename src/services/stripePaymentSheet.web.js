/**
 * Web wallet payments — browser checkout only (no @stripe/stripe-react-native).
 */

function readPublishableKey(fallback) {
  try {
    const k = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    if (k && String(k).trim()) return String(k).trim();
  } catch (_) {
    /* ignore */
  }
  return fallback || null;
}

export function isStripePaymentSheetSupported() {
  return false;
}

export async function presentStripeWalletPaymentSheet() {
  return { ok: false, useCheckout: true, reason: 'web' };
}

export { readPublishableKey as getStripePublishableKey };
