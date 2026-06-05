import { Platform } from 'react-native';
import { getPublicWebOrigin, isTunnelWebHost } from '../services/supabase/authRedirect';

/** Stripe hosted checkout return target on Expo web (ngrok / production). */
export function getStripeWebReturnUrl() {
  const origin = getPublicWebOrigin();
  if (!origin) return null;
  return `${origin.replace(/\/$/, '')}/wallet`;
}

/** Mobile Safari / ngrok web cannot use window.open + postMessage reliably. */
export function shouldUseStripeRedirectCheckout() {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  const ua = String(typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const mobile = /iPhone|iPad|iPod|Android|Mobi/i.test(ua);
  return mobile || isTunnelWebHost(window.location.hostname || '');
}

const STRIPE_TOPUP_PENDING_KEY = 'bidify:stripe-topup-pending';

export function markStripeTopupPending(amount, sessionId) {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(
      STRIPE_TOPUP_PENDING_KEY,
      JSON.stringify({ amount: Number(amount) || 0, sessionId: sessionId || null, at: Date.now() })
    );
  } catch {
    /* ignore */
  }
}

export function consumeStripeTopupPending() {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(STRIPE_TOPUP_PENDING_KEY);
    sessionStorage.removeItem(STRIPE_TOPUP_PENDING_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** After Railway wallet-return redirects back to /wallet?stripeTopup=success */
export function readStripeTopupReturnFromLocation() {
  if (Platform.OS !== 'web' || typeof window === 'undefined' || !window.location?.search) {
    return null;
  }
  const params = new URLSearchParams(window.location.search);
  if (params.get('stripeTopup') !== 'success') return null;
  return {
    amount: params.get('amount') != null ? Number(params.get('amount')) : null,
    balance: params.get('balance') != null ? Number(params.get('balance')) : null,
  };
}

export function clearStripeTopupQueryFromLocation() {
  if (Platform.OS !== 'web' || typeof window === 'undefined' || !window.history?.replaceState) {
    return;
  }
  try {
    const path = window.location.pathname || '/wallet';
    window.history.replaceState({}, document.title, path);
  } catch {
    /* ignore */
  }
}
