import client, { isAuxiliaryApiConfigured } from './client';
import {
  getSupabase,
  isSupabaseConfigured,
} from '../services/supabaseClient';
import {
  getBidTokenStatusSupabase,
  payBidTokenSupabase,
  shouldUseSupabaseBidToken,
} from '../services/bidTokenService';

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

function unwrapErr(error, fallback) {
  const data = error?.response?.data;
  if (data && typeof data === 'object' && data.message) return data;
  if (typeof data === 'string' && data.trim()) return { message: data };
  if (error?.message) return { message: error.message };
  return { message: fallback };
}

export async function getWalletAPI() {
  try {
    const r = await client.get('/wallet', { timeout: 6000 });
    const data = parseJson(r.data);
    if (__DEV__) {
      console.log('[Bidify/Wallet] GET /wallet raw', data);
    }
    return {
      balance: Number(data?.balance) || 0,
      heldBalance: Number(data?.heldBalance) || 0,
      lockedBalance: Number(data?.lockedBalance) || 0,
      ledger: Array.isArray(data?.ledger) ? data.ledger : [],
      walletTransactions: Array.isArray(data?.walletTransactions)
        ? data.walletTransactions
        : Array.isArray(data?.transactions)
          ? data.transactions
          : [],
      transactions: Array.isArray(data?.transactions) ? data.transactions : [],
      source: data?.source || null,
    };
  } catch (e) {
    if (e?.response?.status === 401) {
      console.error(
        '[Bidify/Wallet] 401 on GET /wallet — Express JWT invalid. Log out and log in again.'
      );
    }
    if (e?.message?.includes('Network') || e?.message?.includes('timeout')) {
      return { balance: null, transactions: [], offline: true };
    }
    throw unwrapErr(e, 'Could not load wallet');
  }
}

export async function topUpWalletAPI(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error('amount must be positive');
  if (!isAuxiliaryApiConfigured()) {
    throw new Error(
      'Wallet top-up needs EXPO_PUBLIC_API_URL set (e.g. http://192.168.x.x:4000/api) and npm run api.'
    );
  }
  try {
    const r = await client.post('/wallet/topup', { amount: n }, { timeout: 8000 });
    const data = parseJson(r.data);
    return {
      balance: Number(data?.balance) || 0,
      transaction: data?.transaction || null,
    };
  } catch (e) {
    throw unwrapErr(e, 'Top-up failed');
  }
}

export const TOPUP_PROVIDERS = ['stripe', 'easypaisa', 'jazzcash'];

export async function createWalletTopupSession(provider, amount, options = {}) {
  const p = String(provider || '').toLowerCase();
  if (!TOPUP_PROVIDERS.includes(p)) throw new Error(`Unknown payment provider: ${provider}`);
  const n = Math.floor(Number(amount));
  if (!Number.isFinite(n) || n <= 0) throw new Error('amount must be a positive number');
  if (!isAuxiliaryApiConfigured()) {
    throw new Error(
      'Hosted checkout needs the Express API. Set EXPO_PUBLIC_API_URL (e.g. http://LAN_IP:4000/api) and start the server with npm run api.'
    );
  }
  const body = { amount: n, currency: 'PKR' };
  if (options.returnTo && typeof options.returnTo === 'string') {
    body.returnTo = options.returnTo.trim();
  }
  try {
    const r = await client.post(
      `/payments/${encodeURIComponent(p)}/wallet-topup`,
      body,
      { timeout: 10000 }
    );
    const data = parseJson(r.data) || {};
    return {
      provider: p,
      sessionId: data.sessionId || data.id || null,
      url: data.url || null,
      amount: Number(data.amount) || n,
      status: data.status || (data.success ? 'completed' : null),
      walletBalance: data.walletBalance,
      payment: data.payment || null,
      raw: data,
    };
  } catch (e) {
    if (e?.code === 'ECONNREFUSED' || String(e?.message || '').includes('Network')) {
      throw { message: 'Connection failed. Start the API with npm run api and check EXPO_PUBLIC_API_URL.' };
    }
    const status = e?.response?.status;
    if (status === 401) {
      console.error(
        '[Bidify/Wallet] 401 Unauthorized on wallet-topup — Express JWT missing or expired.',
        'Log out, ensure EXPO_PUBLIC_API_URL points at your API, log in again (bridge-login).',
        e?.response?.data
      );
    } else if (status) {
      console.error('[Bidify/Wallet] wallet-topup HTTP', status, e?.response?.data || e?.message);
    }
    throw unwrapErr(e, 'Could not start payment');
  }
}

