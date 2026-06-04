import React, { useState, useCallback, useMemo, useContext, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Platform,
  useWindowDimensions,
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AuthContext } from '../context/AuthContext';
import { useNotifications } from '../context/NotificationsContext';
import useListings from '../hooks/useListings';
import { useMarketplaceSyncVersion } from '../context/ListingsSyncContext';
import AuctionListingCard from '../components/listings/AuctionListingCard';
import StandardListingCard from '../components/listings/StandardListingCard';
import HomeFloatingHeader from '../components/home/HomeFloatingHeader';
import HomeSearchBar from '../components/home/HomeSearchBar';
import HomeMarketplaceFilterBar from '../components/home/HomeMarketplaceFilterBar';
import FadeInUp from '../components/home/FadeInUp';
import {
  getListingRowKey,
  isAuctionListing,
  isStandardListing,
} from '../utils/listingMedia';
import {
  isMarketplaceAuctionEnded,
  getAuctionEndMs,
} from '../utils/auctionLifecycle';
import { useAuctionClockTick } from '../hooks/useAuctionClockTick';
import { colors, spacing } from '../theme';
import { HOME, HOME_MARKET_TAB_KEYS } from '../constants/homePalette';

const PATTERN_TILE = 82;
const PATTERN_ICONS = [
  'book-outline',
  'hourglass-outline',
  'hammer-outline',
  'flower-outline',
  'diamond-outline',
  'library-outline',
  'watch-outline',
  'wine-outline',
  'color-palette-outline',
  'globe-outline',
];

function matchesSearch(item, q) {
  if (!q) return true;
  const needle = String(q).trim().toLowerCase();
  if (!needle) return true;
  const hay = `${item?.title || ''} ${item?.description || ''} ${item?.category || ''} ${item?.location || ''}`.toLowerCase();
  return hay.includes(needle);
}

function getCreatedMs(item) {
  const raw = item?.createdAt ?? item?.created_at;
  if (!raw) return 0;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : 0;
}

function getEndMs(item) {
  return getAuctionEndMs(item);
}

function getTrendingScore(item) {
  const bid = Number(item?.currentBid ?? item?.price ?? 0);
  const views = Number(item?.views ?? item?.view_count ?? 0);
  const bids = Number(item?.bidCount ?? item?.bid_count ?? 0);
  return bid * 12 + views * 2 + bids * 50;
}

/** Map four UI tabs → auction rows (presentation only; listing fields unchanged). */
function filterAuctionsForMarketTab(list, marketTab) {
  const now = Date.now();
  let out = [...list].filter(isAuctionListing);

  if (marketTab === 'historical') {
    return out
      .filter(isMarketplaceAuctionEnded)
      .sort((a, b) => (getEndMs(b) ?? 0) - (getEndMs(a) ?? 0));
  }

  if (marketTab === 'buyNow') {
    return [];
  }

  out = out.filter((item) => !isMarketplaceAuctionEnded(item));

  if (marketTab === 'live') {
    out = out.filter((item) => {
      const end = getEndMs(item);
      return end != null && end > now;
    });
    out.sort((a, b) => (getEndMs(a) ?? Infinity) - (getEndMs(b) ?? Infinity));
    return out;
  }

  // all — live auctions + trending order
  out.sort((a, b) => getTrendingScore(b) - getTrendingScore(a));
  return out;
}

