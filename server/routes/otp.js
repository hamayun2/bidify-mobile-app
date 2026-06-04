/**
 * Delivery OTP API — proxies to Supabase RPCs (same logic as /api/escrow OTP routes).
 * POST verify_delivery_otp · GET reveal_buyer_delivery_otp
 */

const express = require('express');
const { getSupabaseKeyDiagnostics, isSupabaseWalletSyncConfigured } = require('../supabaseWallet');
const { authRequiredSupabaseOrExpress } = require('../middleware/resolveSupabaseUser');
const { isUuid, rpcAsUser } = require('../services/escrowRpc');

const router = express.Router();

function supabaseUnavailable(res) {
  return res.status(503).json({
    message:
      'Supabase not configured on API server (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).',
    diagnostics: getSupabaseKeyDiagnostics(),
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
        'OTP actions require a Supabase session. Log out and sign in again (bridge-login).',
    });
    return false;
  }
  return true;
}

async function handleVerify(req, res, orderId, otp) {
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
    console.error('[otp/verify]', id, e?.message || e);
    res.status(400).json({
      message: e?.message || 'Could not verify delivery OTP.',
      invalidOtp: !!e?.invalidOtp,
    });
  }
}

async function handleReveal(req, res, orderId) {
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
    console.error('[otp/reveal]', id, e?.message || e);
    res.status(400).json({ message: e?.message || 'Could not load delivery OTP.' });
  }
}

/** POST /api/otp/verify */
router.post('/verify', authRequiredSupabaseOrExpress, async (req, res) => {
  await handleVerify(
    req,
    res,
    req.body?.orderId ?? req.body?.order_id,
    req.body?.otp ?? req.body?.code
  );
});

/** POST /api/otp/verify-delivery */
router.post('/verify-delivery', authRequiredSupabaseOrExpress, async (req, res) => {
  await handleVerify(
    req,
    res,
    req.body?.orderId ?? req.body?.order_id,
    req.body?.otp ?? req.body?.code
  );
});

/** POST /api/otp/:orderId/verify */
router.post('/:orderId/verify', authRequiredSupabaseOrExpress, async (req, res) => {
  await handleVerify(req, res, req.params.orderId, req.body?.otp ?? req.body?.code);
});

/** GET /api/otp/reveal/:orderId */
router.get('/reveal/:orderId', authRequiredSupabaseOrExpress, async (req, res) => {
  await handleReveal(req, res, req.params.orderId);
});

/** GET /api/otp/:orderId/reveal */
router.get('/:orderId/reveal', authRequiredSupabaseOrExpress, async (req, res) => {
  await handleReveal(req, res, req.params.orderId);
});

module.exports = router;
