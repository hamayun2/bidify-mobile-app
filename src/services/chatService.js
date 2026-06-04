import { getSupabase, BUCKET_LISTING_IMAGES } from './supabaseClient';
import { logPostgrestError } from './supabaseErrors';
import { fetchListingById } from './listingsService';
import { isLocalDeviceMediaUri } from '../utils/listingMedia';
import { extFromUri, mimeFromExt, readUriAsUploadBody } from '../utils/storageUpload';

/** Path must match storage RLS: name LIKE auth.uid() || '/%' */
async function uploadChatImage(userId, uri) {
  const supabase = getSupabase();
  const uid = String(userId).trim();
  const ext = extFromUri(uri);
  const path = `${uid}/chat/${Date.now()}.${ext}`;
  const body = await readUriAsUploadBody(uri);
  const { error } = await supabase.storage.from(BUCKET_LISTING_IMAGES).upload(path, body, {
    contentType: mimeFromExt(ext),
    upsert: false,
    cacheControl: '3600',
  });
  if (error) {
    console.error('[chat] storage upload failed', {
      path,
      message: error.message,
      statusCode: error.statusCode,
    });
    logPostgrestError('storage.chat upload', error);
    throw new Error(error.message || 'Could not upload image.');
  }
  const { data: pub } = supabase.storage.from(BUCKET_LISTING_IMAGES).getPublicUrl(path);
  return pub?.publicUrl || null;
}

function mapMessageRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    senderId: row.sender_id != null ? String(row.sender_id) : null,
    text: row.text ?? row.body ?? null,
    imageUrl: row.image_url ?? null,
    isRead: row.is_read === true,
    createdAt: row.created_at,
  };
}

function profileAvatarFromRow(row) {
  if (!row) return null;
  const raw = row.profile_image ?? null;
  return raw != null && String(raw).trim() ? String(raw).trim() : null;
}

function profileDisplayName(row, fallback = 'User') {
  if (!row) return fallback;
  const full = row.full_name != null ? String(row.full_name).trim() : '';
  if (full) return full;
  const user = row.username != null ? String(row.username).trim() : '';
  if (user) return user;
  const email = row.email != null ? String(row.email).trim() : '';
  if (email) return email.split('@')[0];
  return fallback;
}

function mapConversationRow(row, viewerId, listingMeta = {}, profilesById = {}) {
  if (!row) return null;
  const buyerId = row.buyer_id != null ? String(row.buyer_id) : null;
  const sellerId = row.seller_id != null ? String(row.seller_id) : null;
  const otherId = String(viewerId) === buyerId ? sellerId : buyerId;
  const otherProfile = profilesById[otherId] || {};
  const otherName = profileDisplayName(
    otherProfile,
    listingMeta.sellerName || 'Seller'
  );
  return {
    id: String(row.id),
    listingId: row.listing_id != null ? String(row.listing_id) : null,
    listingTitle: listingMeta.title || row.listing_title || 'Listing',
    listingImage: listingMeta.image || row.listing_image || null,
    buyerId,
    sellerId,
    createdAt: row.created_at,
    other: {
      id: otherId,
      name: otherName,
      avatarUrl: profileAvatarFromRow(otherProfile),
      email: otherProfile.email || null,
    },
    lastMessage: null,
  };
}

async function loadProfilesById(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return {};
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, username, email, profile_image')
    .in('id', unique);
  if (error) {
    logPostgrestError('profiles.select chat', error);
    return {};
  }
  const out = {};
  for (const row of data || []) {
    out[String(row.id)] = row;
  }
  return out;
}

async function attachLastMessages(convos) {
  if (!convos.length) return convos;
  const supabase = getSupabase();
  const ids = convos.map((c) => c.id);
  const { data, error } = await supabase
    .from('messages')
    .select('id, conversation_id, sender_id, body, image_url, is_read, created_at')
    .in('conversation_id', ids)
    .order('created_at', { ascending: false });
  if (error) {
    logPostgrestError('messages.select last', error);
    return convos;
  }
  const latestByConvo = {};
  for (const row of data || []) {
    const cid = String(row.conversation_id);
    if (!latestByConvo[cid]) latestByConvo[cid] = mapMessageRow(row);
  }
  return convos.map((c) => ({
    ...c,
    lastMessage: latestByConvo[c.id] || null,
  }));
}