/** Stripe Payment Sheet params (native in-app card UI). */
export async function fetchStripePaymentSheetParams(amount) {
  const n = Math.floor(Number(amount));
  if (!Number.isFinite(n) || n <= 0) throw new Error('amount must be a positive number');
  if (!isAuxiliaryApiConfigured()) {
    throw new Error(
      'Payment sheet needs EXPO_PUBLIC_API_URL (e.g. http://LAN_IP:4000/api) and npm run api in server/.'
    );
  }
  try {
    const r = await client.post(
      '/payments/stripe/payment-sheet',
      { amount: n, currency: 'PKR' },
      { timeout: 12000 }
    );
    const data = parseJson(r.data) || {};
    console.log('[Bidify/Wallet] POST /payments/stripe/payment-sheet', {
      status: r.status,
      hasPaymentIntent: Boolean(data.paymentIntent),
      paymentIntentId: data.paymentIntentId || null,
      amount: data.amount,
    });
    if (!data.paymentIntent) {
      console.error('[Bidify/Wallet] payment-sheet missing paymentIntent', data);
      throw new Error('Server did not return payment sheet parameters.');
    }
    return {
      paymentIntent: data.paymentIntent,
      ephemeralKey: data.ephemeralKey,
      customer: data.customer,
      publishableKey: data.publishableKey || null,
      paymentIntentId: data.paymentIntentId || null,
      amount: Number(data.amount) || n,
    };
  } catch (e) {
    if (e?.code === 'ECONNREFUSED' || String(e?.message || '').includes('Network')) {
      throw { message: 'Connection failed. Start the API with npm run api and check EXPO_PUBLIC_API_URL.' };
    }
    const status = e?.response?.status;
    if (status === 401) {
      console.error(
        '[Bidify/Wallet] 401 on payment-sheet — sign in again; API must accept your Supabase session token.'
      );
    }
    throw unwrapErr(e, 'Could not load Stripe payment sheet');
  }
}

/**
 * EasyPaisa screenshot flow — stub until backend storage is wired (e.g. Supabase).
 */
export async function submitEasypaisaTopupAPI({ amount, receiptUri }) {
  const n = Math.floor(Number(amount));
  if (!Number.isFinite(n) || n <= 0) throw new Error('Enter a valid top-up amount.');
  if (n < 1000) throw new Error('Minimum top-up amount is PKR 1,000.');
  if (!receiptUri) throw new Error('Please attach your EasyPaisa receipt screenshot.');
  if (__DEV__) {
    console.log('[Bidify/Wallet] submitEasypaisaTopupAPI (stub — no server upload yet)', {
      amount: n,
      receiptUri: String(receiptUri).slice(0, 80),
    });
  }
  return {
    topupId: `local-${Date.now()}`,
    status: 'pending',
    amount: n,
    screenshotUrl: null,
  };
}

export async function getMyTopupsAPI() {
  return [];
}

export async function adminGetPendingTopupsAPI() {
  return [];
}

export async function adminGetAllTopupsAPI() {
  return [];
}

export async function adminApproveTopupAPI(_topupId) {
  if (__DEV__) console.log('[Bidify/Wallet] adminApproveTopupAPI (stub)');
  throw new Error('Top-up approval is not connected yet. Use the Express API when configured.');
}

export async function adminRejectTopupAPI(_topupId, _reason) {
  if (__DEV__) console.log('[Bidify/Wallet] adminRejectTopupAPI (stub)');
  throw new Error('Top-up rejection is not connected yet. Use the Express API when configured.');
}

export async function getBidTokenStatusAPI(listingId, opts = {}) {
  const lid = listingId != null ? String(listingId) : '';
  const startingPrice = Number(opts.startingPrice ?? opts.price ?? 0);

  if (shouldUseSupabaseBidToken(lid)) {
    const supabase = getSupabase();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user?.id) {
      return { requiresToken: false, tokenAmount: 0, paid: false, token: null, walletBalance: 0 };
    }
    return getBidTokenStatusSupabase(user.id, lid, startingPrice);
  }

  if (!isAuxiliaryApiConfigured()) {
    return {
      requiresToken: false,
      tokenAmount: 0,
      paid: true,
      token: null,
      walletBalance: 0,
    };
  }
  try {
    const r = await client.get(`/listings/${encodeURIComponent(lid)}/token`, { timeout: 6000 });
    const data = parseJson(r.data) || {};
    return {
      requiresToken: !!data.requiresToken,
      tokenAmount: Number(data.tokenAmount) || 0,
      paid: !!data.paid,
      token: data.token || null,
      walletBalance: Number(data.walletBalance) || 0,
    };
  } catch (e) {
    if (e?.response?.status === 404 && isSupabaseConfigured()) {
      const supabase = getSupabase();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user?.id) {
        return getBidTokenStatusSupabase(user.id, lid, startingPrice);
      }
    }
    if (e?.message?.includes('Network') || e?.message?.includes('timeout')) {
      return { requiresToken: false, tokenAmount: 0, paid: false, offline: true };
    }
    throw unwrapErr(e, 'Could not check bid token');
  }
}

export async function payBidTokenAPI(listingId, opts = {}) {
  const lid = listingId != null ? String(listingId) : '';
  const startingPrice = Number(opts.startingPrice ?? opts.price ?? 0);

  if (shouldUseSupabaseBidToken(lid)) {
    const supabase = getSupabase();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user?.id) throw new Error('Sign in to pay the bid token.');
    return payBidTokenSupabase(user.id, lid, startingPrice);
  }

  if (!isAuxiliaryApiConfigured()) {
    return {
      success: true,
      alreadyPaid: true,
      tokenAmount: 0,
      token: null,
      wallet: null,
    };
  }
  try {
    const r = await client.post(
      `/listings/${encodeURIComponent(lid)}/token`,
      {},
      { timeout: 8000 }
    );
    const data = parseJson(r.data) || {};
    return {
      success: data.success !== false,
      alreadyPaid: !!data.alreadyPaid,
      tokenAmount: Number(data.tokenAmount) || 0,
      token: data.token || null,
      wallet: data.wallet || null,
    };
  } catch (e) {
    if (e?.response?.status === 404 && isSupabaseConfigured()) {
      const supabase = getSupabase();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user?.id) {
        return payBidTokenSupabase(user.id, lid, startingPrice);
      }
    }
    throw unwrapErr(e, 'Could not pay bid token');
  }
}
