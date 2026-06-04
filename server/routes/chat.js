const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { store, persist } = require('../store');
const { authRequired } = require('../authMiddleware');
const { uploadUrl, publicBase } = require('../listingHelpers');

if (!store.conversations) store.conversations = [];
if (!store.messages) store.messages = [];
if (!store.nextConversationId) store.nextConversationId = 1;
if (!store.nextMessageId) store.nextMessageId = 1;

const chatUploadsDir = path.join(__dirname, '..', 'uploads', 'chat');
if (!fs.existsSync(chatUploadsDir)) fs.mkdirSync(chatUploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, chatUploadsDir),
  filename: (_req, file, cb) => {
    const safe = (file.originalname || 'image').replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 } });

const router = express.Router();

function chatUploadUrl(req, filename) {
  if (!filename) return null;
  return `${publicBase(req)}/uploads/chat/${filename}`;
}

function userPublic(id) {
  const u = store.users.find((x) => String(x.id) === String(id));
  if (!u) return { id: String(id), name: `User ${id}` };
  return { id: String(u.id), name: u.fullName || u.email, email: u.email };
}

function findConversation(listingId, buyerId, sellerId) {
  return store.conversations.find(
    (c) =>
      String(c.listingId) === String(listingId) &&
      String(c.buyerId) === String(buyerId) &&
      String(c.sellerId) === String(sellerId)
  );
}

function lastMessageFor(conversationId) {
  for (let i = store.messages.length - 1; i >= 0; i--) {
    if (String(store.messages[i].conversationId) === String(conversationId)) {
      return store.messages[i];
    }
  }
  return null;
}

function serializeConversation(c, viewerId) {
  const last = lastMessageFor(c.id);
  const otherId = String(c.buyerId) === String(viewerId) ? c.sellerId : c.buyerId;
  return {
    id: String(c.id),
    listingId: String(c.listingId),
    listingTitle: c.listingTitle,
    listingImage: c.listingImage,
    buyer: userPublic(c.buyerId),
    seller: userPublic(c.sellerId),
    other: userPublic(otherId),
    createdAt: c.createdAt,
    lastMessage: last
      ? {
          id: String(last.id),
          text: last.text || null,
          imageUrl: last.imageUrl || null,
          senderId: String(last.senderId),
          createdAt: last.createdAt,
        }
      : null,
  };
}

function ensureConversationAccess(conversation, userId) {
  if (!conversation) return false;
  return (
    String(conversation.buyerId) === String(userId) ||
    String(conversation.sellerId) === String(userId)
  );
}

router.post('/conversations', authRequired, (req, res) => {
  const listingId = req.body?.listingId;
  if (!listingId) return res.status(400).json({ message: 'listingId required' });

  const listing = store.listings.find((l) => String(l.id) === String(listingId));
  if (!listing) return res.status(404).json({ message: 'Listing not found' });

  const buyerId = String(req.user.id);
  const sellerId = String(listing.sellerId || 'unknown');
  if (buyerId === sellerId) {
    return res.status(400).json({ message: 'You cannot chat with yourself about your own listing' });
  }

  let convo = findConversation(listingId, buyerId, sellerId);
  if (!convo) {
    convo = {
      id: String(store.nextConversationId++),
      listingId: String(listingId),
      listingTitle: listing.title,
      listingImage: listing.image || (Array.isArray(listing.images) ? listing.images[0] : null),
      buyerId,
      sellerId,
      createdAt: new Date().toISOString(),
    };
    store.conversations.push(convo);
  }
  res.json({ conversation: serializeConversation(convo, buyerId) });
});

router.get('/conversations', authRequired, (req, res) => {
  const uid = String(req.user.id);
  const mine = store.conversations.filter(
    (c) => String(c.buyerId) === uid || String(c.sellerId) === uid
  );
  const rows = mine
    .map((c) => serializeConversation(c, uid))
    .sort((a, b) => {
      const ta = new Date(a.lastMessage?.createdAt || a.createdAt).getTime();
      const tb = new Date(b.lastMessage?.createdAt || b.createdAt).getTime();
      return tb - ta;
    });
  res.json({ conversations: rows });
});

router.get('/conversations/:id/messages', authRequired, (req, res) => {
  const convo = store.conversations.find((c) => String(c.id) === String(req.params.id));
  if (!ensureConversationAccess(convo, req.user.id)) {
    return res.status(404).json({ message: 'Conversation not found' });
  }
  const since = req.query?.since ? new Date(String(req.query.since)).getTime() : 0;
  const list = store.messages
    .filter((m) => String(m.conversationId) === String(convo.id))
    .filter((m) => (Number.isFinite(since) && since > 0 ? new Date(m.createdAt).getTime() > since : true))
    .map((m) => ({
      id: String(m.id),
      conversationId: String(m.conversationId),
      senderId: String(m.senderId),
      text: m.text || null,
      imageUrl: m.imageUrl || null,
      createdAt: m.createdAt,
    }));
  res.json({ messages: list, conversation: serializeConversation(convo, req.user.id) });
});

function postMessageHandler(req, res) {
  const convo = store.conversations.find((c) => String(c.id) === String(req.params.id));
  if (!ensureConversationAccess(convo, req.user.id)) {
    return res.status(404).json({ message: 'Conversation not found' });
  }
  const text = (req.body?.text || '').toString().trim();
  const file = req.file;
  if (!text && !file) {
    return res.status(400).json({ message: 'Message must include text or an image' });
  }
  const msg = {
    id: String(store.nextMessageId++),
    conversationId: String(convo.id),
    senderId: String(req.user.id),
    text: text || null,
    imageUrl: file ? chatUploadUrl(req, file.filename) : null,
    createdAt: new Date().toISOString(),
  };
  store.messages.push(msg);
  if (store.messages.length > 5000) store.messages.splice(0, store.messages.length - 5000);
  res.status(201).json({ message: msg, conversation: serializeConversation(convo, req.user.id) });
}

router.post('/conversations/:id/messages', authRequired, (req, res) => {
  const ct = req.headers['content-type'] || '';
  if (ct.includes('multipart/form-data')) {
    upload.single('image')(req, res, (err) => {
      if (err) return res.status(400).json({ message: 'Upload error' });
      postMessageHandler(req, res);
    });
  } else {
    postMessageHandler(req, res);
  }
});

module.exports = router;
