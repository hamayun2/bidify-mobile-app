import React, { Component, useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { fetchRelatedAds } from '../utils/fetchRelatedAds';
import { ListingCoverImage } from './ListingCoverImage';
import { getListingDisplayTitle } from './listings/AuctionListingCard';
import {
  getListingRowKey,
  isAuctionListing,
  resolveListingCoverForDisplay,
} from '../utils/listingMedia';
import { spacing } from '../theme';

const CARD_WIDTH_BASE = 168;
const SECTION_TOP_SPACING = 30;
const WEB_MAX_SECTION_WIDTH = 720;

class RelatedAdsErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    if (__DEV__) {
      console.warn('[RelatedAds] render error', error?.message || error);
    }
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

function RelatedAdCard({ item, onPress, cardWidth = CARD_WIDTH_BASE }) {
  const cover = resolveListingCoverForDisplay(item);
  const title = getListingDisplayTitle(item);
  const auction = isAuctionListing(item);
  const price = auction
    ? Number(item?.currentBid ?? item?.price ?? 0)
    : Number(item?.buyNowPrice ?? item?.price ?? 0);

  return (
    <TouchableOpacity
      style={[styles.card, { width: cardWidth }]}
      activeOpacity={0.88}
      onPress={() => onPress?.(item)}
      accessibilityRole="button"
      accessibilityLabel={`View related listing ${title}`}
    >
      <View style={styles.imageWrap}>
        {cover ? (
          <ListingCoverImage uri={cover} style={styles.image} recycleKey={item?.id} />
        ) : (
          <View style={[styles.image, styles.imagePlaceholder]}>
            <Ionicons name="image-outline" size={28} color="#94A3B8" />
          </View>
        )}
      </View>
      <Text style={styles.cardTitle} numberOfLines={2}>
        {title}
      </Text>
      <Text style={styles.cardPrice}>Rs. {Number(price).toLocaleString()}</Text>
    </TouchableOpacity>
  );
}

function RelatedAdsBody({ categoryId, currentId, onPressListing }) {
  const navigation = useNavigation();
  const { width: windowWidth } = useWindowDimensions();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const cardWidth = Math.min(
    CARD_WIDTH_BASE,
    Math.max(140, Math.floor((Math.min(windowWidth, WEB_MAX_SECTION_WIDTH) - 48) / 2.2))
  );
  const isWeb = Platform.OS === 'web';

  useEffect(() => {
    let cancelled = false;
    const categoryKey = categoryId != null ? String(categoryId).trim() : '';
    const listingKey = currentId != null ? String(currentId).trim() : '';

    if (!categoryKey || !listingKey) {
      setItems([]);
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    (async () => {
      try {
        const rows = await fetchRelatedAds(categoryKey, listingKey);
        if (__DEV__) {
          console.log('[RelatedAds] fetch result', {
            categoryKey,
            listingKey,
            count: Array.isArray(rows) ? rows.length : 0,
          });
        }
        if (!cancelled) setItems(Array.isArray(rows) ? rows : []);
      } catch (e) {
        if (__DEV__) console.warn('[RelatedAds] fetch failed', e?.message || e);
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [categoryId, currentId]);

  const openRelatedListing = useCallback(
    (item) => {
      if (!item) return;
      if (typeof onPressListing === 'function') {
        try {
          onPressListing(item);
        } catch (e) {
          if (__DEV__) console.warn('[RelatedAds] onPressListing failed', e?.message || e);
        }
        return;
      }
      const listingId = item?.id != null ? String(item.id) : '';
      if (!listingId) return;
      try {
        navigation.navigate('ListingDetail', {
          listingId,
          listing: item,
        });
      } catch (e) {
        if (__DEV__) console.warn('[RelatedAds] navigation failed', e?.message || e);
      }
    },
    [navigation, onPressListing]
  );

  const renderItem = useCallback(
    ({ item }) => (
      <RelatedAdCard item={item} cardWidth={cardWidth} onPress={openRelatedListing} />
    ),
    [openRelatedListing, cardWidth]
  );

  const hasItems = items.length > 0;

  return (
    <View
      style={[
        styles.sectionBox,
        isWeb && styles.sectionBoxWeb,
        isWeb && { maxWidth: WEB_MAX_SECTION_WIDTH, alignSelf: 'center', width: '100%' },
      ]}
    >
      <Text style={styles.sectionTitle}>Related Ads</Text>
      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="small" color="#1E3A8A" />
        </View>
      ) : hasItems ? (
        <FlatList
          data={items}
          horizontal
          showsHorizontalScrollIndicator={isWeb}
          nestedScrollEnabled
          keyExtractor={(item, index) => getListingRowKey(item, index)}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
        />
      ) : (
        <Text style={styles.emptyText}>No related ads available.</Text>
      )}
    </View>
  );
}

/** Horizontal related listings for Listing Detail — persistent section with empty state. */
export default function RelatedAds(props) {
  try {
    return (
      <RelatedAdsErrorBoundary>
        <RelatedAdsBody {...props} />
      </RelatedAdsErrorBoundary>
    );
  } catch (e) {
    if (__DEV__) console.warn('[RelatedAds] mount error', e?.message || e);
    return null;
  }
}

const cardShadow = Platform.select({
  ios: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
  },
  android: { elevation: 2 },
  default: {
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
  },
});

const styles = StyleSheet.create({
  sectionBox: {
    marginTop: SECTION_TOP_SPACING,
    marginBottom: spacing.md,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: '#E8ECF0',
    ...cardShadow,
  },
  sectionBoxWeb: {
    marginHorizontal: 'auto',
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: spacing.md,
    letterSpacing: -0.2,
  },
  loadingWrap: {
    paddingVertical: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    fontSize: 14,
    lineHeight: 20,
    color: '#94A3B8',
    textAlign: 'center',
    paddingVertical: 24,
    paddingHorizontal: 12,
    fontWeight: '500',
  },
  listContent: {
    paddingRight: spacing.sm,
  },
  card: {
    width: CARD_WIDTH_BASE,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    overflow: 'hidden',
    marginRight: spacing.md,
    ...cardShadow,
  },
  imageWrap: {
    width: '100%',
    height: 112,
    backgroundColor: '#F1F5F9',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  imagePlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0F172A',
    marginTop: 8,
    marginHorizontal: 10,
    lineHeight: 18,
    minHeight: 36,
  },
  cardPrice: {
    fontSize: 13,
    fontWeight: '800',
    color: '#1E3A8A',
    marginHorizontal: 10,
    marginBottom: 10,
    marginTop: 4,
  },
});
