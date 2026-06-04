import { getSupabase, BUCKET_LISTING_IMAGES } from './supabaseClient';
import { logPostgrestError } from './supabaseErrors';

function parseRpcError(error, fallback) {
  const msg = error?.message || error?.details || fallback;
  return new Error(msg);
}

async function readUriAsBlob(uri) {
  const res = await fetch(uri);
  if (!res.ok) throw new Error(`Could not read file (${res.status}).`);
  return res.blob();
}

function extFromUri(uri) {
  const lower = String(uri || '').toLowerCase();
  if (lower.includes('.png')) return 'png';
  if (lower.includes('.webp')) return 'webp';
  return 'jpg';
}

function mimeFromExt(ext) {
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

/**
 * Get or create the shared support ticket for a disputed order.
 * @param {string} orderId
 */
export async function ensureOrderSupportTicket(orderId) {
  const supabase = getSupabase();
  const id = orderId != null ? String(orderId).trim() : '';
  if (!id) throw new Error('Order not found.');

  const { data, error } = await supabase.rpc('ensure_order_support_ticket', {
    p_order_id: id,
  });

  if (error) {
    logPostgrestError('rpc.ensure_order_support_ticket', error);
    throw parseRpcError(error, 'Could not open admin support.');
  }

  const row = data != null && typeof data === 'object' ? data : {};
  const ticketId = row.ticket_id != null ? String(row.ticket_id) : null;
  if (!ticketId) throw new Error('Support ticket was not created.');
  await seedSupportTicketAiGreeting(ticketId);
  return { ticketId, created: !!row.created, raw: row };
}

/**
 * Idempotent AI greeting on ticket open (also runs inside ensure_order_support_ticket SQL).
 * @param {string} ticketId
 */
export async function seedSupportTicketAiGreeting(ticketId) {
  const supabase = getSupabase();
  const id = ticketId != null ? String(ticketId).trim() : '';
  if (!id) return null;

  const { data, error } = await supabase.rpc('seed_support_ticket_ai_greeting', {
    p_ticket_id: id,
  });

  if (error) {
    logPostgrestError('rpc.seed_support_ticket_ai_greeting', error);
    return null;
  }
  return data;
}

/**
 * @param {string} ticketId
 */
export async function fetchSupportTicketThread(ticketId) {
  const supabase = getSupabase();
  const id = ticketId != null ? String(ticketId).trim() : '';
  if (!id) throw new Error('Support ticket not found.');

  const { data, error } = await supabase.rpc('fetch_support_ticket_thread', {
    p_ticket_id: id,
  });

  if (error) {
    logPostgrestError('rpc.fetch_support_ticket_thread', error);
    throw parseRpcError(error, 'Could not load support messages.');
  }

  const row = data != null && typeof data === 'object' ? data : {};
  const messages = Array.isArray(row.messages) ? row.messages : [];
  const attachments = Array.isArray(row.attachments) ? row.attachments : [];
  return {
    ticket: mapSupportTicket(row.ticket),
    messages: messages.map(mapSupportMessage),
    attachments,
  };
}

/**
 * Poll order status for dispute chat resolution banner.
 * @param {string} orderId
 */
export async function fetchDisputeOrderStatus(orderId) {
  const supabase = getSupabase();
  const id = orderId != null ? String(orderId).trim() : '';
  if (!id) return null;

  const { data, error } = await supabase
    .from('auction_orders')
    .select('id, status')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    logPostgrestError('auction_orders.select status', error);
    return null;
  }
  if (!data?.status) return null;
  return String(data.status)
    .trim()
    .toLowerCase()
    .replace(/^auction_order_status\./, '');
}

function mapSupportTicket(t) {
  if (!t || typeof t !== 'object') return null;
  const status = t.status != null ? String(t.status) : 'open';
  return {
    id: t.id != null ? String(t.id) : null,
    orderId: t.order_id != null ? String(t.order_id) : null,
    status,
    isHumanRequired: !!t.is_human_required || status === 'awaiting_admin',
    humanRequestedAt: t.human_requested_at || null,
    subject: t.subject || '',
  };
}

