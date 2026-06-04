/**
 * Payment gateway configuration from Expo public env.
 *
 * Set in `.env` (loaded by Expo automatically):
 *
 *   EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...   (publishable only — NEVER sk_*_)
 *   EXPO_PUBLIC_PAYMENTS_STRIPE_ENABLED=true
 *
 *   EXPO_PUBLIC_PAYMENTS_EASYPAISA_ENABLED=true
 *   EXPO_PUBLIC_EASYPAISA_STORE_ID=...               (public store / merchant id; secrets stay on server)
 *
 *   EXPO_PUBLIC_PAYMENTS_JAZZCASH_ENABLED=true
 *   EXPO_PUBLIC_JAZZCASH_MERCHANT_ID=...
 *
 * Optional path overrides for your backend (must return { url } or similar — see paymentGateway.js):
 *   EXPO_PUBLIC_PAYMENT_STRIPE_SESSION_PATH=/payments/stripe/checkout-session
 *   EXPO_PUBLIC_PAYMENT_EASYPAISA_SESSION_PATH=/payments/easypaisa/session
 *   EXPO_PUBLIC_PAYMENT_JAZZCASH_SESSION_PATH=/payments/jazzcash/session
 */

function truthy(v) {
  if (v == null || v === '') return false;
  return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase().trim());
}

export function getPaymentGatewayConfig() {
  const pk = (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY) || '';
  const publishableKey = typeof pk === 'string' ? pk.trim() : '';

  return {
    stripe: {
      enabled:
        truthy(
          typeof process !== 'undefined' ? process.env?.EXPO_PUBLIC_PAYMENTS_STRIPE_ENABLED : null
        ) || publishableKey.startsWith('pk_'),
      publishableKey,
    },
    easypaisa: {
      enabled: truthy(
        typeof process !== 'undefined' ? process.env?.EXPO_PUBLIC_PAYMENTS_EASYPAISA_ENABLED : null
      ),
      storeId:
        (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_EASYPAISA_STORE_ID?.trim()) || '',
    },
    jazzcash: {
      enabled: truthy(
        typeof process !== 'undefined' ? process.env?.EXPO_PUBLIC_PAYMENTS_JAZZCASH_ENABLED : null
      ),
      merchantId:
        (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_JAZZCASH_MERCHANT_ID?.trim()) ||
        '',
    },
  };
}

/** True if at least one gateway is turned on for the checkout UI. */
export function hasConfiguredPaymentGateways() {
  const c = getPaymentGatewayConfig();
  return c.stripe.enabled || c.easypaisa.enabled || c.jazzcash.enabled;
}
