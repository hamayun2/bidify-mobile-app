import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import SmartImage from './SmartImage';
import { resolveMediaUrl } from '../utils/listingMedia';

const INDIGO = '#1E3A8A';
const CARD_BORDER = '#E5E7EB';
const TEXT_PRIMARY = '#0F172A';
const TEXT_SECONDARY = '#64748B';

function sellerInitials(name) {
  const parts = String(name || 'S')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return (parts[0]?.[0] || 'S').toUpperCase();
}

/**
 * OLX-style seller profile row: avatar | name + stats | chevron.
 * Entire card is pressable — navigates to PublicProfileView from parent onPress.
 */
export default function PostedBySellerCard({ seller, onPress, loading = false }) {
  const avatarUri = useMemo(() => {
    const raw = seller?.profileImage;
    if (!raw) return null;
    return resolveMediaUrl(raw);
  }, [seller?.profileImage]);

  const displayName = seller?.displayName || 'Seller';
  const count =
    seller?.totalListingsCount ?? seller?.total_ads ?? seller?.totalAds ?? 0;
  const showCard = loading || seller || onPress;

  if (!showCard) return null;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeading}>Posted by</Text>
      <Pressable
        style={({ pressed }) => [
          styles.card,
          pressed && styles.cardPressed,
          (loading && !seller) && styles.cardLoading,
        ]}
        onPress={onPress}
        disabled={!onPress}
        accessibilityRole="button"
        accessibilityLabel={`View seller profile, ${displayName}`}
        accessibilityHint="Opens public seller profile"
      >
        <View style={styles.avatarColumn}>
          {loading && !seller ? (
            <View style={[styles.avatar, styles.avatarPlaceholder]}>
              <ActivityIndicator size="small" color="#FFFFFF" />
            </View>
          ) : avatarUri ? (
            <SmartImage uri={avatarUri} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarPlaceholder]}>
              <Text style={styles.avatarInitials}>{sellerInitials(displayName)}</Text>
            </View>
          )}
        </View>

        <View style={styles.infoColumn}>
          <Text style={styles.sellerName} numberOfLines={1}>
            {loading && !seller ? 'Loading seller…' : displayName}
          </Text>
          {loading && !seller ? (
            <Text style={styles.metaLine}>Please wait</Text>
          ) : (
            <Text style={styles.metaLine} numberOfLines={1}>
              {`Total Ads: ${Number(count).toLocaleString()}`}
            </Text>
          )}
        </View>

        <View style={styles.chevronColumn}>
          <View style={styles.chevronCircle}>
            <Ionicons name="chevron-forward" size={20} color={TEXT_SECONDARY} />
          </View>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: 20,
    marginBottom: 4,
    width: '100%',
  },
  sectionHeading: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 12,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: CARD_BORDER,
    paddingVertical: 14,
    paddingHorizontal: 14,
    minHeight: 88,
    ...Platform.select({
      ios: {
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.08,
        shadowRadius: 6,
      },
      android: { elevation: 3 },
      default: {},
    }),
  },
  cardPressed: {
    opacity: 0.94,
    backgroundColor: '#FAFAFA',
  },
  cardLoading: {
    opacity: 0.92,
  },
  avatarColumn: {
    marginRight: 14,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#EEF2FF',
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: INDIGO,
    borderWidth: 1,
    borderColor: '#C7D2FE',
  },
  avatarInitials: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '800',
  },
  infoColumn: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    paddingRight: 8,
  },
  sellerName: {
    fontSize: 17,
    fontWeight: '700',
    color: TEXT_PRIMARY,
    marginBottom: 4,
  },
  metaLine: {
    fontSize: 14,
    color: TEXT_SECONDARY,
    lineHeight: 20,
    fontWeight: '500',
  },
  chevronColumn: {
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 4,
  },
  chevronCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
