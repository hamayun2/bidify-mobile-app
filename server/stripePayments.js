/**
 * Stripe Checkout (TEST MODE) for wallet top-ups.
 * Set STRIPE_TEST_SECRET_KEY in server/.env — never use live keys here.
 */
const { store, recordWalletTx } = require('./store');
const { recordPayment, publicBase } = require('./listingHelpers');
const {
  creditProfileWalletTopup,
  isUuid,
  isSupabaseWalletSyncConfigured,
  lookupProfileIdByEmail,
} = require('./supabaseWallet');

let _stripe;

function getStripe() {
  const key = process.env.STRIPE_TEST_SECRET_KEY || process.env.STRIPE_SECRET_KEY;
  if (!key || String(key).startsWith('sk_live')) {
    if (String(key || '').startsWith('sk_live')) {
      console.error('[stripe] Refusing live secret key — use STRIPE_TEST_SECRET_KEY (sk_test_...) only.');
    }
    return null;
  }
  if (!_stripe) {
    // eslint-disable-next-line global-require
    const Stripe = require('stripe');
    _stripe = new Stripe(key, { apiVersion: '2024-06-20' });
    console.log('[stripe] Test-mode client ready');
  }
  return _stripe;
}

function isStripeTestConfigured() {
  return !!getStripe();
}

if (!store.stripeProcessedSessions) store.stripeProcessedSessions = {};

/**
 * Credit Express store (idempotent) + mirror to public.profiles.wallet_balance.
 * @param {string} expressUserId
 * @param {string|null|undefined} profileUserId — Supabase auth UUID
 */
async function completeStripeWalletTopup(
  expressUserId,
  amount,
  sessionId,
  paymentIntentId,
  profileUserId
) {
  const sid = String(sessionId || '');
  if (sid && store.stripeProcessedSessions[sid]) {
    const cached = store.stripeProcessedSessions[sid];
    return {
      wallet: cached.wallet,
      tx: cached.tx,
      duplicate: true,
      profileWalletBalance: cached.supa?.wallet_balance ?? null,
    };
  }

  const { wallet, tx } = recordWalletTx(expressUserId, {
    kind: 'topup',
    amount,
    provider: 'stripe',
    note: `Stripe test top-up (${sid || 'session'}).`,
    stripePaymentId: paymentIntentId || null,
    stripeSessionId: sid || null,
  });

  recordPayment({
    kind: 'wallet_topup',
    provider: 'stripe',
    amount,
    walletDebited: 0,
    bidTokenCreditUsed: 0,
    buyerId: String(expressUserId),
    status: 'completed',
    stripePaymentId: paymentIntentId || sid,
  });

  const idemKey = sid || paymentIntentId || `express_tx_${tx.id}`;
  const resolvedProfileId = profileUserId;
  if (!resolvedProfileId || !isUuid(resolvedProfileId)) {
    console.error('[stripe/topup] FAIL — no Supabase profile id', {
      expressUserId,
      profileUserId,
      fix: 'Log out and log in so bridge-login links supabaseUserId',
    });
    throw new Error(
      'Could not link payment to your Supabase profile. Log out, log in again, then retry top-up.'
    );
  }
  console.log('[stripe/topup] Crediting public.profiles', {
    profileUserId: resolvedProfileId,
    amount,
    idemKey,
  });
  const supa = await creditProfileWalletTopup(resolvedProfileId, amount, idemKey, 'stripe');

  if (sid) {
    store.stripeProcessedSessions[sid] = { wallet, tx, at: new Date().toISOString(), supa };
  }

  return {
    wallet,
    tx,
    duplicate: false,
    profileWalletBalance: supa?.wallet_balance != null ? Number(supa.wallet_balance) : null,
  };
}

/**
 * Create Stripe Checkout Session — returns hosted payment URL (does NOT credit until paid).
 */
async function createCheckoutSession(stripe, params) {
  return stripe.checkout.sessions.create(params);
}

function sanitizeWebReturnTo(raw) {
  const s = String(raw || '').trim();
  if (!s || !/^https?:\/\//i.test(s)) return '';
  return s;
}

function defaultWebReturnTo() {
  const web = String(process.env.EXPO_PUBLIC_WEB_APP_URL || '').trim();
  if (!web) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(web) ? web : `https://${web}`);
    return `${u.origin.replace(/\/$/, '')}/wallet`;
  } catch {
    return '';
  }
}

