import React, { useState, useCallback, useMemo, useContext } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Platform,
  Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { AuthContext } from '../context/AuthContext';
import { fetchMyBidCardsForUser } from '../services/bidsService';
import { isSupabaseConfigured } from '../services/supabaseClient';
import { resolveListingCoverForDisplay } from '../utils/listingMedia';
import { getListingDisplayTitle } from '../components/listings/AuctionListingCard';
import { ListingCoverImage } from '../components/ListingCoverImage';
import useCountdown from '../hooks/useCountdown';
import { colors, spacing } from '../theme';
import MyAuctionsScreen from './MyAuctionsScreen';

const SCREEN_BG = '#F4F6F8';
const INDIGO = '#1E3A8A';
const DEEP_ROYAL_BLUE = '#0B3D91';
const SUCCESS = '#16A34A';
const MUTED = '#64748B';
const CARD_RADIUS = 16;

const SCREEN_MODES = [
  { key: 'bids', label: 'My Bids' },
  { key: 'auctions', label: 'My Listings' },
];

const TABS = [
  { key: 'active', label: 'Active' },
  { key: 'won', label: 'Won' },
  { key: 'lost', label: 'Lost' },
];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function fmtRs(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 'Rs. 0';
  return `Rs. ${x.toLocaleString()}`;
}

let bidStatusFieldWarned = false;

/** Maps existing bid card data to won | lost | active without changing fetch logic. */
function resolveBidVisualStatus(item, bucketKey) {
  const raw = item?.status;
  if (raw != null && String(raw).trim() !== '') {
    const s = String(raw).toLowerCase();
    if (s === 'won' || s === 'lost' || s === 'active') return s;
  }
  if (bucketKey === 'won' || bucketKey === 'lost' || bucketKey === 'active') {
    if ((raw == null || String(raw).trim() === '') && !bidStatusFieldWarned) {
      bidStatusFieldWarned = true;
      console.warn('[MyBids] bid card missing `status`; using tab bucket for UI styling.');
    }
    return bucketKey;
  }
  const label = String(item?.statusLabel || '').toLowerCase();
  if (label.includes('won')) return 'won';
  if (label === 'ended' || label.includes('outbid')) return 'lost';
  return 'active';
}

const STATUS_CHIP = {
  leading: { backgroundColor: '#DCFCE7' },
  outbid: { backgroundColor: '#FEE2E2' },
  won: { backgroundColor: 'rgba(52, 211, 153, 0.2)' },
  lost: { backgroundColor: '#E2E8F0' },
};

function statusChipStyleFor(visualStatus, statusLabel) {
  if (visualStatus === 'won') return STATUS_CHIP.won;
  if (visualStatus === 'lost') return STATUS_CHIP.lost;
  const t = String(statusLabel || '').toLowerCase();
  if (t.includes('highest')) return STATUS_CHIP.leading;
  return STATUS_CHIP.outbid;
}

/** Listing id from bid card payload (API uses listingId / listing_id on row). */
function resolveBidListingId(item) {
  if (!item || typeof item !== 'object') return '';
  const direct =
    item.listing_id ?? item.listingId ?? item.listing?.id ?? item.listingRow?.listing_id;
  if (direct != null && String(direct).trim() !== '') return String(direct).trim();
  if (item.listing?.id != null && String(item.listing.id).trim() !== '') {
    return String(item.listing.id).trim();
  }
  if (item.listingRow?.listing_id != null && String(item.listingRow.listing_id).trim() !== '') {
    return String(item.listingRow.listing_id).trim();
  }
  if (item.listingRow?.id != null && String(item.listingRow.id).trim() !== '') {
    return String(item.listingRow.id).trim();
  }
  return '';
}

function getBidRowKey(item) {
  if (item?.id != null && String(item.id).trim() !== '') return String(item.id);
  const listingId = resolveBidListingId(item);
  if (listingId) return `bid-${listingId}`;
  return 'bid-row';
}

