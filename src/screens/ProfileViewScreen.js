import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRoute, useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { AuthContext } from '../context/AuthContext';
import { getSellerPublicProfileAPI, getSellerListingsAPI } from '../api/users';
import SmartImage from '../components/SmartImage';
import ListingCard from '../components/ListingCard';
import {
  getListingRowKey,
  resolveListingCoverForDisplay,
  resolveMediaUrl,
} from '../utils/listingMedia';
import { formatProfileDisplayName } from '../utils/profileDisplay';
import {
  reconcileSellerAdCount,
  useListingsSync,
  useMarketplaceSyncVersion,
  useProfileSyncVersion,
} from '../context/ListingsSyncContext';
import { spacing } from '../theme';

const SCREEN_BG = '#F4F6F8';
const HEADER_BOX_BG = '#F0F2F5';
const HEADER_BORDER = '#E2E8F0';
const INDIGO = '#1E3A8A';
const GRID_GAP = 15;

const headerBoxShadow = Platform.select({
  ios: {
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
  },
  android: { elevation: 2 },
  default: {},
});

function sellerInitials(name) {
  const parts = String(name || 'S')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return (parts[0]?.[0] || 'S').toUpperCase();
}

export default function ProfileViewScreen() {
  const route = useRoute();
  const navigation = useNavigation();
  const { user } = useContext(AuthContext);
  const userId = route.params?.userId || route.params?.sellerId;
  const isOwnProfile = user?.id && userId && String(user.id) === String(userId);
  const marketplaceSyncVersion = useMarketplaceSyncVersion();
  const profileSyncVersion = useProfileSyncVersion();
  const { deletedListingIds, filterDeletedListings } = useListingsSync();

  const { width: screenWidth } = useWindowDimensions();
  const hPad = spacing.lg;
  const cardWidth = (screenWidth - hPad * 2 - GRID_GAP) / 2;

  const [seller, setSeller] = useState(null);
  const [listings, setListings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(
    async (mode = 'normal') => {
      if (!userId) {
        setError('No seller specified.');
        setLoading(false);
        return;
      }
      if (mode === 'pull') setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const [profile, ads] = await Promise.all([
          getSellerPublicProfileAPI(userId),
          getSellerListingsAPI(userId),
        ]);

        if (__DEV__) {
          const sample = (Array.isArray(ads) ? ads : []).slice(0, 5).map((row) => ({
            id: row?.id,
            image_url: row?.image_url,
            image_urls: row?.image_urls,
            image: row?.image,
            images: row?.images,
            cover: resolveListingCoverForDisplay(row),
          }));
          console.log('[ProfileView] raw listings BEFORE UI', {
            sellerId: userId,
            count: Array.isArray(ads) ? ads.length : 0,
            sample,
          });
        }

        const rows = filterDeletedListings(Array.isArray(ads) ? ads : []);
        let nextProfile = profile;
        if (nextProfile) {
          const apiCount = Number(
            profile?.totalListingsCount ?? profile?.total_ads ?? 0
          );
          const totalCount = reconcileSellerAdCount(userId, apiCount, rows.length);
          nextProfile = {
            ...nextProfile,
            totalListingsCount: totalCount,
            total_ads: totalCount,
          };
        }
        setSeller(nextProfile);
        setListings(rows);
      } catch (e) {
        setError(e?.message || 'Could not load seller profile.');
        setSeller(null);
        setListings([]);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [userId, filterDeletedListings]
  );

  useFocusEffect(
    useCallback(() => {
      load('normal');
    }, [load])
  );

  useEffect(() => {
    if (deletedListingIds.length > 0) {
      setListings((prev) => filterDeletedListings(prev));
    }
  }, [deletedListingIds, filterDeletedListings]);

  useEffect(() => {
    if (marketplaceSyncVersion > 0 || profileSyncVersion > 0) {
      setListings((prev) => filterDeletedListings(prev));
      load('pull');
    }
  }, [marketplaceSyncVersion, profileSyncVersion, load, filterDeletedListings]);

  const avatarUri = useMemo(() => {
    const raw = seller?.profileImage;
    return raw ? resolveMediaUrl(raw) : null;
  }, [seller?.profileImage]);

  const totalAds = reconcileSellerAdCount(
    userId,
    seller?.totalListingsCount ?? seller?.total_ads ?? 0,
    listings.length
  );

  const header = (
    <View style={styles.headerWrap}>
      <View style={[styles.profileHeaderBox, headerBoxShadow]}>
        <View style={styles.profileRow}>
          <View style={styles.avatarOuter}>
            {avatarUri ? (
              <SmartImage uri={avatarUri} style={styles.avatar} />
            ) : (
              <View style={styles.avatarPlaceholder}>
                <Text style={styles.avatarInitials}>
                  {sellerInitials(seller?.displayName)}
                </Text>
              </View>
            )}
          </View>
          <View style={styles.profileText}>
            <Text style={styles.profileName} numberOfLines={2}>
              {formatProfileDisplayName(seller) || seller?.displayName || 'Seller'}
            </Text>
            <View style={styles.adsCountPill}>
              <Ionicons name="albums-outline" size={14} color={INDIGO} />
              <Text style={styles.profileMeta}>
                {totalAds.toLocaleString()} published {totalAds === 1 ? 'ad' : 'ads'}
              </Text>
            </View>
            {isOwnProfile ? (
              <Text style={styles.ownHint}>This is your public seller profile.</Text>
            ) : null}
          </View>
        </View>
      </View>

      <View style={styles.sectionDivider} />

      <View style={styles.adsSectionHead}>
        <Text style={styles.adsSectionTitle}>Published ads</Text>
        <Text style={styles.adsSectionSub}>{listings.length} showing</Text>
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      {loading && !seller ? (
        <View style={styles.loaderWrap}>
          <ActivityIndicator size="large" color={INDIGO} />
        </View>
      ) : (
        <FlatList
          data={listings}
          keyExtractor={(item, index) => getListingRowKey(item, index)}
          numColumns={2}
          columnWrapperStyle={[styles.gridRow, { gap: GRID_GAP, paddingHorizontal: hPad }]}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={header}
          renderItem={({ item, index }) => (
            <ListingCard
              item={item}
              width={cardWidth}
              recycleKey={getListingRowKey(item, index)}
              onPress={() => navigation.navigate('ListingDetail', { listing: item })}
            />
          )}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => load('pull')} tintColor={INDIGO} />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="albums-outline" size={40} color="#94A3B8" />
              <Text style={styles.emptyTitle}>
                {error ? 'Could not load ads' : 'No listings yet'}
              </Text>
              <Text style={styles.emptySub}>
                {error || 'This seller has not published any ads.'}
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: SCREEN_BG },
  loaderWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  listContent: { paddingBottom: 48 },
  headerWrap: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  profileHeaderBox: {
    backgroundColor: HEADER_BOX_BG,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: HEADER_BORDER,
    padding: spacing.lg,
  },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  avatarOuter: {
    width: 80,
    height: 80,
    borderRadius: 40,
    overflow: 'hidden',
    backgroundColor: '#EEF2FF',
    borderWidth: 2,
    borderColor: '#FFFFFF',
  },
  avatar: { width: 80, height: 80 },
  avatarPlaceholder: {
    width: 80,
    height: 80,
    backgroundColor: INDIGO,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: { color: '#FFFFFF', fontSize: 28, fontWeight: '800' },
  profileText: { flex: 1, minWidth: 0 },
  profileName: {
    fontSize: 22,
    fontWeight: '800',
    color: '#0F172A',
    marginBottom: 10,
    letterSpacing: -0.3,
  },
  adsCountPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: HEADER_BORDER,
  },
  profileMeta: {
    fontSize: 13,
    color: '#475569',
    fontWeight: '700',
  },
  ownHint: {
    fontSize: 12,
    color: INDIGO,
    fontWeight: '600',
    marginTop: 10,
  },
  sectionDivider: {
    height: 1,
    backgroundColor: HEADER_BORDER,
    marginTop: spacing.lg,
    marginBottom: spacing.md,
  },
  adsSectionHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  adsSectionTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0F172A',
    letterSpacing: -0.2,
  },
  adsSectionSub: {
    fontSize: 12,
    fontWeight: '600',
    color: '#94A3B8',
  },
  gridRow: {
    marginBottom: GRID_GAP,
  },
  empty: {
    alignItems: 'center',
    paddingTop: 40,
    paddingHorizontal: spacing.xxl,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#0F172A',
    marginTop: spacing.md,
  },
  emptySub: {
    fontSize: 14,
    color: '#64748B',
    marginTop: 6,
    textAlign: 'center',
  },
});
