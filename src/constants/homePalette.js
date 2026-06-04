/** Bidify Home — UI palette (frontend only). */
export const HOME = {
  white: '#FFFFFF',
  black: '#000000',
  divider: '#E0E0E0',
  surface: '#F5F5F5',
  /** Premium light grey page canvas (contrast layer under white cards) */
  pageBg: '#F4F5F7',
  segmentTint: '#F0F1F4',
  /** Light golden header strip */
  headerGold: '#FBF7EE',
  headerGoldBorder: '#EBE3D4',
  charcoal: '#666666',
  priceNavy: '#1A2744',
  borderSoft: '#D4D4D4',
  tabBorder: '#D1D1D1',
  goldDeep: '#4A3810',
  goldDark: '#6B4E1A',
  goldMid: '#9A7224',
  goldLight: '#C9A227',
  goldPale: '#F5E6C8',
  cardRadius: 16,
  /** Shared home listing card layout (auction + buy now). */
  listingCardWidth: 304,
  listingCardImageHeight: 200,
  listingCardOuterRadius: 20,
  listingCardImageRadius: 16,
  listingCardBodyPadding: 16,
  filterTrackShadow: {
    shadowColor: '#1A2744',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  listingCardShadow: {
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 6,
  },
};

/** Four primary home marketplace tabs (replaces dual browse + sort rows). */
export const HOME_MARKET_TABS = [
  { key: 'all', label: 'All Art' },
  { key: 'live', label: 'Live Auctions' },
  { key: 'buyNow', label: 'Buy Now' },
  { key: 'historical', label: 'Ended Auctions' },
];

export const HOME_MARKET_TAB_KEYS = HOME_MARKET_TABS.map((t) => t.key);

/** @deprecated Legacy — use HOME_MARKET_TABS */
export const HOME_TABS = ['Trending', 'Ending Soon', 'Ended'];
/** @deprecated Legacy — use HOME_MARKET_TABS */
export const HOME_BROWSE_FILTERS = ['All', 'Newly Listed', 'Auctions', 'Ended Auctions'];