/** Unread count per conversation (messages from other user with is_read = false). */
async function attachUnreadCounts(convos, viewerId) {
  if (!convos.length || !viewerId) return convos;
  const supabase = getSupabase();
  const uid = String(viewerId).trim();
  const ids = convos.map((c) => c.id);

  const { data, error } = await supabase
    .from('messages')
    .select('conversation_id')
    .in('conversation_id', ids)
    .neq('sender_id', uid)
    .eq('is_read', false);

  if (error) {
    console.error('[chat] unread counts failed', error.message, error.code, error.details);
    logPostgrestError('messages.select unread', error);
    return convos.map((c) => ({ ...c, unreadCount: 0 }));
  }

  const counts = {};
  for (const row of data || []) {
    const cid = String(row.conversation_id);
    counts[cid] = (counts[cid] || 0) + 1;
  }

  return convos.map((c) => ({
    ...c,
    unreadCount: Math.min(99, counts[String(c.id)] || 0),
  }));
}

export async function markConversationMessagesRead(conversationId, viewerId) {
  const cid = conversationId != null ? String(conversationId) : '';
  const uid = viewerId != null ? String(viewerId).trim() : '';
  if (!cid || !uid) return;

  const supabase = getSupabase();
  const { error } = await supabase
    .from('messages')
    .update({ is_read: true })
    .eq('conversation_id', cid)
    .neq('sender_id', uid)
    .eq('is_read', false);

  if (error) {
    console.error('[chat] mark read failed', error.message, error.code);
    logPostgrestError('messages.update mark read', error);
  }
}

export async function startConversationSupabase({ listing, buyer }) {
  if (!listing?.id) throw new Error('listing.id required');
  const listingId = String(listing.id);
  const sellerId = listing.sellerId != null ? String(listing.sellerId) : '';
  if (!sellerId) throw new Error('Listing has no seller.');
  const buyerId = buyer?.id != null ? String(buyer.id) : '';
  if (!buyerId) throw new Error('You must be signed in to chat.');
  if (buyerId === sellerId) throw new Error('You cannot chat about your own listing.');

  const supabase = getSupabase();
  const { data: existing, error: findErr } = await supabase
    .from('conversations')
    .select('*')
    .eq('listing_id', listingId)
    .eq('buyer_id', buyerId)
    .eq('seller_id', sellerId)
    .maybeSingle();
  if (findErr) {
    logPostgrestError('conversations.select', findErr);
    throw new Error(findErr.message || 'Could not open chat.');
  }

  let row = existing;
  if (!row) {
    const { data: inserted, error: insErr } = await supabase
      .from('conversations')
      .insert({
        listing_id: listingId,
        buyer_id: buyerId,
        seller_id: sellerId,
      })
      .select('*')
      .single();
    if (insErr) {
      logPostgrestError('conversations.insert', insErr);
      throw new Error(insErr.message || 'Could not start chat.');
    }
    row = inserted;
  }

  const profiles = await loadProfilesById([buyerId, sellerId]);
  const listingMeta = {
    title: listing.title || 'Listing',
    image: listing.image || (Array.isArray(listing.images) ? listing.images[0] : null),
    sellerName: listing.sellerName,
  };
  return mapConversationRow(row, buyerId, listingMeta, profiles);
}

export async function getConversationsSupabase(viewerId) {
  const uid = viewerId != null ? String(viewerId) : '';
  if (!uid) return [];
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .or(`buyer_id.eq.${uid},seller_id.eq.${uid}`)
    .order('created_at', { ascending: false });
  if (error) {
    logPostgrestError('conversations.select mine', error);
    throw new Error(error.message || 'Could not load chats.');
  }
  const rows = Array.isArray(data) ? data : [];
  const otherIds = rows.map((r) => {
    const b = String(r.buyer_id);
    const s = String(r.seller_id);
    return b === uid ? s : b;
  });
  const profiles = await loadProfilesById(otherIds);
  let convos = rows.map((r) => mapConversationRow(r, uid, {}, profiles));
  convos = await attachLastMessages(convos);
  convos = await attachUnreadCounts(convos, uid);
  return convos;
}

