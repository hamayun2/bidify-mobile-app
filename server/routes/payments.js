const express = require('express');
const { store, getOrCreateWallet, recordWalletTx } = require('../store');
const { authRequired } = require('../authMiddleware');
const { authRequiredSupabaseOrExpress } = require('../middleware/resolveSupabaseUser');
const { recordPayment, publicBase } = require('../listingHelpers');
const {
  isStripeTestConfigured,
  createStripeWalletCheckout,
  createStripeWalletPaymentSheet,
  fulfillStripeWalletPaymentIntent,
  fulfillStripeWalletSession,
  resolveStripeReturnTo,
  walletReturnHtml,
} = require('../stripePayments');

if (!store.paymentSessions) store.paymentSessions = {};
if (!store.nextPaymentSessionId) store.nextPaymentSessionId = 1;

const router = express.Router();

const PROVIDER_LABELS = {
  stripe: 'Stripe',
  easypaisa: 'Easypaisa',
  jazzcash: 'JazzCash',
};

function findHeldTokenForListing(listing, userId) {
  if (!listing?.bidTokens || !Array.isArray(listing.bidTokens)) return null;
  return (
    listing.bidTokens.find(
      (t) => t.held === true && String(t.userId) === String(userId) && t.consumed !== true
    ) || null
  );
}

function consumeHeldTokenIfWinner(listing, userId) {
  const held = findHeldTokenForListing(listing, userId);
  if (!held) return 0;
  held.consumed = true;
  held.consumedAt = new Date().toISOString();
  return Number(held.amount) || 0;
}

function buildReceiptUrl(req, sessionId) {
  return `${publicBase(req)}/payments/receipt/${encodeURIComponent(sessionId)}`;
}

const MIN_WALLET_TOPUP_PKR = 1000;

function completeSandboxTopup(req, provider, body) {
  const amount = Math.floor(Number(body?.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: { status: 400, message: 'A positive amount is required.' } };
  }
  if (amount < MIN_WALLET_TOPUP_PKR) {
    return {
      error: {
        status: 400,
        message: `Minimum top-up is Rs. ${MIN_WALLET_TOPUP_PKR.toLocaleString()}.`,
        minAmount: MIN_WALLET_TOPUP_PKR,
      },
    };
  }

  const { wallet, tx } = recordWalletTx(req.user.id, {
    kind: 'topup',
    amount,
    provider,
    note: `${PROVIDER_LABELS[provider] || provider} wallet top-up (sandbox).`,
  });

  const payment = recordPayment({
    kind: 'wallet_topup',
    provider,
    amount,
    walletDebited: 0,
    bidTokenCreditUsed: 0,
    buyerId: String(req.user.id),
    buyerName: req.user.fullName || req.user.email,
    status: 'completed',
  });

  const sessionId = `${provider.slice(0, 2).toUpperCase()}T-${store.nextPaymentSessionId++}-${Date.now()}`;
  const session = {
    id: sessionId,
    kind: 'wallet_topup',
    provider,
    amount,
    due: amount,
    heldCredit: 0,
    buyerId: String(req.user.id),
    status: 'completed',
    paymentId: payment.id,
    walletTxId: tx.id,
    walletBalanceAfter: wallet.balance,
    createdAt: new Date().toISOString(),
  };
  store.paymentSessions[sessionId] = session;

  return { session, payment, walletBalance: wallet.balance };
}

