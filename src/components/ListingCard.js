import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ListingCoverImage } from './ListingCoverImage';
import { getListingDisplayTitle } from './listings/AuctionListingCard';
import {
  isAuctionListing,
  resolveListingCoverForDisplay,
} from '../utils/listingMedia';
import { isMarketplaceAuctionEnded } from '../utils/auctionLifecycle';

const INDIGO = '#1E3A8A';
const CARD_BORDER = '#E8ECF0';

const cardElevation = Platform.select({
  ios: {
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
  },
  android: { elevation: 3 },
  default: {},
});

/**
 * Premium grid listing card for seller profile / published ads.
 * UI-only — no data fetching.
 */
export default function ListingCard({ item, width, onPress, recycleKey }) {
  const cover = resolveListingCoverForDisplay(item);
  const title = getListingDisplayTitle(item);
  const auction = isAuctionListing(item);
  const ended = auction && isMarketplaceAuctionEnded(item);
  const price = auction
    ? Number(item?.currentBid ?? item?.price ?? 0)
    : Number(item?.buyNowPrice ?? item?.price ?? 0);

  return (
    <TouchableOpacity
      style={[styles.cardOuter, { width }, cardElevation]}
      activeOpacity={0.9}
      onPress={onPress}
      accessibilityRole="button"
    >
      <View style={styles.imageSection}>
        {cover ? (
          <ListingCoverImage uri={cover} style={styles.image} recycleKey={recycleKey} />
        ) : (
          <View style={styles.imagePlaceholder}>
            <Ionicons name="image-outline" size={32} color="#94A3B8" />
          </View>
        )}
        {auction ? (
          <View style={[styles.typeBadge, ended && styles.typeBadgeEnded]}>
            <Text style={styles.typeBadgeText}>{ended ? 'Ended' : 'Auction'}</Text>
          </View>
        ) : (
          <View style={[styles.typeBadge, styles.typeBadgeBuyNow]}>
            <Text style={[styles.typeBadgeText, styles.typeBadgeTextDark]}>Buy Now</Text>
          </View>
        )}
      </View>

      <View style={styles.bodySection}>
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
        <View style={styles.priceRow}>
          {auction ? <Text style={styles.priceLabel}>Current bid</Text> : null}
          <Text style={styles.priceValue}>
            Rs. {price.toLocaleString()}
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  cardOuter: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: CARD_BORDER,
    overflow: 'hidden',
  },
  imageSection: {
    width: '100%',
    aspectRatio: 1,
    backgroundColor: '#F1F5F9',
    overflow: 'hidden',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  imagePlaceholder: {
    flex: 1,
    minHeight: 100,
    alignItems: 'center',
    justifyContent: 'center',
  },
  typeBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: '#B91C1C',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  typeBadgeEnded: {
    backgroundColor: '#64748B',
  },
  typeBadgeBuyNow: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: CARD_BORDER,
  },
  typeBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 0.2,
  },
  typeBadgeTextDark: {
    color: INDIGO,
  },
  bodySection: {
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 12,
    borderTopWidth: 1,
    borderTopColor: CARD_BORDER,
    backgroundColor: '#FFFFFF',
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    color: '#0F172A',
    lineHeight: 18,
    marginBottom: 8,
  },
  priceRow: {
    gap: 2,
  },
  priceLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748B',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  priceValue: {
    fontSize: 16,
    fontWeight: '800',
    color: INDIGO,
    letterSpacing: -0.2,
  },
});