function resolveStripeReturnTo(req) {
  const fromBody = sanitizeWebReturnTo(req?.body?.returnTo);
  if (fromBody) return fromBody;
  const fromQuery = sanitizeWebReturnTo(req?.query?.returnTo);
  if (fromQuery) return fromQuery;
  const fromEnv = defaultWebReturnTo();
  if (fromEnv) return fromEnv;
  return process.env.PAYMENT_RETURN_URL || 'bidify://wallet';
}

async function createStripeWalletCheckout(req, amountPkr) {
  const stripe = getStripe();
  if (!stripe) return null;

  const amount = Math.floor(Number(amountPkr));
  const base = publicBase(req);
  const userId = String(req.authUser?.id || req.user?.supabaseUserId || req.user?.id);
  const returnTo = resolveStripeReturnTo(req);
  const returnQ =
    returnTo && /^https?:\/\//i.test(returnTo)
      ? `&returnTo=${encodeURIComponent(returnTo)}`
      : '';
  const cancelReturnQ =
    returnTo && /^https?:\/\//i.test(returnTo)
      ? `?returnTo=${encodeURIComponent(returnTo)}`
      : '';

  const sessionPayload = (currency) => ({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency,
          product_data: {
            name: 'Bidify Wallet Top-up',
            description: `Add Rs. ${amount.toLocaleString()} to your wallet (Stripe test)`,
          },
          unit_amount: currency === 'pkr' ? amount * 100 : Math.max(50, amount),
        },
        quantity: 1,
      },
    ],
    metadata: {
      kind: 'wallet_topup',
      userId,
      profileUserId: req.user.supabaseUserId && isUuid(req.user.supabaseUserId) ? req.user.supabaseUserId : '',
      amountPkr: String(amount),
    },
    success_url: `${base}/payments/stripe/wallet-return?session_id={CHECKOUT_SESSION_ID}${returnQ}`,
    cancel_url: `${base}/payments/stripe/wallet-cancel${cancelReturnQ}`,
  });

  let session;
  try {
    session = await createCheckoutSession(stripe, sessionPayload('pkr'));
  } catch (pkrErr) {
    console.warn('[stripe] PKR checkout failed, retrying with USD test amount:', pkrErr?.message);
    session = await createCheckoutSession(stripe, sessionPayload('usd'));
  }

  if (!store.paymentSessions) store.paymentSessions = {};
  store.paymentSessions[session.id] = {
    id: session.id,
    kind: 'wallet_topup',
    provider: 'stripe',
    amount,
    buyerId: userId,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  console.log('[stripe] Checkout session created', session.id, 'amount PKR', amount);
  return {
    sessionId: session.id,
    url: session.url,
    amount,
    pending: true,
  };
}

/**
 * Verify session after redirect and credit wallet.
 */
async function fulfillStripeWalletSession(sessionId, expectedUserId) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe is not configured on the server.');

  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent'],
  });

  if (session.metadata?.kind !== 'wallet_topup') {
    throw new Error('Not a wallet top-up session.');
  }
  if (String(session.metadata?.userId) !== String(expectedUserId)) {
    throw new Error('Session does not belong to this user.');
  }
  if (session.payment_status !== 'paid') {
    return { paid: false, status: session.payment_status, walletBalance: null };
  }

  const amount = Math.floor(Number(session.metadata?.amountPkr || session.amount_total / 100));
  const paymentIntentId =
    typeof session.payment_intent === 'object'
      ? session.payment_intent?.id
      : session.payment_intent;

  const profileUserId = await resolveProfileUserId(session.metadata, expectedUserId);
  const { wallet, duplicate, profileWalletBalance } = await completeStripeWalletTopup(
    expectedUserId,
    amount,
    session.id,
    paymentIntentId,
    profileUserId
  );

  const displayBalance = profileWalletBalance ?? wallet.balance;

  if (store.paymentSessions?.[session.id]) {
    store.paymentSessions[session.id].status = 'completed';
    store.paymentSessions[session.id].walletBalanceAfter = displayBalance;
  }

  console.log('[stripe] Wallet credited', {
    sessionId: session.id,
    amount,
    duplicate,
    profileUserId,
    profileWalletBalance,
  });
  return { paid: true, walletBalance: displayBalance, amount, duplicate };
}

