import client, { isAuxiliaryApiConfigured } from './client';
import { getSupabase } from '../services/supabaseClient';

const ACTION_TO_ATOMIC = {
  release_seller: 'RELEASE_TO_SELLER',
  refund_buyer: 'REFUND_TO_BUYER',
  RELEASE_TO_SELLER: 'RELEASE_TO_SELLER',
  REFUND_TO_BUYER: 'REFUND_TO_BUYER',
};

/**
 * Settle a disputed order via Supabase atomic RPC, legacy RPC, or Express fallback.
 * @param {{
 *   orderId: string;
 *   ticketId?: string | null;
 *   action: 'release_seller' | 'refund_buyer';
 *   resolutionAction?: 'RELEASE_TO_SELLER' | 'REFUND_TO_BUYER';
 *   note?: string;
 * }} params
 */
export async function adminSettleDispute({
  orderId,
  ticketId = null,
  action,
  resolutionAction,
  note = '',
}) {
  const supabase = getSupabase();
  const { data: sessionData } = await supabase.auth.getSession();
  const adminUserId = sessionData?.session?.user?.id;
  if (!adminUserId) {
    throw new Error('Sign in again to settle disputes.');
  }

  const atomicAction =
    resolutionAction ||
    ACTION_TO_ATOMIC[action] ||
    null;

  if (!atomicAction) {
    throw new Error('Invalid settlement action.');
  }

  const { data: atomicData, error: atomicError } = await supabase.rpc('atomic_settle_dispute', {
    p_order_id: String(orderId),
    p_resolution_action: atomicAction,
  });

  if (!atomicError) {
    return normalizeSettleResult(atomicData, action);
  }

  const atomicMsg = String(atomicError.message || atomicError.details || '');
  const atomicMissing =
    atomicError.code === 'PGRST202' ||
    /could not find the function/i.test(atomicMsg) ||
    /atomic_settle_dispute/i.test(atomicMsg);

  if (!atomicMissing && atomicMsg) {
    throw new Error(atomicMsg || 'Settlement failed.');
  }

  const rpcParams = {
    p_order_id: String(orderId),
    p_action: action,
    p_note: note || null,
    p_admin_user_id: adminUserId,
  };

  const { data: rpcData, error: rpcError } = await supabase.rpc('settle_order_dispute', rpcParams);

  if (!rpcError) {
    return normalizeSettleResult(rpcData, action);
  }

  const rpcMsg = String(rpcError.message || rpcError.details || '');
  const rpcMissing =
    rpcError.code === 'PGRST202' ||
    /could not find the function/i.test(rpcMsg) ||
    /settle_order_dispute/i.test(rpcMsg);

  if (!rpcMissing && rpcMsg) {
    throw new Error(rpcMsg || 'Settlement failed.');
  }

  if (isAuxiliaryApiConfigured()) {
    const token = sessionData?.session?.access_token;
    const { data } = await client.post(
      `/admin/disputes/${encodeURIComponent(orderId)}/settle`,
      {
        orderId: String(orderId),
        ticketId: ticketId != null ? String(ticketId) : null,
        action,
        resolution_action: atomicAction,
        note: note || null,
        adminUserId,
      },
      {
        timeout: 30_000,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      }
    );
    return normalizeSettleResult(data, action);
  }

  throw new Error(
    atomicMsg ||
      rpcMsg ||
      'Settlement failed. Run supabase/atomic_settle_dispute.sql in the Supabase SQL Editor.'
  );
}

function normalizeSettleResult(row, action) {
  const data = row?.raw != null && typeof row.raw === 'object' ? row.raw : row;
  const payload = data != null && typeof data === 'object' ? data : {};
  const ok = payload.ok !== false;
  if (!ok) {
    throw new Error(payload.message || 'Settlement failed.');
  }
  return {
    ok: true,
    orderId: payload.order_id != null ? String(payload.order_id) : null,
    status: payload.status,
    resolution: payload.resolution || action,
    amount:
      Number(payload.settled_amount ?? payload.escrow_released ?? payload.refunded_amount) || null,
    message: 'Funds successfully transferred!',
  };
}
