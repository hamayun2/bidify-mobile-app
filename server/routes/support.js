const express = require('express');
const {
  supabaseRpc,
  isSupabaseWalletSyncConfigured,
  isUuid,
} = require('../supabaseWallet');
const { generateDisputeAiReply } = require('../geminiDisputeAssistant');

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  '';

async function supabaseRest(pathAndQuery) {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('Supabase service role not configured on API server.');
  }
  const url = `${String(SUPABASE_URL).replace(/\/$/, '')}/rest/v1/${pathAndQuery}`;
  const res = await fetch(url, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg =
      (data && typeof data === 'object' && (data.message || data.error)) ||
      res.statusText;
    throw new Error(msg);
  }
  return data;
}

async function loadDisputeContext(orderId, ticketId, userId) {
  const orders = await supabaseRest(
    `auction_orders?id=eq.${encodeURIComponent(orderId)}&select=id,status,escrow_amount,buyer_id,seller_id,listing_id,disputed_at,disputed_by`
  );
  const order = Array.isArray(orders) ? orders[0] : null;
  if (!order) throw new Error('Order not found.');

  const uid = String(userId);
  const isParty =
    String(order.buyer_id) === uid || String(order.seller_id) === uid;
  if (!isParty) {
    throw new Error('Not allowed to access this dispute.');
  }

  if (String(order.status) !== 'disputed') {
    throw new Error('AI assistant is only available for disputed orders.');
  }

  let listingTitle = null;
  if (order.listing_id) {
    const listings = await supabaseRest(
      `listings?id=eq.${encodeURIComponent(order.listing_id)}&select=id,title`
    );
    listingTitle = listings?.[0]?.title || null;
  }

  const tickets = await supabaseRest(
    `support_tickets?id=eq.${encodeURIComponent(ticketId)}&select=id,order_id,status,opened_by,reason,is_human_required,human_requested_at`
  );
  const ticket = Array.isArray(tickets) ? tickets[0] : null;
  if (!ticket || String(ticket.order_id) !== String(orderId)) {
    throw new Error('Support ticket not found for this order.');
  }

  const messages = await supabaseRest(
    `support_ticket_messages?ticket_id=eq.${encodeURIComponent(ticketId)}&order=created_at.asc&select=id,body,is_ai_assistant,is_admin_message,sender_id,created_at`
  );

  return {
    order,
    ticket,
    listingTitle,
    messages: Array.isArray(messages) ? messages : [],
    userRole: String(order.buyer_id) === uid ? 'buyer' : 'seller',
  };
}

function buildConversationForGemini(messages, userId) {
  return (messages || [])
    .filter((m) => m?.body && !m.is_admin_message)
    .map((m) => ({
      role:
        m.is_ai_assistant
          ? 'model'
          : String(m.sender_id) === String(userId)
            ? 'user'
            : 'model',
      text: String(m.body),
    }));
}

/**
 * POST /api/support/ai-dispute-handler
 * Body: { ticketId, orderId, userId, userMessage }
 */
router.post('/ai-dispute-handler', async (req, res) => {
  if (!isSupabaseWalletSyncConfigured()) {
    return res.status(503).json({
      message: 'Supabase not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).',
    });
  }

  const ticketId = req.body?.ticketId != null ? String(req.body.ticketId).trim() : '';
  const orderId = req.body?.orderId != null ? String(req.body.orderId).trim() : '';
  const userId = req.body?.userId != null ? String(req.body.userId).trim() : '';
  const userMessage = String(req.body?.userMessage ?? '').trim();

  if (!isUuid(ticketId) || !isUuid(orderId) || !isUuid(userId)) {
    return res.status(400).json({ message: 'ticketId, orderId, and userId are required.' });
  }
  if (!userMessage) {
    return res.status(400).json({ message: 'userMessage is required.' });
  }

  try {
    const ctx = await loadDisputeContext(orderId, ticketId, userId);

    if (
      ctx.ticket.is_human_required === true ||
      String(ctx.ticket.status) === 'awaiting_admin'
    ) {
      return res.json({
        ok: true,
        skipped: true,
        reason: 'human_admin_required',
        message: 'AI assistant is paused — a human admin will respond.',
      });
    }

    const conversationHistory = buildConversationForGemini(ctx.messages, userId);
    if (process.env.NODE_ENV !== 'production') {
      console.log(
        `[support/ai-dispute-handler] ticket=${ticketId} history=${conversationHistory.length} userMsg=${userMessage.slice(0, 80)}`
      );
    }

    const orderContext = {
      orderId: ctx.order.id,
      status: ctx.order.status,
      escrowAmount: ctx.order.escrow_amount,
      listingTitle: ctx.listingTitle,
      userRole: ctx.userRole,
      disputedBy: ctx.order.disputed_by,
      ticketStatus: ctx.ticket.status,
    };

    const aiReply = await generateDisputeAiReply({
      orderContext,
      conversationHistory,
      userMessage,
    });

    const saved = await supabaseRpc('send_support_ticket_ai_message', {
      p_ticket_id: ticketId,
      p_body: aiReply,
    });

    return res.json({
      ok: true,
      reply: aiReply,
      message: saved?.message || null,
    });
  } catch (e) {
    console.error('[support/ai-dispute-handler]', e?.message || e);
    return res.status(500).json({
      message: e?.message || 'AI dispute assistant failed.',
    });
  }
});

/**
 * POST /api/support/tickets/:id/request-human
 * Body: { orderId, userId }
 */
router.post('/tickets/:id/request-human', async (req, res) => {
  if (!isSupabaseWalletSyncConfigured()) {
    return res.status(503).json({
      message: 'Supabase not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).',
    });
  }

  const ticketId = req.params?.id != null ? String(req.params.id).trim() : '';
  const orderId = req.body?.orderId != null ? String(req.body.orderId).trim() : '';
  const userId = req.body?.userId != null ? String(req.body.userId).trim() : '';

  if (!isUuid(ticketId) || !isUuid(orderId) || !isUuid(userId)) {
    return res.status(400).json({ message: 'ticket id, orderId, and userId are required.' });
  }

  try {
    await loadDisputeContext(orderId, ticketId, userId);

    const result = await supabaseRpc('request_support_ticket_human_for_user', {
      p_ticket_id: ticketId,
      p_user_id: userId,
    });

    if (process.env.NODE_ENV !== 'production') {
      console.log('[support/request-human] ok', {
        ticketId,
        status: result?.status,
        is_human_required: result?.is_human_required,
      });
    }

    return res.json({
      ok: true,
      ticketId,
      status: result?.status || 'awaiting_admin',
      isHumanRequired: result?.is_human_required !== false,
      raw: result,
    });
  } catch (e) {
    console.error('[support/request-human]', e?.message || e);
    return res.status(500).json({
      message: e?.message || 'Could not request human admin.',
    });
  }
});

module.exports = router;