async function resolveProfileUserId(metadata, expressUserId, explicitProfileId) {
  if (explicitProfileId && isUuid(String(explicitProfileId))) {
    return String(explicitProfileId);
  }
  const fromMeta = metadata?.profileUserId;
  if (fromMeta && isUuid(String(fromMeta))) return String(fromMeta);
  if (expressUserId && isUuid(String(expressUserId))) return String(expressUserId);
  const u = store.users.find((x) => String(x.id) === String(expressUserId));
  if (u?.supabaseUserId && isUuid(String(u.supabaseUserId))) return String(u.supabaseUserId);
  if (u?.email && isSupabaseWalletSyncConfigured()) {
    const byEmail = await lookupProfileIdByEmail(u.email);
    if (byEmail) {
      u.supabaseUserId = byEmail;
      const { persist } = require('./store');
      persist();
      console.log('[stripe] Linked Express user to Supabase profile via email', u.email);
      return byEmail;
    }
  }
  return null;
}

function walletReturnHtml({ success, amount, balance, message, returnUrl }) {
  const safeMsg = String(message || '').replace(/</g, '&lt;');
  const title = success ? 'Payment successful' : 'Payment';
  const safeReturn = String(returnUrl || '');
  const isWebReturn = /^https?:\/\//i.test(safeReturn);
  const separator = safeReturn.includes('?') ? '&' : '?';
  const redirectTarget = isWebReturn
    ? `${safeReturn}${separator}stripeTopup=${success ? 'success' : 'cancel'}&amount=${Number(amount) || 0}${
        balance != null ? `&balance=${Number(balance)}` : ''
      }`
    : safeReturn;
  const notifyScript = success
    ? `<script>
try {
  if (window.opener && !window.opener.closed) {
    window.opener.postMessage({ type: 'bidify-wallet-topup', success: true, amount: ${Number(amount) || 0}, balance: ${balance != null ? Number(balance) : 'null'} }, '*');
    setTimeout(function(){ window.close(); }, 1200);
  } else if (${JSON.stringify(isWebReturn)}) {
    setTimeout(function(){ window.location.replace(${JSON.stringify(redirectTarget)}); }, 600);
  }
} catch (e) {
  if (${JSON.stringify(isWebReturn)}) {
    window.location.replace(${JSON.stringify(redirectTarget)});
  }
}
</script>`
    : isWebReturn
      ? `<script>setTimeout(function(){ window.location.replace(${JSON.stringify(redirectTarget)}); }, 800);</script>`
      : '';
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<style>
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f5f5f7;color:#111;padding:24px}
.card{max-width:420px;margin:40px auto;background:#fff;border-radius:16px;padding:24px;box-shadow:0 8px 32px rgba(0,0,0,.08)}
h1{font-size:22px;margin:0 0 12px}
p{color:#444;line-height:1.5}
.btn{display:inline-block;margin-top:20px;padding:14px 20px;background:#111;color:#fff;text-decoration:none;border-radius:12px;font-weight:600}
.ok{color:#16a34a;font-weight:700}
</style></head><body>
<div class="card">
<h1>${title}</h1>
<p>${safeMsg}</p>
${success && amount ? `<p class="ok">+ Rs. ${Number(amount).toLocaleString()}</p>` : ''}
${balance != null ? `<p>New balance: <strong>Rs. ${Number(balance).toLocaleString()}</strong></p>` : ''}
<a class="btn" href="${returnUrl}">Return to Bidify</a>
</div>${notifyScript}</body></html>`;
}

/**
 * Stripe webhook → credit public.profiles.wallet_balance (and Express ledger).
 * @param {Buffer|string} rawBody
 * @param {string} signature — Stripe-Signature header
 * @param {{ log?: (step: string, msg: string, extra?: object) => void }} [opts]
 */
async function handleStripeWebhook(rawBody, signature, opts = {}) {
  const log =
    opts.log ||
    ((step, msg, extra) => {
      const suffix = extra != null ? ` ${JSON.stringify(extra)}` : '';
      console.log(`[stripe/webhook] ${step} ${msg}${suffix}`);
    });

  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripe) {
    log('FAIL', 'Stripe not configured — set STRIPE_TEST_SECRET_KEY in .env');
    return { handled: false, reason: 'stripe_not_configured' };
  }
  if (!secret || !String(secret).trim()) {
    log('FAIL', 'STRIPE_WEBHOOK_SECRET missing — run: npm run stripe:listen OR set whsec_ in .env');
    return { handled: false, reason: 'webhook_secret_missing' };
  }
  if (!isSupabaseWalletSyncConfigured()) {
    log('WARN', 'Supabase sync not configured — wallet will NOT update profiles table');
  } else {
    log('4/6', 'Supabase wallet sync ready');
  }

  let event;
  try {
    log('4/6', 'Verifying webhook signature with STRIPE_WEBHOOK_SECRET…');
    event = stripe.webhooks.constructEvent(rawBody, signature, secret);
    log('4/6', 'Signature OK', { eventId: event.id, type: event.type });
  } catch (e) {
    log('FAIL', 'Signature mismatch or invalid payload', {
      error: e?.message,
      fix: 'Use secret from `stripe listen` (npm run stripe:listen) in root .env',
    });
    throw e;
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    log('5/6', 'checkout.session.completed', {
      sessionId: session.id,
      paymentStatus: session.payment_status,
      kind: session.metadata?.kind,
    });

    if (session.metadata?.kind !== 'wallet_topup') {
      log('SKIP', 'Not a wallet_topup session', { kind: session.metadata?.kind });
      return { handled: true, skipped: true, reason: 'not_wallet_topup' };
    }
    if (session.payment_status !== 'paid') {
      log('SKIP', 'Session not paid yet', { payment_status: session.payment_status });
      return { handled: true, skipped: true, reason: 'not_paid' };
    }

    const expressUserId = session.metadata?.userId;
    if (!expressUserId) {
      log('FAIL', 'session.metadata.userId missing — cannot credit wallet');
      return { handled: true, skipped: true, reason: 'no_express_user_id' };
    }

    log('5/6', 'Crediting wallet…', {
      expressUserId,
      profileUserId: session.metadata?.profileUserId || '(resolve by email)',
      amountPkr: session.metadata?.amountPkr,
    });

    const result = await fulfillStripeWalletSession(session.id, expressUserId);
    log('5/6', 'Credit result', {
      walletBalance: result.walletBalance,
      amount: result.amount,
      duplicate: result.duplicate,
    });
    return { handled: true, eventType: event.type, result };
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    log('5/6', 'payment_intent.succeeded', {
      paymentIntentId: pi.id,
      kind: pi.metadata?.kind,
      amount: pi.metadata?.amountPkr,
    });

    if (pi.metadata?.kind !== 'wallet_topup') {
      log('SKIP', 'Not a wallet_topup PaymentIntent', { kind: pi.metadata?.kind });
      return { handled: true, skipped: true, reason: 'not_wallet_topup' };
    }

    const expressUserId = pi.metadata?.userId;
    if (!expressUserId) {
      log('FAIL', 'payment_intent.metadata.userId missing');
      return { handled: true, skipped: true, reason: 'no_express_user_id' };
    }

    const profileFromMeta =
      pi.metadata?.profileUserId && isUuid(String(pi.metadata.profileUserId))
        ? String(pi.metadata.profileUserId)
        : null;

    log('5/6', 'Crediting wallet…', { expressUserId, profileUserId: profileFromMeta || '(resolve)' });

    const result = await fulfillStripePaymentIntent(pi.id, expressUserId, profileFromMeta);
    log('5/6', 'Credit result', {
      walletBalance: result.walletBalance,
      profileCredited: result.profileCredited,
      amount: result.amount,
      duplicate: result.duplicate,
    });
    return { handled: true, eventType: event.type, result };
  }

  log('SKIP', 'Unhandled event type (ignored)', { type: event.type });
  return { handled: true, ignored: event.type };
}

/**
 * In-app Payment Sheet (PaymentIntent) for wallet top-up.
 */
async function createStripeWalletPaymentSheet(req, amountPkr) {
  const stripe = getStripe();
  if (!stripe) return null;

  const amount = Math.floor(Number(amountPkr));
  const userId = String(req.authUser?.id || req.user?.supabaseUserId || req.user?.id);
  const email = String(req.user?.email || req.authUser?.email || '').trim() || undefined;

  let customerId = req.user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email,
      metadata: { bidifyUserId: userId },
    });
    customerId = customer.id;
    const u = store.users.find((x) => String(x.id) === userId);
    if (u) {
      u.stripeCustomerId = customerId;
      const { persist } = require('./store');
      persist();
    }
  }

  const ephemeralKey = await stripe.ephemeralKeys.create(
    { customer: customerId },
    { apiVersion: '2024-06-20' }
  );

  let paymentIntent;
  const pkrCents = amount * 100;
  try {
    paymentIntent = await stripe.paymentIntents.create({
      amount: pkrCents,
      currency: 'pkr',
      customer: customerId,
      automatic_payment_methods: { enabled: true },
      metadata: {
        kind: 'wallet_topup',
        userId,
        profileUserId: isUuid(userId) ? userId : '',
        amountPkr: String(amount),
      },
    });
  } catch (pkrErr) {
    console.warn('[stripe] PaymentIntent PKR failed, retrying USD test amount:', pkrErr?.message);
    paymentIntent = await stripe.paymentIntents.create({
      amount: Math.max(50, amount),
      currency: 'usd',
      customer: customerId,
      automatic_payment_methods: { enabled: true },
      metadata: {
        kind: 'wallet_topup',
        userId,
        profileUserId: isUuid(userId) ? userId : '',
        amountPkr: String(amount),
      },
    });
  }

  if (!store.stripePaymentIntents) store.stripePaymentIntents = {};
  store.stripePaymentIntents[paymentIntent.id] = {
    userId,
    profileUserId: req.user.supabaseUserId || null,
    amountPkr: amount,
    createdAt: new Date().toISOString(),
  };

  const publishableKey =
    process.env.STRIPE_TEST_PUBLISHABLE_KEY ||
    process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ||
    process.env.STRIPE_PUBLISHABLE_KEY ||
    null;

  console.log('[stripe] Payment sheet created', paymentIntent.id, 'PKR', amount);
  return {
    paymentIntent: paymentIntent.client_secret,
    ephemeralKey: ephemeralKey.secret,
    customer: customerId,
    publishableKey,
    amount,
    paymentIntentId: paymentIntent.id,
  };
}

/**
 * Credit wallet after Payment Sheet succeeds (client calls after presentPaymentSheet).
 */
async function fulfillStripePaymentIntent(paymentIntentId, expectedUserId, explicitProfileId) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe is not configured on the server.');

  const pi = await stripe.paymentIntents.retrieve(String(paymentIntentId));
  if (pi.metadata?.kind !== 'wallet_topup') {
    throw new Error('Not a wallet top-up payment.');
  }
  if (String(pi.metadata?.userId) !== String(expectedUserId)) {
    throw new Error('Payment does not belong to this user.');
  }
  if (pi.status !== 'succeeded') {
    return { paid: false, status: pi.status, walletBalance: null };
  }

  const amount = Math.floor(Number(pi.metadata?.amountPkr || pi.amount / 100));
  const profileUserId = await resolveProfileUserId(pi.metadata, expectedUserId, explicitProfileId);
  const { wallet, duplicate, profileWalletBalance } = await completeStripeWalletTopup(
    expectedUserId,
    amount,
    `pi_${pi.id}`,
    pi.id,
    profileUserId
  );
  return {
    paid: true,
    walletBalance: profileWalletBalance ?? wallet.balance,
    profileCredited: profileWalletBalance != null,
    amount,
    duplicate,
  };
}

module.exports = {
  getStripe,
  isStripeTestConfigured,
  createStripeWalletCheckout,
  createStripeWalletPaymentSheet,
  fulfillStripeWalletPaymentIntent: fulfillStripePaymentIntent,
  fulfillStripeWalletSession,
  completeStripeWalletTopup,
  resolveStripeReturnTo,
  walletReturnHtml,
  handleStripeWebhook,
};
