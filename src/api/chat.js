import client, { isAuxiliaryApiConfigured } from './client';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isLocalDeviceMediaUri } from '../utils/listingMedia';
import { isSupabaseConfigured } from '../services/supabaseClient';
import {
  startConversationSupabase,
  getConversationsSupabase,
  getMessagesSupabase,
  sendMessageSupabase,
  resolveListingForChat,
} from '../services/chatService';

const CONVOS_KEY = 'mockChatConversations';
const MSG_KEY = (id) => `mockChatMessages:${id}`;

function parseJson(body) {
  if (body == null) return body;
  if (typeof body === 'string') {
    const t = body.trim();
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch {
      return body;
    }
  }
  return body;
}

function isOffline(err) {
  const m = err?.message || '';
  return m === 'Network Error' || m.includes('Network') || m.includes('timeout');
}

function guessImageMime(uri) {
  const lower = (uri || '').toLowerCase();
  if (lower.includes('.png')) return 'image/png';
  if (lower.includes('.webp')) return 'image/webp';
  if (lower.includes('.heic')) return 'image/heic';
  if (lower.includes('.gif')) return 'image/gif';
  return 'image/jpeg';
}

function fileNameFromUri(uri) {
  try {
    const seg = decodeURIComponent(String(uri).split('/').pop() || '');
    const base = seg.split('?')[0];
    if (base && base.includes('.')) return base;
  } catch (_) {}
  return `chat_${Date.now()}.jpg`;
}

