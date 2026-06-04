import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Platform,
  ScrollView,
  useWindowDimensions,
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { getListingsAPI } from '../api/listings';
import {
  getListingRowKey,
  isAuctionListing,
  resolveListingCoverForDisplay,
} from '../utils/listingMedia';
import {
  isMarketplaceAuctionEnded,
  getAuctionEndMs,
} from '../utils/auctionLifecycle';
import { useAuctionClockTick } from '../hooks/useAuctionClockTick';
import { getListingDisplayTitle } from '../components/listings/AuctionListingCard';
import { ListingCoverImage } from '../components/ListingCoverImage';
import { useListingsSync, useMarketplaceSyncVersion } from '../context/ListingsSyncContext';
import { colors, spacing } from '../theme';

const SCREEN_BG = '#F4F6F8';
const INDIGO = '#1E3A8A';
const FILTER_PILLS = ['All', 'Newly Listed', 'Auctions', 'Ended Auctions'];

function matchesQuery(item, q) {
  if (!q) return true;
  const needle = String(q).trim().toLowerCase();
  if (!needle) return true;
  const hay = `${item?.title || ''} ${item?.description || ''} ${item?.category || ''} ${item?.location || ''}`.toLowerCase();
  return hay.includes(needle);
}

function getListingPrice(item) {
  if (isAuctionListing(item)) {
    const n = Number(item?.currentBid ?? item?.price ?? 0);
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(item?.buyNowPrice ?? item?.price ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function getCreatedMs(item) {
  const raw = item?.createdAt ?? item?.created_at;
  if (!raw) return 0;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : 0;
}

function FilterPill({ label, active, onPress }) {
  return (
    <TouchableOpacity
      style={[styles.pill, active ? styles.pillActive : styles.pillInactive]}
      onPress={onPress}
      activeOpacity={0.88}
    >
      <Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function ListingTypeBadge({ auction, ended }) {
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!auction) return undefined;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.72, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [auction, pulse]);

  if (auction) {
    if (ended) {
      return (
        <View style={styles.badgeEnded}>
          <Ionicons name="time-outline" size={11} color="#FFFFFF" />
          <Text style={styles.badgeText}>Ended</Text>
        </View>
      );
    }
    return (
      <Animated.View style={[styles.badgeAuction, { opacity: pulse }]}>
        <Ionicons name="hammer" size={11} color="#FFFFFF" />
        <Text style={styles.badgeText}>Live Auction</Text>
      </Animated.View>
    );
  }

  return (
    <View style={styles.badgeStandard}>
      <Ionicons name="pricetag" size={11} color={INDIGO} />
      <Text style={styles.badgeTextStandard}>Buy Now</Text>
    </View>
  );
}

function ExploreGridCard({ item, width, onPress, recycleKey }) {
  const cover = resolveListingCoverForDisplay(item);
  const title = getListingDisplayTitle(item);
  const price = getListingPrice(item);
  const auction = isAuctionListing(item);
  const ended = auction && isMarketplaceAuctionEnded(item);

  return (
    <TouchableOpacity
      style={[styles.gridCard, { width }]}
      activeOpacity={0.9}
      onPress={onPress}
    >
      <View style={styles.gridImageWrap}>
        {cover ? (
          <ListingCoverImage uri={cover} style={styles.gridImage} recycleKey={recycleKey} />
        ) : (
          <View style={styles.gridImagePlaceholder}>
            <Ionicons name="image-outline" size={36} color="#94A3B8" />
          </View>
        )}
        <View style={styles.badgeOverlay}>
          <ListingTypeBadge auction={auction} ended={ended} />
        </View>
      </View>
      <View style={styles.gridBody}>
        <Text style={styles.gridTitle} numberOfLines={2}>
          {title}
        </Text>
        <Text style={styles.gridPrice}>
          {auction ? 'Bid ' : ''}Rs. {price.toLocaleString()}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

const SearchScreen = ({ navigation }) => {
  const { width: screenWidth } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('All');
  const clockTick = useAuctionClockTick(30000);
  const marketplaceSyncVersion = useMarketplaceSyncVersion();
  const { filterDeletedListings } = useListingsSync();
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const hasLoadedOnce = useRef(false);
  const seqRef = useRef(0);

  const gridGap = 12;
  const hPad = spacing.lg;
  const cardWidth = (screenWidth - hPad * 2 - gridGap) / 2;

  const fetchResults = useCallback(async (mode = 'normal', q) => {
    const mySeq = ++seqRef.current;
    if (mode === 'pull') setRefreshing(true);
    else if (mode === 'silent') {
      /* background sync after delete */
    } else if (!hasLoadedOnce.current) setLoading(true);
    try {
      const data = await getListingsAPI({ search: q ?? query });
      if (mySeq === seqRef.current) {
        if (Array.isArray(data)) setResults(filterDeletedListings(data));
        else setResults([]);
      }
    } catch (_) {
      if (mySeq === seqRef.current && !hasLoadedOnce.current) setResults([]);
    } finally {
      if (mySeq === seqRef.current) {
        hasLoadedOnce.current = true;
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [query, filterDeletedListings]);

  useEffect(() => {
    fetchResults('normal');
  }, []);

  useEffect(() => {
    const t = setTimeout(() => fetchResults('normal', query), 350);
    return () => clearTimeout(t);
  }, [query, fetchResults]);

  useEffect(() => {
    if (marketplaceSyncVersion > 0) {
      setResults((prev) => filterDeletedListings(prev));
      void fetchResults('pull', query);
    }
  }, [marketplaceSyncVersion, fetchResults, query, filterDeletedListings]);

  const visible = useMemo(() => {
    let list = results.filter((i) => matchesQuery(i, query));

    if (activeFilter === 'Ended Auctions') {
      return list
        .filter((i) => isAuctionListing(i) && isMarketplaceAuctionEnded(i))
        .sort((a, b) => (getAuctionEndMs(b) ?? 0) - (getAuctionEndMs(a) ?? 0));
    }

    list = list.filter((i) => !isMarketplaceAuctionEnded(i));

    if (activeFilter === 'Auctions') {
      list = list.filter(isAuctionListing);
    }

    if (activeFilter === 'Newly Listed') {
      list = [...list].sort((a, b) => getCreatedMs(b) - getCreatedMs(a));
    }

    return list;
  }, [results, query, activeFilter, clockTick]);

  const emptyMessage = useMemo(() => {
    if (activeFilter === 'Ended Auctions') {
      return 'No ended auctions match your search. Try another keyword or browse live auctions.';
    }
    if (activeFilter === 'Auctions') {
      return 'No live auctions match your search right now. Check back soon or try another filter.';
    }
    if (activeFilter === 'Newly Listed') {
      return 'No new listings match your search. Try a different keyword or browse All.';
    }
    return 'No listings match your search. Try another keyword or pull to refresh.';
  }, [activeFilter]);

  const renderItem = ({ item, index }) => (
    <ExploreGridCard
      item={item}
      width={cardWidth}
      recycleKey={getListingRowKey(item, index)}
      onPress={() => navigation.navigate('ListingDetail', { listing: item })}
    />
  );

  const listHeader = (
    <View style={styles.listHeader}>
      <View style={styles.headerTop}>
        <Text style={styles.headerTitle}>Discover Treasures</Text>
        <Text style={styles.headerSubtitle}>Curated collections · auctions & buy now</Text>
      </View>

      <View style={styles.searchBar}>
        <Ionicons name="search" size={22} color={INDIGO} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search listings, categories, cities..."
          placeholderTextColor="#94A3B8"
          value={query}
          onChangeText={setQuery}
          returnKeyType="search"
        />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.pillsRow}
      >
        {FILTER_PILLS.map((label) => (
          <FilterPill
            key={label}
            label={label}
            active={activeFilter === label}
            onPress={() => setActiveFilter(label)}
          />
        ))}
      </ScrollView>
    </View>
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {loading && results.length === 0 ? (
        <View style={styles.loaderWrap}>
          {listHeader}
          <ActivityIndicator style={styles.loader} color={INDIGO} />
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(item, index) => getListingRowKey(item, index)}
          renderItem={renderItem}
          numColumns={2}
          columnWrapperStyle={[styles.gridRow, { gap: gridGap, paddingHorizontal: hPad }]}
          contentContainerStyle={styles.gridList}
          ListHeaderComponent={listHeader}
          showsVerticalScrollIndicator
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => fetchResults('pull')}
              tintColor={INDIGO}
            />
          }
          ListEmptyComponent={
            <Text style={styles.empty}>{emptyMessage}</Text>
          }
        />
      )}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: SCREEN_BG },
  listHeader: {
    paddingBottom: spacing.sm,
  },
  headerTop: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  headerTitle: {
    fontSize: 30,
    fontWeight: '800',
    color: '#0F172A',
    letterSpacing: -0.8,
  },
  headerSubtitle: {
    fontSize: 14,
    color: '#64748B',
    marginTop: 6,
    fontWeight: '500',
    lineHeight: 20,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.xl,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.lg,
    height: 52,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    gap: spacing.sm,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.05,
        shadowRadius: 8,
      },
      android: { elevation: 3 },
    }),
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: '#0F172A',
    paddingVertical: 0,
    fontWeight: '500',
  },
  pillsRow: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.sm,
    gap: 10,
    alignItems: 'center',
  },
  pill: {
    paddingHorizontal: 20,
    paddingVertical: 11,
    borderRadius: 24,
    marginRight: 4,
  },
  pillInactive: {
    backgroundColor: '#E2E8F0',
  },
  pillActive: {
    backgroundColor: INDIGO,
  },
  pillText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#475569',
  },
  pillTextActive: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  loaderWrap: { flex: 1 },
  loader: { marginTop: 32, marginBottom: 48 },
  gridList: {
    paddingBottom: 48,
  },
  gridRow: {
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  gridCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 12,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.05,
        shadowRadius: 6,
      },
      android: { elevation: 2 },
    }),
  },
  gridImageWrap: {
    width: '100%',
    aspectRatio: 1,
    backgroundColor: '#EDE9E3',
    position: 'relative',
  },
  gridImage: {
    width: '100%',
    height: '100%',
  },
  gridImagePlaceholder: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EDE9E3',
  },
  badgeOverlay: {
    position: 'absolute',
    left: 8,
    bottom: 8,
  },
  badgeAuction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#B91C1C',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
  },
  badgeEnded: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#64748B',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
  },
  badgeStandard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.12,
        shadowRadius: 3,
      },
      android: { elevation: 2 },
    }),
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 0.2,
  },
  badgeTextStandard: {
    fontSize: 10,
    fontWeight: '800',
    color: INDIGO,
    letterSpacing: 0.2,
  },
  gridBody: {
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 12,
  },
  gridTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0F172A',
    lineHeight: 18,
    marginBottom: 6,
    minHeight: 36,
  },
  gridPrice: {
    fontSize: 17,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: -0.4,
  },
  empty: {
    color: colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
    marginTop: 32,
    paddingHorizontal: spacing.xxl,
    lineHeight: 21,
  },
});

export default SearchScreen;
