const express = require('express');
const { serializeListing } = require('../listingHelpers');
const { store } = require('../store');
const {
  isSupabaseSellerProfileConfigured,
  fetchSellerPublicProfile,
  fetchSellerListingsRows,
  fetchExpressSellerPublicProfile,
} = require('../sellerProfile');

const router = express.Router();

function mapExpressListingRow(req, row) {
  return serializeListing(req, row);
}

/** GET /api/users/:id/public-profile — display name, avatar, member year, total ads */
router.get('/:id/public-profile', async (req, res) => {
  const userId = String(req.params.id || '').trim();
  if (!userId) {
    return res.status(400).json({ message: 'userId is required.' });
  }

  try {
    if (isSupabaseSellerProfileConfigured()) {
      const seller = await fetchSellerPublicProfile(userId);
      if (!seller) {
        return res.status(404).json({ message: 'Seller profile not found.' });
      }
      return res.json({ seller });
    }

    const seller = fetchExpressSellerPublicProfile(userId);
    if (!seller) {
      return res.status(404).json({ message: 'Seller profile not found.' });
    }
    return res.json({ seller });
  } catch (e) {
    console.error('[users] public-profile', e?.message || e);
    return res.status(500).json({ message: e?.message || 'Could not load seller profile.' });
  }
});

/** GET /api/users/:id/listings — all listings published by this user */
router.get('/:id/listings', async (req, res) => {
  const userId = String(req.params.id || '').trim();
  if (!userId) {
    return res.status(400).json({ message: 'userId is required.' });
  }

  try {
    if (isSupabaseSellerProfileConfigured()) {
      const rows = await fetchSellerListingsRows(userId);
      const listings = rows.map((row) => {
        const urls = [];
        if (row.image_url) urls.push(String(row.image_url));
        if (Array.isArray(row.image_urls)) {
          urls.push(...row.image_urls.filter(Boolean).map(String));
        }
        const draft = {
          id: String(row.id),
          sellerId: row.seller_id,
          title: row.title,
          description: row.description ?? '',
          price: Number(row.price) || 0,
          type:
            row.listing_type === 'auction' || row.type === 'auction'
              ? 'auction'
              : 'standard',
          category: row.category ?? '',
          location: row.location ?? '',
          images: urls,
          image: urls[0] || null,
          image_url: urls[0] || null,
          image_urls: urls,
          status: row.status,
          currentBid: row.current_bid != null ? Number(row.current_bid) : undefined,
          buyNowPrice: row.buy_now_price != null ? Number(row.buy_now_price) : undefined,
          endTime: row.auction_end_time || row.end_time || null,
          createdAt: row.created_at,
        };
        return serializeListing(req, draft);
      });
      if (process.env.NODE_ENV !== 'production') {
        console.log(
          '[users] listings sample',
          listings.slice(0, 2).map((l) => ({
            id: l.id,
            image: l.image,
            images: l.images,
          }))
        );
      }
      return res.json({ listings });
    }

    const mine = (store.listings || []).filter((l) => String(l.sellerId) === userId);
    return res.json({ listings: mine.map((l) => mapExpressListingRow(req, l)) });
  } catch (e) {
    console.error('[users] listings', e?.message || e);
    return res.status(500).json({ message: e?.message || 'Could not load seller listings.' });
  }
});

module.exports = router;