export async function getMessagesSupabase(conversationId, sinceIso) {
  const cid = conversationId != null ? String(conversationId) : '';
  if (!cid) return { messages: [], conversation: null };
  const supabase = getSupabase();
  let q = supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', cid)
    .order('created_at', { ascending: true });
  if (sinceIso) q = q.gt('created_at', sinceIso);
  const { data, error } = await q;
  if (error) {
    logPostgrestError('messages.select', error);
    throw new Error(error.message || 'Could not load messages.');
  }
  return {
    messages: (data || []).map(mapMessageRow).filter(Boolean),
    conversation: null,
  };
}

export async function sendMessageSupabase(conversationId, { text, imageUri, sender } = {}) {
  const cid = conversationId != null ? String(conversationId) : '';
  if (!cid) throw new Error('conversationId required');
  const trimmed = text ? String(text).trim() : '';
  if (!trimmed && !imageUri) throw new Error('Empty message');

  const senderId = sender?.id != null ? String(sender.id) : '';
  if (!senderId) throw new Error('You must be signed in to send messages.');

  let imageUrl = null;
  try {
    if (imageUri && isLocalDeviceMediaUri(imageUri)) {
      imageUrl = await uploadChatImage(senderId, imageUri);
    } else if (imageUri) {
      imageUrl = imageUri;
    }
  } catch (uploadErr) {
    console.error('SUPABASE CHAT ERROR:', uploadErr);
    throw uploadErr;
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: cid,
      sender_id: senderId,
      body: trimmed || '',
      image_url: imageUrl,
      is_read: false,
    })
    .select('*')
    .single();
  if (error) {
    console.error('SUPABASE CHAT ERROR:', error);
    logPostgrestError('messages.insert', error);
    throw error;
  }
  return mapMessageRow(data);
}

/** Load the other participant's profile for the chat header. */
export async function fetchChatPartnerProfile(userId) {
  const id = userId != null ? String(userId).trim() : '';
  if (!id) return null;
  const profiles = await loadProfilesById([id]);
  const row = profiles[id];
  if (!row) {
    return { id, name: 'User', avatarUrl: null, email: null };
  }
  return {
    id,
    name: profileDisplayName(row, 'User'),
    avatarUrl: profileAvatarFromRow(row),
    email: row.email || null,
  };
}

/** Resolve listing from id when navigation only passes listingId. */
export async function resolveListingForChat(listingId) {
  const id = listingId != null ? String(listingId).trim() : '';
  if (!id || id === '[object Object]') return null;
  const listing = await fetchListingById(id);
  return listing || null;
}

/** Total unread messages for Chats tab badge (messages table, not notifications). */
export async function fetchUnreadMessagesCount(userId) {
  const uid = userId != null ? String(userId).trim() : '';
  if (!uid) return 0;

  const supabase = getSupabase();
  const { data: convos, error: convoErr } = await supabase
    .from('conversations')
    .select('id')
    .or(`buyer_id.eq.${uid},seller_id.eq.${uid}`);

  if (convoErr) {
    logPostgrestError('conversations.select for unread', convoErr);
    return 0;
  }

  const ids = (Array.isArray(convos) ? convos : []).map((c) => c.id).filter(Boolean);
  if (!ids.length) return 0;

  const { count, error } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .in('conversation_id', ids)
    .neq('sender_id', uid)
    .eq('is_read', false);

  if (error) {
    logPostgrestError('messages.count unread', error, { userId: uid });
    return 0;
  }
  return Math.min(99, Number(count) || 0);
}

/** Realtime updates for Chats tab badge when messages are sent or marked read. */
export function subscribeToUnreadMessages(userId, onChange) {
  const uid = userId != null ? String(userId).trim() : '';
  if (!uid) return () => {};

  const supabase = getSupabase();
  let debounce = null;
  const schedule = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      onChange?.();
    }, 350);
  };

  const channel = supabase
    .channel(`chat-unread:${uid}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages' },
      schedule
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'messages' },
      schedule
    )
    .subscribe();

  return () => {
    if (debounce) clearTimeout(debounce);
    supabase.removeChannel(channel);
  };
}
