const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { store, getOrCreateWallet, recordWalletTx, persist } = require('../store');
const { authRequired } = require('../authMiddleware');
const { authRequiredSupabaseOrExpress } = require('../middleware/resolveSupabaseUser');
const {
  deleteListingPermanent,
  isDeleteListingConfigured,
} = require('../services/deleteListing');
const { syncSellerTotalAdsAfterListingChange } = require('../services/syncSellerListingCount');
const { countExpressSellerListings } = require('../sellerProfile');
const { uploadUrl, serializeListing, recordPayment } = require('../listingHelpers');
const {
  isSupabaseSellerProfileConfigured,
  fetchSellerPublicProfile,
  fetchExpressSellerPublicProfile,
} = require('../sellerProfile');

/**
 * Reject any non-string or obviously-garbage value before it ever lands in
 * the persisted store. Catches historical bugs that wrote `"[object Object]"`
 * into the image array.
 */
function isCleanImageString(s) {
  if (s == null || typeof s !== 'string') return false;
  const t = s.trim();
  if (!t) return false;
  if (t === '[object Object]') return false;
  if (t === 'null' || t === 'undefined' || t === 'NaN') return false;
  if (t.startsWith('[object ')) return false;
  return true;
}
const { calculateBidToken } = require('../bidToken');
const { calculateAuctionListingFee } = require('../constants/auctionListingFee');

/** Keep in sync with `src/constants/walletRules.js` — enforced server-side. */
const MIN_WALLET_BALANCE_TO_BID_PKR = 1000;

