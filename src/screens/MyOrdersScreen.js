import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  RefreshControl,
  Modal,
  Pressable,
  Platform,
  Alert,
  DeviceEventEmitter,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import {
  normalizeOrderStatus,
  raiseOrderDispute,
  revealBuyerDeliveryOtp,
  resolveOrderRole,
  verifyDeliveryOtp,
  mapOrderRowForUi,
  subscribeToMyAuctionOrders,
} from '../services/auctionOrdersService';
import { AuthContext } from '../context/AuthContext';
import { getSupabase, isSupabaseConfigured } from '../services/supabaseClient';
import { AUCTION_RESOLVED_EVENT } from '../services/auctionResolveScheduler';
import { WALLET_HOLD_CONFIRMED_EVENT } from '../services/otpListener';
import { ensureOrderSupportTicket } from '../services/supportTicketService';
import { useWallet } from '../context/WalletContext';
import { backToHome } from '../utils/safeBack';
import { ListingCoverImage } from '../components/ListingCoverImage';
import { spacing } from '../theme';

function isMyOrdersTabRoot(navigation) {
  try {
    const tab = navigation.getParent?.();
    const state = tab?.getState?.();
    return state?.type === 'tab' && state.routes?.[state.index]?.name === 'MyOrders';
  } catch (_) {
    return false;
  }
}

