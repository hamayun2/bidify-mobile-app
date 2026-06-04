const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { isSupabaseWalletSyncConfigured, isUuid } = require('../supabaseWallet');

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  '';

function getAnonClient() {
  if (!SUPABASE_URL || !ANON_KEY) return null;
  return createClient(String(SUPABASE_URL).replace(/\/$/, ''), ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function getServiceClient() {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  return createClient(String(SUPABASE_URL).replace(/\/$/, ''), SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function resolveUserFromBearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return { user: null, error: 'Missing Authorization bearer token.' };

  const token = m[1].trim();
  const anon = getAnonClient();
  if (!anon) return { user: null, error: 'Supabase anon key not configured on server.' };

  const { data, error } = await anon.auth.getUser(token);
  if (error || !data?.user?.id) {
    return { user: null, error: error?.message || 'Invalid or expired session.' };
  }
  return { user: data.user, accessToken: token };
}

/**
 * POST /api/bids/place
 * Body: { listingId, amount }
 * Requires Supabase access token (Authorization: Bearer).
 */
router.post('/place', async (req, res) => {
  if (!isSupabaseWalletSyncConfigured()) {
    return res.status(503).json({
      ok: false,
      message:
        'Bid placement requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY on the API server.',
    });
  }

  const { user, accessToken, error: authErr } = await resolveUserFromBearer(req);
  if (!user?.id) {
    return res.status(401).json({ ok: false, message: authErr || 'Unauthorized' });
  }

  const listingId = String(req.body?.listingId || req.body?.listing_id || '').trim();
  const amount = Number(req.body?.amount);

  if (!listingId || !isUuid(listingId)) {
    return res.status(400).json({ ok: false, message: 'Invalid listing id.' });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ ok: false, message: 'Invalid bid amount.' });
  }

  try {
    const admin = getServiceClient();
    if (!admin) {
      return res.status(503).json({ ok: false, message: 'Supabase service client unavailable.' });
    }

    const { data: profile, error: profileErr } = await admin
      .from('profiles')
      .select('wallet_balance')
      .eq('id', user.id)
      .maybeSingle();

    if (profileErr) {
      console.warn('[bids/place] profile read', profileErr.message);
    }

    const walletBalance = Number(profile?.wallet_balance ?? 0) || 0;
    if (walletBalance < amount) {
      return res.status(400).json({
        ok: false,
        message: `Insufficient wallet balance. Need Rs. ${amount.toLocaleString()}; you have Rs. ${walletBalance.toLocaleString()}.`,
        topUpRequired: true,
        balance: walletBalance,
        required: amount,
        bidAmount: amount,
      });
    }

    const anon = getAnonClient();
    if (!anon) {
      return res.status(503).json({ ok: false, message: 'Supabase anon client unavailable.' });
    }

    const supabaseUser = createClient(
      String(SUPABASE_URL).replace(/\/$/, ''),
      ANON_KEY,
      {
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      }
    );

    const securityFee =
      amount > 10000 ? 1000 : amount > 5000 ? 500 : amount > 1000 ? 500 : 100;

    const { data: bidRow, error: rpcErr } = await supabaseUser.rpc('place_bid_with_wallet_lock', {
      p_listing_id: listingId,
      p_amount: amount,
      p_security_fee: securityFee,
    });

    if (rpcErr) {
      const msg = String(rpcErr.message || 'Could not place bid.');
      const status = /insufficient wallet balance/i.test(msg) ? 400 : 400;
      return res.status(status).json({
        ok: false,
        message: msg.replace(/^place_bid_with_wallet_lock:\s*/i, ''),
        topUpRequired: /insufficient wallet balance/i.test(msg),
      });
    }

    return res.json({
      ok: true,
      bid: bidRow,
      amount,
    });
  } catch (e) {
    console.error('[bids/place]', e?.message || e);
    return res.status(500).json({
      ok: false,
      message: e?.message || 'Could not place bid.',
    });
  }
});

module.exports = router;