const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const base = `${Date.now()}-${(file.originalname || 'image').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    cb(null, base);
  },
});
const upload = multer({ storage });

const router = express.Router();

function parseRemoteUrls(body) {
  const raw = body?.remoteImageUrls;
  if (!raw) return [];
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

function handleCreate(req, res) {
  const b = req.body || {};
  const title = b.title;
  const description = b.description || '';
  const price = Number(b.price);
  // Canonical types: 'auction' or 'standard'. Legacy clients posting 'buynow' map to 'standard'.
  const rawType = b.type || 'standard';
  const type = rawType === 'auction' ? 'auction' : 'standard';
  const duration = b.duration != null ? parseInt(String(b.duration), 10) : 3;
  const category = typeof b.category === 'string' && b.category.trim() ? b.category.trim() : null;
  const buyNowPriceRaw = b.buyNowPrice != null ? Number(b.buyNowPrice) : null;

  if (!title || !Number.isFinite(price)) {
    return res.status(400).json({ message: 'title and price required' });
  }

  const fileUrls = (req.files || [])
    .map((f) => uploadUrl(req, f.filename))
    .filter(isCleanImageString);
  const multipartRemote = parseRemoteUrls(b).filter(isCleanImageString);
  const jsonImages = Array.isArray(b.images)
    ? b.images.filter(isCleanImageString)
    : [];
  // De-dupe in case the same URL arrived in two paths (multipart + JSON).
  const seen = new Set();
  const images = [];
  for (const u of [...fileUrls, ...multipartRemote, ...jsonImages]) {
    if (!seen.has(u)) {
      seen.add(u);
      images.push(u);
    }
  }

  const id = String(store.nextListingId++);
  const row = {
    id,
    title: String(title),
    description: String(description),
    price,
    type,
    category,
    sellerId: String(req.user.id),
    moderationStatus: 'pending',
    status: 'pending_review',
    images,
    image: images[0] || null,
    createdAt: new Date().toISOString(),
  };

  if (type === 'auction') {
    const listingFee = calculateAuctionListingFee(price);
    const sellerWallet = getOrCreateWallet(req.user.id);
    if (sellerWallet.balance < listingFee) {
      return res.status(400).json({
        message: `Insufficient wallet balance to pay the required Auction Listing Fee of ${listingFee.toLocaleString()} Rs.`,
      });
    }
    recordWalletTx(req.user.id, {
      kind: 'auction_listing_fee',
      amount: listingFee,
      note: `Auction listing activation fee (starting bid Rs. ${price.toLocaleString()})`,
    });
    row.listingActivationFee = listingFee;
    row.currentBid = price;
    const days = Number.isFinite(duration) && duration > 0 ? duration : 3;
    row.endTime = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    // Optional buy-now-during-auction (automated payment shortcut) only for auctions.
    if (Number.isFinite(buyNowPriceRaw) && buyNowPriceRaw > 0) {
      row.buyNowPrice = buyNowPriceRaw;
    }
  }
  // Standard listings have NO buyNowPrice — buyers coordinate via "Chat with Seller".

  store.listings.unshift(row);
  persist();
  res.status(201).json({ success: true, listing: serializeListing(req, row) });
}

router.get('/mine', authRequired, (req, res) => {
  const sid = String(req.user.id);
  const mine = store.listings.filter((l) => String(l.sellerId) === sid);
  res.json({ listings: mine.map((l) => serializeListing(req, l)) });
});

function isAuctionEnded(row) {
  if (!row || row.type !== 'auction') return false;
  if (!row.endTime) return false;
  const t = new Date(row.endTime).getTime();
  return Number.isFinite(t) && t <= Date.now();
}

function getActiveBidToken(row, userId) {
  if (!row?.bidTokens || !Array.isArray(row.bidTokens)) return null;
  return (
    row.bidTokens.find(
      (t) => String(t.userId) === String(userId) && t.refunded !== true && t.held !== true
    ) || null
  );
}

function settleAuctionIfEnded(row) {
  if (!row || row.type !== 'auction') return;
  if (row.settled) return;
  if (!isAuctionEnded(row)) return;

  const tokens = Array.isArray(row.bidTokens) ? row.bidTokens : [];
  const winnerId =
    row.highestBidderId != null
      ? String(row.highestBidderId)
      : tokens.length > 0
        ? String(tokens[tokens.length - 1].userId)
        : null;

  for (const tok of tokens) {
    if (tok.refunded || tok.held) continue;
    if (winnerId && String(tok.userId) === winnerId) {
      tok.held = true;
      tok.heldAt = new Date().toISOString();
      recordWalletTx(tok.userId, {
        kind: 'win_hold_note',
        amount: 0,
        listingId: String(row.id),
        listingTitle: row.title,
        note: `You won the auction. Your token of Rs. ${Number(tok.amount).toLocaleString()} is held until checkout.`,
      });
    } else {
      recordWalletTx(tok.userId, {
        kind: 'token_refund',
        amount: Number(tok.amount) || 0,
        listingId: String(row.id),
        listingTitle: row.title,
        note: 'Auction ended — token refunded to your wallet.',
      });
      tok.refunded = true;
      tok.refundedAt = new Date().toISOString();
    }
  }
  row.settled = true;
  row.settledAt = new Date().toISOString();
  if (winnerId) row.winnerId = winnerId;
}

router.post('/:id/token', authRequired, (req, res) => {
  const row = store.listings.find((l) => String(l.id) === String(req.params.id));
  if (!row) return res.status(404).json({ message: 'Listing not found' });
  if (row.type !== 'auction') {
    return res.status(400).json({ message: 'Tokens are only required for auctions' });
  }
  if (isAuctionEnded(row)) {
    return res.status(400).json({ message: 'Auction has already ended' });
  }
  const tokenAmount = calculateBidToken(row.price);
  if (tokenAmount <= 0) {
    return res.json({
      requiresToken: false,
      tokenAmount: 0,
      message: 'No token required for this listing.',
    });
  }
  const existing = getActiveBidToken(row, req.user.id);
  if (existing) {
    return res.json({
      alreadyPaid: true,
      tokenAmount,
      token: existing,
      wallet: getOrCreateWallet(req.user.id),
    });
  }
  const wallet = getOrCreateWallet(req.user.id);
  if (wallet.balance < tokenAmount) {
    return res.status(402).json({
      message: `Insufficient wallet balance (Rs. ${wallet.balance.toLocaleString()}). Top up at least Rs. ${tokenAmount.toLocaleString()} to bid.`,
      tokenAmount,
      balance: wallet.balance,
    });
  }
  const { wallet: walletAfter, tx } = recordWalletTx(req.user.id, {
    kind: 'token_paid',
    amount: tokenAmount,
    listingId: String(row.id),
    listingTitle: row.title,
    note: `Bid token reserved for "${row.title}".`,
  });
  if (!Array.isArray(row.bidTokens)) row.bidTokens = [];
  const tokenEntry = {
    userId: String(req.user.id),
    userName: req.user.fullName || req.user.email,
    amount: tokenAmount,
    txId: tx.id,
    createdAt: new Date().toISOString(),
    refunded: false,
    held: false,
  };
  row.bidTokens.push(tokenEntry);
  persist();
  res.status(201).json({
    success: true,
    tokenAmount,
    token: tokenEntry,
    wallet: walletAfter,
    listing: serializeListing(req, row),
  });
});

router.get('/:id/token', authRequired, (req, res) => {
  const row = store.listings.find((l) => String(l.id) === String(req.params.id));
  if (!row) return res.status(404).json({ message: 'Listing not found' });
  if (row.type !== 'auction') {
    return res.json({ requiresToken: false, tokenAmount: 0, paid: false });
  }
  const tokenAmount = calculateBidToken(row.price);
  const existing = getActiveBidToken(row, req.user.id);
  res.json({
    requiresToken: tokenAmount > 0,
    tokenAmount,
    paid: !!existing,
    token: existing,
    walletBalance: getOrCreateWallet(req.user.id).balance,
  });
});

router.post('/:id/bid', authRequired, (req, res) => {
  const row = store.listings.find((l) => String(l.id) === String(req.params.id));
  if (!row) return res.status(404).json({ message: 'Listing not found' });
  if (row.type !== 'auction') {
    return res.status(400).json({ message: 'This listing is not an auction' });
  }
  if (isAuctionEnded(row)) {
    settleAuctionIfEnded(row);
    return res.status(400).json({ message: 'Auction has ended' });
  }
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ message: 'Invalid bid amount' });
  }
  const current = Number(row.currentBid || row.price || 0);
  if (amount <= current) {
    return res.status(400).json({ message: 'Bid must exceed current bid' });
  }
  const tokenAmount = calculateBidToken(row.price);
  if (tokenAmount > 0) {
    const existing = getActiveBidToken(row, req.user.id);
    if (!existing) {
      return res.status(402).json({
        message: `Pay the Rs. ${tokenAmount.toLocaleString()} bid token first to participate in this auction.`,
        tokenRequired: true,
        tokenAmount,
      });
    }
  }

  const wallet = getOrCreateWallet(req.user.id);
  if (wallet.balance < MIN_WALLET_BALANCE_TO_BID_PKR) {
    return res.status(402).json({
      message: `Your wallet must have at least Rs. ${MIN_WALLET_BALANCE_TO_BID_PKR.toLocaleString()} to place bids. Please top up.`,
      topUpRequired: true,
      minBalance: MIN_WALLET_BALANCE_TO_BID_PKR,
      balance: wallet.balance,
    });
  }

  row.currentBid = amount;
  row.highestBidderId = String(req.user.id);
  row.highestBidder = req.user.fullName || req.user.email;
  persist();
  recordPayment({
    kind: 'auction_bid',
    listingId: String(row.id),
    listingTitle: row.title,
    amount,
    buyerId: String(req.user.id),
    buyerName: req.user.fullName || req.user.email,
    status: 'logged',
  });
  res.json({ success: true, newBid: amount, listing: serializeListing(req, row) });
});

router.post('/:id/buy-now', authRequired, (req, res) => {
  const row = store.listings.find((l) => String(l.id) === String(req.params.id));
  if (!row) return res.status(404).json({ message: 'Listing not found' });
  const amt = Number(row.buyNowPrice != null ? row.buyNowPrice : row.price);
  recordPayment({
    kind: 'buy_now',
    listingId: String(row.id),
    listingTitle: row.title,
    amount: Number.isFinite(amt) ? amt : 0,
    buyerId: String(req.user.id),
    buyerName: req.user.fullName || req.user.email,
    status: 'completed',
  });
  res.json({ success: true });
});

function isPublicListing(l) {
  if (!l) return false;
  const ms = String(l.moderationStatus || '').toLowerCase();
  if (ms === 'rejected') return false;
  if (ms === 'approved') return true;
  const st = String(l.status || '').toLowerCase();
  if (st === 'rejected' || st === 'pending_review') return false;
  return st === 'active' || st === 'sold' || st === 'approved' || ms === 'pending';
}

/**
 * Public marketplace feed — all approved/global demo listings (not filtered by requester userId).
 * New signups see the same catalog as existing users for FYP presentation.
 */
router.get('/', (req, res) => {
  for (const l of store.listings) settleAuctionIfEnded(l);
  const visible = store.listings.filter(isPublicListing);
  res.json({ listings: visible.map((l) => serializeListing(req, l)) });
});

router.get('/:id', async (req, res) => {
  const row = store.listings.find((l) => String(l.id) === String(req.params.id));
  if (!row) return res.status(404).json({ message: 'Listing not found' });
  settleAuctionIfEnded(row);
  const listing = serializeListing(req, row);
  let sellerSummary = null;
  const sellerId = row.sellerId;
  if (sellerId) {
    try {
      if (isSupabaseSellerProfileConfigured()) {
        sellerSummary = await fetchSellerPublicProfile(sellerId);
      } else {
        sellerSummary = fetchExpressSellerPublicProfile(sellerId);
      }
    } catch (e) {
      console.warn('[listings/:id] sellerSummary', e?.message || e);
    }
  }
  res.json({ listing, sellerSummary });
});

router.post('/', authRequired, (req, res) => {
  const ct = req.headers['content-type'] || '';
  if (ct.includes('multipart/form-data')) {
    upload.array('images', 12)(req, res, (err) => {
      if (err) return res.status(400).json({ message: 'Upload error' });
      handleCreate(req, res);
    });
  } else {
    handleCreate(req, res);
  }
});

router.patch('/:id', authRequired, (req, res) => {
  const row = store.listings.find((l) => String(l.id) === String(req.params.id));
  if (!row) return res.status(404).json({ message: 'Listing not found' });
  if (String(row.sellerId) !== String(req.user.id)) {
    return res.status(403).json({ message: 'You can only edit your own listings.' });
  }

  const b = req.body || {};
  if (b.title != null) row.title = String(b.title).trim();
  if (b.description != null) row.description = String(b.description).trim();
  if (b.price != null) {
    const p = Number(b.price);
    if (Number.isFinite(p)) {
      row.price = p;
      if (row.type === 'auction' && !row.currentBid) row.currentBid = p;
    }
  }
  if (b.category != null) row.category = String(b.category).trim() || null;
  if (b.buyNowPrice != null) {
    const bn = Number(b.buyNowPrice);
    row.buyNowPrice = Number.isFinite(bn) && bn > 0 ? bn : undefined;
  }
  row.updatedAt = new Date().toISOString();
  persist();
  return res.json({ success: true, listing: serializeListing(req, row) });
});

router.delete('/:id', authRequiredSupabaseOrExpress, async (req, res) => {
  console.log('DEBUG: Received ID in Backend:', req.params.id, {
    type: typeof req.params.id,
    raw: req.params.id,
  });
  const listingId = String(req.params.id || '').trim();
  if (!listingId) {
    return res.status(400).json({ message: 'Listing id is required.' });
  }

  const sellerId = String(req.authUser?.id || req.user?.supabaseUserId || '').trim();
  console.log('[listings DELETE] request', {
    listingId,
    sellerId,
    supabaseDeleteConfigured: isDeleteListingConfigured(),
  });

  try {
    let payload = null;

    if (isDeleteListingConfigured()) {
      payload = await deleteListingPermanent({
        listingId,
        sellerId,
        accessToken: req.authUser?.accessToken || null,
      });
    } else {
      console.warn(
        '[listings DELETE] Supabase service role missing — Express store only. Set SUPABASE_SERVICE_ROLE_KEY in .env and restart the API.'
      );
      const looksLikeUuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          listingId
        );
      if (looksLikeUuid) {
        return res.status(503).json({
          success: false,
          deleted: false,
          message:
            'Cannot delete Supabase listing: API server needs SUPABASE_SERVICE_ROLE_KEY. Restart with npm run api after updating .env.',
        });
      }
      const storeIdx = store.listings.findIndex((l) => String(l.id) === listingId);
      const removedFromStore = storeIdx >= 0;
      let sellerTotalAds = countExpressSellerListings(sellerId);
      try {
        const synced = await syncSellerTotalAdsAfterListingChange(sellerId);
        if (Number.isFinite(synced)) sellerTotalAds = synced;
      } catch (_) {
        /* no Supabase sync */
      }
      payload = {
        success: removedFromStore,
        deleted: removedFromStore,
        listingId,
        sellerId,
        sellerTotalAds,
        totalListingsCount: sellerTotalAds,
        total_ads: sellerTotalAds,
        message: removedFromStore
          ? 'Listing removed from local store.'
          : 'Listing not found.',
      };
      if (!removedFromStore) {
        return res.status(404).json(payload);
      }
    }

    const idx = store.listings.findIndex((l) => String(l.id) === listingId);
    if (idx >= 0) {
      store.listings.splice(idx, 1);
      persist();
      console.log('[listings DELETE] removed from Express store.json', listingId);
    }

    return res.status(200).json(payload);
  } catch (e) {
    const status = e.statusCode || 500;
    console.error('[listings DELETE] failed', status, e?.message || e);
    return res.status(status).json({
      success: false,
      deleted: false,
      message: e?.message || 'Could not delete listing.',
    });
  }
});

module.exports = router;
