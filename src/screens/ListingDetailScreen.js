import React, { useState, useContext, useMemo, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  ScrollView,
  TouchableOpacity,
  Pressable,
  TextInput,
  Modal,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import useCountdown from '../hooks/useCountdown';
import { placeBidAPI, getListingDetailsAPI } from '../api/listings';
import { AuthContext } from '../context/AuthContext';
import {
  normalizeListing,
  getListingModerationStatus,
  resolveMediaUrl,
  isAuctionListing,
  isStandardListing,
} from '../utils/listingMedia';
import { calculateBidToken } from '../utils/bidToken';
import { getBidTokenStatusAPI, payBidTokenAPI } from '../api/wallet';
import { fetchProfileWallet } from '../services/profileWalletService';
import { computeAuctionEndIso } from '../constants/auctionDuration';
import { MIN_WALLET_BALANCE_TO_BID_PKR } from '../constants/walletRules';
import { evaluateBidWalletGateWithHold } from '../services/walletService';
import { getBidSecurityFeePkr } from '../constants/bidSecurityFee';
import { runEscrowOtpTriggerPipeline } from '../services/transactionPipeline';
import { subscribeOTPListener } from '../services/otpListener';
import { isSupabaseConfigured } from '../services/supabaseClient';
import { fetchBidsForListing } from '../services/bidsService';
import { fetchSellerPublicProfile } from '../services/sellerProfileService';
import PostedBySellerCard from '../components/PostedBySellerCard';
import { useMarketplaceSyncVersion } from '../context/ListingsSyncContext';
import useResolveAuctionOnEnd from '../hooks/useResolveAuctionOnEnd';
import { useWallet } from '../context/WalletContext';
import { isKycVerified, showKycBidBlockedAlert } from '../utils/kycVerification';
import BidConfirmModal from '../components/BidConfirmModal';
import RelatedAds from '../components/RelatedAds';

/** Countdown target for auctions: prefer server/mock endTime; else duration + createdAt. */
function resolveAuctionEndTime(listing) {
  if (!listing || listing.type !== 'auction') return '';
  if (listing.endTime) {
    const t = new Date(listing.endTime);
    if (!Number.isNaN(t.getTime())) return listing.endTime;
  }
  let base = listing.createdAt ? new Date(listing.createdAt) : null;
  if (!base || Number.isNaN(base.getTime())) base = new Date();
  return computeAuctionEndIso(listing.duration ?? '3', base.getTime());
}

const DEFAULT_LISTING_RAW = {
  id: '1',
  title: 'Vintage Rolex Submariner',
  description: 'A beautiful vintage Rolex from 1980 in pristine condition. Includes original box and papers.',
  price: 1000000,
  currentBid: 1450000,
  highestBidder: 'Ali Khan',
  buyNowPrice: 1500000,
  image: 'https://images.unsplash.com/photo-1523170335258-f5ed11844a49?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80',
  endTime: new Date(Date.now() + 1000 * 60 * 60 * 24 * 2).toISOString(),
  type: 'auction',
};

const ListingDetailScreen = ({ route, navigation }) => {
  // We use state for the listing so we can update the currentBid when a new bid is placed
  const [listing, setListing] = useState(() =>
    normalizeListing(route.params?.listing || DEFAULT_LISTING_RAW)
  );
  const [sellerSummary, setSellerSummary] = useState(
    () => route.params?.listing?.sellerSummary || null
  );
  const [sellerLoading, setSellerLoading] = useState(false);
  const [imageIndex, setImageIndex] = useState(0);
  const marketplaceSyncVersion = useMarketplaceSyncVersion();

  const galleryUrls = useMemo(() => {
    const raw = Array.isArray(listing.images) && listing.images.length > 0
      ? listing.images
      : listing.image
        ? [listing.image]
        : [];
    const seen = new Set();
    const out = [];
    for (const u of raw) {
      const r = resolveMediaUrl(u);
      if (r && !seen.has(r)) {
        seen.add(r);
        out.push(r);
      }
    }
    return out;
  }, [listing.images, listing.image]);

  // Warm the image cache so swiping forward/back stays sharp.
  useEffect(() => {
    if (!Array.isArray(galleryUrls) || galleryUrls.length === 0) return;
    for (const u of galleryUrls) {
      if (typeof u === 'string' && /^https?:\/\//i.test(u)) {
        try { Image.prefetch(u); } catch (_) { /* native picky; ignore */ }
      }
    }
  }, [galleryUrls]);

  useEffect(() => {
    setImageIndex(0);
  }, [listing.id]);

  const activeUri = galleryUrls[imageIndex] ?? null;
  const [galleryUriFailed, setGalleryUriFailed] = useState(false);
  const [galleryRetry, setGalleryRetry] = useState(0);
  const galleryRetriedRef = useRef(false);

  useEffect(() => {
    setGalleryUriFailed(false);
    setGalleryRetry(0);
    galleryRetriedRef.current = false;
  }, [activeUri]);

  const activeUriSrc = useMemo(() => {
    if (!activeUri) return null;
    if (galleryRetry > 0) {
      return activeUri + (activeUri.includes('?') ? '&' : '?') + `_r=${galleryRetry}`;
    }
    return activeUri;
  }, [activeUri, galleryRetry]);

  const handleGalleryError = () => {
    if (!galleryRetriedRef.current) {
      galleryRetriedRef.current = true;
      setGalleryRetry(Date.now());
      return;
    }
    setGalleryUriFailed(true);
  };

  const goImgPrev = () => setImageIndex((i) => Math.max(0, i - 1));
  const goImgNext = () =>
    setImageIndex((i) => Math.min(Math.max(0, galleryUrls.length - 1), i + 1));

  const [bidAmount, setBidAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [bidConfirmVisible, setBidConfirmVisible] = useState(false);
  const [modalTitle, setModalTitle] = useState('');
  const [modalMessage, setModalMessage] = useState('');
  const [modalType, setModalType] = useState('error'); // 'error' or 'success'
  /** Optional second action (e.g. Open wallet after Top-up Required). */
  const [modalExtraAction, setModalExtraAction] = useState(null);
  const tokenAmountForListing = useMemo(
    () => (listing.type === 'auction' ? calculateBidToken(listing.price) : 0),
    [listing.type, listing.price]
  );
  const [tokenPaid, setTokenPaid] = useState(false);
  const [liveWalletBalance, setLiveWalletBalance] = useState(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const [tokenChecking, setTokenChecking] = useState(false);
  const [payingToken, setPayingToken] = useState(false);
  const auctionEndIso = useMemo(() => resolveAuctionEndTime(listing), [
    listing.type,
    listing.endTime,
    listing.duration,
    listing.createdAt,
  ]);
  const { days, hours, minutes, seconds, isEnded } = useCountdown(
    listing.type === 'auction' ? auctionEndIso : ''
  );
  const { user, refreshProfile } = useContext(AuthContext);
  const { refresh: refreshWallet } = useWallet();

  const [bidHistory, setBidHistory] = useState([]);
  const [loadingBids, setLoadingBids] = useState(false);

  const reloadLiveWallet = useCallback(async () => {
    if (!user?.id || !isSupabaseConfigured()) {
      setLiveWalletBalance(0);
      return 0;
    }
    setWalletLoading(true);
    try {
      const pw = await fetchProfileWallet(user.id);
      setLiveWalletBalance(pw.walletBalance);
      return pw.walletBalance;
    } catch (e) {
      if (__DEV__) console.warn('[ListingDetail] wallet fetch', e?.message || e);
      setLiveWalletBalance(0);
      return 0;
    } finally {
      setWalletLoading(false);
    }
  }, [user?.id]);

  useFocusEffect(
    useCallback(() => {
      void reloadLiveWallet();
      if (typeof refreshWallet === 'function') void refreshWallet();
    }, [reloadLiveWallet, refreshWallet])
  );

  const spendableWalletBalance = liveWalletBalance;

  const reloadBidHistory = useCallback(async () => {
    if (!isSupabaseConfigured() || !listing?.id || !isAuctionListing(listing)) {
      setBidHistory([]);
      return;
    }
    setLoadingBids(true);
    try {
      const rows = await fetchBidsForListing(listing.id);
      setBidHistory(Array.isArray(rows) ? rows : []);
    } catch (e) {
      if (__DEV__) console.warn('[ListingDetail] bids load', e?.message || e);
      setBidHistory([]);
    } finally {
      setLoadingBids(false);
    }
  }, [listing]);

  useEffect(() => {
    void reloadBidHistory();
  }, [reloadBidHistory]);

  const parsedBidAmount = useMemo(() => {
    const n = parseInt(String(bidAmount || '').replace(/\D/g, ''), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [bidAmount]);

  const moderation = listing.moderationStatus || getListingModerationStatus(listing);
  const tradingOpen = moderation === 'approved';
  const auctionMode = isAuctionListing(listing);
  const standardMode = isStandardListing(listing);

  const reloadListingFromServer = useCallback(async () => {
    if (!listing?.id) return null;
    try {
      const fresh = await getListingDetailsAPI(listing.id);
      if (fresh?.id) {
        setListing(normalizeListing(fresh));
        if (fresh.sellerSummary) setSellerSummary(fresh.sellerSummary);
        return fresh;
      }
      return null;
    } catch (e) {
      if (__DEV__) console.warn('[ListingDetail] listing refresh', e?.message || e);
      return null;
    }
  }, [listing?.id]);

  const loadSellerSummary = useCallback(async () => {
    const sellerId = listing?.sellerId;
    if (!sellerId) {
      setSellerSummary(null);
      return;
    }
    if (listing?.sellerSummary?.id && String(listing.sellerSummary.id) === String(sellerId)) {
      setSellerSummary(listing.sellerSummary);
      return;
    }
    setSellerLoading(true);
    try {
      const summary = await fetchSellerPublicProfile(sellerId);
      setSellerSummary(summary);
    } catch (e) {
      if (__DEV__) console.warn('[ListingDetail] seller summary', e?.message || e);
    } finally {
      setSellerLoading(false);
    }
  }, [listing?.sellerId, listing?.sellerSummary]);

  useEffect(() => {
    void loadSellerSummary();
  }, [loadSellerSummary]);

  useEffect(() => {
    if (marketplaceSyncVersion <= 0) return;
    void (async () => {
      const fresh = await reloadListingFromServer();
      if (!fresh?.id) {
        if (navigation.canGoBack()) navigation.goBack();
        return;
      }
      const sellerId = fresh.sellerId ?? listing?.sellerId;
      if (!sellerId) return;
      setSellerLoading(true);
      try {
        const summary = await fetchSellerPublicProfile(String(sellerId));
        setSellerSummary(summary);
      } catch (e) {
        if (__DEV__) console.warn('[ListingDetail] seller sync', e?.message || e);
      } finally {
        setSellerLoading(false);
      }
    })();
  }, [marketplaceSyncVersion, reloadListingFromServer, listing?.sellerId, navigation]);

  const openSellerProfile = useCallback(() => {
    const sellerId = listing?.sellerId;
    if (!sellerId) return;
    navigation.navigate('PublicProfileView', {
      userId: sellerId,
      sellerId,
      sellerName: sellerSummary?.displayName || 'Seller',
    });
  }, [navigation, listing?.sellerId, sellerSummary?.displayName]);

  const handleAuctionResolved = useCallback(
    async (result) => {
      await Promise.all([
        reloadListingFromServer(),
        reloadBidHistory(),
        typeof refreshWallet === 'function' ? refreshWallet().catch(() => {}) : Promise.resolve(),
        typeof refreshProfile === 'function' ? refreshProfile().catch(() => {}) : Promise.resolve(),
      ]);
      const uid = user?.id ?? user?.uid;
      const winnerId =
        result?.winner_bidder_id != null ? String(result.winner_bidder_id) : null;
      if (uid && winnerId && uid === winnerId && (result?.order_id || result?.order_status)) {
        setModalTitle('You won!');
        setModalMessage(
          'Your order is ready. Open My Orders from Profile to complete delivery with the seller.'
        );
        setModalType('success');
        setModalVisible(true);
      }
    },
    [reloadListingFromServer, reloadBidHistory, refreshWallet, refreshProfile, user?.id, user?.uid]
  );

  useResolveAuctionOnEnd(listing?.id, auctionEndIso, {
    enabled: auctionMode && isSupabaseConfigured(),
    skipIfResolved: !!listing.auctionResolvedAt,
    auctionResolvedAt: listing.auctionResolvedAt,
    onResolved: (result) => {
      void handleAuctionResolved(result);
    },
  });

  useEffect(() => {
    if (!user?.id || !listing?.id || !auctionMode || !isSupabaseConfigured()) return undefined;
    return subscribeOTPListener({
      userId: user.id,
      listingId: String(listing.id),
      onHoldConfirmed: () => {
        void reloadLiveWallet();
        if (typeof refreshWallet === 'function') void refreshWallet();
      },
    });
  }, [user?.id, listing?.id, auctionMode, reloadLiveWallet, refreshWallet]);

  // Only auction listings expose an automated-payment Buy-It-Now button. Standard
  // listings use "Chat with Seller" exclusively (per product requirement).
  const buyNowAmount = useMemo(() => {
    if (!auctionMode) return null;
    const raw = listing.buyNowPrice;
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [auctionMode, listing.buyNowPrice]);

  const standardPriceAmount = useMemo(() => {
    if (!standardMode) return null;
    const raw = listing.price ?? listing.buyNowPrice;
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [standardMode, listing.price, listing.buyNowPrice]);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      if (listing.type !== 'auction' || tokenAmountForListing <= 0 || !user || !tradingOpen) {
        return;
      }
      setTokenChecking(true);
      try {
        const status = await getBidTokenStatusAPI(listing.id, {
          startingPrice: listing.price,
        });
        if (cancelled) return;
        setTokenPaid(!!status.paid);
      } catch (_) {
        /* ignore — gate stays closed; user will see error if they try to bid */
      } finally {
        if (!cancelled) setTokenChecking(false);
      }
    }
    check();
    return () => {
      cancelled = true;
    };
  }, [listing.id, listing.type, tokenAmountForListing, tradingOpen, user]);

  const handlePayBidToken = async () => {
    if (!user) {
      showModal('Sign in needed', 'Please sign in to pay the bid token.');
      return;
    }
    if (tokenAmountForListing <= 0) {
      setTokenPaid(true);
      return;
    }
    setPayingToken(true);
    try {
      const r = await payBidTokenAPI(listing.id, { startingPrice: listing.price });
      setTokenPaid(true);
      await reloadLiveWallet();
      showModal(
        'Token reserved',
        `Rs. ${tokenAmountForListing.toLocaleString()} held from your wallet. You can place bids now. If you don't win, it goes back to your wallet.`,
        'success'
      );
    } catch (err) {
      showModal('Could not pay token', err?.message || 'Try again or top up your wallet.');
    } finally {
      setPayingToken(false);
    }
  };

  const showModal = (title, message, type = 'error', extraAction = null) => {
    setModalTitle(title);
    setModalMessage(message);
    setModalType(type);
    setModalExtraAction(extraAction);
    setModalVisible(true);
  };

  const closeModal = () => {
    setModalVisible(false);
    setModalExtraAction(null);
  };

  const handlePlaceBid = () => {
    if (!tradingOpen) {
      showModal(
        'Not live yet',
        moderation === 'rejected'
          ? 'This listing was not approved. You cannot place bids on it.'
          : 'This listing is still waiting for admin approval. Bidding opens once it is approved.'
      );
      return;
    }
    const trimmed = bidAmount.trim();
    if (!trimmed) {
      showModal('Bid required', 'Enter how much you want to bid in rupees (numbers only).');
      return;
    }

    const amount = parseInt(trimmed, 10);
    if (!Number.isFinite(amount) || amount <= 0) {
      showModal('Invalid amount', 'Use digits only for your bid (e.g. 15000).');
      return;
    }

    if (amount % 100 !== 0) {
      showModal('Invalid Bid', 'Bid amount must be a multiple of 100 (e.g. 100, 500, 1000). Values like 699 are not allowed.');
      return;
    }

    const minimumRequiredBid = listing.currentBid || listing.price;
    if (amount <= minimumRequiredBid) {
      showModal('Bid too low', `Your bid must be strictly higher than Rs. ${minimumRequiredBid.toLocaleString()}`);
      return;
    }

    if (tokenAmountForListing > 0 && !tokenPaid) {
      showModal(
        'Pay the bid token first',
        `This listing requires a Rs. ${tokenAmountForListing.toLocaleString()} refundable token before you can bid. Tap "Pay token" to reserve it.`
      );
      return;
    }

    setBidConfirmVisible(true);
  };

  const executePlaceBid = async () => {
    setBidConfirmVisible(false);
    const trimmed = bidAmount.trim();
    const amount = parseInt(trimmed, 10);

    const liveBal = await reloadLiveWallet();
    const gate = evaluateBidWalletGateWithHold(liveBal, amount, getBidSecurityFeePkr(amount));
    if (!gate.ok && gate.topUpRequired) {
      showModal(
        'Top-up required',
        gate.message ||
          `You need at least Rs. ${MIN_WALLET_BALANCE_TO_BID_PKR.toLocaleString()} in your wallet to place bids (current: Rs. ${Number(
            gate.balance ?? 0
          ).toLocaleString()}). Add funds, then try again.`,
        'error',
        {
          label: 'Open wallet',
          onPress: () => {
            closeModal();
            navigation.navigate('Wallet');
          },
        }
      );
      return;
    }

    setLoading(true);
    try {
      await placeBidAPI(listing.id, amount, {
        listingTitle: listing.title,
        listingPrice: listing.price,
        startingPrice: listing.price,
        buyerId: user?.id,
        buyerName: user?.name ?? user?.email,
      });

      if (isEnded) {
        try {
          await runEscrowOtpTriggerPipeline(String(listing.id), { force: true });
        } catch (resolveErr) {
          if (__DEV__) {
            console.warn('[ListingDetail] escrow/OTP trigger after bid', resolveErr?.message);
          }
        }
      }

      // Update the local state to show the new bid immediately
      const newBidder = user?.name || 'You';
      setListing(prev => ({
        ...prev,
        currentBid: amount,
        highestBidder: newBidder
      }));

      await Promise.all([
        reloadLiveWallet(),
        typeof refreshWallet === 'function' ? refreshWallet().catch(() => {}) : Promise.resolve(),
        typeof refreshProfile === 'function' ? refreshProfile().catch(() => {}) : Promise.resolve(),
        reloadBidHistory(),
      ]);

      showModal(
        'Bid placed',
        `Rs. ${amount.toLocaleString()} is locked in escrow for this auction. If you are outbid, the full amount returns to your wallet automatically.`,
        'success'
      );
      setBidAmount('');
    } catch (error) {
      if (error?.topUpRequired) {
        showModal(
          'Top-up required',
          error.message ||
            `Your wallet must have at least Rs. ${MIN_WALLET_BALANCE_TO_BID_PKR.toLocaleString()} to bid.`,
          'error',
          {
            label: 'Open wallet',
            onPress: () => {
              closeModal();
              navigation.navigate('Wallet');
            },
          }
        );
      } else {
        const msg = error?.message || 'Failed to place bid';
        const title = error?.bidTooLow
          ? 'Bid too low'
          : error?.authRequired
            ? 'Sign in needed'
            : 'Could not place bid';
        const walletAction =
          error?.insufficientBalance ||
          error?.topUpRequired ||
          (/wallet|insufficient|funds|balance|escrow|locked/i.test(msg) &&
            !/network|timeout|fetch/i.test(msg));
        showModal(
          title,
          msg,
          'error',
          walletAction
            ? {
                label: 'Open wallet',
                onPress: () => {
                  closeModal();
                  navigation.navigate('Wallet');
                },
              }
            : null
        );
      }
    } finally {
      setLoading(false);
    }
  };

  const handleBuyNow = () => {
    if (!tradingOpen || buyNowAmount == null) return;
    navigation.navigate('PaymentCheckout', {
      listing: { ...listing },
      amount: buyNowAmount,
      buyerId: user?.id,
      buyerName: user?.name ?? user?.email,
    });
  };

  const isOwnListing =
    user?.id != null &&
    listing?.sellerId != null &&
    String(user.id) === String(listing.sellerId);

  const handleChatWithSeller = () => {
    if (!user) {
      showModal('Sign in needed', 'Please sign in to message the seller.');
      return;
    }
    if (!isKycVerified(user)) {
      showKycBidBlockedAlert();
      return;
    }
    if (isOwnListing) {
      showModal('Cannot chat', 'You cannot start a chat about your own listing.');
      return;
    }
    navigation.navigate('Chat', {
      listingId: String(listing.id),
      listingTitle: listing.title,
      listingImage: listing.image || (Array.isArray(listing.images) ? listing.images[0] : null),
      title: listing.sellerName || 'Seller',
    });
  };

  const openChatHandledRef = useRef(false);
  useEffect(() => {
    if (!route.params?.openChat || openChatHandledRef.current || !listing?.id) return;
    openChatHandledRef.current = true;
    handleChatWithSeller();
  }, [route.params?.openChat, listing?.id]);

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {!tradingOpen ? (
          <View
            style={[
              styles.moderationBanner,
              moderation === 'rejected' ? styles.moderationBannerRejected : null,
            ]}
          >
            <Ionicons
              name={moderation === 'rejected' ? 'close-circle-outline' : 'hourglass-outline'}
              size={22}
              color={moderation === 'rejected' ? '#c62828' : '#b45309'}
            />
            <View style={{ flex: 1 }}>
              <Text
                style={[
                  styles.moderationBannerText,
                  moderation === 'rejected' ? styles.moderationBannerTextRejected : null,
                ]}
              >
                {moderation === 'rejected'
                  ? (listing.rejectionReason && String(listing.rejectionReason).trim()) ||
                    'Sorry, your product is not according to our guidelines.'
                  : 'Waiting for admin approval. Bidding and purchases stay closed until the listing is live.'}
              </Text>
              {moderation === 'rejected' ? (
                <Text style={styles.moderationBannerSub}>
                  This listing is hidden from the public marketplace.
                </Text>
              ) : null}
            </View>
          </View>
        ) : null}
        <View style={styles.galleryWrap}>
          {activeUri ? (
            !galleryUriFailed ? (
              <>
                <Image
                  key={activeUri}
                  source={{ uri: activeUriSrc || activeUri }}
                  style={styles.galleryImage}
                  resizeMode="cover"
                  resizeMethod={Platform.OS === 'android' ? 'resize' : 'auto'}
                  progressiveRenderingEnabled
                  fadeDuration={150}
                  onError={handleGalleryError}
                />
                {galleryUrls.length > 1 && (
                  <>
                    <TouchableOpacity
                      style={[styles.galleryArrow, styles.galleryArrowLeft]}
                      onPress={goImgPrev}
                      disabled={imageIndex === 0}
                    >
                      <Ionicons
                        name="chevron-back"
                        size={24}
                        color="#fff"
                        style={imageIndex === 0 ? styles.iconMuted : null}
                      />
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.galleryArrow, styles.galleryArrowRight]}
                      onPress={goImgNext}
                      disabled={imageIndex >= galleryUrls.length - 1}
                    >
                      <Ionicons
                        name="chevron-forward"
                        size={24}
                        color="#fff"
                        style={imageIndex >= galleryUrls.length - 1 ? styles.iconMuted : null}
                      />
                    </TouchableOpacity>
                    <Text style={styles.galleryCounter}>
                      Photo {imageIndex + 1} of {galleryUrls.length}
                    </Text>
                  </>
                )}
              </>
            ) : (
              <View style={styles.galleryPlaceholder}>
                <Ionicons name="cloud-offline-outline" size={48} color="#ccc" />
                <Text style={styles.galleryPlaceholderText}>Could not load this image (check URL or network)</Text>
              </View>
            )
          ) : (
            <View style={styles.galleryPlaceholder}>
              <Ionicons name="image-outline" size={48} color="#ccc" />
              <Text style={styles.galleryPlaceholderText}>No photos for this listing</Text>
            </View>
          )}
        </View>
        
        <View style={styles.contentContainer}>
          <Text style={styles.title}>{listing.title}</Text>
          
          {listing.type === 'auction' && (
            <View style={styles.timerCard}>
              <Text style={styles.timerLabel}>Auction ends in:</Text>
              <Text style={styles.timerText}>
                {isEnded ? 'Auction Ended' : `${days}d ${hours}h ${minutes}m ${seconds}s`}
              </Text>
            </View>
          )}

          <View style={styles.priceContainer}>
            {auctionMode && (
              <>
                <View style={styles.priceBox}>
                  <Text style={styles.priceLabel}>Starting Bid</Text>
                  <Text style={styles.priceValue}>Rs. {listing.price?.toLocaleString() || 'N/A'}</Text>
                </View>
                <View style={styles.priceBox}>
                  <Text style={styles.priceLabel}>Current / Last Bid</Text>
                  <Text style={styles.priceValueCurrent}>Rs. {listing.currentBid?.toLocaleString() || 'N/A'}</Text>
                  {listing.highestBidder && (
                    <Text style={styles.bidderText}>by {listing.highestBidder}</Text>
                  )}
                </View>
              </>
            )}

            {auctionMode && buyNowAmount != null && (
              <View style={styles.priceBox}>
                <Text style={styles.priceLabel}>Buy It Now</Text>
                <Text style={styles.priceValueBuyNow}>Rs. {buyNowAmount.toLocaleString()}</Text>
              </View>
            )}

            {standardMode && standardPriceAmount != null && (
              <View style={styles.priceBox}>
                <Text style={styles.priceLabel}>Asking Price</Text>
                <Text style={styles.priceValueBuyNow}>Rs. {standardPriceAmount.toLocaleString()}</Text>
              </View>
            )}
          </View>

          <View style={styles.descriptionContainer}>
            <Text style={styles.sectionTitle}>Description</Text>
            <Text style={styles.descriptionText}>{listing.description}</Text>
          </View>

          {listing?.sellerId ? (
            <View style={styles.sellerCardSection}>
              <PostedBySellerCard
                seller={sellerSummary}
                loading={sellerLoading && !sellerSummary}
                onPress={openSellerProfile}
              />
            </View>
          ) : null}

          {auctionMode && isSupabaseConfigured() ? (
            <View style={styles.bidHistorySection}>
              <Text style={styles.sectionTitle}>Recent bids</Text>
              {loadingBids ? (
                <View style={styles.bidHistoryLoading}>
                  <ActivityIndicator size="small" color="#888" />
                  <Text style={styles.bidHistoryLoadingText}>Loading bids…</Text>
                </View>
              ) : bidHistory.length === 0 ? (
                <Text style={styles.bidHistoryEmpty}>No bids on this listing yet.</Text>
              ) : (
                bidHistory.map((b) => (
                  <View key={b.id} style={styles.bidHistoryRow}>
                    <Text style={styles.bidHistoryAmount}>Rs. {b.amount.toLocaleString()}</Text>
                    <Text style={styles.bidHistoryBy}>By {b.bidderDisplayName}</Text>
                  </View>
                ))
              )}
            </View>
          ) : null}

          {auctionMode && !isOwnListing ? (
            <TouchableOpacity style={styles.chatSellerButton} onPress={handleChatWithSeller}>
              <Ionicons name="chatbubbles-outline" size={20} color="#007AFF" />
              <Text style={styles.chatSellerButtonText}>Chat with seller</Text>
            </TouchableOpacity>
          ) : null}

          <RelatedAds
            categoryId={listing?.category_id ?? listing?.category}
            currentId={listing?.id}
            onPressListing={(related) => {
              if (!related) return;
              navigation.push('ListingDetail', { listing: related });
            }}
          />
        </View>
      </ScrollView>

      {/* CUSTOM POPUP MODAL */}
      <Modal
        animationType="fade"
        transparent={true}
        visible={modalVisible}
        onRequestClose={closeModal}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalView}>
            <Text style={[styles.modalTitle, modalType === 'success' ? styles.modalTitleSuccess : styles.modalTitleError]}>
              {modalTitle}
            </Text>
            <Text style={styles.modalMessage}>{modalMessage}</Text>
            <View style={styles.modalButtonRow}>
              {modalExtraAction ? (
                <TouchableOpacity style={styles.modalButtonSecondary} onPress={modalExtraAction.onPress}>
                  <Text style={styles.modalButtonSecondaryText}>{modalExtraAction.label}</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                style={[styles.modalButton, modalType === 'success' ? styles.modalButtonSuccess : styles.modalButtonError]}
                onPress={closeModal}
              >
                <Text style={styles.modalButtonText}>OK</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <BidConfirmModal
        visible={bidConfirmVisible}
        onConfirm={executePlaceBid}
        onCancel={() => setBidConfirmVisible(false)}
        loading={loading}
      />

      <View style={styles.actionBottomBar}>
        {auctionMode && !isEnded && !tradingOpen ? (
          <Text style={styles.closedHint}>Bidding opens after admin approval.</Text>
        ) : null}
        {auctionMode && !isEnded && tradingOpen && tokenAmountForListing > 0 ? (
          tokenPaid ? (
            <View style={styles.tokenPaidRow}>
              <Ionicons name="shield-checkmark" size={16} color="#1b5e20" />
              <Text style={styles.tokenPaidText}>
                Bid token of Rs. {tokenAmountForListing.toLocaleString()} reserved.
              </Text>
            </View>
          ) : (
            <View style={styles.tokenGate}>
              <Text style={styles.tokenGateTitle}>
                Bid token: Rs. {tokenAmountForListing.toLocaleString()}
              </Text>
              <Text style={styles.tokenGateText}>
                Reserved from your wallet. Refunded automatically if you don't win.
                {liveWalletBalance != null
                  ? `  ·  Wallet (live): Rs. ${Number(liveWalletBalance).toLocaleString()}`
                  : ''}
              </Text>
              <TouchableOpacity
                style={styles.tokenGateButton}
                onPress={handlePayBidToken}
                disabled={payingToken || tokenChecking}
              >
                <Text style={styles.tokenGateButtonText}>
                  {payingToken ? 'Reserving…' : `Pay token to bid (Rs. ${tokenAmountForListing.toLocaleString()})`}
                </Text>
              </TouchableOpacity>
            </View>
          )
        ) : null}
        {auctionMode && !isEnded && tradingOpen ? (
          <Text style={styles.walletBidHint}>
            Your full bid amount will be securely locked in escrow. If you are outbid, the funds will be instantly returned to your wallet.
            {parsedBidAmount > 0
              ? ` For Rs. ${parsedBidAmount.toLocaleString()}, you need at least that much spendable balance.`
              : ''}
            {walletLoading
              ? ' Loading wallet…'
              : spendableWalletBalance != null
                ? ` Spendable now: Rs. ${Number(spendableWalletBalance).toLocaleString()}.`
                : ''}
            {` Minimum wallet to bid: Rs. ${MIN_WALLET_BALANCE_TO_BID_PKR.toLocaleString()}.`}
          </Text>
        ) : null}
        {auctionMode && !isEnded && tradingOpen && (
          <View style={styles.bidActionContainer}>
            <View style={styles.bidActionRow}>
              <TextInput
                style={styles.bidInput}
                placeholder="Enter bid amount"
                keyboardType={Platform.OS === 'ios' ? 'number-pad' : 'numeric'}
                value={bidAmount}
                onChangeText={(t) => setBidAmount(t.replace(/\D/g, ''))}
                editable={tokenAmountForListing === 0 || tokenPaid}
              />
              <Pressable
                style={({ pressed }) => [
                  styles.bidButton,
                  (loading || (tokenAmountForListing > 0 && !tokenPaid)) &&
                    styles.bidButtonDisabled,
                  pressed &&
                    !loading &&
                    !(tokenAmountForListing > 0 && !tokenPaid) &&
                    styles.bidButtonPressed,
                ]}
                onPress={handlePlaceBid}
                disabled={loading || (tokenAmountForListing > 0 && !tokenPaid)}
              >
                <Text style={styles.buttonText}>{loading ? 'Wait...' : 'Place Bid'}</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* Auction-only optional Buy-It-Now payment shortcut. Standard listings never show a pay button. */}
        {auctionMode && buyNowAmount != null ? (
          !tradingOpen ? (
            <Text style={styles.closedHint}>Buy It Now is unavailable until this listing is approved.</Text>
          ) : (
            <TouchableOpacity style={styles.buyNowButton} onPress={handleBuyNow} disabled={loading}>
              <Text style={styles.buyNowButtonText}>
                {loading ? 'Processing...' : `Buy It Now (Rs. ${buyNowAmount.toLocaleString()})`}
              </Text>
            </TouchableOpacity>
          )
        ) : null}

        {/* Standard listings: in-person coordination, no payment processing. */}
        {standardMode ? (
          !tradingOpen ? (
            <Text style={styles.closedHint}>This listing is waiting for admin approval.</Text>
          ) : isOwnListing ? (
            <Text style={styles.closedHint}>This is your listing. Buyers will reach out to you here.</Text>
          ) : (
            <TouchableOpacity
              style={styles.chatSellerPrimaryButton}
              onPress={handleChatWithSeller}
              activeOpacity={0.85}
            >
              <Ionicons name="chatbubbles" size={20} color="#fff" />
              <Text style={styles.chatSellerPrimaryButtonText}>Chat with Seller</Text>
            </TouchableOpacity>
          )
        ) : null}
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  scrollContent: {
    paddingBottom: 20,
  },
  moderationBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginHorizontal: 0,
    marginBottom: 0,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff8e6',
    borderBottomWidth: 1,
    borderBottomColor: '#ffe0b2',
  },
  moderationBannerRejected: {
    backgroundColor: '#fdecea',
    borderBottomColor: '#f5c6c6',
  },
  moderationBannerText: {
    flex: 1,
    fontSize: 14,
    color: '#5c4033',
    lineHeight: 20,
    fontWeight: '500',
  },
  moderationBannerTextRejected: {
    color: '#b71c1c',
    fontWeight: '700',
  },
  moderationBannerSub: {
    marginTop: 4,
    fontSize: 12,
    color: '#7a1f1f',
  },
  closedHint: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    paddingVertical: 12,
    fontWeight: '600',
  },
  galleryWrap: {
    width: '100%',
    height: 300,
    backgroundColor: '#f0f0f0',
    position: 'relative',
  },
  galleryImage: {
    width: '100%',
    height: '100%',
  },
  galleryPlaceholder: {
    flex: 1,
    minHeight: 300,
    justifyContent: 'center',
    alignItems: 'center',
  },
  galleryPlaceholderText: {
    marginTop: 8,
    color: '#999',
    fontSize: 15,
  },
  galleryArrow: {
    position: 'absolute',
    top: 0,
    bottom: 36,
    justifyContent: 'center',
    paddingHorizontal: 8,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  galleryArrowLeft: {
    left: 0,
    borderTopRightRadius: 8,
    borderBottomRightRadius: 8,
  },
  galleryArrowRight: {
    right: 0,
    borderTopLeftRadius: 8,
    borderBottomLeftRadius: 8,
  },
  galleryCounter: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    textAlign: 'center',
    paddingVertical: 8,
    backgroundColor: 'rgba(0,0,0,0.45)',
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  iconMuted: {
    opacity: 0.4,
  },
  contentContainer: {
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 15,
  },
  timerCard: {
    backgroundColor: '#fff4e5',
    padding: 15,
    borderRadius: 10,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#ffdcb5',
    alignItems: 'center',
  },
  timerLabel: {
    fontSize: 14,
    color: '#d97706',
    fontWeight: '600',
    marginBottom: 5,
  },
  timerText: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#b45309',
  },
  priceContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 20,
    gap: 15,
  },
  priceBox: {
    flex: 1,
    backgroundColor: '#f8f9fa',
    padding: 15,
    borderRadius: 10,
  },
  priceLabel: {
    fontSize: 14,
    color: '#666',
    marginBottom: 5,
  },
  priceValue: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
  },
  priceValueCurrent: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#d97706',
  },
  bidderText: {
    fontSize: 12,
    color: '#888',
    marginTop: 2,
    fontStyle: 'italic',
  },
  priceValueBuyNow: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#2e7d32',
  },
  descriptionContainer: {
    marginTop: 10,
    marginBottom: 4,
  },
  sellerCardSection: {
    width: '100%',
    paddingBottom: 8,
  },
  bidHistorySection: {
    marginTop: 22,
    paddingTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e8e8e8',
  },
  bidHistoryLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
  },
  bidHistoryLoadingText: {
    fontSize: 14,
    color: '#888',
  },
  bidHistoryEmpty: {
    fontSize: 14,
    color: '#888',
    fontStyle: 'italic',
    paddingVertical: 6,
  },
  bidHistoryRow: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
    backgroundColor: '#f8f9fa',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#eee',
  },
  bidHistoryAmount: {
    fontSize: 17,
    fontWeight: '700',
    color: '#333',
  },
  bidHistoryBy: {
    fontSize: 13,
    color: '#666',
    marginTop: 4,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 10,
  },
  descriptionText: {
    fontSize: 16,
    color: '#555',
    lineHeight: 24,
  },
  chatSellerButton: {
    marginTop: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#007AFF',
    backgroundColor: '#F2F8FF',
  },
  chatSellerButtonText: {
    color: '#007AFF',
    fontWeight: '700',
    fontSize: 15,
  },
  actionBottomBar: {
    padding: 15,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderColor: '#e0e0e0',
  },
  bidActionContainer: {
    flexDirection: 'column',
    marginBottom: 10,
    gap: 10,
  },
  walletBidHint: {
    fontSize: 11,
    color: '#666',
    marginTop: 4,
    marginBottom: 2,
    paddingHorizontal: 4,
    lineHeight: 15,
  },
  bidActionRow: {
    flexDirection: 'row',
    gap: 10,
    width: '100%',
  },
  bidGateWarning: {
    width: '100%',
    fontSize: 13,
    fontWeight: '600',
    color: '#B45309',
    backgroundColor: '#FEF3C7',
    borderWidth: 1,
    borderColor: '#FCD34D',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
    lineHeight: 18,
  },
  bidInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 15,
    fontSize: 16,
    backgroundColor: '#f9f9f9',
  },
  bidInputLocked: {
    backgroundColor: '#E2E8F0',
    borderColor: '#CBD5E1',
    color: '#64748B',
  },
  bidButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 20,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 8,
  },
  bidButtonDisabled: {
    backgroundColor: '#9ec3f0',
  },
  bidButtonUnderReview: {
    opacity: 0.4,
  },
  bidButtonPressed: {
    opacity: 0.9,
    transform: [{ scale: 0.98 }],
  },
  tokenGate: {
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#fff8e1',
    borderWidth: 1,
    borderColor: '#ffe082',
    marginBottom: 10,
  },
  tokenGateTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#8d6e00',
  },
  tokenGateText: {
    fontSize: 12,
    color: '#5c4033',
    marginTop: 4,
    lineHeight: 17,
  },
  tokenGateButton: {
    marginTop: 10,
    backgroundColor: '#ff9800',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  tokenGateButtonText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 14,
  },
  tokenPaidRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: '#e8f5e9',
    borderRadius: 6,
    marginBottom: 8,
    alignSelf: 'flex-start',
  },
  tokenPaidText: {
    fontSize: 12,
    color: '#1b5e20',
    fontWeight: '700',
  },
  buttonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 16,
  },
  buyNowButton: {
    backgroundColor: '#4caf50',
    paddingVertical: 15,
    borderRadius: 8,
    alignItems: 'center',
  },
  buyNowButtonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 16,
  },
  chatSellerPrimaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: '#111',
    paddingVertical: 16,
    borderRadius: 10,
  },
  chatSellerPrimaryButtonText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 16,
    letterSpacing: 0.2,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  modalView: {
    width: '80%',
    backgroundColor: 'white',
    borderRadius: 20,
    padding: 25,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 10,
    textAlign: 'center',
  },
  modalTitleError: {
    color: '#e53935',
  },
  modalTitleSuccess: {
    color: '#4caf50',
  },
  modalMessage: {
    fontSize: 16,
    color: '#333',
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 22,
  },
  modalButton: {
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    elevation: 2,
    flex: 1,
    alignItems: 'center',
  },
  modalButtonError: {
    backgroundColor: '#e53935',
  },
  modalButtonSuccess: {
    backgroundColor: '#4caf50',
  },
  modalButtonText: {
    color: 'white',
    fontWeight: 'bold',
    fontSize: 16,
  },
  modalButtonRow: {
    flexDirection: 'row',
    gap: 10,
    width: '100%',
    alignItems: 'stretch',
  },
  modalButtonSecondary: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#007AFF',
    backgroundColor: '#fff',
  },
  modalButtonSecondaryText: {
    color: '#007AFF',
    fontWeight: '700',
    fontSize: 15,
  },
});

export default ListingDetailScreen;
