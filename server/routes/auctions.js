const express = require('express');
const {
  supabaseRpc,
  isSupabaseWalletSyncConfigured,
  getSupabaseKeyDiagnostics,
} = require('../supabaseWallet');

const router = express.Router();

/**
 * POST /api/auctions/resolve-expired
 * Alias for POST /api/escrow/resolve-expired (backward compatibility).
 */
router.post('/resolve-expired', async (req, res) => {
  console.log('CRON TICK (manual HTTP): Checking for expired auctions...');
  if (!isSupabaseWalletSyncConfigured()) {
    const diag = getSupabaseKeyDiagnostics();
    console.log('RESOLUTION RESULT: ', { data: null, error: 'service role not configured', diag });
    return res.status(503).json({
      message:
        'Supabase service role not configured on API server (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).',
      diagnostics: diag,
    });
  }
  const limit = Math.min(500, Math.max(1, Number(req.body?.limit) || 50));
  let data = null;
  let error = null;
  try {
    console.log('[auctions/resolve-expired] auth:', getSupabaseKeyDiagnostics());
    data = await supabaseRpc('resolve_expired_auctions', { p_limit: limit }, { logTag: 'auctions-http' });
    console.log('RESOLUTION RESULT: ', { data, error: null });
    res.json(data);
  } catch (e) {
    error = e?.message || String(e);
    console.log('RESOLUTION RESULT: ', { data: null, error });
    res.status(500).json({ message: error });
  }
});

module.exports = router;