function GalleryWallpaper({ children, scrollY }) {
  const { width, height } = useWindowDimensions();
  const cols = Math.ceil(width / PATTERN_TILE) + 1;
  const rows = Math.ceil((height + 160) / PATTERN_TILE) + 1;

  const parallaxY = scrollY.interpolate({
    inputRange: [0, 600],
    outputRange: [0, -12],
    extrapolate: 'clamp',
  });

  const tiles = useMemo(() => {
    const out = [];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        out.push({
          key: `${r}-${c}`,
          left: c * PATTERN_TILE + (r % 2 === 0 ? 6 : PATTERN_TILE / 2),
          top: r * PATTERN_TILE + 10,
          icon: PATTERN_ICONS[(r + c) % PATTERN_ICONS.length],
        });
      }
    }
    return out;
  }, [cols, rows]);

  return (
    <View style={styles.wallpaper}>
      <Animated.View
        style={[styles.wallpaperPattern, { transform: [{ translateY: parallaxY }] }]}
        pointerEvents="none"
      >
        {tiles.map((t) => (
          <Ionicons
            key={t.key}
            name={t.icon}
            size={19}
            color="rgba(102, 102, 102, 0.04)"
            style={{ position: 'absolute', left: t.left, top: t.top }}
          />
        ))}
      </Animated.View>
      {children}
    </View>
  );
}

function PulsingDot() {
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.5, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <View style={styles.liveDotWrap}>
      <Animated.View style={[styles.liveDot, { transform: [{ scale: pulse }] }]} />
    </View>
  );
}

function TabContentShell({ tabKey, children }) {
  const slide = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;
  const prevIndexRef = useRef(HOME_MARKET_TAB_KEYS.indexOf(tabKey));

  useEffect(() => {
    const nextIndex = HOME_MARKET_TAB_KEYS.indexOf(tabKey);
    const prevIndex = prevIndexRef.current;
    const direction = nextIndex >= prevIndex ? 1 : -1;
    prevIndexRef.current = nextIndex >= 0 ? nextIndex : prevIndex;

    slide.setValue(direction * 36);
    opacity.setValue(0.55);

    Animated.parallel([
      Animated.spring(slide, {
        toValue: 0,
        friction: 8,
        tension: 68,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: 320,
        useNativeDriver: true,
      }),
    ]).start();
  }, [tabKey, opacity, slide]);

  return (
    <Animated.View style={{ opacity, transform: [{ translateX: slide }] }}>{children}</Animated.View>
  );
}

