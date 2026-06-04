import React, { useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Platform,
  Pressable,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { ListingCoverImage } from '../ListingCoverImage';
import useCountdown from '../../hooks/useCountdown';
import useResolveAuctionOnEnd from '../../hooks/useResolveAuctionOnEnd';
import { resolveListingCoverForDisplay } from '../../utils/listingMedia';
import { HOME } from '../../constants/homePalette';
import { listingCardShellStyles as shell, LISTING_CARD_SHELL } from './listingCardShellStyles';

function formatRs(n) {
  const x = Number(n);
  return Number.isFinite(x) ? `Rs. ${x.toLocaleString()}` : 'Rs. —';
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Actual listing title from API — never a generic placeholder when data exists. */
export function getListingDisplayTitle(listing) {
  for (const raw of [listing?.title, listing?.name]) {
    const t = raw != null ? String(raw).trim() : '';
    if (t && !['auction', 'listing', 'untitled'].includes(t.toLowerCase())) return t;
  }
  return 'Untitled lot';
}

export function getListingSellerLabel(listing) {
  const candidates = [
    listing?.sellerName,
    listing?.seller?.name,
    listing?.seller?.full_name,
    listing?.ownerName,
  ];
  for (const raw of candidates) {
    const s = raw != null ? String(raw).trim() : '';
    if (s) return s;
  }
  return null;
}

function PlaceBidButton({ isEnded, onPress }) {
  const scale = useRef(new Animated.Value(1)).current;
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (isEnded) return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.02, duration: 1400, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 1400, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [isEnded, pulse]);

  const bumpIn = () => {
    Animated.spring(scale, { toValue: 1.05, friction: 5, tension: 220, useNativeDriver: true }).start();
  };
  const bumpOut = () => {
    Animated.spring(scale, { toValue: 1, friction: 6, tension: 180, useNativeDriver: true }).start();
  };

  return (
    <Pressable
      onPress={onPress}
      onPressIn={bumpIn}
      onPressOut={bumpOut}
      disabled={!onPress}
      style={shell.primaryActionWrap}
    >
      <Animated.View style={{ transform: [{ scale: Animated.multiply(scale, pulse) }] }}>
        <LinearGradient
          colors={isEnded ? [HOME.charcoal, HOME.charcoal] : ['#1E293B', '#1E293B']}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={shell.primaryActionBtn}
        >
          <LinearGradient
            colors={['rgba(255,255,255,0.12)', 'transparent']}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={styles.bidBtnSheen}
            pointerEvents="none"
          />
          <Text style={shell.primaryActionText}>{isEnded ? 'View lot' : 'Place Bid'}</Text>
          {!isEnded ? (
            <Ionicons name="arrow-forward" size={16} color={HOME.white} />
          ) : null}
        </LinearGradient>
      </Animated.View>
    </Pressable>
  );
}

export default function AuctionListingCard({
  listing,
  onPress,
  onPlaceBid,
  recycleKey,
  isSelected = false,
  highlightPulse = false,
  layoutWidth,
}) {
  const cover = useMemo(() => resolveListingCoverForDisplay(listing), [listing]);
  const displayTitle = getListingDisplayTitle(listing);
  const sellerLabel = getListingSellerLabel(listing);
  const endTime = listing?.endTime || listing?.end_time || listing?.auction_end_time;
  const { days, hours, minutes, seconds, isEnded } = useCountdown(endTime);
  useResolveAuctionOnEnd(listing?.id, endTime, {
    skipIfResolved: !!listing?.auctionResolvedAt,
  });
  const currentBid = Number(listing?.currentBid ?? listing?.price ?? 0);

  const cardScale = useRef(new Animated.Value(1)).current;
  const liveDotScale = useRef(new Animated.Value(1)).current;

  const activeMotion = isSelected || highlightPulse;

  useEffect(() => {
    if (!activeMotion) {
      cardScale.setValue(1);
      return undefined;
    }
    const scaleLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(cardScale, { toValue: 1.02, duration: 600, useNativeDriver: true }),
        Animated.timing(cardScale, { toValue: 1, duration: 600, useNativeDriver: true }),
      ])
    );
    scaleLoop.start();
    return () => scaleLoop.stop();
  }, [activeMotion, cardScale]);

  useEffect(() => {
    if (isEnded) return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(liveDotScale, { toValue: 1.35, duration: 700, useNativeDriver: true }),
        Animated.timing(liveDotScale, { toValue: 1, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [isEnded, liveDotScale]);

  const timerLabel = isEnded
    ? 'Auction ended'
    : `${days}d ${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;

  const handleBid = (e) => {
    e?.stopPropagation?.();
    if (!isEnded && onPlaceBid) onPlaceBid(listing);
    else if (onPress) onPress();
  };

  return (
    <Animated.View
      style={[
        shell.cardOuter,
        layoutWidth != null ? { width: layoutWidth, marginRight: 0 } : null,
        {
          transform: [{ scale: cardScale }],
          borderColor: activeMotion ? HOME.black : LISTING_CARD_SHELL.border,
        },
      ]}
    >
      <TouchableOpacity style={shell.cardPressable} activeOpacity={0.96} onPress={onPress}>
        <View style={shell.imageFrame}>
          {cover ? (
            <ListingCoverImage uri={cover} style={shell.image} recycleKey={recycleKey} />
          ) : (
            <View style={shell.imagePlaceholder}>
              <Ionicons name="image-outline" size={40} color={HOME.charcoal} />
            </View>
          )}
          {!isEnded ? (
            <View style={styles.livePill}>
              <Animated.View style={[styles.liveDot, { transform: [{ scale: liveDotScale }] }]} />
              <Text style={styles.liveText}>LIVE</Text>
            </View>
          ) : (
            <View style={styles.endedPill}>
              <Text style={styles.endedText}>ENDED</Text>
            </View>
          )}
        </View>

        <View style={shell.metaBlock}>
          <Text style={shell.title} numberOfLines={2}>
            {displayTitle}
          </Text>
          {sellerLabel ? (
            <Text style={shell.seller} numberOfLines={1}>
              {sellerLabel}
            </Text>
          ) : null}
        </View>

        <View style={shell.actionPanel}>
          <View style={shell.priceBlock}>
            <Text style={shell.priceLabel}>Current bid</Text>
            <Text style={shell.price}>{formatRs(currentBid)}</Text>
          </View>

          <View style={styles.timerRow}>
            <Ionicons name="time-outline" size={15} color={HOME.charcoal} />
            <Text style={[styles.timer, isEnded && styles.timerEnded]}>{timerLabel}</Text>
          </View>

          <PlaceBidButton isEnded={isEnded} onPress={handleBid} />
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  livePill: {
    position: 'absolute',
    top: 10,
    left: 10,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    gap: 6,
    backgroundColor: 'rgba(0, 0, 0, 0.52)',
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#EF4444',
  },
  liveText: {
    color: HOME.white,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
  },
  endedPill: {
    position: 'absolute',
    top: 10,
    left: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    backgroundColor: 'rgba(102, 102, 102, 0.88)',
  },
  endedText: {
    color: HOME.white,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  timerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 2,
  },
  timer: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
    color: HOME.charcoal,
    fontVariant: ['tabular-nums'],
  },
  timerEnded: {
    fontStyle: 'italic',
  },
  bidBtnSheen: {
    ...StyleSheet.absoluteFillObject,
    height: '45%',
  },
});