function BidCard({ item, bucketKey, onOpenListing, onPlaceBid }) {
  const visualStatus = resolveBidVisualStatus(item, bucketKey);
  const listing = item?.listing;
  const listingRow = item?.listingRow;
  const cover = resolveListingCoverForDisplay(listing || listingRow);
  const title =
    getListingDisplayTitle(listing) ||
    (listingRow?.title ? String(listingRow.title).trim() : 'Untitled lot');
  const myBid = Number(item?.myBidAmount) || 0;
  const statusLabel = item?.statusLabel || 'Outbid';
  const endTime =
    listing?.endTime ||
    listing?.end_time ||
    listing?.auction_end_time ||
    listingRow?.auction_end_time ||
    listingRow?.end_time;
  const { days, hours, minutes, seconds, isEnded } = useCountdown(
    visualStatus === 'active' ? endTime : ''
  );

  const isWon = visualStatus === 'won';
  const isLost = visualStatus === 'lost';
  const isActive = visualStatus === 'active';
  const showPlaceBid = isActive && !isEnded;
  const chipLabel = isLost ? 'Bid Ended' : isWon ? 'Won' : statusLabel;
  const timerLabel = isEnded
    ? 'Auction ended'
    : `${days}d ${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;

  return (
    <Pressable
      style={({ pressed }) => [
        styles.orderStyleCard,
        isWon && styles.cardWon,
        isLost && styles.cardLost,
        pressed && !isLost && styles.cardPressed,
      ]}
      onPress={onOpenListing}
    >
      <View style={styles.cardTopRow}>
        {cover ? (
          <ListingCoverImage
            uri={cover}
            style={[styles.thumb, isLost && styles.thumbMuted]}
            recycleKey={getBidRowKey(item)}
          />
        ) : (
          <View style={[styles.thumb, styles.thumbPlaceholder, isLost && styles.thumbMuted]}>
            <Ionicons name="image-outline" size={28} color={MUTED} />
          </View>
        )}
        <View style={styles.cardHeadText}>
          <Text
            style={[styles.cardTitle, isLost && styles.cardTitleMuted]}
            numberOfLines={2}
          >
            {title}
          </Text>
          <View style={styles.badgeRow}>
            <View style={[styles.statusChip, statusChipStyleFor(visualStatus, statusLabel)]}>
              <Text
                style={[
                  styles.statusChipText,
                  isLost && styles.statusChipTextLost,
                  isWon && styles.statusChipTextWon,
                ]}
              >
                {chipLabel}
              </Text>
            </View>
          </View>
          <Text style={[styles.bidLine, isLost && styles.bidLineMuted]}>
            Your bid: {fmtRs(myBid)}
          </Text>
          {isActive ? (
            <View style={styles.timerRow}>
              {!isEnded ? <View style={styles.liveDot} /> : null}
              <Ionicons
                name={isEnded ? 'time-outline' : 'hourglass-outline'}
                size={14}
                color={isEnded ? MUTED : INDIGO}
              />
              <Text style={[styles.timerText, isEnded && styles.timerTextEnded]}>{timerLabel}</Text>
            </View>
          ) : null}
        </View>
      </View>

      {isWon ? (
        <View style={styles.wonBanner}>
          <Ionicons name="checkmark-circle" size={20} color={SUCCESS} />
          <Text style={styles.wonBannerText}>
            Auction won · Your winning bid {fmtRs(myBid)}
          </Text>
        </View>
      ) : null}

      {isLost ? (
        <View style={styles.endedFooter}>
          <Text style={styles.endedFooterText}>Bid Ended</Text>
        </View>
      ) : null}

      {showPlaceBid ? (
        <Pressable
          style={({ pressed }) => [styles.placeBidBtn, pressed && styles.placeBidBtnPressed]}
          onPress={(e) => {
            e?.stopPropagation?.();
            onPlaceBid?.();
          }}
          accessibilityRole="button"
          accessibilityLabel="Place bid on this auction"
        >
          <Text style={styles.placeBidBtnText}>Place Bid</Text>
          <Ionicons name="arrow-forward" size={16} color="#FFFFFF" />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

function MyBidsBlueHeader() {
  return (
    <View style={styles.blueHeader}>
      <SafeAreaView edges={['top']}>
        <View style={styles.blueHeaderBar}>
          <Text style={styles.blueHeaderTitle}>MY BIDS</Text>
        </View>
      </SafeAreaView>
    </View>
  );
}

function BidsEmptyState({ title, subtitle, showBrowse, onBrowse }) {
  return (
    <View style={styles.emptyCard}>
      <View style={styles.emptyIconWrap}>
        <Ionicons name="hammer-outline" size={32} color={INDIGO} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptySub}>{subtitle}</Text>
      {showBrowse ? (
        <TouchableOpacity
          style={styles.browseBtn}
          onPress={onBrowse}
          activeOpacity={0.9}
          accessibilityRole="button"
          accessibilityLabel="View live auctions"
        >
          <Text style={styles.browseBtnText}>View Live Auctions</Text>
          <Ionicons name="arrow-forward" size={18} color="#FFFFFF" />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const MyBidsScreen = () => {
  const navigation = useNavigation();
  const { user } = useContext(AuthContext);
  const [buckets, setBuckets] = useState({ active: [], won: [], lost: [] });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  const [screenMode, setScreenMode] = useState('bids');
  const [activeTab, setActiveTab] = useState('active');

  const fetchBids = useCallback(
    async (mode = 'normal') => {
      if (!user?.id) {
        setBuckets({ active: [], won: [], lost: [] });
        setLoading(false);
        setRefreshing(false);
        return;
      }
      if (!isSupabaseConfigured()) {
        setFetchError('Sign in with Supabase to view your bids.');
        setBuckets({ active: [], won: [], lost: [] });
        setLoading(false);
        setRefreshing(false);
        return;
      }

      if (mode === 'pull') setRefreshing(true);
      else setLoading(true);
      setFetchError(null);

      try {
        const data = await fetchMyBidCardsForUser(user?.id);
        setBuckets(data || { active: [], won: [], lost: [] });
      } catch (e) {
        setFetchError(e?.message || 'Could not load your bids.');
        setBuckets({ active: [], won: [], lost: [] });
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [user?.id]
  );

  useFocusEffect(
    useCallback(() => {
      fetchBids('normal');
    }, [fetchBids])
  );

  const counts = useMemo(
    () => ({
      active: buckets.active?.length ?? 0,
      won: buckets.won?.length ?? 0,
      lost: buckets.lost?.length ?? 0,
    }),
    [buckets]
  );

  const visible = buckets[activeTab] || [];

  const emptyTitle = useMemo(() => {
    if (fetchError) return 'Could not load bids';
    if (activeTab === 'active') return 'No live bids active';
    if (activeTab === 'won') return 'No auctions won yet';
    return 'No lost auctions';
  }, [fetchError, activeTab]);

  const emptySubtitle = useMemo(() => {
    if (fetchError) return fetchError;
    if (activeTab === 'active') {
      return 'Browse live auctions and place a bid to track your activity here.';
    }
    if (activeTab === 'won') return 'Winning auctions appear in this tab.';
    return 'Lost auctions appear in this tab.';
  }, [fetchError, activeTab]);

  const showBrowseCta = !fetchError && activeTab === 'active';

  const goToLiveAuctions = useCallback(() => {
    navigation.navigate('Home');
  }, [navigation]);

  const openListing = useCallback(
    (bidItem) => {
      if (!bidItem) return;
      const listing = bidItem.listing;
      const listingId = resolveBidListingId(bidItem);
      if (listing) {
        navigation.navigate('ListingDetail', {
          listing,
          listingId: listingId || undefined,
        });
        return;
      }
      if (listingId) {
        navigation.navigate('ListingDetail', { listingId });
      }
    },
    [navigation]
  );

  const renderItem = useCallback(
    ({ item }) => (
      <BidCard
        item={item}
        bucketKey={activeTab}
        onOpenListing={() => openListing(item)}
        onPlaceBid={() => openListing(item)}
      />
    ),
    [activeTab, openListing]
  );

  const modeBar = (
    <View style={styles.modeBar}>
      {SCREEN_MODES.map((m) => {
        const active = screenMode === m.key;
        return (
          <Pressable
            key={m.key}
            style={[styles.modeTab, active && styles.modeTabActive]}
            onPress={() => setScreenMode(m.key)}
          >
            <Text style={[styles.modeTabText, active && styles.modeTabTextActive]}>{m.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );

  if (screenMode === 'auctions') {
    return (
      <View style={styles.screenRoot}>
        <MyBidsBlueHeader />
        <SafeAreaView style={styles.safe} edges={['bottom']}>
          <View style={styles.content}>{modeBar}</View>
          <MyAuctionsScreen embedded />
        </SafeAreaView>
      </View>
    );
  }

  return (
    <View style={styles.screenRoot}>
      <MyBidsBlueHeader />
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <View style={styles.content}>
          {modeBar}

          <TouchableOpacity
            style={styles.ordersCtaWrap}
            onPress={() => navigation.navigate('MyOrders')}
            activeOpacity={0.9}
            accessibilityRole="button"
            accessibilityLabel="Open My Orders"
          >
            <LinearGradient
              colors={['#1E3A8A', '#4338CA']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.ordersCta}
            >
              <View style={styles.ordersCtaIcon}>
                <Ionicons name="cube-outline" size={22} color="#FFFFFF" />
              </View>
              <View style={styles.ordersCtaText}>
                <Text style={styles.ordersCtaTitle}>My Orders</Text>
                <Text style={styles.ordersCtaSub}>
                  {activeTab === 'won'
                    ? 'Won an auction? Show your OTP or track delivery here.'
                    : 'Delivery OTP, escrow, and seller payouts'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.9)" />
            </LinearGradient>
          </TouchableOpacity>

          <View style={styles.tabBar}>
            {TABS.map((t) => {
              const active = activeTab === t.key;
              return (
                <Pressable
                  key={t.key}
                  style={[styles.tab, active && styles.tabActive]}
                  onPress={() => setActiveTab(t.key)}
                >
                  <Text style={[styles.tabText, active && styles.tabTextActive]}>
                    {t.label} ({counts[t.key]})
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {loading ? (
          <ActivityIndicator style={styles.loader} color={INDIGO} />
        ) : (
          <FlatList
            data={visible}
            keyExtractor={(item) => getBidRowKey(item)}
            renderItem={renderItem}
            contentContainerStyle={styles.list}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => fetchBids('pull')}
                tintColor={INDIGO}
              />
            }
            ListEmptyComponent={
              <BidsEmptyState
                title={emptyTitle}
                subtitle={emptySubtitle}
                showBrowse={showBrowseCta}
                onBrowse={goToLiveAuctions}
              />
            }
          />
        )}
      </SafeAreaView>
    </View>
  );
};

const cardShadow = Platform.select({
  ios: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
  },
  android: { elevation: 2 },
});

const styles = StyleSheet.create({
  screenRoot: {
    flex: 1,
    backgroundColor: SCREEN_BG,
  },
  blueHeader: {
    width: '100%',
    backgroundColor: DEEP_ROYAL_BLUE,
  },
  blueHeaderBar: {
    paddingVertical: 20,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  blueHeaderTitle: {
    fontSize: 19,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 1.6,
    textAlign: 'center',
  },
  safe: { flex: 1, backgroundColor: SCREEN_BG },
  content: {
    paddingHorizontal: spacing.xl,
    paddingTop: 20,
  },
  modeBar: {
    flexDirection: 'row',
    marginBottom: 20,
    gap: 8,
  },
  modeTab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  modeTabActive: {
    backgroundColor: INDIGO,
    borderColor: INDIGO,
  },
  modeTabText: { fontSize: 13, fontWeight: '700', color: '#64748B' },
  modeTabTextActive: { color: '#FFFFFF' },
  ordersCtaWrap: {
    marginBottom: 20,
  },
  ordersCta: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 16,
    padding: spacing.md,
    gap: spacing.md,
  },
  ordersCtaIcon: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ordersCtaText: { flex: 1 },
  ordersCtaTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  ordersCtaSub: {
    fontSize: 12,
    fontWeight: '500',
    color: 'rgba(255,255,255,0.88)',
    marginTop: 3,
    lineHeight: 16,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 4,
    marginBottom: 20,
    ...cardShadow,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 12,
  },
  tabActive: {
    backgroundColor: SCREEN_BG,
  },
  tabText: { fontSize: 12, fontWeight: '600', color: '#64748B' },
  tabTextActive: { color: INDIGO, fontWeight: '700' },
  loader: { marginTop: 48 },
  list: {
    paddingHorizontal: spacing.md,
    paddingBottom: 48,
    flexGrow: 1,
  },
  orderStyleCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: CARD_RADIUS,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: '#E8ECF0',
    ...cardShadow,
  },
  cardPressed: { opacity: 0.96 },
  cardWon: {
    borderColor: '#BBF7D0',
    backgroundColor: '#FAFFFE',
  },
  cardLost: {
    backgroundColor: '#F8FAFC',
    borderColor: '#E2E8F0',
    opacity: 0.92,
  },
  cardTopRow: { flexDirection: 'row', gap: spacing.md },
  thumb: {
    width: 72,
    height: 72,
    borderRadius: 12,
    backgroundColor: '#EDE9E3',
  },
  thumbMuted: { opacity: 0.55 },
  thumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  cardHeadText: { flex: 1, minWidth: 0 },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: 6,
    lineHeight: 20,
  },
  cardTitleMuted: { color: '#94A3B8' },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  statusChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: '#F1F5F9',
  },
  statusChipLeading: { backgroundColor: '#DCFCE7' },
  statusChipOutbid: { backgroundColor: '#FEE2E2' },
  statusChipWon: { backgroundColor: 'rgba(52, 211, 153, 0.2)' },
  statusChipLost: { backgroundColor: '#E2E8F0' },
  statusChipText: { fontSize: 11, fontWeight: '600', color: '#334155' },
  statusChipTextWon: { color: SUCCESS, fontWeight: '700' },
  statusChipTextLost: { color: '#64748B', fontWeight: '600' },
  bidLine: { fontSize: 14, fontWeight: '700', color: INDIGO },
  bidLineMuted: { color: '#94A3B8', fontWeight: '600' },
  timerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#EF4444',
  },
  timerText: { fontSize: 12, fontWeight: '700', color: INDIGO, fontVariant: ['tabular-nums'] },
  timerTextEnded: { color: MUTED, fontWeight: '600' },
  wonBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E2E8F0',
  },
  wonBannerText: { fontSize: 13, color: SUCCESS, fontWeight: '600', flex: 1 },
  endedFooter: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E2E8F0',
    alignItems: 'center',
  },
  endedFooterText: {
    fontSize: 13,
    fontWeight: '700',
    color: MUTED,
    letterSpacing: 0.3,
  },
  placeBidBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: spacing.md,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: DEEP_ROYAL_BLUE,
  },
  placeBidBtnPressed: { opacity: 0.9 },
  placeBidBtnText: { fontSize: 15, fontWeight: '800', color: '#FFFFFF' },
  emptyCard: {
    marginTop: 24,
    marginHorizontal: 4,
    paddingVertical: 32,
    paddingHorizontal: 24,
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    alignItems: 'center',
    ...cardShadow,
  },
  emptyIconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#E8EEF7',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#000000',
    textAlign: 'center',
    marginBottom: 10,
  },
  emptySub: {
    fontSize: 14,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
    paddingHorizontal: 8,
  },
  browseBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: DEEP_ROYAL_BLUE,
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 16,
    minWidth: '88%',
    ...Platform.select({
      ios: {
        shadowColor: DEEP_ROYAL_BLUE,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.25,
        shadowRadius: 8,
      },
      android: { elevation: 4 },
    }),
  },
  browseBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
});

export default MyBidsScreen;
