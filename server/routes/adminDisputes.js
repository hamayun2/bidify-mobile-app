const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { supabaseRpc, isSupabaseWalletSyncConfigured, isUuid } = require('../supabaseWallet');

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

const VALID_ACTIONS = new Set(['release_seller', 'refund_buyer']);

/** Map Express/client actions → atomic_settle_dispute RPC action literals. */
function toAtomicResolutionAction(action, resolutionAction) {
  const ra = String(resolutionAction || '').trim().toUpperCase();
  if (ra === 'RELEASE_TO_SELLER' || ra === 'REFUND_TO_BUYER') {
    return ra;
  }
  if (action === 'release_seller') return 'RELEASE_TO_SELLER';
  if (action === 'refund_buyer') return 'REFUND_TO_BUYER';
  return null;
}

function logPostgresSettlementError(tag, err, context = {}) {
  const payload = {
    ...context,
    message: err?.message || String(err),
    code: err?.code || err?.pgCode || null,
    details: err?.details || err?.pgDetails || null,
    hint: err?.hint || err?.pgHint || null,
  };
  console.error(`[${tag}] PostgreSQL / RPC settlement error`, payload);
  return payload;
}

function parseRpcError(err) {
  const msg = String(err?.message || '');
  const codeMatch = msg.match(/\b(P\d{4})\b/);
  return {
    message: msg || 'Dispute settlement failed.',
    code: err?.code || codeMatch?.[1] || null,
    details: err?.details || null,
    hint: err?.hint || null,
  };
}

async function resolveSupabaseUserFromBearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m || !SUPABASE_URL || !ANON_KEY) return null;
  const client = createClient(String(SUPABASE_URL).replace(/\/$/, ''), ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(m[1].trim());
  if (error || !data?.user?.id) return null;
  return data.user;
}

/**
 * POST /api/admin/disputes/:orderId/settle
 * Body: { action: 'release_seller' | 'refund_buyer', note?: string, adminUserId?: uuid }
 * Auth: Bearer <supabase_access_token>
 *
 * Invokes public.atomic_settle_dispute via Supabase service role.
 */
router.post('/disputes/:orderId/settle', async (req, res) => {
  const authUser = await resolveSupabaseUserFromBearer(req);
  if (!authUser?.id) {
    return res.status(401).json({ message: 'Unauthorized — sign in with a valid Supabase session.' });
  }
  if (!isSupabaseWalletSyncConfigured()) {
    return res.status(503).json({
      message: 'Supabase service role not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).',
    });
  }

  const orderId = req.params?.orderId != null ? String(req.params.orderId).trim() : '';
  const ticketId =
    req.body?.ticketId != null ? String(req.body.ticketId).trim() : null;
  const action = req.body?.action != null ? String(req.body.action).trim() : '';
  const resolutionAction =
    req.body?.resolution_action != null ? String(req.body.resolution_action).trim() : '';
  const adminUserId =
    req.body?.adminUserId != null ? String(req.body.adminUserId).trim() : String(authUser.id);

  if (!isUuid(orderId)) {
    return res.status(400).json({ message: 'Valid orderId is required.' });
  }
  const atomicAction = toAtomicResolutionAction(action, resolutionAction);
  const resolvedAction =
    atomicAction === 'RELEASE_TO_SELLER'
      ? 'release_seller'
      : atomicAction === 'REFUND_TO_BUYER'
        ? 'refund_buyer'
        : action;

  if (!VALID_ACTIONS.has(resolvedAction)) {
    return res.status(400).json({
      message: 'action must be release_seller or refund_buyer (or resolution_action RELEASE_TO_SELLER / REFUND_TO_BUYER)',
    });
  }
  if (adminUserId && !isUuid(adminUserId)) {
    return res.status(400).json({ message: 'adminUserId must be a valid UUID when provided.' });
  }
  if (ticketId && !isUuid(ticketId)) {
    return res.status(400).json({ message: 'ticketId must be a valid UUID when provided.' });
  }
  if (!atomicAction) {
    return res.status(400).json({ message: 'Unsupported settlement action.' });
  }

  try {
    const result = await supabaseRpc(
      'atomic_settle_dispute',
      {
        p_order_id: orderId,
        p_resolution_action: atomicAction,
      },
      { logTag: 'admin/settle' }
    );

    if (process.env.NODE_ENV !== 'production') {
      console.log('[admin/settle] atomic_settle_dispute ok', {
        orderId,
        ticketId,
        action: resolvedAction,
        atomicAction,
        status: result?.status,
        resolution: result?.resolution,
        settled_amount: result?.settled_amount,
      });
    }

    return res.json({
      ok: true,
      orderId,
      ticketId,
      action: resolvedAction,
      atomicAction,
      status: result?.status,
      resolution: result?.resolution || resolvedAction,
      amount: result?.settled_amount ?? result?.escrow_released ?? result?.refunded_amount ?? null,
      message:
        result?.message ||
        (resolvedAction === 'release_seller'
          ? 'Funds successfully transferred!'
          : 'Funds successfully transferred!'),
      raw: result,
    });
  } catch (e) {
    const pg = logPostgresSettlementError('admin/settle', e, {
      orderId,
      ticketId,
      action: resolvedAction,
      atomicAction,
      adminUserId,
    });
    const parsed = parseRpcError(e);
    const clientMessage = parsed.message || pg.message || 'Dispute settlement failed.';
    const isClientError =
      /not found/i.test(clientMessage) ||
      /not in disputed/i.test(clientMessage) ||
      /invalid p_resolution_action/i.test(clientMessage) ||
      /admin only/i.test(clientMessage) ||
      /invalid escrow/i.test(clientMessage);

    return res.status(isClientError ? 400 : 500).json({
      message: clientMessage,
      code: parsed.code,
      details: parsed.details,
      hint: parsed.hint,
    });
  }
});

module.exports = router;
