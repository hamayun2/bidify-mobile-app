const express = require('express');
const {
  supabaseRpc,
  isSupabaseWalletSyncConfigured,
  getSupabaseKeyDiagnostics,
} = require('../supabaseWallet');
const { authRequiredSupabaseOrExpress } = require('../middleware/resolveSupabaseUser');
const {
  fetchWalletBundleForUser,
  fetchWalletLedgerForUser,
  fetchWalletTransactionsForUser,
  isSupabaseWalletDataConfigured,
} = require('../services/supabaseWalletData');
const {
  isUuid,
  rpcAsUser,
  fetchAuctionOrdersForUser,
} = require('../services/escrowRpc');

const router = express.Router();

function supabaseUnavailable(res) {
  const diag = getSupabaseKeyDiagnostics();
  return res.status(503).json({
    message:
      'Supabase service role not configured on API server (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).',
    diagnostics: diag,
  });
}

function requireSupabaseSession(req, res) {
  if (!isSupabaseWalletSyncConfigured()) {
    supabaseUnavailable(res);
    return false;
  }
  if (req.authUser?.source !== 'supabase' || !req.authUser?.accessToken) {
    res.status(401).json({
      message:
        'Escrow workflow requires a Supabase session. Log out and sign in again (bridge-login).',
    });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Wallet reads (service_role)
// ---------------------------------------------------------------------------

router.get('/ledger', authRequiredSupabaseOrExpress, async (req, res) => {
  if (!isSupabaseWalletDataConfigured()) return supabaseUnavailable(res);
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 80));
    const ledger = await fetchWalletLedgerForUser(req.authUser.id, limit);
    res.json({ ledger });
  } catch (e) {
    console.error('[escrow/ledger]', e?.message || e);
    res.status(500).json({ message: e?.message || 'Could not load wallet ledger.' });
  }
});

router.get('/transactions', authRequiredSupabaseOrExpress, async (req, res) => {
  if (!isSupabaseWalletDataConfigured()) return supabaseUnavailable(res);
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 80));
    const transactions = await fetchWalletTransactionsForUser(req.authUser.id, limit);
    res.json({ transactions });
  } catch (e) {
    console.error('[escrow/transactions]', e?.message || e);
    res.status(500).json({ message: e?.message || 'Could not load wallet transactions.' });
  }
});

router.get('/bundle', authRequiredSupabaseOrExpress, async (req, res) => {
  if (!isSupabaseWalletDataConfigured()) return supabaseUnavailable(res);
  try {
    const bundle = await fetchWalletBundleForUser(req.authUser.id);
    if (!bundle) return res.status(400).json({ message: 'Invalid user id.' });
    res.json(bundle);
  } catch (e) {
    console.error('[escrow/bundle]', e?.message || e);
    res.status(500).json({ message: e?.message || 'Could not load wallet bundle.' });
  }
});

// ---------------------------------------------------------------------------
// Master escrow workflow (user JWT → same Supabase RPCs as the app)
// ---------------------------------------------------------------------------

/**
 * POST /api/escrow/buy
 * Lock funds in escrow for an auction bid / buy-now amount.
 * Body: { listingId, amount }
 * RPC: place_bid_with_wallet_lock
 */
router.post('/buy', authRequiredSupabaseOrExpress, async (req, res) => {
  if (!requireSupabaseSession(req, res)) return;

  const listingId = String(req.body?.listingId || req.body?.listing_id || '').trim();
  const amount = Number(req.body?.amount);
  if (!listingId || !isUuid(listingId)) {
    return res.status(400).json({ message: 'Valid listingId is required.' });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ message: 'Valid amount is required.' });
  }

  try {
    const securityFee =
      amount > 10000 ? 1000 : amount > 5000 ? 500 : amount > 1000 ? 500 : 100;

    const bid = await rpcAsUser(req.authUser.accessToken, 'place_bid_with_wallet_lock', {
      p_listing_id: listingId,
      p_amount: amount,
      p_security_fee: securityFee,
    });
    res.json({ ok: true, bid, amount });
  } catch (e) {
    console.error('[escrow/buy]', listingId, e?.message || e);
    const status = /insufficient wallet balance/i.test(e?.message || '') ? 400 : 400;
    res.status(status).json({
      ok: false,
      message: e?.message || 'Could not lock funds in escrow.',
      topUpRequired: /insufficient wallet balance/i.test(e?.message || ''),
    });
  }
});

/** GET /api/escrow/orders — buyer/seller auction_orders */
router.get('/orders', authRequiredSupabaseOrExpress, async (req, res) => {
  if (!requireSupabaseSession(req, res)) return;
  try {
    const orders = await fetchAuctionOrdersForUser(req.authUser.accessToken, req.authUser.id);
    res.json({ orders });
  } catch (e) {
    console.error('[escrow/orders]', e?.message || e);
    res.status(500).json({ message: e?.message || 'Could not load orders.' });
  }
});