const HomeScreen = () => {
  const navigation = useNavigation();
  const { user } = useContext(AuthContext);
  const { unreadCount: notificationUnread } = useNotifications();
  const { listings, loading, refreshing, error, refresh } = useListings();
  const marketplaceSyncVersion = useMarketplaceSyncVersion();
  const [query, setQuery] = useState('');
  const [marketTab, setMarketTab] = useState('all');
  const [profilePic, setProfilePic] = useState(null);

  const profileUri = useMemo(() => {
    if (profilePic) return profilePic;
    const fromUser = user?.profileImage || user?.profile_image || user?.avatarUrl;
    return fromUser && String(fromUser).trim() ? String(fromUser).trim() : null;
  }, [profilePic, user]);
  const [selectedListingId, setSelectedListingId] = useState(null);
  const clockTick = useAuctionClockTick(30000);

  const scrollY = useRef(new Animated.Value(0)).current;
  const contentParallax = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (marketplaceSyncVersion > 0) {
      void refresh();
    }
  }, [marketplaceSyncVersion, refresh]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          if (user?.id) {
            const pic = await AsyncStorage.getItem(`profilePic_${user?.id}`);
            if (!cancelled) setProfilePic(pic || null);
          } else if (!cancelled) setProfilePic(null);
        } catch (_) {
          if (!cancelled) setProfilePic(null);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [user?.id])
  );

  const auctionVisible = useMemo(() => {
    const base = listings.filter((i) => matchesSearch(i, query));
    return filterAuctionsForMarketTab(base, marketTab);
  }, [listings, query, marketTab, clockTick]);

  const isEndedTab = marketTab === 'historical';
  const showAuctionSection = marketTab !== 'buyNow';
  const showBuyNowSection = marketTab === 'all' || marketTab === 'buyNow';

  const standardVisible = useMemo(() => {
    if (!showBuyNowSection) return [];
    return listings
      .filter(isStandardListing)
      .filter((i) => matchesSearch(i, query))
      .sort((a, b) => getCreatedMs(b) - getCreatedMs(a));
  }, [listings, query, showBuyNowSection]);

  const openDetail = useCallback(
    (listing) => {
      const id = listing?.id != null ? String(listing.id) : null;
      if (id) {
        setSelectedListingId(id);
        setTimeout(() => setSelectedListingId(null), 1200);
      }
      navigation.navigate('ListingDetail', { listing });
    },
    [navigation]
  );

  const openChat = useCallback(
    (listing) => {
      navigation.navigate('ListingDetail', { listing, openChat: true });
    },
    [navigation]
  );

  const onScroll = Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
    useNativeDriver: true,
    listener: (e) => {
      contentParallax.setValue(e.nativeEvent.contentOffset.y * 0.02);
    },
  });

  const foregroundTranslate = contentParallax.interpolate({
    inputRange: [0, 48],
    outputRange: [0, -1],
    extrapolate: 'clamp',
  });

  const renderAuction = ({ item, index }) => {
    const id = item?.id != null ? String(item.id) : getListingRowKey(item, index);
    return (
      <FadeInUp delay={Math.min(index * 70, 420)} resetKey={`${marketTab}-${id}`}>
        <AuctionListingCard
          listing={item}
          recycleKey={getListingRowKey(item, index)}
          isSelected={selectedListingId === id}
          onPress={() => openDetail(item)}
          onPlaceBid={() => openDetail(item)}
        />
      </FadeInUp>
    );
  };

  const renderStandard = ({ item, index }) => (
    <FadeInUp delay={Math.min(index * 70, 420)} resetKey={`buy-${item?.id}`}>
      <StandardListingCard
        listing={item}
        recycleKey={getListingRowKey(item, index)}
        onPress={() => openDetail(item)}
        onChat={() => openChat(item)}
      />
    </FadeInUp>
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <GalleryWallpaper scrollY={scrollY}>
        <View style={styles.segmentHeader}>
          <HomeFloatingHeader
            navigation={navigation}
            profileUri={profileUri}
            notificationUnread={notificationUnread}
          />
        </View>

        <View style={styles.segmentSearch}>
          <HomeSearchBar value={query} onChangeText={setQuery} />
        </View>

        <HomeMarketplaceFilterBar activeTab={marketTab} onChange={setMarketTab} />

        <Animated.ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={HOME.charcoal} />
          }
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={onScroll}
        >
          <Animated.View style={{ transform: [{ translateY: foregroundTranslate }] }}>
            {error ? <Text style={styles.errorBanner}>{error}</Text> : null}

            {loading ? (
              <ActivityIndicator style={styles.loader} color={HOME.charcoal} />
            ) : (
              <TabContentShell tabKey={marketTab}>
                {showAuctionSection ? (
                  <View style={styles.segmentAuctions}>
                    <View style={styles.sectionHeader}>
                      <Text style={styles.sectionTitle}>
                        {isEndedTab ? 'Auctions ended' : 'Live auctions'}
                      </Text>
                      {isEndedTab ? (
                        <View style={styles.endedBadge}>
                          <Ionicons name="time-outline" size={12} color={HOME.charcoal} />
                          <Text style={styles.endedBadgeText}>Historical</Text>
                        </View>
                      ) : (
                        <View style={styles.liveBadge}>
                          <PulsingDot />
                          <Text style={styles.liveBadgeText}>Bidding open</Text>
                        </View>
                      )}
                    </View>

                    {auctionVisible.length === 0 ? (
                      <Text style={styles.empty}>
                        {isEndedTab
                          ? 'No ended auctions match your search.'
                          : marketTab === 'live'
                            ? 'No live auctions right now.'
                            : 'No lots match your search.'}
                      </Text>
                    ) : (
                      <FlatList
                        data={auctionVisible}
                        renderItem={renderAuction}
                        keyExtractor={(item, index) =>
                          `a-${marketTab}-${getListingRowKey(item, index)}`
                        }
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.hList}
                      />
                    )}
                  </View>
                ) : null}

                {showBuyNowSection ? (
                  <View style={[styles.segmentBuyNow, styles.buyNowSection]}>
                    <Text style={styles.sectionTitleStandalone}>Buy now</Text>
                    {standardVisible.length === 0 ? (
                      <Text style={styles.empty}>No pieces match your search.</Text>
                    ) : (
                      <FlatList
                        data={standardVisible}
                        renderItem={renderStandard}
                        keyExtractor={(item, index) => `s-${getListingRowKey(item, index)}`}
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.hList}
                      />
                    )}
                  </View>
                ) : null}
              </TabContentShell>
            )}
          </Animated.View>
        </Animated.ScrollView>
      </GalleryWallpaper>
    </SafeAreaView>
  );
};