async function readMockConvos() {
  try {
    const s = await AsyncStorage.getItem(CONVOS_KEY);
    const arr = s ? JSON.parse(s) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function writeMockConvos(arr) {
  try {
    await AsyncStorage.setItem(CONVOS_KEY, JSON.stringify(arr));
  } catch {}
}

async function readMockMessages(convoId) {
  try {
    const s = await AsyncStorage.getItem(MSG_KEY(convoId));
    const arr = s ? JSON.parse(s) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function writeMockMessages(convoId, arr) {
  try {
    await AsyncStorage.setItem(MSG_KEY(convoId), JSON.stringify(arr));
  } catch {}
}

function mockUserPublic(id, fallbackName) {
  return { id: id != null ? String(id) : 'unknown', name: fallbackName || `User ${id}` };
}

/** Start (or fetch) a conversation between current user and the listing's seller. */
export async function startConversationAPI({ listing, listingId, buyer }) {
  let resolvedListing = listing;
  const idFromParam =
    listingId != null
      ? String(listingId).trim()
      : listing?.id != null
        ? String(listing.id)
        : listing?._id != null
          ? String(listing._id)
          : '';
  if ((!resolvedListing || !resolvedListing.id) && idFromParam) {
    if (isSupabaseConfigured()) {
      resolvedListing = await resolveListingForChat(idFromParam);
      if (!resolvedListing) throw new Error('Listing not found.');
    } else {
      resolvedListing = { id: idFromParam, sellerId: 'seed-seller', title: 'Listing' };
    }
  }
  if (!resolvedListing) throw new Error('listing required');
  const listingIdResolved = String(resolvedListing.id ?? resolvedListing._id ?? '');
  if (!listingIdResolved || listingIdResolved === '[object Object]') {
    throw new Error('listing.id required');
  }

  if (isSupabaseConfigured()) {
    return startConversationSupabase({ listing: resolvedListing, buyer });
  }

  if (!isAuxiliaryApiConfigured()) {
    const sellerId = resolvedListing.sellerId != null ? String(resolvedListing.sellerId) : 'seed-seller';
    const buyerId = buyer?.id != null ? String(buyer.id) : 'me';
    const convos = await readMockConvos();
    let convo = convos.find(
      (c) =>
        String(c.listingId) === listingIdResolved &&
        String(c.buyerId) === buyerId &&
        String(c.sellerId) === sellerId
    );
    if (!convo) {
      convo = {
        id: `local-${Date.now()}`,
        listingId: listingIdResolved,
        listingTitle: resolvedListing.title || 'Listing',
        listingImage:
          resolvedListing.image ||
          (Array.isArray(resolvedListing.images) ? resolvedListing.images[0] : null),
        buyerId,
        sellerId,
        createdAt: new Date().toISOString(),
        buyer: mockUserPublic(buyerId, buyer?.name || buyer?.email || 'You'),
        seller: mockUserPublic(sellerId, resolvedListing.sellerName || 'Seller'),
        other: mockUserPublic(sellerId, resolvedListing.sellerName || 'Seller'),
        lastMessage: null,
      };
      convos.unshift(convo);
      await writeMockConvos(convos);
    }
    return convo;
  }

  try {
    const r = await client.post('/chat/conversations', { listingId: listingIdResolved });
    const data = parseJson(r.data);
    return data?.conversation ?? data;
  } catch (e) {
    if (!isOffline(e)) throw e.response?.data || { message: 'Failed to start chat' };
    const sellerId = resolvedListing.sellerId != null ? String(resolvedListing.sellerId) : 'seed-seller';
    const buyerId = buyer?.id != null ? String(buyer.id) : 'me';
    const convos = await readMockConvos();
    let convo = convos.find(
      (c) =>
        String(c.listingId) === listingIdResolved &&
        String(c.buyerId) === buyerId &&
        String(c.sellerId) === sellerId
    );
    if (!convo) {
      convo = {
        id: `local-${Date.now()}`,
        listingId: listingIdResolved,
        listingTitle: resolvedListing.title || 'Listing',
        listingImage:
          resolvedListing.image ||
          (Array.isArray(resolvedListing.images) ? resolvedListing.images[0] : null),
        buyerId,
        sellerId,
        createdAt: new Date().toISOString(),
        buyer: mockUserPublic(buyerId, buyer?.name || buyer?.email || 'You'),
        seller: mockUserPublic(sellerId, resolvedListing.sellerName || 'Seller'),
        other: mockUserPublic(sellerId, resolvedListing.sellerName || 'Seller'),
        lastMessage: null,
      };
      convos.unshift(convo);
      await writeMockConvos(convos);
    }
    return convo;
  }
}

export async function getConversationsAPI(viewerId) {
  if (isSupabaseConfigured()) {
    return getConversationsSupabase(viewerId);
  }
  if (!isAuxiliaryApiConfigured()) {
    return readMockConvos();
  }
  try {
    const r = await client.get('/chat/conversations', { timeout: 6000 });
    const data = parseJson(r.data);
    if (Array.isArray(data?.conversations)) return data.conversations;
    if (Array.isArray(data)) return data;
    return [];
  } catch (e) {
    if (!isOffline(e)) throw e.response?.data || { message: 'Failed to load chats' };
    return readMockConvos();
  }
}

export async function getMessagesAPI(conversationId, sinceIso) {
  if (!conversationId) return { messages: [], conversation: null };
  if (isSupabaseConfigured()) {
    return getMessagesSupabase(conversationId, sinceIso);
  }
  if (!isAuxiliaryApiConfigured()) {
    const all = await readMockMessages(conversationId);
    const since = sinceIso ? new Date(sinceIso).getTime() : 0;
    const messages = since > 0 ? all.filter((m) => new Date(m.createdAt).getTime() > since) : all;
    return { messages, conversation: null };
  }
  try {
    const params = sinceIso ? { since: sinceIso } : undefined;
    const r = await client.get(`/chat/conversations/${encodeURIComponent(conversationId)}/messages`, {
      params,
      timeout: 6000,
    });
    const data = parseJson(r.data) || {};
    return {
      messages: Array.isArray(data.messages) ? data.messages : [],
      conversation: data.conversation || null,
    };
  } catch (e) {
    if (!isOffline(e)) throw e.response?.data || { message: 'Failed to load messages' };
    const all = await readMockMessages(conversationId);
    const since = sinceIso ? new Date(sinceIso).getTime() : 0;
    const messages = since > 0 ? all.filter((m) => new Date(m.createdAt).getTime() > since) : all;
    return { messages, conversation: null };
  }
}

/** Send a message. Pass either `text`, `imageUri`, or both. */
export async function sendMessageAPI(conversationId, { text, imageUri, sender } = {}) {
  if (!conversationId) throw new Error('conversationId required');
  const trimmed = text ? String(text).trim() : '';
  if (!trimmed && !imageUri) throw new Error('Empty message');

  const url = `/chat/conversations/${encodeURIComponent(conversationId)}/messages`;

  if (isSupabaseConfigured()) {
    return sendMessageSupabase(conversationId, { text: trimmed, imageUri, sender });
  }

  if (!isAuxiliaryApiConfigured()) {
    const msg = {
      id: `local-${Date.now()}`,
      conversationId: String(conversationId),
      senderId: sender?.id != null ? String(sender.id) : 'me',
      text: trimmed || null,
      imageUrl: imageUri || null,
      createdAt: new Date().toISOString(),
      pending: true,
    };
    const all = await readMockMessages(conversationId);
    all.push(msg);
    await writeMockMessages(conversationId, all);

    const convos = await readMockConvos();
    const idx = convos.findIndex((c) => String(c.id) === String(conversationId));
    if (idx >= 0) {
      convos[idx] = {
        ...convos[idx],
        lastMessage: {
          id: msg.id,
          text: msg.text,
          imageUrl: msg.imageUrl,
          senderId: msg.senderId,
          createdAt: msg.createdAt,
        },
      };
      await writeMockConvos(convos);
    }
    return msg;
  }

  try {
    if (imageUri && isLocalDeviceMediaUri(imageUri)) {
      const form = new FormData();
      if (trimmed) form.append('text', trimmed);
      form.append('image', {
        uri: imageUri,
        name: fileNameFromUri(imageUri),
        type: guessImageMime(imageUri),
      });
      const r = await client.post(url, form, { timeout: 60000 });
      const data = parseJson(r.data);
      return data?.message ?? data;
    }
    const body = { text: trimmed || undefined, imageUrl: imageUri || undefined };
    const r = await client.post(url, body, { timeout: 8000 });
    const data = parseJson(r.data);
    return data?.message ?? data;
  } catch (e) {
    if (!isOffline(e)) throw e.response?.data || { message: 'Failed to send message' };
    const msg = {
      id: `local-${Date.now()}`,
      conversationId: String(conversationId),
      senderId: sender?.id != null ? String(sender.id) : 'me',
      text: trimmed || null,
      imageUrl: imageUri || null,
      createdAt: new Date().toISOString(),
      pending: true,
    };
    const all = await readMockMessages(conversationId);
    all.push(msg);
    await writeMockMessages(conversationId, all);

    const convos = await readMockConvos();
    const idx = convos.findIndex((c) => String(c.id) === String(conversationId));
    if (idx >= 0) {
      convos[idx] = {
        ...convos[idx],
        lastMessage: {
          id: msg.id,
          text: msg.text,
          imageUrl: msg.imageUrl,
          senderId: msg.senderId,
          createdAt: msg.createdAt,
        },
      };
      await writeMockConvos(convos);
    }
    return msg;
  }
}
