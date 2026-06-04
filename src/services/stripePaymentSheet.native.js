/**
 * Stripe Payment Sheet for wallet top-up (native iOS/Android).
 * Falls back to hosted Checkout in WalletScreen when sheet is unavailable (web / Expo Go).
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import client, { isAuxiliaryApiConfigured } from '../api/client';
import { fetchStripePaymentSheetParams } from '../api/wallet';

function readPublishableKey(fallback) {
  try {
    const k = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    if (k && String(k).trim()) return String(k).trim();
  } catch (_) {
    /* ignore */
  }
  return fallback || null;
}

function loadStripeModule() {
  try {
    // eslint-disable-next-line global-require
    return require('@stripe/stripe-react-native');
  } catch (e) {
    if (__DEV__) {
      console.warn(
        '[Bidify/Stripe] @stripe/stripe-react-native not available — use a dev build (not Expo Go) or web checkout.',
        e?.message
      );
    }
    return null;
  }
}

export function isStripePaymentSheetSupported() {
  if (Platform.OS === 'web') return false;
  return !!loadStripeModule() && isAuxiliaryApiConfigured();
}

/**
 * @returns {{ ok: true, amount: number, walletBalance?: number } | { ok: false, useCheckout: true, reason?: string }}
 */
export async function presentStripeWalletPaymentSheet(amountPkr) {
  const stripeMod = loadStripeModule();
  if (!stripeMod) {
    return { ok: false, useCheckout: true, reason: 'native_module_unavailable' };
  }

  const { initPaymentSheet, presentPaymentSheet } = stripeMod;
  if (typeof initPaymentSheet !== 'function' || typeof presentPaymentSheet !== 'function') {
    return { ok: false, useCheckout: true, reason: 'api_missing' };
  }

  console.log('[Bidify/Stripe] fetchPaymentSheetParams — amount PKR', amountPkr);
  const params = await fetchStripePaymentSheetParams(amountPkr);
  const publishableKey = readPublishableKey(params.publishableKey);
  if (!publishableKey) {
    console.error(
      '[Bidify/Stripe] Missing publishable key — set EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY in .env (pk_test_...)'
    );
    throw new Error('Stripe publishable key missing. Add EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY to .env.');
  }

  console.log('[Bidify/Stripe] initPaymentSheet');
  const initResult = await initPaymentSheet({
    merchantDisplayName: 'Bidify',
    customerId: params.customer,
    customerEphemeralKeySecret: params.ephemeralKey,
    paymentIntentClientSecret: params.paymentIntent,
    allowsDelayedPaymentMethods: false,
    returnURL: 'bidify://wallet',
  });

  if (initResult?.error) {
    console.error('[Bidify/Stripe] initPaymentSheet FAILED', initResult.error);
    throw new Error(initResult.error.message || 'Could not initialize payment sheet.');
  }

  console.log('[Bidify/Stripe] presentPaymentSheet');
  const presentResult = await presentPaymentSheet();
  if (presentResult?.error) {
    if (presentResult.error.code === 'Canceled') {
      console.log('[Bidify/Stripe] User cancelled payment sheet');
      return { ok: false, cancelled: true };
    }
    console.error('[Bidify/Stripe] presentPaymentSheet FAILED', presentResult.error);
    throw new Error(presentResult.error.message || 'Payment was not completed.');
  }

  const paymentIntentId = params.paymentIntentId || extractPaymentIntentId(params.paymentIntent);
  if (!paymentIntentId) {
    console.warn('[Bidify/Stripe] Could not parse paymentIntentId — wallet may not credit until refresh');
    return { ok: true, amount: params.amount };
  }

  console.log('[Bidify/Stripe] confirm payment on server', paymentIntentId);
  let supabaseUserId = null;
  try {
    const raw = await AsyncStorage.getItem('authUser');
    if (raw) {
      const u = JSON.parse(raw);
      supabaseUserId = u?.id || u?.uid || null;
    }
  } catch (_) {
    /* ignore */
  }
  const r = await client.post(
    '/payments/stripe/payment-sheet/confirm',
    { paymentIntentId, supabaseUserId },
    { timeout: 12000 }
  );
  const data = r.data || {};
  return {
    ok: true,
    amount: Number(data.amount) || params.amount,
    walletBalance: data.walletBalance != null ? Number(data.walletBalance) : undefined,
  };
}

function extractPaymentIntentId(clientSecret) {
  const s = String(clientSecret || '');
  const m = s.match(/^(pi_[a-zA-Z0-9]+)_secret_/);
  return m ? m[1] : null;
}

export { readPublishableKey as getStripePublishableKey };