function completeSandboxSale(req, provider, body) {
  const listingId = body?.listingId != null ? String(body.listingId) : '';
  const amount = Math.floor(Number(body?.amount));
  if (!listingId || !Number.isFinite(amount) || amount <= 0) {
    return { error: { status: 400, message: 'listingId and a positive amount are required' } };
  }
  const listing = store.listings.find((l) => String(l.id) === listingId);
  if (!listing) {
    return { error: { status: 404, message: `Listing ${listingId} not found` } };
  }
  if (String(listing.sellerId || '') === String(req.user.id)) {
    return { error: { status: 400, message: 'You cannot pay for your own listing.' } };
  }

  const heldCredit = consumeHeldTokenIfWinner(listing, req.user.id);
  const due = Math.max(0, amount - heldCredit);

  const wallet = getOrCreateWallet(req.user.id);
  if (due > 0 && wallet.balance < due) {
    return {
      error: {
        status: 402,
        message: `Insufficient wallet balance (Rs. ${wallet.balance.toLocaleString()}). Top up at least Rs. ${(
          due - wallet.balance
        ).toLocaleString()} or pay the difference outside the wallet.`,
        balance: wallet.balance,
        due,
        heldCredit,
      },
    };
  }

  if (due > 0) {
    recordWalletTx(req.user.id, {
      kind: 'token_paid',
      amount: due,
      listingId,
      listingTitle: listing.title,
      note: `${PROVIDER_LABELS[provider] || provider} payment for "${listing.title}".`,
    });
  }

  if (heldCredit > 0) {
    recordWalletTx(req.user.id, {
      kind: 'token_refund',
      amount: 0,
      listingId,
      listingTitle: listing.title,
      note: `Held bid token of Rs. ${heldCredit.toLocaleString()} applied to this purchase.`,
    });
  }

  if (listing.type === 'auction' && !listing.soldAt) {
    listing.soldAt = new Date().toISOString();
    listing.soldTo = String(req.user.id);
  }

  const payment = recordPayment({
    kind: 'buy_now',
    provider,
    listingId,
    listingTitle: listing.title,
    amount,
    walletDebited: due,
    bidTokenCreditUsed: heldCredit,
    buyerId: String(req.user.id),
    buyerName: req.user.fullName || req.user.email,
    status: 'completed',
  });

  const sessionId = `${provider.slice(0, 2).toUpperCase()}-${store.nextPaymentSessionId++}-${Date.now()}`;
  const session = {
    id: sessionId,
    provider,
    listingId,
    listingTitle: listing.title,
    amount,
    due,
    heldCredit,
    buyerId: String(req.user.id),
    status: 'completed',
    paymentId: payment.id,
    createdAt: new Date().toISOString(),
  };
  store.paymentSessions[sessionId] = session;

  return { session, payment, walletBalance: wallet.balance };
}

function postSession(req, res) {
  const provider = req.params.provider;
  if (!PROVIDER_LABELS[provider]) {
    return res.status(404).json({ message: 'Unknown payment provider' });
  }
  const result = completeSandboxSale(req, provider, req.body || {});
  if (result.error) {
    return res.status(result.error.status).json(result.error);
  }
  const url = buildReceiptUrl(req, result.session.id);
  res.status(201).json({
    success: true,
    sessionId: result.session.id,
    url,
    provider,
    amount: result.session.amount,
    due: result.session.due,
    heldCredit: result.session.heldCredit,
    status: 'completed',
    walletBalance: result.walletBalance,
    payment: result.payment,
  });
}

router.post('/:provider/checkout-session', authRequired, postSession);
router.post('/:provider/session', authRequired, postSession);

async function postTopup(req, res) {
  const provider = req.params.provider;
  if (!PROVIDER_LABELS[provider]) {
    return res.status(404).json({ message: 'Unknown payment provider' });
  }

  const amount = Math.floor(Number(req.body?.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ message: 'A positive amount is required.' });
  }
  if (amount < MIN_WALLET_TOPUP_PKR) {
    return res.status(400).json({
      message: `Minimum top-up is Rs. ${MIN_WALLET_TOPUP_PKR.toLocaleString()}.`,
      minAmount: MIN_WALLET_TOPUP_PKR,
    });
  }

  if (provider === 'stripe' && isStripeTestConfigured()) {
    try {
      console.log('[payments] Stripe test Checkout — wallet top-up', amount, 'user', req.user.id);
      const checkout = await createStripeWalletCheckout(req, amount);
      if (!checkout?.url) {
        return res.status(500).json({ message: 'Could not create Stripe checkout session.' });
      }
      return res.status(201).json({
        success: true,
        sessionId: checkout.sessionId,
        url: checkout.url,
        provider: 'stripe',
        amount: checkout.amount,
        status: 'pending',
        kind: 'wallet_topup',
        pending: true,
        testMode: true,
      });
    } catch (e) {
      console.error('[payments] Stripe checkout error', e?.message || e);
      return res.status(500).json({ message: e?.message || 'Stripe checkout failed.' });
    }
  }

  const result = completeSandboxTopup(req, provider, req.body || {});
  if (result.error) {
    return res.status(result.error.status).json(result.error);
  }
  const url = buildReceiptUrl(req, result.session.id);
  res.status(201).json({
    success: true,
    sessionId: result.session.id,
    url,
    provider,
    amount: result.session.amount,
    status: 'completed',
    kind: 'wallet_topup',
    walletBalance: result.walletBalance,
    payment: result.payment,
    testMode: provider === 'stripe',
  });
}