function handleOrdersBack(navigation) {
  try {
    if (typeof navigation.canGoBack === 'function' && navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    const tabNav = navigation.getParent?.();
    const state = tabNav?.getState?.();
    if (
      state?.routeNames?.includes('MyOrders') &&
      state.routes?.[state.index]?.name === 'MyOrders'
    ) {
      tabNav.navigate('Home');
      return;
    }
  } catch (_) {
    /* fall through */
  }
  backToHome(navigation);
}

function isPendingDelivery(order) {
  return order?.isPending === true || normalizeOrderStatus(order?.status) === 'pending_delivery';
}

function isDisputedOrder(order) {
  return order?.isDisputed === true || normalizeOrderStatus(order?.status) === 'disputed';
}

function isCompletedOrder(order) {
  const s = normalizeOrderStatus(order?.status);
  return (
    order?.isCompleted === true ||
    s === 'completed' ||
    s === 'refunded' ||
    order?.isRefunded === true
  );
}

/** Active tab: everything except completed/refunded. */
function isActiveTabOrder(order) {
  return !isCompletedOrder(order);
}

const ORDER_BRIDGE_SELECT = `
  id,
  listing_id,
  buyer_id,
  seller_id,
  winning_bid_id,
  winning_bid_amount,
  escrow_amount,
  status,
  disputed_at,
  disputed_by,
  delivery_otp_expires_at,
  otp_verified_at,
  otp_verified_by,
  completed_at,
  created_at,
  updated_at,
  metadata
`;

function bucketOrdersForUi(mapped) {
  const pending = mapped.filter((o) => o.isPending);
  const completed = mapped.filter((o) => o.isCompleted || o.isRefunded);
  const other = mapped.filter((o) => !o.isPending && !o.isCompleted && !o.isRefunded);
  return { pending, completed, other, all: mapped };
}

async function resolveOrdersScreenUserId(contextUser) {
  const fromContext = contextUser?.id ?? contextUser?.uid ?? null;
  if (!isSupabaseConfigured()) {
    return fromContext != null ? String(fromContext).trim() : null;
  }
  try {
    const supabase = getSupabase();
    const { data } = await supabase.auth.getSession();
    const sessionUid = data?.session?.user?.id
      ? String(data.session.user.id).trim()
      : '';
    if (sessionUid) return sessionUid;
  } catch (e) {
    console.warn('[MyOrders] resolveOrdersScreenUserId session', e?.message);
  }
  return fromContext != null ? String(fromContext).trim() : null;
}

/** Buyer: reveal OTP + dispute (pending_delivery only). */
function BuyerEscrowPanel({
  buyerOtp,
  buyerOtpLoading,
  onLoadBuyerOtp,
  onCopyOtp,
  onOpenDispute,
}) {
  return (
    <View style={styles.escrowPanel}>
      <View style={styles.escrowPanelHeader}>
        <Ionicons name="lock-closed" size={18} color={GOLD} />
        <Text style={styles.escrowPanelTitle}>Escrow · Delivery OTP</Text>
      </View>
      <Text style={styles.hint}>
        Reveal your 6-digit code only after you have safely received the item, then share it with
        the seller in person.
      </Text>
      {buyerOtpLoading ? (
        <ActivityIndicator color={ACCENT} style={{ marginVertical: 12 }} />
      ) : buyerOtp ? (
        <View style={styles.otpDisplayRow}>
          <Text style={styles.otpDigits} selectable>
            {buyerOtp}
          </Text>
          <TouchableOpacity style={styles.copyBtn} onPress={onCopyOtp} activeOpacity={0.85}>
            <Ionicons name="copy-outline" size={18} color={TEXT} />
            <Text style={styles.copyBtnText}>Copy</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity style={styles.revealOtpBtn} onPress={onLoadBuyerOtp} activeOpacity={0.88}>
          <Ionicons name="key-outline" size={20} color="#FFFFFF" />
          <Text style={styles.revealOtpBtnText}>Reveal Delivery OTP</Text>
        </TouchableOpacity>
      )}
      <TouchableOpacity style={styles.disputeBtn} onPress={onOpenDispute} activeOpacity={0.88}>
        <Ionicons name="warning-outline" size={18} color="#FFFFFF" />
        <Text style={styles.disputeBtnText}>Raise Dispute / Report Issue</Text>
      </TouchableOpacity>
    </View>
  );
}

/** Shown on disputed orders — opens shared admin support ticket. */
function DisputedAdminSupportBar({ onPress, loading }) {
  return (
    <TouchableOpacity
      style={[styles.adminSupportBtn, loading && styles.primaryBtnDisabled]}
      onPress={onPress}
      disabled={loading}
      activeOpacity={0.9}
    >
      {loading ? (
        <ActivityIndicator color="#FFFFFF" />
      ) : (
        <>
          <Ionicons name="headset" size={20} color="#FFFFFF" />
          <Text style={styles.adminSupportBtnText}>Open Admin Chat</Text>
          <Ionicons name="chevron-forward" size={18} color="rgba(255,255,255,0.85)" />
        </>
      )}
    </TouchableOpacity>
  );
}

/** Seller: OTP input + verify + dispute (pending_delivery only). */
function SellerEscrowPanel({ otpInput, onOtpChange, onVerify, verifying, onOpenDispute }) {
  return (
    <View style={styles.escrowPanel}>
      <View style={styles.escrowPanelHeader}>
        <Ionicons name="lock-closed" size={18} color={GOLD} />
        <Text style={styles.escrowPanelTitle}>Escrow · Claim funds</Text>
      </View>
      <Text style={styles.hint}>
        Enter the 6-digit delivery OTP the buyer gives you after they receive the item.
      </Text>
      <TextInput
        style={styles.otpInput}
        value={otpInput}
        onChangeText={onOtpChange}
        placeholder="000000"
        placeholderTextColor="rgba(148, 163, 184, 0.6)"
        keyboardType={Platform.OS === 'ios' ? 'number-pad' : 'numeric'}
        maxLength={6}
        editable={!verifying}
      />
      <TouchableOpacity
        style={[styles.primaryBtn, verifying && styles.primaryBtnDisabled]}
        onPress={onVerify}
        disabled={verifying}
        activeOpacity={0.9}
      >
        {verifying ? (
          <ActivityIndicator color="#0F172A" />
        ) : (
          <>
            <Ionicons name="shield-checkmark" size={20} color="#0F172A" />
            <Text style={styles.primaryBtnText}>Verify & Claim Funds</Text>
          </>
        )}
      </TouchableOpacity>
      <TouchableOpacity style={styles.disputeBtn} onPress={onOpenDispute} activeOpacity={0.88}>
        <Ionicons name="warning-outline" size={18} color="#FFFFFF" />
        <Text style={styles.disputeBtnText}>Raise Dispute / Report Issue</Text>
      </TouchableOpacity>
    </View>
  );
}

const BG_TOP = '#0F172A';
const BG_BOTTOM = '#020617';
const GLASS = 'rgba(255, 255, 255, 0.08)';
const GLASS_BORDER = 'rgba(255, 255, 255, 0.14)';
const TEXT = '#F8FAFC';
const MUTED = '#94A3B8';
const ACCENT = '#60A5FA';
const SUCCESS = '#34D399';
const DANGER = '#F87171';
const GOLD = '#C9A227';

const TABS = [
  { key: 'active', label: 'Active' },
  { key: 'completed', label: 'Completed' },
];

const ROLE_TABS = [
  { key: 'all', label: 'All' },
  { key: 'buying', label: 'Buying' },
  { key: 'selling', label: 'Selling' },
];

function fmtRs(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 'Rs. 0';
  return `Rs. ${x.toLocaleString()}`;
}

function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusLabel(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'pending_delivery') return 'Awaiting delivery';
  if (s === 'completed') return 'Completed';
  if (s === 'disputed') return 'Disputed';
  if (s === 'refunded') return 'Refunded';
  return status || 'Unknown';
}

function statusChipStyle(order) {
  if (order.isDisputed) return styles.statusDisputed;
  if (order.isPending) return styles.statusPending;
  if (order.isCompleted) return styles.statusDone;
  return null;
}

