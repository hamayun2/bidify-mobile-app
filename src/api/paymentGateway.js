import client, { isAuxiliaryApiConfigured } from './client';

function parseJson(body) {
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

/** Extract payment / checkout URL from common API response shapes. */
export function unwrapCheckoutUrl(payload) {
  const p = parseJson(payload);
  if (!p) return null;
  if (typeof p === 'string' && /^https?:\/\//i.test(p.trim())) return p.trim();
  const root = p.data && typeof p.data === 'object' ? p.data : p;
  const url =
    root.url ||
    root.paymentUrl ||
    root.redirectUrl ||
    root.checkoutUrl ||
    root.href ||
    (root.session && root.session.url);
  return typeof url === 'string' && url.trim() ? url.trim() : null;
}

function pathOrDefault(envKey, fallback) {
  const raw = typeof process !== 'undefined' ? process.env?.[envKey] : null;
  if (raw && typeof raw === 'string') {
    const t = raw.trim();
    if (t) return t.startsWith('/') ? t : `/${t}`;
  }
  return fallback;
}

const stripeSessionPath = () =>
  pathOrDefault('EXPO_PUBLIC_PAYMENT_STRIPE_SESSION_PATH', '/payments/stripe/checkout-session');
const easypaisaSessionPath = () =>
  pathOrDefault('EXPO_PUBLIC_PAYMENT_EASYPAISA_SESSION_PATH', '/payments/easypaisa/session');
const jazzcashSessionPath = () =>
  pathOrDefault('EXPO_PUBLIC_PAYMENT_JAZZCASH_SESSION_PATH', '/payments/jazzcash/session');

function unwrapSessionResult(payload) {
  const p = parseJson(payload);
  const root = p && p.data && typeof p.data === 'object' ? p.data : p || {};
  return {
    url: unwrapCheckoutUrl(payload),
    sessionId: root.sessionId || root.id || null,
    status: root.status || (root.success ? 'completed' : null),
    amount: root.amount,
    due: root.due,
    heldCredit: root.heldCredit,
    walletBalance: root.walletBalance,
    payment: root.payment || null,
    raw: root,
  };
}

async function createSession(path, payload, label) {
  if (!isAuxiliaryApiConfigured()) {
    throw new Error(
      'Payment server is not configured. Set EXPO_PUBLIC_API_URL in .env to your Express API root ' +
        '(e.g. http://YOUR_PC_LAN_IP:4000/api), run `npm run api` from the project root, then restart Expo with --clear.'
    );
  }
  const response = await client.post(path, payload, { timeout: 8000 });
  const result = unwrapSessionResult(response.data);
  if (!result.url) {
    throw new Error(`Server did not return a checkout URL for ${label}`);
  }
  return result;
}

/** Stripe sandbox / hosted checkout. Backend completes the sale and returns a receipt URL. */
export function createStripeCheckoutSession(payload) {
  return createSession(stripeSessionPath(), payload, 'Stripe');
}

/** Easypaisa sandbox / hosted payment. Backend completes the sale and returns a receipt URL. */
export function createEasypaisaSession(payload) {
  return createSession(easypaisaSessionPath(), payload, 'Easypaisa');
}

/** JazzCash sandbox / hosted payment. Backend completes the sale and returns a receipt URL. */
export function createJazzCashSession(payload) {
  return createSession(jazzcashSessionPath(), payload, 'JazzCash');
}
