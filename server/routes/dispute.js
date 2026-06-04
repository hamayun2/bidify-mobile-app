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
        'Dispute actions require a Supabase session. Log out and sign in again (bridge-login).',
    });
    return false;
  }
  return true;
}

async function handleRaiseDispute(req, res, orderId, reason) {
  if (!requireSupabaseSession(req, res)) return;

  const id = orderId != null ? String(orderId).trim() : '';
  const text = String(reason ?? '').trim();
  if (!id || !isUuid(id)) {
    return res.status(400).json({ message: 'Valid orderId is required.' });
  }
  if (text.length < 10) {
    return res.status(400).json({ message: 'Please describe the issue (at least 10 characters).' });
  }

  try {
    const data = await rpcAsUser(req.authUser.accessToken, 'raise_order_dispute', {
      p_order_id: id,
      p_reason: text,
    });
    res.json(data != null && typeof data === 'object' ? data : { ok: true });
  } catch (e) {
    console.error('[dispute/raise]', id, e?.message || e);
    res.status(400).json({ message: e?.message || 'Could not raise dispute.', code: e?.code });
  }
}

/**
 * POST /api/dispute/raise
 * Body: { orderId, reason }
 */
router.post('/raise', authRequiredSupabaseOrExpress, async (req, res) => {
  await handleRaiseDispute(
    req,
    res,
    req.body?.orderId ?? req.body?.order_id,
    req.body?.reason
  );
});

/**
 * POST /api/dispute/:orderId/raise
 * Body: { reason }
 */
router.post('/:orderId/raise', authRequiredSupabaseOrExpress, async (req, res) => {
  await handleRaiseDispute(req, res, req.params.orderId, req.body?.reason);
});

/** Alias used by some clients */
router.post('/raise-order', authRequiredSupabaseOrExpress, async (req, res) => {
  await handleRaiseDispute(
    req,
    res,
    req.body?.orderId ?? req.body?.order_id,
    req.body?.reason
  );
});

module.exports = router;