router.post('/:provider/wallet-topup', authRequiredSupabaseOrExpress, (req, res) => {
  void postTopup(req, res);
});

/** Native Stripe Payment Sheet — returns client_secret + ephemeral key. */
router.post('/stripe/payment-sheet', authRequiredSupabaseOrExpress, async (req, res) => {
  const amount = Math.floor(Number(req.body?.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ message: 'A positive amount is required.' });
  }
  if (amount < MIN_WALLET_TOPUP_PKR) {
    return res.status(400).json({
      message: `Minimum top-up is Rs. ${MIN_WALLET_TOPUP_PKR.toLocaleString()}.`,
      minAmount: MIN_WALLET_TOPUP_PKR,
    });
  }
  if (!isStripeTestConfigured()) {
    return res.status(503).json({
      message: 'Stripe test key missing. Set STRIPE_TEST_SECRET_KEY in server/.env (sk_test_...).',
    });
  }
  try {
    const profileId = req.authUser?.id || req.user?.supabaseUserId || req.user?.id;
    console.log('[payments] Stripe Payment Sheet — wallet top-up', amount, 'profile', profileId);
    const sheet = await createStripeWalletPaymentSheet(req, amount);
    if (!sheet?.paymentIntent) {
      return res.status(500).json({ message: 'Could not create payment sheet.' });
    }
    return res.status(201).json({
      ...sheet,
      provider: 'stripe',
      status: 'requires_payment',
      testMode: true,
    });
  } catch (e) {
    console.error('[payments] payment-sheet error', e?.message || e);
    return res.status(500).json({ message: e?.message || 'Payment sheet failed.' });
  }
});

/** After Payment Sheet succeeds on device — credit wallet. */
router.post('/stripe/payment-sheet/confirm', authRequiredSupabaseOrExpress, async (req, res) => {
  const paymentIntentId = req.body?.paymentIntentId;
  if (!paymentIntentId) {
    return res.status(400).json({ message: 'paymentIntentId is required.' });
  }
  if (!isStripeTestConfigured()) {
    return res.status(503).json({ message: 'Stripe is not configured.' });
  }
  try {
    const supabaseUserId =
      (req.body?.supabaseUserId && String(req.body.supabaseUserId).trim()) ||
      req.authUser?.id ||
      req.user?.supabaseUserId ||
      null;
    const expectedUserId = String(req.authUser?.id || req.user?.supabaseUserId || req.user?.id);
    const result = await fulfillStripeWalletPaymentIntent(
      String(paymentIntentId),
      expectedUserId,
      supabaseUserId
    );
    if (!result.paid) {
      return res.status(402).json({
        message: `Payment not completed (${result.status || 'pending'}).`,
        status: result.status,
      });
    }
    if (!result.profileCredited && result.walletBalance == null) {
      return res.status(500).json({
        message:
          'Payment received but wallet was not credited in Supabase. Log out, log in again, and contact support if balance is still missing.',
      });
    }
    return res.json({
      success: true,
      walletBalance: result.walletBalance,
      amount: result.amount,
      duplicate: result.duplicate,
      profileCredited: result.profileCredited,
    });
  } catch (e) {
    console.error('[payments] payment-sheet confirm', e?.message || e);
    return res.status(500).json({ message: e?.message || 'Could not confirm payment.' });
  }
});

/** Browser redirect from Stripe — no JWT; user id comes from Checkout session metadata. */
router.get('/stripe/wallet-return', async (req, res) => {
  const sessionId = req.query?.session_id;
  const returnUrl = resolveStripeReturnTo(req);

  if (!sessionId || !isStripeTestConfigured()) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(400).send(
      walletReturnHtml({
        success: false,
        message: 'Missing payment session.',
        returnUrl,
      })
    );
  }

  try {
    const stripe = require('../stripePayments').getStripe();
    const checkout = await stripe.checkout.sessions.retrieve(String(sessionId));
    const userId = checkout?.metadata?.userId;
    if (!userId) {
      return res.status(400).send(
        walletReturnHtml({ success: false, message: 'Invalid session metadata.', returnUrl })
      );
    }
    const result = await fulfillStripeWalletSession(String(sessionId), userId);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!result.paid) {
      return res.send(
        walletReturnHtml({
          success: false,
          message: `Payment not completed yet (${result.status || 'pending'}).`,
          returnUrl,
        })
      );
    }
    return res.send(
      walletReturnHtml({
        success: true,
        amount: result.amount,
        balance: result.walletBalance,
        message: result.duplicate
          ? 'This payment was already applied to your wallet.'
          : 'Your wallet has been credited.',
        returnUrl,
      })
    );
  } catch (e) {
    console.error('[payments] stripe wallet-return', e?.message || e);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(500).send(
      walletReturnHtml({
        success: false,
        message: e?.message || 'Could not verify payment.',
        returnUrl,
      })
    );
  }
});