const SEGMENT_SHADOW = Platform.select({
  ios: {
    shadowColor: HOME.black,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
  },
  android: { elevation: 3 },
});

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: HOME.pageBg },
  wallpaper: { flex: 1, backgroundColor: HOME.pageBg },
  wallpaperPattern: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  segmentHeader: {
    backgroundColor: HOME.headerGold,
    paddingBottom: 0,
    borderBottomWidth: 0,
  },
  segmentSearch: {
    alignItems: 'center',
    paddingTop: 12,
    paddingBottom: 4,
    backgroundColor: HOME.pageBg,
  },
  searchContainer: {
    width: '90%',
    backgroundColor: HOME.white,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: HOME.divider,
    paddingHorizontal: 14,
    paddingVertical: 12,
    ...Platform.select({
      ios: {
        shadowColor: HOME.black,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.07,
        shadowRadius: 8,
      },
      android: { elevation: 2 },
    }),
  },
  segmentAuctions: {
    marginTop: 20,
    paddingBottom: 8,
    backgroundColor: 'transparent',
  },
  segmentBuyNow: {
    marginTop: 20,
    paddingBottom: 8,
    backgroundColor: 'transparent',
  },
  scroll: { flex: 1, backgroundColor: HOME.pageBg },
  scrollContent: { paddingBottom: 64, paddingTop: 0 },
  searchPill: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 40,
    gap: 8,
    backgroundColor: HOME.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.9)',
    borderBottomColor: 'rgba(0, 0, 0, 0.06)',
    borderLeftColor: 'rgba(0, 0, 0, 0.04)',
    borderRightColor: 'rgba(0, 0, 0, 0.04)',
    paddingHorizontal: 12,
    ...Platform.select({
      ios: {
        shadowColor: HOME.black,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 2,
      },
      android: { elevation: 0 },
    }),
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: HOME.black,
    paddingVertical: 0,
    fontWeight: '500',
  },
  loader: { marginTop: 48, marginBottom: 32 },
  buyNowSection: {
    paddingTop: 4,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    marginBottom: spacing.lg,
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: HOME.black,
    letterSpacing: -0.4,
  },
  sectionTitleStandalone: {
    fontSize: 22,
    fontWeight: '800',
    color: HOME.black,
    letterSpacing: -0.4,
    paddingHorizontal: 20,
    marginBottom: spacing.lg,
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: HOME.white,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: HOME.divider,
  },
  endedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: HOME.surface,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: HOME.divider,
  },
  endedBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: HOME.charcoal,
  },
  liveDotWrap: {
    width: 10,
    height: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#EF4444',
  },
  liveBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: HOME.charcoal,
    letterSpacing: 0.2,
  },
  hList: {
    paddingLeft: 20,
    paddingRight: 16,
    paddingBottom: spacing.sm,
    gap: 20,
  },
  empty: {
    paddingHorizontal: 20,
    color: HOME.charcoal,
    fontSize: 14,
    marginBottom: spacing.lg,
    lineHeight: 22,
    fontStyle: 'italic',
  },
  errorBanner: {
    marginHorizontal: spacing.xl,
    marginBottom: spacing.sm,
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
  },
});

export default HomeScreen;