async function handleVerifyOtp(req, res, orderId, otp) {
  if (!requireSupabaseSession(req, res)) return;

  const id = orderId != null ? String(orderId).trim() : '';
  const code = String(otp ?? '').trim();
  if (!id || !isUuid(id)) {
    return res.status(400).json({ message: 'Valid orderId is required.' });
  }
  if (!code) {
    return res.status(400).json({ message: 'Enter the 6-digit delivery OTP.' });
  }

  try {
    const data = await rpcAsUser(req.authUser.accessToken, 'verify_delivery_otp', {
      p_order_id: id,
      p_otp: code,
    });
    res.json(data != null && typeof data === 'object' ? data : { ok: true });
  } catch (e) {
    console.error('[escrow/verify-otp]', id, e?.message || e);
    res.status(400).json({
      message: e?.message || 'Could not verify delivery OTP.',
      invalidOtp: !!e?.invalidOtp,
    });
  }
}

async function handleRevealOtp(req, res, orderId) {
  if (!requireSupabaseSession(req, res)) return;

  const id = orderId != null ? String(orderId).trim() : '';
  if (!id || !isUuid(id)) {
    return res.status(400).json({ message: 'Valid orderId is required.' });
  }

  try {
    const data = await rpcAsUser(req.authUser.accessToken, 'reveal_buyer_delivery_otp', {
      p_order_id: id,
    });
    const row = data != null && typeof data === 'object' ? data : {};
    const otp =
      row.otp != null
        ? String(row.otp).trim()
        : row.delivery_otp != null
          ? String(row.delivery_otp).trim()
          : '';
    res.json({ ...row, otp });
  } catch (e) {
    console.error('[escrow/reveal-otp]', id, e?.message || e);
    res.status(400).json({ message: e?.message || 'Could not load delivery OTP.' });
  }
}

router.post('/orders/:orderId/verify-otp', authRequiredSupabaseOrExpress, async (req, res) => {
  await handleVerifyOtp(req, res, req.params.orderId, req.body?.otp ?? req.body?.code);
});

router.post('/verify-otp', authRequiredSupabaseOrExpress, async (req, res) => {
  await handleVerifyOtp(
    req,
    res,
    req.body?.orderId ?? req.body?.order_id,
    req.body?.otp ?? req.body?.code
  );
});

router.post('/verify-delivery-otp', authRequiredSupabaseOrExpress, async (req, res) => {
  await handleVerifyOtp(
    req,
    res,
    req.body?.orderId ?? req.body?.order_id,
    req.body?.otp ?? req.body?.code
  );
});

router.get('/orders/:orderId/reveal-otp', authRequiredSupabaseOrExpress, async (req, res) => {
  await handleRevealOtp(req, res, req.params.orderId);
});

router.get('/reveal-otp/:orderId', authRequiredSupabaseOrExpress, async (req, res) => {
  await handleRevealOtp(req, res, req.params.orderId);
});

router.get('/reveal-buyer-otp/:orderId', authRequiredSupabaseOrExpress, async (req, res) => {
  await handleRevealOtp(req, res, req.params.orderId);
});

// ---------------------------------------------------------------------------
// Auction resolution (service_role)
// ---------------------------------------------------------------------------

router.post('/resolve/:listingId', authRequiredSupabaseOrExpress, async (req, res) => {
  if (!isSupabaseWalletSyncConfigured()) return supabaseUnavailable(res);
  const listingId = req.params.listingId != null ? String(req.params.listingId).trim() : '';
  if (!listingId) return res.status(400).json({ message: 'listingId required' });
  const force = !!(req.body?.force ?? req.query?.force);
  try {
    const data = await supabaseRpc(
      'resolve_auction',
      { p_listing_id: listingId, p_force: force },
      { logTag: 'escrow/resolve' }
    );
    res.json(data);
  } catch (e) {
    console.error('[escrow/resolve]', listingId, e?.message || e);
    res.status(500).json({ message: e?.message || 'Could not resolve auction escrow.' });
  }
});

router.post('/resolve-expired', async (req, res) => {
  if (!isSupabaseWalletSyncConfigured()) return supabaseUnavailable(res);
  const limit = Math.min(500, Math.max(1, Number(req.body?.limit) || 50));
  try {
    const data = await supabaseRpc('resolve_expired_auctions', { p_limit: limit }, { logTag: 'escrow/batch' });
    res.json(data);
  } catch (e) {
    console.error('[escrow/resolve-expired]', e?.message || e);
    res.status(500).json({ message: e?.message || 'Could not resolve expired auctions.' });
  }
});

module.exports = router;