router.get('/stripe/status', (_req, res) => {
  res.json({
    stripeTestMode: isStripeTestConfigured(),
    minTopupPkr: MIN_WALLET_TOPUP_PKR,
    message: isStripeTestConfigured()
      ? 'Stripe Checkout (test) is active for wallet top-ups.'
      : 'Set STRIPE_TEST_SECRET_KEY in server/.env to enable real Stripe Checkout.',
  });
});

router.get('/stripe/wallet-cancel', (req, res) => {
  const returnUrl = resolveStripeReturnTo(req);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(
    walletReturnHtml({
      success: false,
      message: 'Payment cancelled. No charge was made.',
      returnUrl,
    })
  );
});

router.get('/sessions/:id', authRequired, (req, res) => {
  const session = store.paymentSessions[req.params.id];
  if (!session) return res.status(404).json({ message: 'Payment session not found' });
  if (String(session.buyerId) !== String(req.user.id)) {
    return res.status(403).json({ message: 'Not your session' });
  }
  res.json(session);
});

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

router.get('/receipt/:id', (req, res) => {
  const session = store.paymentSessions[req.params.id];
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (!session) {
    const fallbackReturn =
      (typeof req.query?.returnTo === 'string' && req.query.returnTo.trim()) ||
      process.env.PAYMENT_RETURN_URL ||
      'bidify://wallet';
    return res.status(404).send(
      `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Receipt not found</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f5f5f7;color:#222}
  .topbar{position:sticky;top:0;background:#fff;border-bottom:1px solid #eee;padding:14px 16px;display:flex;gap:12px;align-items:center}
  .backBtn{display:inline-flex;align-items:center;gap:8px;padding:10px 14px;border-radius:999px;background:#111;color:#fff;border:0;font-size:14px;font-weight:600;cursor:pointer}
  .backBtn svg{width:16px;height:16px}
  .wrap{padding:32px 16px}
  .card{max-width:480px;margin:0 auto;background:#fff;border-radius:18px;padding:28px;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center}
</style></head><body>
  <div class="topbar">
    <button class="backBtn" id="backBtn" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>Back to Bidify</button>
  </div>
  <div class="wrap"><div class="card"><h2>Receipt not found</h2><p>This link is invalid or expired.</p></div></div>
  <script>
    document.getElementById('backBtn').addEventListener('click', function () {
      try { window.close(); } catch (_) {}
      setTimeout(function () {
        if (!document.hidden) {
          if (window.history.length > 1 && document.referrer) { window.history.back(); return; }
          window.location.href = ${JSON.stringify(fallbackReturn)};
        }
      }, 120);
    });
  </script>
</body></html>`
    );
  }
  const provider = PROVIDER_LABELS[session.provider] || session.provider;
  const isTopup = session.kind === 'wallet_topup';
  const amount = Number(session.amount).toLocaleString();
  const due = Number(session.due || 0).toLocaleString();
  const credit = Number(session.heldCredit || 0).toLocaleString();
  const heading = isTopup ? 'Top-Up Successful' : 'Payment Successful';

  const rowsHtml = isTopup
    ? `
      <tr><td class="label">Top-up</td><td class="val">Rs. ${amount}</td></tr>
      <tr><td class="label">New wallet balance</td><td class="val">Rs. ${Number(
        session.walletBalanceAfter || 0
      ).toLocaleString()}</td></tr>
      <tr><td class="label">Provider</td><td class="val">${escapeHtml(provider)}</td></tr>
      <tr><td class="label">Reference</td><td class="val" style="font-family:monospace;font-size:12px">${escapeHtml(
        session.id
      )}</td></tr>`
    : `
      <tr><td class="label">Listing</td><td class="val">${escapeHtml(session.listingTitle || '')}</td></tr>
      <tr><td class="label">Amount</td><td class="val">Rs. ${amount}</td></tr>
      ${
        Number(session.heldCredit) > 0
          ? `<tr><td class="label">Held bid token applied</td><td class="val">- Rs. ${credit}</td></tr>`
          : ''
      }
      <tr><td class="label">Charged via wallet</td><td class="val">Rs. ${due}</td></tr>
      <tr><td class="label">Provider</td><td class="val">${escapeHtml(provider)}</td></tr>
      <tr><td class="label">Reference</td><td class="val" style="font-family:monospace;font-size:12px">${escapeHtml(
        session.id
      )}</td></tr>`;

  // Optional deep-link the back button falls back to (configurable).
  const returnTo =
    (typeof req.query?.returnTo === 'string' && req.query.returnTo.trim()) ||
    process.env.PAYMENT_RETURN_URL ||
    'bidify://wallet';

  const html = `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(heading)} — ${escapeHtml(provider)}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f5f5f7;color:#222;padding:0;}
  .topbar{position:sticky;top:0;z-index:10;background:#fff;border-bottom:1px solid #eee;padding:14px 16px;display:flex;align-items:center;gap:12px}
  .backBtn{display:inline-flex;align-items:center;gap:8px;padding:10px 14px;border-radius:999px;background:#111;color:#fff;border:0;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none}
  .backBtn:active{transform:scale(.98)}
  .backBtn svg{width:16px;height:16px}
  .topbarTitle{font-size:14px;font-weight:600;color:#555}
  .wrap{padding:24px 16px 40px}
  .card{max-width:480px;margin:0 auto;background:#fff;border-radius:18px;padding:28px;box-shadow:0 4px 24px rgba(0,0,0,.08);}
  .check{width:64px;height:64px;border-radius:50%;background:#111;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;color:#fff;font-size:36px;font-weight:bold}
  h1{font-size:22px;text-align:center;margin:0 0 6px}
  p.sub{margin:0 0 22px;text-align:center;color:#666;font-size:14px}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  td{padding:8px 0;border-bottom:1px solid #eee;font-size:14px}
  td.label{color:#777}
  td.val{text-align:right;font-weight:600}
  .meta{margin-top:18px;font-size:12px;color:#999;text-align:center}
  .footerBtn{display:block;text-align:center;max-width:480px;margin:18px auto 0;padding:14px;border-radius:14px;background:#111;color:#fff;font-weight:600;font-size:15px;text-decoration:none}
</style></head>
<body>
  <div class="topbar">
    <button class="backBtn" id="backBtn" type="button" aria-label="Back to Bidify">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
      Back to Bidify
    </button>
    <span class="topbarTitle">${escapeHtml(heading)}</span>
  </div>

  <div class="wrap">
    <div class="card">
      <div class="check">&#10003;</div>
      <h1>${escapeHtml(heading)}</h1>
      <p class="sub">${escapeHtml(provider)} (sandbox) — return to the Bidify app.</p>
      <table>${rowsHtml}</table>
      <p class="meta">${escapeHtml(session.createdAt)}</p>
    </div>
    <a class="footerBtn" href="${escapeHtml(returnTo)}" id="returnLink">Done — Return to App</a>
  </div>

  <script>
    (function () {
      var returnTo = ${JSON.stringify(returnTo)};
      function goBack() {
        // 1. In-app browser modals (Expo WebBrowser): closing is handled by the
        //    host app's listener — calling window.close() works on iOS/Android.
        try { window.close(); } catch (_) {}
        // 2. If still on the page after a moment, fall back to history or deep-link.
        setTimeout(function () {
          if (!document.hidden) {
            if (window.history.length > 1 && document.referrer) {
              window.history.back();
              return;
            }
            window.location.href = returnTo;
          }
        }, 120);
      }
      var btn = document.getElementById('backBtn');
      if (btn) btn.addEventListener('click', goBack);
      var link = document.getElementById('returnLink');
      if (link) link.addEventListener('click', function (e) {
        // Try the smart back first; deep-link href is the fallback if all else fails.
        e.preventDefault();
        goBack();
      });
    })();
  </script>
</body></html>`;
  res.send(html);
});

module.exports = router;
