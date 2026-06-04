import { getSupabase } from './supabaseClient';
import { logPostgrestError } from './supabaseErrors';

export async function fetchAdminTicketIdForOrder(orderId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('support_tickets')
    .select('id')
    .eq('order_id', String(orderId))
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    logPostgrestError('support_tickets.select by order', error);
    return null;
  }
  return data?.id != null ? String(data.id) : null;
}

function parseRpcError(error, fallback) {
  return new Error(error?.message || error?.details || fallback);
}

async function rpc(name, params = {}) {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc(name, params);
  if (error) {
    logPostgrestError(`rpc.${name}`, error);
    throw parseRpcError(error, `Admin action failed (${name}).`);
  }
  return data != null && typeof data === 'object' ? data : {};
}

export async function fetchAdminDashboardMetrics() {
  const row = await rpc('admin_dashboard_metrics');
  return {
    totalUsers: Number(row.total_users) || 0,
    escrowLockedTotal: Number(row.escrow_locked_total) || 0,
    activeDisputes: Number(row.active_disputes) || 0,
    openSupportTickets: Number(row.open_support_tickets) || 0,
  };
}

export async function fetchAdminDisputedOrders() {
  const row = await rpc('admin_list_disputed_orders');
  const orders = Array.isArray(row.orders) ? row.orders : [];
  return orders.map(mapDisputedOrder);
}

function mapDisputedOrder(o) {
  return {
    id: String(o.id),
    listingId: o.listing_id != null ? String(o.listing_id) : null,
    listingTitle: o.listing_title || 'Listing',
    buyerId: o.buyer_id != null ? String(o.buyer_id) : null,
    sellerId: o.seller_id != null ? String(o.seller_id) : null,
    winningBidAmount: Number(o.winning_bid_amount) || 0,
    escrowAmount: Number(o.escrow_amount) || 0,
    status: o.status,
    disputedAt: o.disputed_at,
    disputedBy: o.disputed_by,
    supportTicketId: o.support_ticket_id != null ? String(o.support_ticket_id) : null,
    ticketStatus: o.ticket_status,
    isHumanRequired: !!o.is_human_required,
  };
}

export async function fetchAdminSupportInbox() {
  const row = await rpc('admin_list_support_inbox');
  const tickets = Array.isArray(row.tickets) ? row.tickets : [];
  return tickets.map(mapInboxTicket);
}

function mapInboxTicket(t) {
  return {
    id: String(t.id),
    orderId: String(t.order_id),
    status: t.status,
    subject: t.subject || 'Dispute',
    reason: t.reason || '',
    openedBy: t.opened_by,
    openedByUserId: t.opened_by_user_id != null ? String(t.opened_by_user_id) : null,
    isHumanRequired: !!t.is_human_required,
    humanRequestedAt: t.human_requested_at,
    listingTitle: t.listing_title || 'Order',
    buyerId: t.buyer_id != null ? String(t.buyer_id) : null,
    sellerId: t.seller_id != null ? String(t.seller_id) : null,
    escrowAmount: Number(t.escrow_amount) || 0,
    orderStatus: t.order_status,
    updatedAt: t.updated_at,
  };
}

export async function adminSendSupportMessage(ticketId, body) {
  const row = await rpc('admin_send_support_message', {
    p_ticket_id: String(ticketId),
    p_body: String(body).trim(),
  });
  const m = row.message;
  return m
    ? {
        id: String(m.id),
        body: m.body,
        isAdmin: true,
        isAi: !!m.is_ai_assistant,
        createdAt: m.created_at,
      }
    : { ok: true };
}

export async function adminResolveReleaseSeller(orderId, note = '') {
  const { adminSettleDispute } = await import('../api/adminDisputes');
  return adminSettleDispute({
    orderId: String(orderId),
    action: 'release_seller',
    note,
  });
}

export async function adminResolveRefundBuyer(orderId, note = '') {
  const { adminSettleDispute } = await import('../api/adminDisputes');
  return adminSettleDispute({
    orderId: String(orderId),
    action: 'refund_buyer',
    note,
  });
}

export async function fetchAdminUserWalletLedger(userId, limit = 100) {
  const row = await rpc('admin_get_user_wallet_ledger', {
    p_user_id: String(userId),
    p_limit: limit,
  });
  const profile = row.profile || {};
  const ledger = Array.isArray(row.ledger) ? row.ledger : [];
  return {
    profile: {
      id: String(profile.id),
      email: profile.email,
      fullName: profile.full_name,
      phone: profile.phone_number,
      walletBalance: Number(profile.wallet_balance) || 0,
      heldBalance: Number(profile.held_balance) || 0,
      lockedBalance: Number(profile.locked_balance) || 0,
      createdAt: profile.created_at,
    },
    ledger: ledger.map((e) => ({
      id: String(e.id),
      entryType: e.entry_type,
      amount: Number(e.amount) || 0,
      listingId: e.listing_id,
      orderId: e.order_id,
      description: e.metadata?.description || e.metadata?.reason || e.entry_type,
      createdAt: e.created_at,
    })),
  };
}
