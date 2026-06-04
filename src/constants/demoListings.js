/**
 * FYP demo marketplace feed — shown when Supabase returns no public listings for a new user.
 * Kept in sync with server/data/store.json seed titles where possible.
 */
export const DEMO_FYP_LISTINGS = [
  {
    id: 'demo-1',
    title: 'Artist Auction Item 1 — Contemporary Canvas',
    description: 'Original acrylic on canvas, signed by the artist. FYP demo listing.',
    price: 45000,
    currentBid: 52000,
    type: 'auction',
    moderationStatus: 'approved',
    status: 'active',
    category: 'Art',
    sellerId: 'demo-seller',
    endTime: new Date(Date.now() + 1000 * 60 * 60 * 48).toISOString(),
    image:
      'https://images.unsplash.com/photo-1541961017774-22349e4a1262?auto=format&fit=crop&w=800&q=80',
    images: [
      'https://images.unsplash.com/photo-1541961017774-22349e4a1262?auto=format&fit=crop&w=800&q=80',
    ],
    createdAt: new Date().toISOString(),
  },
  {
    id: 'demo-2',
    title: 'Vintage Oil Paintings Set',
    description: 'Pair of mid-century landscape paintings in gilt frames.',
    price: 85000,
    buyNowPrice: 85000,
    type: 'standard',
    moderationStatus: 'approved',
    status: 'active',
    category: 'Art',
    sellerId: 'demo-seller',
    image:
      'https://images.unsplash.com/photo-1579783902614-a3fb3927b6a5?auto=format&fit=crop&w=800&q=80',
    images: [
      'https://images.unsplash.com/photo-1579783902614-a3fb3927b6a5?auto=format&fit=crop&w=800&q=80',
    ],
    createdAt: new Date().toISOString(),
  },
  {
    id: 'demo-3',
    title: 'Vintage Rolex Submariner (seed)',
    description: 'Sample approved auction listing for Bidify FYP presentation.',
    price: 1000000,
    currentBid: 1450000,
    type: 'auction',
    moderationStatus: 'approved',
    status: 'active',
    sellerId: 'seed-seller',
    endTime: new Date(Date.now() + 1000 * 60 * 60 * 72).toISOString(),
    image:
      'https://images.unsplash.com/photo-1523170335258-f5ed11844a49?auto=format&fit=crop&w=800&q=80',
    images: [
      'https://images.unsplash.com/photo-1523170335258-f5ed11844a49?auto=format&fit=crop&w=800&q=80',
    ],
    createdAt: new Date().toISOString(),
  },
  {
    id: 'demo-4',
    title: 'Antique Persian Rug (seed)',
    description: 'Hand-knotted Persian rug, approx. 8x10 ft.',
    price: 85000,
    buyNowPrice: 85000,
    type: 'standard',
    moderationStatus: 'approved',
    status: 'active',
    category: 'Antiques',
    sellerId: 'seed-seller',
    image:
      'https://images.unsplash.com/photo-1600166898405-da9535204843?auto=format&fit=crop&w=800&q=80',
    images: [
      'https://images.unsplash.com/photo-1600166898405-da9535204843?auto=format&fit=crop&w=800&q=80',
    ],
    createdAt: new Date().toISOString(),
  },
];