function OrderCard({
  order,
  currentUserId,
  otpInput,
  onOtpChange,
  onVerify,
  verifying,
  buyerOtp,
  buyerOtpLoading,
  onLoadBuyerOtp,
  onCopyOtp,
  onOpenDispute,
  onOpenAdminSupport,
  supportOpening,
}) {
  const role = resolveOrderRole(order, currentUserId);
  const isSeller = role === 'seller';
  const isBuyer = role === 'buyer';
  const pending = isPendingDelivery(order);
  const disputed = isDisputedOrder(order);
  const completed = isCompletedOrder(order);

  return (
    <View style={styles.glassCard}>
      <View style={styles.cardTopRow}>
        {order.listingImage ? (
          <ListingCoverImage uri={order.listingImage} style={styles.thumb} recycleKey={order.id} />
        ) : (
          <View style={[styles.thumb, styles.thumbPlaceholder]}>
            <Ionicons name="cube-outline" size={28} color={MUTED} />
          </View>
        )}
        <View style={styles.cardHeadText}>
          <Text style={styles.cardTitle} numberOfLines={2}>
            {order.listingTitle}
          </Text>
          <View style={styles.badgeRow}>
            <View style={[styles.rolePill, isSeller && styles.rolePillSeller]}>
              <Text style={styles.rolePillText}>
                {isSeller ? 'Seller' : isBuyer ? 'Buyer' : 'Participant'}
              </Text>
            </View>
            <View style={[styles.statusChip, statusChipStyle(order)]}>
              <Text
                style={[
                  styles.statusChipText,
                  disputed && styles.statusChipTextDisputed,
                ]}
              >
                {statusLabel(order.status)}
              </Text>
            </View>
          </View>
          <Text style={styles.escrowLine}>Escrow: {fmtRs(order.escrowAmount)}</Text>
          <Text style={styles.dateLine}>{fmtWhen(order.createdAt)}</Text>
        </View>
      </View>

      {disputed ? (
        <View style={styles.disputedBanner}>
          <Ionicons name="shield-outline" size={22} color={DANGER} />
          <Text style={styles.disputedBannerText}>
            This order is under review by Admin. Funds are safely frozen in Escrow.
          </Text>
        </View>
      ) : null}

      {disputed && (isBuyer || isSeller) ? (
        <DisputedAdminSupportBar
          onPress={() => onOpenAdminSupport?.(order)}
          loading={!!supportOpening}
        />
      ) : null}

      {pending && isBuyer && !disputed ? (
        <BuyerEscrowPanel
          buyerOtp={buyerOtp}
          buyerOtpLoading={buyerOtpLoading}
          onLoadBuyerOtp={onLoadBuyerOtp}
          onCopyOtp={onCopyOtp}
          onOpenDispute={onOpenDispute}
        />
      ) : null}

      {pending && isSeller && !disputed ? (
        <SellerEscrowPanel
          otpInput={otpInput}
          onOtpChange={onOtpChange}
          onVerify={onVerify}
          verifying={verifying}
          onOpenDispute={onOpenDispute}
        />
      ) : null}

      {completed ? (
        <View style={styles.completedBanner}>
          <Ionicons name="checkmark-circle" size={20} color={SUCCESS} />
          <Text style={styles.completedText}>
            Payment released · {fmtWhen(order.completedAt || order.otpVerifiedAt)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const MyOrdersScreen = () => {
  const navigation = useNavigation();
  const onOrdersTab = isMyOrdersTabRoot(navigation);
  const { user } = useContext(AuthContext);
  const { refresh: refreshWallet } = useWallet();

  const [buckets, setBuckets] = useState({ pending: [], completed: [], other: [], all: [] });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [effectiveUserId, setEffectiveUserId] = useState(null);

  const fetchOrdersForScreen = useCallback(async (mode = 'normal') => {
    if (!isSupabaseConfigured()) {
      setError('Sign in with Supabase to view orders.');
      setBuckets({ pending: [], completed: [], other: [], all: [] });
      setLoading(false);
      setRefreshing(false);
      return;
    }

    const uid = await resolveOrdersScreenUserId(user);
    if (!uid) {
      console.warn('[MyOrders] fetchOrdersForScreen — user_id is null/undefined');
      setEffectiveUserId(null);
      setBuckets({ pending: [], completed: [], other: [], all: [] });
      setLoading(false);
      setRefreshing(false);
      return;
    }

    setEffectiveUserId(uid);
    if (mode === 'pull') setRefreshing(true);
    else if (mode === 'normal') setLoading(true);
    else if (mode === 'silent') {
      /* keep list visible */
    }
    setError(null);

    try {
      const supabase = getSupabase();
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData?.session?.access_token) {
        throw new Error('Sign in again — no active Supabase session for orders.');
      }

      const { data, error: fetchErr } = await supabase
        .from('auction_orders')
        .select(ORDER_BRIDGE_SELECT)
        .or(`buyer_id.eq.${uid},seller_id.eq.${uid}`)
        .order('created_at', { ascending: false });

      console.log('[MyOrders] Supabase auction_orders fetch', {
        user_id: uid,
        rowCount: Array.isArray(data) ? data.length : 0,
        error: fetchErr?.message ?? null,
        sample: Array.isArray(data) && data.length > 0 ? data[0] : null,
      });

      if (fetchErr) {
        throw new Error(fetchErr.message || 'Could not load orders.');
      }

      const mapped = (Array.isArray(data) ? data : [])
        .map((row) => mapOrderRowForUi(row, uid))
        .filter(Boolean);

      const nextBuckets = bucketOrdersForUi(mapped);
      setBuckets(nextBuckets);

      console.log('[MyOrders] UI buckets mapped', {
        active: nextBuckets.all.filter((o) => isActiveTabOrder(o)).length,
        ended: nextBuckets.all.filter((o) => isCompletedOrder(o)).length,
        pending: nextBuckets.pending.length,
        completed: nextBuckets.completed.length,
        total: nextBuckets.all.length,
      });
    } catch (e) {
      const msg = e?.message || 'Could not load orders.';
      console.error('[MyOrders] fetchOrdersForScreen failed', msg);
      setError(msg);
      setBuckets({ pending: [], completed: [], other: [], all: [] });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user]);

  const refresh = useCallback(() => fetchOrdersForScreen('pull'), [fetchOrdersForScreen]);

  useEffect(() => {
    void fetchOrdersForScreen('normal');
  }, [fetchOrdersForScreen, user?.id, user?.uid]);

  const [activeTab, setActiveTab] = useState('active');
  const [roleTab, setRoleTab] = useState('all');

  const [sellerOtpByOrder, setSellerOtpByOrder] = useState({});
  const [verifyingId, setVerifyingId] = useState(null);

  const [buyerOtpByOrder, setBuyerOtpByOrder] = useState({});
  const [buyerOtpLoadingId, setBuyerOtpLoadingId] = useState(null);

  const [modalVisible, setModalVisible] = useState(false);
  const [modalTitle, setModalTitle] = useState('');
  const [modalMessage, setModalMessage] = useState('');
  const [modalSuccess, setModalSuccess] = useState(false);

  const [disputeModalVisible, setDisputeModalVisible] = useState(false);
  const [disputeOrder, setDisputeOrder] = useState(null);
  const [disputeReason, setDisputeReason] = useState('');
  const [disputeSubmitting, setDisputeSubmitting] = useState(false);
  const [supportOpeningId, setSupportOpeningId] = useState(null);

  const showModal = (title, message, success = false) => {
    setModalTitle(title);
    setModalMessage(message);
    setModalSuccess(success);
    setModalVisible(true);
  };

  useFocusEffect(
    useCallback(() => {
      void fetchOrdersForScreen('normal');
    }, [fetchOrdersForScreen])
  );

  useEffect(() => {
    const subResolved = DeviceEventEmitter.addListener(AUCTION_RESOLVED_EVENT, () => {
      void refreshWallet?.();
      void fetchOrdersForScreen('silent');
    });
    const subHold = DeviceEventEmitter.addListener(WALLET_HOLD_CONFIRMED_EVENT, () => {
      void fetchOrdersForScreen('silent');
    });
    return () => {
      subResolved.remove();
      subHold.remove();
    };
  }, [refreshWallet, fetchOrdersForScreen]);

  useEffect(() => {
    if (!effectiveUserId || !isSupabaseConfigured()) return undefined;
    return subscribeToMyAuctionOrders(effectiveUserId, () => {
      void fetchOrdersForScreen('silent');
    });
  }, [effectiveUserId, fetchOrdersForScreen]);

  const visible = useMemo(() => {
    const all = buckets.all?.length
      ? buckets.all
      : [...(buckets.pending || []), ...(buckets.other || []), ...(buckets.completed || [])];
    let list =
      activeTab === 'active'
        ? all.filter((o) => isActiveTabOrder(o))
        : all.filter((o) => isCompletedOrder(o));

    if (roleTab === 'buying') {
      list = list.filter((o) => resolveOrderRole(o, effectiveUserId) === 'buyer');
    } else if (roleTab === 'selling') {
      list = list.filter((o) => resolveOrderRole(o, effectiveUserId) === 'seller');
    }
    return list;
  }, [activeTab, roleTab, buckets, effectiveUserId]);

  const handleLoadBuyerOtp = async (orderId) => {
    setBuyerOtpLoadingId(orderId);
    try {
      const data = await revealBuyerDeliveryOtp(orderId);
      const otp = String(data?.otp ?? '').replace(/\D/g, '').slice(0, 6);
      if (otp.length !== 6) {
        throw new Error('No delivery OTP returned from Supabase. Try again.');
      }
      setBuyerOtpByOrder((prev) => ({ ...prev, [orderId]: otp }));
    } catch (e) {
      showModal('Could not reveal OTP', e?.message || 'Try again.');
    } finally {
      setBuyerOtpLoadingId(null);
    }
  };

  const handleCopyOtp = async (otp) => {
    try {
      await Clipboard.setStringAsync(String(otp));
      showModal('Copied', 'Delivery OTP copied to clipboard.', true);
    } catch (_) {
      Alert.alert('Your OTP', String(otp));
    }
  };

  const markOrderDisputedLocally = useCallback((orderId) => {
    const toDisputed = (o) => ({
      ...o,
      status: 'disputed',
      isPending: false,
      isDisputed: true,
      isCompleted: false,
    });

    setBuckets((prev) => {
      const fromPending = (prev.pending || []).find((o) => o.id === orderId);
      const patchList = (list) =>
        (list || []).map((o) => (o.id === orderId ? toDisputed(o) : o));
      const nextOther = fromPending
        ? [toDisputed(fromPending), ...(prev.other || []).filter((o) => o.id !== orderId)]
        : patchList(prev.other);
      return {
        pending: (prev.pending || []).filter((o) => o.id !== orderId),
        completed: patchList(prev.completed),
        other: nextOther,
        all: patchList(prev.all),
      };
    });

    setBuyerOtpByOrder((prev) => {
      const next = { ...prev };
      delete next[orderId];
      return next;
    });
  }, []);

  const openDisputeModal = (order) => {
    setDisputeOrder(order);
    setDisputeReason('');
    setDisputeModalVisible(true);
  };

  const handleOpenAdminSupport = useCallback(
    async (order) => {
      if (!order?.id) return;
      setSupportOpeningId(order.id);
      try {
        const { ticketId } = await ensureOrderSupportTicket(order.id);
        navigation.navigate('DisputeSupportChat', {
          orderId: order.id,
          ticketId,
          listingTitle: order.listingTitle || 'Disputed order',
        });
      } catch (e) {
        showModal('Admin support', e?.message || 'Could not open support chat.');
      } finally {
        setSupportOpeningId(null);
      }
    },
    [navigation]
  );

  const submitDispute = async () => {
    if (!disputeOrder?.id) return;
    const reason = disputeReason.trim();
    if (reason.length < 10) {
      showModal('More detail needed', 'Please describe the issue in at least 10 characters.');
      return;
    }
    setDisputeSubmitting(true);
    try {
      await raiseOrderDispute(disputeOrder.id, reason);
      setDisputeModalVisible(false);
      setDisputeOrder(null);
      setDisputeReason('');
      markOrderDisputedLocally(disputeOrder.id);
      showModal(
        'Dispute raised',
        'Funds are frozen and admin has been notified. This order is under review until resolved.',
        true
      );
      await refresh();
    } catch (e) {
      showModal('Could not raise dispute', e?.message || 'Try again.');
    } finally {
      setDisputeSubmitting(false);
    }
  };

  const handleVerify = async (order) => {
    const code = String(sellerOtpByOrder[order.id] || '').trim();
    if (code.length < 6) {
      showModal('OTP required', 'Enter the full 6-digit code from the buyer.');
      return;
    }
    setVerifyingId(order.id);
    try {
      const result = await verifyDeliveryOtp(order.id, code);
      if (__DEV__) {
        console.log('[MyOrders] verify_delivery_otp ok', result);
      }
      setSellerOtpByOrder((prev) => ({ ...prev, [order.id]: '' }));
      showModal(
        'Success!',
        'Funds have been transferred to your wallet. Escrow is now in your spendable balance.',
        true
      );
      await Promise.all([
        refresh(),
        typeof refreshWallet === 'function' ? refreshWallet().catch(() => {}) : Promise.resolve(),
      ]);
    } catch (e) {
      const title = e?.invalidOtp ? 'Invalid OTP' : 'Verification failed';
      showModal(title, e?.message || 'Could not verify delivery OTP.');
    } finally {
      setVerifyingId(null);
    }
  };

  const renderItem = ({ item }) => (
    <OrderCard
      order={item}
      currentUserId={effectiveUserId}
      otpInput={sellerOtpByOrder[item.id] || ''}
      onOtpChange={(t) =>
        setSellerOtpByOrder((prev) => ({
          ...prev,
          [item.id]: t.replace(/\D/g, '').slice(0, 6),
        }))
      }
      onVerify={() => handleVerify(item)}
      verifying={verifyingId === item.id}
      buyerOtp={buyerOtpByOrder[item.id]}
      buyerOtpLoading={buyerOtpLoadingId === item.id}
      onLoadBuyerOtp={() => handleLoadBuyerOtp(item.id)}
      onCopyOtp={() => handleCopyOtp(buyerOtpByOrder[item.id])}
      onOpenDispute={() => openDisputeModal(item)}
      onOpenAdminSupport={handleOpenAdminSupport}
      supportOpening={supportOpeningId === item.id}
    />
  );

  return (
    <View style={styles.root}>
      <LinearGradient colors={[BG_TOP, BG_BOTTOM]} style={StyleSheet.absoluteFill} />
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.header}>
          {onOrdersTab ? (
            <View style={styles.backBtn} />
          ) : (
            <TouchableOpacity
              onPress={() => handleOrdersBack(navigation)}
              style={styles.backBtn}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons name="chevron-back" size={26} color={TEXT} />
            </TouchableOpacity>
          )}
          <View style={styles.headerCenter}>
            <Text style={styles.headerTitle}>My Orders</Text>
            <Text style={styles.headerSub}>Escrow · delivery · payouts</Text>
          </View>
          <View style={styles.backBtn} />
        </View>

        <View style={styles.tabBar}>
          {TABS.map((t) => {
            const active = activeTab === t.key;
            const all = buckets.all?.length
              ? buckets.all
              : [...(buckets.pending || []), ...(buckets.other || []), ...(buckets.completed || [])];
            const count =
              t.key === 'active'
                ? all.filter((o) => isActiveTabOrder(o)).length
                : all.filter((o) => isCompletedOrder(o)).length;
            return (
              <TouchableOpacity
                key={t.key}
                style={[styles.tab, active && styles.tabActive]}
                onPress={() => setActiveTab(t.key)}
                activeOpacity={0.88}
              >
                <Text style={[styles.tabText, active && styles.tabTextActive]}>{t.label}</Text>
                <View style={[styles.tabCount, active && styles.tabCountActive]}>
                  <Text style={[styles.tabCountText, active && styles.tabCountTextActive]}>
                    {count}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={styles.roleTabBar}>
          {ROLE_TABS.map((t) => {
            const active = roleTab === t.key;
            const all = buckets.all?.length
              ? buckets.all
              : [...(buckets.pending || []), ...(buckets.other || []), ...(buckets.completed || [])];
            const base =
              activeTab === 'active'
                ? all.filter((o) => isActiveTabOrder(o))
                : all.filter((o) => isCompletedOrder(o));
            const count =
              t.key === 'all'
                ? base.length
                : t.key === 'buying'
                  ? base.filter((o) => resolveOrderRole(o, effectiveUserId) === 'buyer').length
                  : base.filter((o) => resolveOrderRole(o, effectiveUserId) === 'seller').length;
            return (
              <TouchableOpacity
                key={t.key}
                style={[styles.roleTab, active && styles.roleTabActive]}
                onPress={() => setRoleTab(t.key)}
                activeOpacity={0.88}
              >
                <Text style={[styles.roleTabText, active && styles.roleTabTextActive]}>{t.label}</Text>
                {count > 0 ? (
                  <Text style={[styles.roleTabCount, active && styles.roleTabCountActive]}>{count}</Text>
                ) : null}
              </TouchableOpacity>
            );
          })}
        </View>

        {loading && !refreshing ? (
          <ActivityIndicator color={ACCENT} style={{ marginTop: 40 }} />
        ) : (
          <FlatList
            data={visible}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={ACCENT} />
            }
            ListEmptyComponent={
              <View style={styles.emptyGlass}>
                <Ionicons name="receipt-outline" size={36} color={MUTED} />
                <Text style={styles.emptyTitle}>
                  {activeTab === 'active' ? 'No active orders' : 'No completed orders yet'}
                </Text>
                <Text style={styles.emptySub}>
                  {activeTab === 'active'
                    ? roleTab === 'buying'
                      ? 'When you win an auction, your order appears here with a delivery OTP to share with the seller.'
                      : roleTab === 'selling'
                        ? 'When your auction ends with a winning bid, enter the buyer’s delivery OTP here to release escrow.'
                        : 'Ended auctions create escrow orders automatically. Pull to refresh if you just won or sold.'
                    : 'Completed deliveries will appear after OTP verification.'}
                </Text>
              </View>
            }
            ListHeaderComponent={
              error ? (
                <View style={styles.errorBanner}>
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              ) : null
            }
          />
        )}
      </SafeAreaView>

      <Modal
        visible={disputeModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => !disputeSubmitting && setDisputeModalVisible(false)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => !disputeSubmitting && setDisputeModalVisible(false)}
        >
          <Pressable style={styles.disputeModalCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.disputeModalTitle}>What is the issue with this delivery?</Text>
            <Text style={styles.disputeModalSub}>
              Describe the problem. Funds will stay frozen until an admin reviews your case.
            </Text>
            <TextInput
              style={styles.disputeInput}
              value={disputeReason}
              onChangeText={setDisputeReason}
              placeholder="e.g. Item not received, wrong item, damaged package…"
              placeholderTextColor="rgba(148, 163, 184, 0.65)"
              multiline
              numberOfLines={5}
              textAlignVertical="top"
              editable={!disputeSubmitting}
            />
            <TouchableOpacity
              style={[styles.disputeSubmitBtn, disputeSubmitting && styles.primaryBtnDisabled]}
              onPress={submitDispute}
              disabled={disputeSubmitting}
            >
              {disputeSubmitting ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.disputeSubmitText}>Submit dispute</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.disputeCancelBtn}
              onPress={() => setDisputeModalVisible(false)}
              disabled={disputeSubmitting}
            >
              <Text style={styles.disputeCancelText}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={modalVisible} transparent animationType="fade" onRequestClose={() => setModalVisible(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setModalVisible(false)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <Ionicons
              name={modalSuccess ? 'checkmark-circle' : 'alert-circle'}
              size={48}
              color={modalSuccess ? SUCCESS : DANGER}
            />
            <Text style={styles.modalTitle}>{modalTitle}</Text>
            <Text style={styles.modalMessage}>{modalMessage}</Text>
            <TouchableOpacity
              style={[styles.modalOk, modalSuccess && styles.modalOkSuccess]}
              onPress={() => setModalVisible(false)}
            >
              <Text style={styles.modalOkText}>OK</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG_BOTTOM },
  safe: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.md,
  },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerTitle: { fontSize: 22, fontWeight: '800', color: TEXT, letterSpacing: -0.3 },
  headerSub: { fontSize: 12, color: MUTED, marginTop: 2 },
  roleTabBar: {
    flexDirection: 'row',
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    gap: 8,
  },
  roleTab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: GLASS_BORDER,
    backgroundColor: GLASS,
  },
  roleTabActive: {
    borderColor: 'rgba(96, 165, 250, 0.5)',
    backgroundColor: 'rgba(96, 165, 250, 0.15)',
  },
  roleTabText: { fontSize: 13, fontWeight: '600', color: MUTED },
  roleTabTextActive: { color: TEXT, fontWeight: '700' },
  roleTabCount: { fontSize: 12, fontWeight: '700', color: MUTED },
  roleTabCountActive: { color: ACCENT },
  tabBar: {
    flexDirection: 'row',
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    backgroundColor: GLASS,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: GLASS_BORDER,
    padding: 4,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
  },
  tabActive: { backgroundColor: 'rgba(96, 165, 250, 0.22)' },
  tabText: { fontSize: 14, fontWeight: '600', color: MUTED },
  tabTextActive: { color: TEXT, fontWeight: '700' },
  tabCount: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  tabCountActive: { backgroundColor: 'rgba(15, 23, 42, 0.5)' },
  tabCountText: { fontSize: 11, fontWeight: '700', color: MUTED },
  tabCountTextActive: { color: TEXT },
  listContent: { paddingHorizontal: spacing.md, paddingBottom: 48 },
  glassCard: {
    backgroundColor: GLASS,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: GLASS_BORDER,
    padding: spacing.md,
    marginBottom: spacing.md,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.35,
        shadowRadius: 16,
      },
      android: { elevation: 6 },
    }),
  },
  cardTopRow: { flexDirection: 'row', gap: spacing.md },
  thumb: { width: 72, height: 72, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.25)' },
  thumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  cardHeadText: { flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 16, fontWeight: '700', color: TEXT, marginBottom: 6 },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  rolePill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: 'rgba(96, 165, 250, 0.25)',
  },
  rolePillSeller: { backgroundColor: 'rgba(201, 162, 39, 0.28)' },
  rolePillText: { fontSize: 11, fontWeight: '700', color: TEXT },
  statusChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  statusPending: { backgroundColor: 'rgba(251, 191, 36, 0.22)' },
  statusDone: { backgroundColor: 'rgba(52, 211, 153, 0.2)' },
  statusDisputed: { backgroundColor: 'rgba(248, 113, 113, 0.28)' },
  statusChipText: { fontSize: 11, fontWeight: '600', color: TEXT },
  statusChipTextDisputed: { color: '#FECACA', fontWeight: '800' },
  escrowLine: { fontSize: 14, fontWeight: '700', color: GOLD },
  dateLine: { fontSize: 11, color: MUTED, marginTop: 4 },
  section: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: GLASS_BORDER,
  },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: TEXT, marginBottom: 8 },
  hint: { fontSize: 13, lineHeight: 19, color: MUTED, marginBottom: 12 },
  finePrint: { fontSize: 11, lineHeight: 16, color: 'rgba(148, 163, 184, 0.85)', marginTop: 10 },
  otpDisplayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: GLASS_BORDER,
    paddingVertical: 14,
    paddingHorizontal: 18,
  },
  otpDigits: {
    fontSize: 28,
    fontWeight: '800',
    color: TEXT,
    letterSpacing: 8,
    fontVariant: ['tabular-nums'],
  },
  copyBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 8 },
  copyBtnText: { color: TEXT, fontWeight: '600', fontSize: 13 },
  otpInput: {
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: GLASS_BORDER,
    paddingVertical: 14,
    paddingHorizontal: 18,
    fontSize: 24,
    fontWeight: '700',
    color: TEXT,
    letterSpacing: 10,
    textAlign: 'center',
    marginBottom: 12,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: GOLD,
    borderRadius: 14,
    paddingVertical: 14,
  },
  primaryBtnDisabled: { opacity: 0.65 },
  primaryBtnText: { fontSize: 16, fontWeight: '800', color: '#0F172A' },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: GLASS_BORDER,
    paddingVertical: 12,
    backgroundColor: 'rgba(15, 23, 42, 0.4)',
  },
  secondaryBtnText: { color: ACCENT, fontWeight: '700', fontSize: 15 },
  completedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: GLASS_BORDER,
  },
  completedText: { fontSize: 13, color: SUCCESS, fontWeight: '600', flex: 1 },
  disputedBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: 12,
    backgroundColor: 'rgba(248, 113, 113, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(248, 113, 113, 0.35)',
  },
  adminSupportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
    backgroundColor: '#1D4ED8',
    borderWidth: 1,
    borderColor: 'rgba(96, 165, 250, 0.45)',
  },
  adminSupportBtnText: {
    flex: 1,
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 15,
    letterSpacing: 0.2,
  },
  disputedBannerText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 19,
    color: '#FECACA',
    fontWeight: '700',
  },
  escrowPanel: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: 14,
    backgroundColor: 'rgba(15, 23, 42, 0.65)',
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 39, 0.35)',
  },
  escrowPanelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  escrowPanelTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: GOLD,
  },
  revealOtpBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#2563EB',
    borderRadius: 14,
    paddingVertical: 14,
    marginBottom: 12,
  },
  revealOtpBtnText: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 16,
  },
  disputeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 14,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#B91C1C',
    borderWidth: 1,
    borderColor: 'rgba(254, 202, 202, 0.35)',
  },
  disputeBtnText: { color: '#FFFFFF', fontWeight: '800', fontSize: 14 },
  disputeModalCard: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#1E293B',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: GLASS_BORDER,
    padding: spacing.lg,
  },
  disputeModalTitle: { fontSize: 18, fontWeight: '800', color: TEXT, marginBottom: 8 },
  disputeModalSub: { fontSize: 13, color: MUTED, lineHeight: 19, marginBottom: 14 },
  disputeInput: {
    minHeight: 120,
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: GLASS_BORDER,
    padding: 14,
    fontSize: 15,
    color: TEXT,
    marginBottom: 14,
  },
  disputeSubmitBtn: {
    backgroundColor: '#B91C1C',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  disputeSubmitText: { color: '#FFFFFF', fontWeight: '800', fontSize: 16 },
  disputeCancelBtn: { alignItems: 'center', paddingVertical: 12, marginTop: 4 },
  disputeCancelText: { color: MUTED, fontWeight: '600', fontSize: 14 },
  emptyGlass: {
    alignItems: 'center',
    padding: spacing.xl,
    marginTop: spacing.lg,
    backgroundColor: GLASS,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: GLASS_BORDER,
  },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: TEXT, marginTop: 12 },
  emptySub: { fontSize: 13, color: MUTED, textAlign: 'center', marginTop: 8, lineHeight: 20 },
  errorBanner: {
    backgroundColor: 'rgba(248, 113, 113, 0.15)',
    borderRadius: 12,
    padding: 12,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: 'rgba(248, 113, 113, 0.35)',
  },
  errorText: { color: DANGER, fontSize: 13 },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  modalCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#1E293B',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: GLASS_BORDER,
    padding: spacing.lg,
    alignItems: 'center',
  },
  modalTitle: { fontSize: 20, fontWeight: '800', color: TEXT, marginTop: 12 },
  modalMessage: {
    fontSize: 14,
    color: MUTED,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 21,
  },
  modalOk: {
    marginTop: 20,
    backgroundColor: ACCENT,
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 12,
  },
  modalOkSuccess: { backgroundColor: SUCCESS },
  modalOkText: { fontWeight: '800', color: '#0F172A', fontSize: 15 },
});

export default MyOrdersScreen;