/**
 * Request human admin (also available via Express API).
 * @param {string} ticketId
 */
export async function requestSupportTicketHuman(ticketId) {
  const supabase = getSupabase();
  const id = ticketId != null ? String(ticketId).trim() : '';
  if (!id) throw new Error('Support ticket not found.');

  const { data, error } = await supabase.rpc('request_support_ticket_human', {
    p_ticket_id: id,
  });

  if (error) {
    logPostgrestError('rpc.request_support_ticket_human', error);
    throw parseRpcError(error, 'Could not request human admin.');
  }

  const row = data != null && typeof data === 'object' ? data : { ok: true };
  if (row.ok === false) {
    throw new Error(row.message || 'Could not request human admin.');
  }
  return {
    ok: true,
    status: row.status || 'awaiting_admin',
    isHumanRequired: row.is_human_required !== false,
    alreadyRequested: !!row.already_requested,
    ticketId: row.ticket_id != null ? String(row.ticket_id) : id,
    raw: row,
  };
}

function mapSupportMessage(m) {
  return {
    id: String(m.id),
    ticketId: String(m.ticket_id),
    senderId: m.sender_id != null ? String(m.sender_id) : null,
    body: m.body || '',
    isAdmin: !!m.is_admin_message,
    isAi: !!m.is_ai_assistant,
    createdAt: m.created_at,
  };
}

/**
 * @param {string} ticketId
 * @param {string} body
 */
export async function sendSupportTicketMessage(ticketId, body) {
  const supabase = getSupabase();
  const id = ticketId != null ? String(ticketId).trim() : '';
  const text = String(body ?? '').trim();
  if (!id) throw new Error('Support ticket not found.');
  if (!text) throw new Error('Message cannot be empty.');

  const { data, error } = await supabase.rpc('send_support_ticket_message', {
    p_ticket_id: id,
    p_body: text,
  });

  if (error) {
    logPostgrestError('rpc.send_support_ticket_message', error);
    throw parseRpcError(error, 'Could not send message.');
  }

  const msg = data?.message;
  return msg ? mapSupportMessage(msg) : { ok: true };
}

/**
 * Upload proof image and register attachment linked to a message.
 * @param {string} ticketId
 * @param {string} messageId
 * @param {string} userId
 * @param {string} localUri
 */
export async function uploadSupportTicketAttachment(ticketId, messageId, userId, localUri) {
  const supabase = getSupabase();
  const tid = String(ticketId).trim();
  const mid = String(messageId).trim();
  const uid = String(userId).trim();
  if (!tid || !mid || !uid || !localUri) throw new Error('Missing attachment data.');

  const ext = extFromUri(localUri);
  const storagePath = `support-tickets/${tid}/${uid}-${Date.now()}.${ext}`;
  const blob = await readUriAsBlob(localUri);

  const { error: upErr } = await supabase.storage.from(BUCKET_LISTING_IMAGES).upload(storagePath, blob, {
    contentType: mimeFromExt(ext),
    upsert: false,
  });
  if (upErr) {
    logPostgrestError('storage.support upload', upErr);
    throw new Error(upErr.message || 'Could not upload proof image.');
  }

  const { data: pub } = supabase.storage.from(BUCKET_LISTING_IMAGES).getPublicUrl(storagePath);
  const publicUrl = pub?.publicUrl || null;

  const { data, error } = await supabase.rpc('register_support_ticket_attachment', {
    p_ticket_id: tid,
    p_message_id: mid,
    p_storage_path: storagePath,
    p_file_name: `proof.${ext}`,
    p_mime_type: mimeFromExt(ext),
  });

  if (error) {
    logPostgrestError('rpc.register_support_ticket_attachment', error);
    throw parseRpcError(error, 'Could not save attachment record.');
  }

  return { storagePath, publicUrl, raw: data };
}
