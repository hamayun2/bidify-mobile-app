import React, { useState, useCallback, useMemo, useContext, useEffect, useLayoutEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Pressable,
  RefreshControl,
  ActivityIndicator,
  Alert,
  ScrollView,
  Dimensions,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import {
  getAdminListingsAPI,
  setListingModerationAPI,
  DEFAULT_REJECT_REASON,
} from '../api/listings';
import { getAdminPaymentsAPI } from '../api/adminFinance';
import { getAdminUsersAPI } from '../api/adminUsers';
import {
  adminGetAllTopupsAPI,
  adminApproveTopupAPI,
  adminRejectTopupAPI,
} from '../api/wallet';
import { getListingCoverUri, getListingRowKey } from '../utils/listingMedia';
import { ListingCoverImage } from '../components/ListingCoverImage';
import { formatCnicDisplay } from '../utils/pakValidation';
import SmartImage from '../components/SmartImage';
import { AuthContext } from '../context/AuthContext';
import { getSupabase, isSupabaseConfigured } from '../services/supabaseClient';
import { isAdminUser } from '../utils/userRole';
import { resetToMainApp, useAdminRootBackGuard } from '../navigation/adminNavigation';
import { fetchAdminDashboardMetrics } from '../services/adminPanelService';

const SECTIONS = [
  { key: 'overview', label: 'Overview', icon: 'bar-chart-outline' },
  { key: 'disputes', label: 'Disputes', icon: 'warning', screen: 'AdminDisputes' },
  { key: 'support', label: 'Support', icon: 'chatbubbles', screen: 'AdminSupportInbox' },
  { key: 'listings', label: 'Listings', icon: 'albums' },
  { key: 'users', label: 'Users', icon: 'people' },
  { key: 'topups', label: 'Wallets', icon: 'wallet' },
  { key: 'payments', label: 'Payments', icon: 'card' },
  { key: 'reports', label: 'Reports', icon: 'document-text-outline' },
  { key: 'settings', label: 'Settings', icon: 'settings-outline' },
];

function previewText(text, max = 72) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

const TOPUP_FILTERS = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
];

const LISTING_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Live' },
  { key: 'rejected', label: 'Rejected' },
];

const CARD_W = (Dimensions.get('window').width - 16 * 2 - 10) / 2;

function StatCard({ label, value, sub, accent }) {
  return (
    <View style={[styles.statCard, { width: CARD_W }, accent && styles.statCardAccent]}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
      {sub ? <Text style={styles.statSub}>{sub}</Text> : null}
    </View>
  );
}

function formatRs(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '0';
  return `Rs. ${x.toLocaleString()}`;
}

function formatTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return String(iso);
  }
}

const LOGOUT_ICON_COLOR = '#B91C1C';

function AdminHeaderLogoutButton({ onPress }) {
  return (
    <Pressable
      onPress={() => onPress?.()}
      hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
      style={({ pressed }) => [styles.headerLogoutBtn, pressed && styles.headerLogoutBtnPressed]}
      accessibilityRole="button"
      accessibilityLabel="Log out"
    >
      <Ionicons name="log-out-outline" size={24} color={LOGOUT_ICON_COLOR} />
    </Pressable>
  );
}

const AdminScreen = () => {
  const navigation = useNavigation();
  const { user, isLoading: authLoading, logout } = useContext(AuthContext);
  const [section, setSection] = useState('overview');

  const executeLogout = useCallback(async () => {
    try {
      if (isSupabaseConfigured()) {
        const supabase = getSupabase();
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
      }
      await logout?.({ force: true });
    } catch (e) {
      console.error('[Bidify/Admin] Logout failed', e);
      const message = e?.message || 'Failed to sign out. Please try again.';
      if (Platform.OS === 'web') {
        window.alert(`Error\n\n${message}`);
      } else {
        Alert.alert('Error', message);
      }
    }
  }, [logout]);

  const confirmLogout = useCallback(() => {
    const message = 'Are you sure you want to log out?';
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(message)) {
        void executeLogout();
      }
      return;
    }
    Alert.alert('Log out', message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Logout', style: 'destructive', onPress: () => void executeLogout() },
    ]);
  }, [executeLogout]);

  useAdminRootBackGuard(navigation, executeLogout);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => <AdminHeaderLogoutButton onPress={confirmLogout} />,
    });
  }, [navigation, confirmLogout]);

  useEffect(() => {
    if (authLoading) return;
    if (!isAdminUser(user)) {
      console.warn('[Bidify/Admin] Access denied — not an admin user');
      resetToMainApp(navigation);
    } else if (__DEV__) {
      console.log('[Bidify/Admin] Panel opened for', user?.email);
    }
  }, [user, authLoading, navigation]);

  if (authLoading || !isAdminUser(user)) {
    return (
      <View style={styles.centerBox}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }
  const [listings, setListings] = useState([]);
  const [payments, setPayments] = useState([]);
  const [users, setUsers] = useState([]);
  const [usersError, setUsersError] = useState(null);
  const [listFilter, setListFilter] = useState('pending');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [rejectTarget, setRejectTarget] = useState(null);
  const [rejectReason, setRejectReason] = useState(DEFAULT_REJECT_REASON);
  const [notice, setNotice] = useState(null);
  const [cnicViewer, setCnicViewer] = useState({ visible: false, uri: null, label: '' });
  const [topups, setTopups] = useState([]);
  const [topupFilter, setTopupFilter] = useState('pending');
  const [topupBusyId, setTopupBusyId] = useState(null);
  const [topupReceiptViewer, setTopupReceiptViewer] = useState({ visible: false, uri: null, amount: 0 });
  const [topupRejectTarget, setTopupRejectTarget] = useState(null);
  const [topupRejectReason, setTopupRejectReason] = useState('Receipt could not be verified. Please re-submit with a clearer screenshot.');
  const [escrowMetrics, setEscrowMetrics] = useState({
    totalUsers: 0,
    escrowLockedTotal: 0,
    activeDisputes: 0,
    openSupportTickets: 0,
  });
  const [userSearch, setUserSearch] = useState('');

  const showNotice = (kind, text) => {
    setNotice({ kind, text });
    setTimeout(() => setNotice(null), 4000);
  };

  const load = useCallback(async (mode = 'full') => {
    if (mode === 'pull') setRefreshing(true);
    else if (mode === 'full') setLoading(true);
    if (mode !== 'silent') setError(null);
    try {
      const [rows, pay] = await Promise.all([getAdminListingsAPI(), getAdminPaymentsAPI()]);
      setListings(Array.isArray(rows) ? rows : []);
      setPayments(Array.isArray(pay) ? pay : []);
      setError(null);
      // Users load is best-effort: a failure here should NOT block the rest
      // of the panel from showing listings / payments.
      try {
        const u = await getAdminUsersAPI();
        setUsers(Array.isArray(u) ? u : []);
        setUsersError(null);
      } catch (ue) {
        setUsers([]);
        setUsersError(ue?.message || 'Could not load registered users.');
      }
      try {
        const t = await adminGetAllTopupsAPI();
        setTopups(Array.isArray(t) ? t : []);
      } catch (_) {
        setTopups([]);
      }
      try {
        setEscrowMetrics(await fetchAdminDashboardMetrics());
      } catch (_) {
        setEscrowMetrics({
          totalUsers: users.length,
          escrowLockedTotal: 0,
          activeDisputes: 0,
          openSupportTickets: 0,
        });
      }
    } catch (e) {
      if (mode !== 'silent') {
        const msg = e?.message || 'Could not load admin data';
        setError(typeof msg === 'string' ? msg : 'Admin access may be required on the server.');
        setListings([]);
        setPayments([]);
      }
    } finally {
      if (mode === 'pull') setRefreshing(false);
      else if (mode === 'full') setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load('full');
    }, [load])
  );

  const listingCounts = useMemo(() => {
    const c = { all: listings.length, pending: 0, approved: 0, rejected: 0 };
    for (const item of listings) {
      const s = item.moderationStatus || 'approved';
      if (s === 'pending') c.pending += 1;
      else if (s === 'rejected') c.rejected += 1;
      else c.approved += 1;
    }
    return c;
  }, [listings]);

  const paymentStats = useMemo(() => {
    const buyNows = payments.filter((p) => p.kind === 'buy_now' || p.type === 'buy_now');
    const bids = payments.filter((p) => p.kind === 'auction_bid' || p.type === 'auction_bid');
    const revenue = buyNows.reduce((s, p) => s + Number(p.amount ?? 0), 0);
    const bidVolume = bids.reduce((s, p) => s + Number(p.amount ?? 0), 0);
    return {
      checkoutCount: buyNows.length,
      revenue,
      bidCount: bids.length,
      bidVolume,
    };
  }, [payments]);

  const visibleListings = useMemo(() => {
    if (listFilter === 'all') return listings;
    return listings.filter((item) => (item.moderationStatus || 'approved') === listFilter);
  }, [listings, listFilter]);

  const recentActivity = useMemo(() => payments.slice(0, 8), [payments]);

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => {
      const hay = [u.fullName, u.email, u.phone, u.id, u.cnic]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [users, userSearch]);

  const onApprove = async (item) => {
    if (busyId) return;
    setBusyId(item.id);
    setListings((prev) =>
      prev.map((row) =>
        String(row.id) === String(item.id)
          ? { ...row, moderationStatus: 'approved', status: 'active', rejectionReason: null }
          : row
      )
    );
    try {
      await setListingModerationAPI(item.id, 'approved');
      showNotice('success', `"${item.title || 'Listing'}" is live for everyone now.`);
      load('silent');
    } catch (err) {
      setListings((prev) =>
        prev.map((row) =>
          String(row.id) === String(item.id)
            ? { ...row, moderationStatus: 'pending', status: 'pending_review' }
            : row
        )
      );
      const m =
        (err && (err.message || err.error || err.detail)) ||
        'Could not approve. Make sure you are signed in as admin (admin@bidify.com).';
      showNotice('error', typeof m === 'string' ? m : 'Approve failed');
    } finally {
      setBusyId(null);
    }
  };

  const openRejectModal = (item) => {
    setRejectTarget(item);
    setRejectReason(DEFAULT_REJECT_REASON);
  };

  const closeRejectModal = () => {
    setRejectTarget(null);
    setRejectReason(DEFAULT_REJECT_REASON);
  };

  const submitReject = async () => {
    if (!rejectTarget) return;
    const item = rejectTarget;
    const reason = (rejectReason || '').trim() || DEFAULT_REJECT_REASON;
    closeRejectModal();
    setBusyId(item.id);
    setListings((prev) =>
      prev.map((row) =>
        String(row.id) === String(item.id)
          ? { ...row, moderationStatus: 'rejected', status: 'rejected', rejectionReason: reason }
          : row
      )
    );
    try {
      await setListingModerationAPI(item.id, 'rejected', { reason });
      showNotice('success', 'Listing rejected. The seller will see your message.');
      load('silent');
    } catch (err) {
      setListings((prev) =>
        prev.map((row) =>
          String(row.id) === String(item.id)
            ? { ...row, moderationStatus: 'pending', status: 'pending_review', rejectionReason: null }
            : row
        )
      );
      const m =
        (err && (err.message || err.error || err.detail)) ||
        'Could not reject. Make sure you are signed in as admin.';
      showNotice('error', typeof m === 'string' ? m : 'Reject failed');
    } finally {
      setBusyId(null);
    }
  };

  const statusStyle = (s) => {
    if (s === 'pending') return styles.badgePending;
    if (s === 'rejected') return styles.badgeRejected;
    return styles.badgeApproved;
  };

  const filteredTopups = React.useMemo(() => {
    return topups.filter((t) => (t.status || 'pending') === topupFilter);
  }, [topups, topupFilter]);

  const topupCounts = React.useMemo(() => {
    const c = { pending: 0, approved: 0, rejected: 0 };
    for (const t of topups) {
      const s = t.status || 'pending';
      if (c[s] != null) c[s] += 1;
    }
    return c;
  }, [topups]);

  const handleApproveTopup = async (item) => {
    if (topupBusyId) return;
    setTopupBusyId(item.id);
    setTopups((prev) =>
      prev.map((row) => (row.id === item.id ? { ...row, status: 'approved' } : row))
    );
    try {
      await adminApproveTopupAPI(item.id);
      showNotice('success', `Top-up of Rs. ${Number(item.amount).toLocaleString()} approved.`);
      load('silent');
    } catch (e) {
      setTopups((prev) =>
        prev.map((row) => (row.id === item.id ? { ...row, status: 'pending' } : row))
      );
      showNotice('error', e?.message || 'Could not approve top-up.');
    } finally {
      setTopupBusyId(null);
    }
  };

  const confirmRejectTopup = async () => {
    const target = topupRejectTarget;
    if (!target) return;
    const reason = topupRejectReason.trim() || 'Top-up rejected by admin.';
    setTopupBusyId(target.id);
    setTopupRejectTarget(null);
    setTopups((prev) =>
      prev.map((row) =>
        row.id === target.id ? { ...row, status: 'rejected', rejectionReason: reason } : row
      )
    );
    try {
      await adminRejectTopupAPI(target.id, reason);
      showNotice('success', 'Top-up rejected.');
      load('silent');
    } catch (e) {
      setTopups((prev) =>
        prev.map((row) =>
          row.id === target.id ? { ...row, status: 'pending', rejectionReason: null } : row
        )
      );
      showNotice('error', e?.message || 'Could not reject top-up.');
    } finally {
      setTopupBusyId(null);
    }
  };

  const renderListing = ({ item, index }) => {
    const uri = getListingCoverUri(item);
    const rowKey = getListingRowKey(item, index);
    const mod = item.moderationStatus || 'approved';
    const sid = item.sellerId != null ? String(item.sellerId) : '—';
    const isLive = mod === 'approved';
    return (
      <View style={styles.card}>
        <TouchableOpacity
          style={styles.cardTopRow}
          activeOpacity={0.85}
          onPress={() => navigation.navigate('ListingDetail', { listing: item })}
        >
          <ListingCoverImage uri={uri} style={styles.thumb} recycleKey={rowKey} />
          <View style={styles.cardBody}>
            <Text style={styles.cardTitle} numberOfLines={1}>
              {item.title}
            </Text>
            {item.description ? (
              <Text style={styles.cardPreview} numberOfLines={2}>
                {previewText(item.description)}
              </Text>
            ) : null}
            <Text style={styles.meta} numberOfLines={1}>
              Seller · {sid.slice(0, 8)}…
            </Text>
            <Text style={styles.meta}>
              {item.type === 'auction' ? 'Auction' : 'Buy now'} · {formatRs(item.price ?? 0)}
            </Text>
            <View style={[styles.badge, statusStyle(mod)]}>
              <Text style={styles.badgeText}>{isLive ? 'Live on app' : mod}</Text>
            </View>
          </View>
          {busyId === item.id ? (
            <ActivityIndicator style={styles.rowSpinner} color="#007AFF" />
          ) : (
            <Ionicons name="chevron-forward" size={20} color="#ccc" />
          )}
        </TouchableOpacity>

        {mod === 'pending' && (
          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.btn, styles.btnApprove, busyId === item.id && styles.btnDisabled]}
              disabled={busyId === item.id}
              activeOpacity={0.7}
              onPress={() => onApprove(item)}
            >
              <Ionicons name="checkmark-circle" size={18} color="#1b5e20" />
              <Text style={styles.btnApproveText}> Approve — go live</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, styles.btnReject, busyId === item.id && styles.btnDisabled]}
              disabled={busyId === item.id}
              activeOpacity={0.7}
              onPress={() => openRejectModal(item)}
            >
              <Text style={styles.btnRejectText}>Reject</Text>
            </TouchableOpacity>
          </View>
        )}

        {mod === 'rejected' && item.rejectionReason ? (
          <Text style={styles.rejectReasonText} numberOfLines={3}>
            Reason: {item.rejectionReason}
          </Text>
        ) : null}
      </View>
    );
  };

  const renderPayment = ({ item }) => {
    const kind = item.kind || item.type || 'payment';
    const isBuy = kind === 'buy_now';
    return (
      <View style={styles.payCard}>
        <View style={[styles.payIcon, isBuy ? styles.payIconBuy : styles.payIconBid]}>
          <Ionicons name={isBuy ? 'bag-check-outline' : 'trending-up-outline'} size={20} color={isBuy ? '#1565c0' : '#6a1b9a'} />
        </View>
        <View style={styles.payBody}>
          <Text style={styles.payTitle} numberOfLines={1}>
            {isBuy ? 'Buy now checkout' : 'Auction bid'}
          </Text>
          <Text style={styles.paySub} numberOfLines={1}>
            {item.listingTitle || `Listing ${item.listingId || '—'}`}
          </Text>
          <Text style={styles.payMeta}>
            {formatRs(item.amount)} · {item.buyerName || item.buyerId || 'Buyer'}
          </Text>
        </View>
        <Text style={styles.payTime}>{formatTime(item.createdAt)}</Text>
      </View>
    );
  };

  const openCnic = (uri, label) => {
    if (!uri) return;
    setCnicViewer({ visible: true, uri, label });
  };

  const renderUser = ({ item }) => {
    const verified = !!(item.cnicVerifiedAt || (item.cnicFrontUrl && item.cnicBackUrl));
    const cnicDisplay = item.cnic ? formatCnicDisplay(item.cnic) : '—';
    const isAdmin = item.role === 'admin';
    return (
      <TouchableOpacity
        style={styles.userCard}
        activeOpacity={0.9}
        onPress={() =>
          navigation.navigate('AdminUserDetail', {
            userId: item.id,
            displayName: item.fullName || item.email || 'User',
          })
        }
      >
        <View style={styles.userHeaderRow}>
          <View style={styles.userAvatar}>
            <Text style={styles.userAvatarText}>
              {(item.fullName || item.email || '?').slice(0, 1).toUpperCase()}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.userName} numberOfLines={1}>
              {item.fullName || '—'}
            </Text>
            <Text style={styles.userEmail} numberOfLines={1}>
              {item.email || '—'}
            </Text>
          </View>
          {isAdmin ? (
            <View style={[styles.userPill, styles.userPillAdmin]}>
              <Ionicons name="shield-checkmark" size={12} color="#fff" />
              <Text style={styles.userPillTextLight}>Admin</Text>
            </View>
          ) : verified ? (
            <View style={[styles.userPill, styles.userPillVerified]}>
              <Ionicons name="checkmark-circle" size={12} color="#1b5e20" />
              <Text style={styles.userPillText}>Verified</Text>
            </View>
          ) : (
            <View style={[styles.userPill, styles.userPillPending]}>
              <Text style={styles.userPillText}>Pending</Text>
            </View>
          )}
        </View>

        <View style={styles.userInfoRow}>
          <Ionicons name="call-outline" size={14} color="#666" />
          <Text style={styles.userInfoText}>{item.phone || 'No phone'}</Text>
        </View>
        <View style={styles.userInfoRow}>
          <Ionicons name="card-outline" size={14} color="#666" />
          <Text style={styles.userInfoText}>{cnicDisplay}</Text>
        </View>

        {(item.cnicFrontUrl || item.cnicBackUrl) ? (
          <View style={styles.cnicGrid}>
            <TouchableOpacity
              style={styles.cnicCell}
              activeOpacity={0.85}
              disabled={!item.cnicFrontUrl}
              onPress={() => openCnic(item.cnicFrontUrl, `${item.fullName || item.email} — CNIC Front`)}
            >
              {item.cnicFrontUrl ? (
                <SmartImage
                  uri={item.cnicFrontUrl}
                  style={styles.cnicImg}
                  resizeMode="cover"
                  placeholder={<Ionicons name="image-outline" size={22} color="#bbb" />}
                />
              ) : (
                <View style={[styles.cnicImg, styles.cnicImgEmpty]}>
                  <Ionicons name="image-outline" size={22} color="#bbb" />
                </View>
              )}
              <Text style={styles.cnicCellLabel}>Front</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.cnicCell}
              activeOpacity={0.85}
              disabled={!item.cnicBackUrl}
              onPress={() => openCnic(item.cnicBackUrl, `${item.fullName || item.email} — CNIC Back`)}
            >
              {item.cnicBackUrl ? (
                <SmartImage
                  uri={item.cnicBackUrl}
                  style={styles.cnicImg}
                  resizeMode="cover"
                  placeholder={<Ionicons name="image-outline" size={22} color="#bbb" />}
                />
              ) : (
                <View style={[styles.cnicImg, styles.cnicImgEmpty]}>
                  <Ionicons name="image-outline" size={22} color="#bbb" />
                </View>
              )}
              <Text style={styles.cnicCellLabel}>Back</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <Text style={styles.cnicEmptyHint}>No CNIC images uploaded.</Text>
        )}
        <View style={styles.userWalletHint}>
          <Ionicons name="wallet-outline" size={14} color="#1E3A8A" />
          <Text style={styles.userWalletHintText}>Tap for wallet & transaction history</Text>
          <Ionicons name="chevron-forward" size={16} color="#94A3B8" />
        </View>
      </TouchableOpacity>
    );
  };

  const renderOverview = () => (
    <ScrollView
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load('pull')} />}
      contentContainerStyle={styles.overviewPad}
    >
      <Text style={styles.dashboardTitle}>Admin dashboard</Text>
      <Text style={styles.dashboardSub}>Escrow disputes, support inbox, users, and marketplace moderation.</Text>
      <Text style={styles.sectionHeading}>Escrow & support</Text>
      <View style={styles.statRow}>
        <StatCard label="Total users" value={String(escrowMetrics.totalUsers)} />
        <StatCard
          label="Escrow locked"
          value={formatRs(escrowMetrics.escrowLockedTotal)}
          sub="Held in disputed orders"
          accent
        />
      </View>
      <View style={styles.statRow}>
        <StatCard label="Active disputes" value={String(escrowMetrics.activeDisputes)} />
        <StatCard label="Open support tickets" value={String(escrowMetrics.openSupportTickets)} />
      </View>
      <View style={styles.hubRow}>
        {[
          { screen: 'AdminDisputes', icon: 'warning', label: 'Disputes', sub: `${escrowMetrics.activeDisputes} active` },
          { screen: 'AdminSupportInbox', icon: 'chatbubbles', label: 'Support inbox', sub: `${escrowMetrics.openSupportTickets} awaiting` },
          { key: 'listings', icon: 'albums', label: 'Listings', sub: `${listingCounts.pending} pending` },
          { key: 'users', icon: 'people', label: 'Users', sub: `${escrowMetrics.totalUsers || users.length} registered` },
          { key: 'topups', icon: 'wallet', label: 'Top-ups', sub: `${topupCounts.pending} pending` },
          { key: 'payments', icon: 'card', label: 'Payments', sub: `${payments.length} records` },
        ].map((hub) => (
          <TouchableOpacity
            key={hub.screen || hub.key}
            style={styles.hubCard}
            activeOpacity={0.85}
            onPress={() => {
              if (hub.screen) navigation.navigate(hub.screen);
              else setSection(hub.key);
            }}
          >
            <Ionicons name={hub.icon} size={22} color="#111" />
            <Text style={styles.hubLabel}>{hub.label}</Text>
            <Text style={styles.hubSub} numberOfLines={1}>
              {hub.sub}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.sectionHeading}>Marketplace</Text>
      <View style={styles.statRow}>
        <StatCard label="Total listings" value={String(listingCounts.all)} />
        <StatCard label="Pending review" value={String(listingCounts.pending)} accent />
      </View>
      <View style={styles.statRow}>
        <StatCard label="Live on app" value={String(listingCounts.approved)} />
        <StatCard label="Rejected" value={String(listingCounts.rejected)} />
      </View>
      <View style={styles.statRow}>
        <StatCard
          label="Buy-now checkouts"
          value={String(paymentStats.checkoutCount)}
          sub="Completed sales"
        />
        <StatCard
          label="Checkout revenue"
          value={formatRs(paymentStats.revenue)}
          sub="Sum of buy now"
          accent
        />
      </View>
      <View style={styles.statRow}>
        <StatCard label="Auction bids logged" value={String(paymentStats.bidCount)} sub="Activity" />
        <StatCard
          label="Bid volume"
          value={formatRs(paymentStats.bidVolume)}
          sub="Sum of bid amounts"
        />
      </View>
      <Text style={styles.sectionHeading}>Recent activity</Text>
      {recentActivity.length === 0 ? (
        <Text style={styles.emptyHint}>
          No payments or bids recorded yet. Buys and bids appear here as users complete them (and sync from your server at GET /admin/payments if configured).
        </Text>
      ) : (
        recentActivity.map((item) => (
          <View key={item.id || `${item.createdAt}-${item.listingId}`}>{renderPayment({ item })}</View>
        ))
      )}
    </ScrollView>
  );

  const renderSectionTabs = () => (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.sectionTabsScroll}
      contentContainerStyle={styles.sectionTabs}
    >
      {SECTIONS.map((s) => {
        const active = section === s.key;
        return (
          <TouchableOpacity
            key={s.key}
            style={[styles.sectionTab, active && styles.sectionTabActive]}
            onPress={() => {
              if (s.screen) navigation.navigate(s.screen);
              else setSection(s.key);
            }}
          >
            <Ionicons name={s.icon} size={16} color={active ? '#fff' : '#555'} />
            <Text style={[styles.sectionTabText, active && styles.sectionTabTextActive]}>{s.label}</Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );

  if (error && section === 'overview' && listings.length === 0 && payments.length === 0) {
    return (
      <View style={styles.container}>
        {renderSectionTabs()}
        <View style={styles.centerBox}>
          <Ionicons name="warning-outline" size={40} color="#c62828" />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => load('full')}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (loading && listings.length === 0 && payments.length === 0) {
    return (
      <View style={styles.container}>
        {renderSectionTabs()}
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color="#007AFF" />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {renderSectionTabs()}
      {notice ? (
        <View
          style={[
            styles.noticeBar,
            notice.kind === 'error' ? styles.noticeBarError : styles.noticeBarSuccess,
          ]}
        >
          <Ionicons
            name={notice.kind === 'error' ? 'alert-circle' : 'checkmark-circle'}
            size={18}
            color={notice.kind === 'error' ? '#b71c1c' : '#1b5e20'}
          />
          <Text
            style={[
              styles.noticeText,
              notice.kind === 'error' ? styles.noticeTextError : styles.noticeTextSuccess,
            ]}
            numberOfLines={2}
          >
            {notice.text}
          </Text>
        </View>
      ) : null}
      {section === 'overview' && renderOverview()}
      {section === 'listings' && (
        <>
          <FlatList
            horizontal
            data={LISTING_FILTERS}
            keyExtractor={(f) => f.key}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipsRow}
            renderItem={({ item: f }) => (
              <TouchableOpacity
                style={[styles.chip, listFilter === f.key && styles.chipActive]}
                onPress={() => setListFilter(f.key)}
              >
                <Text style={[styles.chipLabel, listFilter === f.key && styles.chipLabelActive]}>{f.label}</Text>
              </TouchableOpacity>
            )}
          />
          <FlatList
            data={visibleListings}
            keyExtractor={(item, index) => getListingRowKey(item, index)}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load('pull')} />}
            contentContainerStyle={styles.listPad}
            ListHeaderComponent={
              <Text style={styles.listHint}>
                Approve a listing to send it live on Home & Search. Pending items are hidden from buyers until you tap “Approve — go live”.
              </Text>
            }
            ListEmptyComponent={<Text style={styles.empty}>No listings in this filter.</Text>}
            renderItem={renderListing}
          />
        </>
      )}
      <Modal
        animationType="fade"
        transparent
        visible={!!rejectTarget}
        onRequestClose={closeRejectModal}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalOverlay}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Reject listing</Text>
            <Text style={styles.modalSub} numberOfLines={2}>
              {rejectTarget?.title || 'Listing'}
            </Text>
            <Text style={styles.modalLabel}>Message to seller</Text>
            <TextInput
              style={styles.modalInput}
              multiline
              value={rejectReason}
              onChangeText={setRejectReason}
              placeholder={DEFAULT_REJECT_REASON}
              placeholderTextColor="#888"
            />
            <Text style={styles.modalHint}>
              The seller will see this message on their listing. Leave it as the default if it fits.
            </Text>
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalBtnGhost} onPress={closeRejectModal}>
                <Text style={styles.modalBtnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalBtnDanger} onPress={submitReject}>
                <Text style={styles.modalBtnDangerText}>Reject &amp; notify seller</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {section === 'topups' && (
        <FlatList
          data={filteredTopups}
          keyExtractor={(t) => String(t.id)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load('pull')} />}
          contentContainerStyle={styles.listPad}
          ListHeaderComponent={
            <View>
              <Text style={styles.payHeaderTitle}>Pending transactions</Text>
              <Text style={styles.payHeaderSub}>
                {topupCounts.pending} pending · {topupCounts.approved} approved · {topupCounts.rejected} rejected
              </Text>
              <View style={styles.chipRow}>
                {TOPUP_FILTERS.map((f) => (
                  <TouchableOpacity
                    key={f.key}
                    style={[styles.chip, topupFilter === f.key && styles.chipActive]}
                    onPress={() => setTopupFilter(f.key)}
                  >
                    <Text style={[styles.chipLabel, topupFilter === f.key && styles.chipLabelActive]}>
                      {f.label}
                      {f.key === 'pending' && topupCounts.pending > 0 ? `  (${topupCounts.pending})` : ''}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          }
          ListEmptyComponent={
            <Text style={styles.empty}>
              No {topupFilter} top-up requests.
            </Text>
          }
          renderItem={({ item }) => {
            const isBusy = topupBusyId === item.id;
            return (
              <View style={styles.topupCard}>
                <View style={styles.topupHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.topupAmount}>{formatRs(item.amount)}</Text>
                    <Text style={styles.topupMeta}>
                      {(item.provider || 'easypaisa').toUpperCase()} · {formatTime(item.createdAt)}
                    </Text>
                  </View>
                  <View style={[styles.statusBadge, statusStyle(item.status)]}>
                    <Text style={styles.statusBadgeText}>{(item.status || 'pending').toUpperCase()}</Text>
                  </View>
                </View>

                <View style={styles.topupUserBlock}>
                  <Text style={styles.topupUserName}>{item.userName || item.userEmail || item.userId}</Text>
                  {item.userEmail ? <Text style={styles.topupUserMeta}>{item.userEmail}</Text> : null}
                  {item.userPhone ? <Text style={styles.topupUserMeta}>{item.userPhone}</Text> : null}
                </View>

                {item.screenshotUrl ? (
                  <TouchableOpacity
                    onPress={() =>
                      setTopupReceiptViewer({
                        visible: true,
                        uri: item.screenshotUrl,
                        amount: item.amount,
                      })
                    }
                    activeOpacity={0.85}
                  >
                    <SmartImage uri={item.screenshotUrl} style={styles.topupThumb} resizeMode="cover" />
                    <Text style={styles.topupThumbHint}>Tap to view full receipt</Text>
                  </TouchableOpacity>
                ) : (
                  <Text style={styles.topupNoReceipt}>No receipt uploaded.</Text>
                )}

                {item.rejectionReason ? (
                  <Text style={styles.topupRejectReason}>Reason: {item.rejectionReason}</Text>
                ) : null}

                {item.status === 'pending' && (
                  <View style={styles.topupActions}>
                    <TouchableOpacity
                      style={[styles.actionBtn, styles.actionReject, isBusy && styles.actionBusy]}
                      onPress={() => setTopupRejectTarget(item)}
                      disabled={isBusy}
                    >
                      <Ionicons name="close-circle-outline" size={16} color="#fff" />
                      <Text style={styles.actionText}>Reject</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.actionBtn, styles.actionApprove, isBusy && styles.actionBusy]}
                      onPress={() => handleApproveTopup(item)}
                      disabled={isBusy}
                    >
                      <Ionicons name="checkmark-circle-outline" size={16} color="#fff" />
                      <Text style={styles.actionText}>Approve & Credit</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            );
          }}
        />
      )}

      {/* Full-screen receipt viewer */}
      <Modal
        visible={topupReceiptViewer.visible}
        transparent
        animationType="fade"
        onRequestClose={() => setTopupReceiptViewer({ visible: false, uri: null, amount: 0 })}
      >
        <View style={styles.viewerBackdrop}>
          <TouchableOpacity
            style={styles.viewerClose}
            onPress={() => setTopupReceiptViewer({ visible: false, uri: null, amount: 0 })}
          >
            <Ionicons name="close" size={22} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.viewerCaption}>
            Top-up receipt · {formatRs(topupReceiptViewer.amount)}
          </Text>
          {topupReceiptViewer.uri ? (
            <SmartImage
              uri={topupReceiptViewer.uri}
              style={styles.viewerImage}
              resizeMode="contain"
            />
          ) : null}
        </View>
      </Modal>

      {/* Reject reason modal */}
      <Modal
        visible={!!topupRejectTarget}
        transparent
        animationType="slide"
        onRequestClose={() => setTopupRejectTarget(null)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.rejectBackdrop}
        >
          <View style={styles.rejectCard}>
            <Text style={styles.rejectTitle}>Reject top-up</Text>
            <Text style={styles.rejectSub}>
              Tell the user why this receipt was rejected.
            </Text>
            <TextInput
              value={topupRejectReason}
              onChangeText={setTopupRejectReason}
              multiline
              style={styles.rejectInput}
              placeholder="Reason"
              placeholderTextColor="#999"
            />
            <View style={styles.rejectActions}>
              <TouchableOpacity
                style={[styles.actionBtn, styles.actionGhost]}
                onPress={() => setTopupRejectTarget(null)}
              >
                <Text style={[styles.actionText, { color: '#222' }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionBtn, styles.actionReject]}
                onPress={confirmRejectTopup}
              >
                <Text style={styles.actionText}>Confirm Reject</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {section === 'users' && (
        <FlatList
          data={filteredUsers}
          keyExtractor={(u, i) => String(u.id || u.email || i)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load('pull')} />}
          contentContainerStyle={styles.listPad}
          ListHeaderComponent={
            <View>
              <Text style={styles.payHeaderTitle}>Registered users</Text>
              <Text style={styles.payHeaderSub}>
                {users.length} profile{users.length === 1 ? '' : 's'} on file. Tap a user for wallet ledger; CNIC images open full-screen.
              </Text>
              <TextInput
                style={styles.userSearchInput}
                value={userSearch}
                onChangeText={setUserSearch}
                placeholder="Search name, email, phone, or ID…"
                placeholderTextColor="#999"
                autoCapitalize="none"
                autoCorrect={false}
              />
              {usersError ? (
                <Text style={[styles.errorText, { marginTop: 8, textAlign: 'left', color: '#b71c1c' }]}>
                  {usersError}
                </Text>
              ) : null}
            </View>
          }
          ListEmptyComponent={
            <Text style={styles.empty}>
              {usersError ? 'Could not load users.' : 'No users have registered yet.'}
            </Text>
          }
          renderItem={renderUser}
        />
      )}

      {/* CNIC full-screen viewer */}
      <Modal
        visible={cnicViewer.visible}
        transparent
        animationType="fade"
        onRequestClose={() => setCnicViewer({ visible: false, uri: null, label: '' })}
      >
        <View style={styles.cnicViewerBg}>
          <View style={styles.cnicViewerHeader}>
            <TouchableOpacity
              style={styles.cnicViewerClose}
              onPress={() => setCnicViewer({ visible: false, uri: null, label: '' })}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <Ionicons name="close" size={24} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.cnicViewerTitle} numberOfLines={1}>
              {cnicViewer.label || 'CNIC'}
            </Text>
          </View>
          {cnicViewer.uri ? (
            <SmartImage
              uri={cnicViewer.uri}
              style={styles.cnicViewerImage}
              resizeMode="contain"
              placeholder={
                <View style={styles.cnicViewerEmpty}>
                  <Ionicons name="image-outline" size={48} color="#ccc" />
                  <Text style={styles.cnicViewerEmptyText}>
                    Could not load this image — the upload may have failed or the URL has expired.
                  </Text>
                </View>
              }
            />
          ) : null}
        </View>
      </Modal>

      {section === 'payments' && (
        <FlatList
          data={payments}
          keyExtractor={(item, i) => String(item.id || item.createdAt || i)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load('pull')} />}
          contentContainerStyle={styles.listPad}
          ListHeaderComponent={
            <View style={styles.payHeader}>
              <Text style={styles.payHeaderTitle}>Payment & bid log</Text>
              <Text style={styles.payHeaderSub}>
                {paymentStats.checkoutCount} checkouts · {formatRs(paymentStats.revenue)} revenue ·{' '}
                {paymentStats.bidCount} bids logged
              </Text>
            </View>
          }
          ListEmptyComponent={
            <Text style={styles.empty}>No transactions yet. Buy-now purchases and auction bids show here.</Text>
          }
          renderItem={renderPayment}
        />
      )}

      {section === 'reports' && (
        <ScrollView
          contentContainerStyle={styles.listPad}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load('pull')} />}
        >
          <Text style={styles.payHeaderTitle}>Reports</Text>
          <Text style={styles.payHeaderSub}>Summary metrics from listings and payments.</Text>
          <View style={styles.statRow}>
            <StatCard label="Users" value={String(users.length)} />
            <StatCard label="Listings" value={String(listingCounts.all)} />
          </View>
          <View style={styles.statRow}>
            <StatCard label="Revenue" value={formatRs(paymentStats.revenue)} accent />
            <StatCard label="Bid volume" value={formatRs(paymentStats.bidVolume)} />
          </View>
          <View style={[styles.compactCard, { marginTop: 12 }]}>
            <Text style={styles.compactCardTitle}>Activity snapshot</Text>
            <Text style={styles.compactCardMeta}>
              {paymentStats.checkoutCount} buy-now · {paymentStats.bidCount} bids · {topupCounts.pending}{' '}
              wallet requests pending
            </Text>
          </View>
        </ScrollView>
      )}

      {section === 'settings' && (
        <ScrollView contentContainerStyle={styles.listPad}>
          <Text style={styles.payHeaderTitle}>Settings</Text>
          <Text style={styles.payHeaderSub}>Built-in admin and payment configuration.</Text>
          <View style={styles.compactCard}>
            <Text style={styles.compactCardTitle}>Built-in admin</Text>
            <Text style={styles.compactCardMeta}>
              Login with admin@bidify.com (or EXPO_PUBLIC_BUILTIN_ADMIN_EMAIL). Admin accounts cannot register via
              Sign Up.
            </Text>
          </View>
          <View style={[styles.compactCard, { marginTop: 10 }]}>
            <Text style={styles.compactCardTitle}>Stripe test mode</Text>
            <Text style={styles.compactCardMeta}>
              Set STRIPE_TEST_SECRET_KEY on the Express API (sk_test_…). Wallet top-ups open Stripe Checkout in the
              browser; balance updates after payment.
            </Text>
          </View>
          <View style={[styles.compactCard, { marginTop: 10 }]}>
            <Text style={styles.compactCardTitle}>Supabase SQL</Text>
            <Text style={styles.compactCardMeta}>
              Run supabase/builtin_admin.sql and schema.sql in the SQL Editor for roles, RLS, and wallet_transactions.
            </Text>
          </View>
        </ScrollView>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  headerLogoutBtn: {
    marginRight: Platform.OS === 'ios' ? 4 : 12,
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerLogoutBtnPressed: {
    opacity: 0.55,
  },
  container: {
    flex: 1,
    backgroundColor: '#f0f4f8',
  },
  sectionTabsScroll: {
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e5ea',
    maxHeight: 52,
  },
  sectionTabs: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
    alignItems: 'center',
  },
  sectionTab: {
    flexGrow: 0,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#eef2f6',
  },
  sectionTabActive: {
    backgroundColor: '#007AFF',
  },
  sectionTabText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#333',
  },
  sectionTabTextActive: {
    color: '#fff',
  },
  dashboardTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#1a1a1a',
    marginBottom: 6,
  },
  dashboardSub: {
    fontSize: 13,
    color: '#666',
    marginBottom: 14,
    lineHeight: 18,
  },
  hubRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginBottom: 12,
    gap: 8,
  },
  hubCard: {
    width: '48%',
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: '#e8ecf0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  hubLabel: { fontSize: 15, fontWeight: '800', color: '#111', marginTop: 8 },
  hubSub: { fontSize: 12, color: '#666', marginTop: 2 },
  compactCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e8ecf0',
  },
  compactCardTitle: { fontSize: 15, fontWeight: '700', color: '#111', marginBottom: 6 },
  compactCardMeta: { fontSize: 13, color: '#555', lineHeight: 18 },
  overviewPad: {
    padding: 16,
    paddingBottom: 32,
  },
  statRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  statCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },
  statCardAccent: {
    borderWidth: 1,
    borderColor: '#b3d7ff',
    backgroundColor: '#f3f9ff',
  },
  statValue: {
    fontSize: 22,
    fontWeight: '800',
    color: '#0d47a1',
  },
  statLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#444',
    marginTop: 4,
  },
  statSub: {
    fontSize: 11,
    color: '#666',
    marginTop: 2,
  },
  sectionHeading: {
    fontSize: 17,
    fontWeight: '800',
    color: '#222',
    marginTop: 8,
    marginBottom: 10,
  },
  emptyHint: {
    fontSize: 14,
    color: '#666',
    lineHeight: 20,
  },
  chipsRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#fff',
    marginRight: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  chipActive: {
    backgroundColor: '#007AFF',
    borderColor: '#007AFF',
  },
  chipLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#333',
  },
  chipLabelActive: {
    color: '#fff',
  },
  listPad: {
    padding: 12,
    paddingBottom: 32,
  },
  listHint: {
    fontSize: 13,
    color: '#555',
    lineHeight: 19,
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  card: {
    flexDirection: 'column',
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 12,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 2,
  },
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  thumb: {
    width: 76,
    height: 76,
    borderRadius: 10,
    backgroundColor: '#eee',
  },
  thumbPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: {
    flex: 1,
    marginLeft: 12,
    marginRight: 8,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#222',
  },
  cardPreview: {
    fontSize: 12,
    color: '#777',
    marginTop: 4,
    lineHeight: 16,
  },
  meta: {
    fontSize: 12,
    color: '#666',
    marginTop: 2,
  },
  badge: {
    alignSelf: 'flex-start',
    marginTop: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgePending: {
    backgroundColor: '#fff4e5',
  },
  badgeApproved: {
    backgroundColor: '#e8f5e9',
  },
  badgeRejected: {
    backgroundColor: '#ffebee',
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'capitalize',
    color: '#333',
  },
  actions: {
    flexDirection: 'row',
    marginTop: 10,
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
  },
  btnApprove: {
    backgroundColor: '#c8e6c9',
  },
  btnApproveText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#1b5e20',
  },
  btnReject: {
    backgroundColor: '#ffcdd2',
    paddingHorizontal: 14,
  },
  btnRejectText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#b71c1c',
  },
  btnDisabled: {
    opacity: 0.55,
  },
  noticeBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  noticeBarSuccess: {
    backgroundColor: '#e8f5e9',
    borderBottomColor: '#c8e6c9',
  },
  noticeBarError: {
    backgroundColor: '#fdecea',
    borderBottomColor: '#f5c6c6',
  },
  noticeText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
  },
  noticeTextSuccess: {
    color: '#1b5e20',
  },
  noticeTextError: {
    color: '#b71c1c',
  },
  rowSpinner: {
    marginLeft: 4,
  },
  centerBox: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  errorText: {
    marginTop: 12,
    fontSize: 15,
    color: '#333',
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: 16,
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: '#007AFF',
    borderRadius: 8,
  },
  retryText: {
    color: '#fff',
    fontWeight: '700',
  },
  empty: {
    textAlign: 'center',
    marginTop: 40,
    color: '#888',
    fontSize: 15,
  },
  payHeader: {
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  payHeaderTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#1a1a1a',
  },
  payHeaderSub: {
    fontSize: 13,
    color: '#555',
    marginTop: 4,
  },
  payCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
  },
  payIcon: {
    width: 44,
    height: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  payIconBuy: {
    backgroundColor: '#e3f2fd',
  },
  payIconBid: {
    backgroundColor: '#f3e5f5',
  },
  payBody: {
    flex: 1,
    marginLeft: 12,
  },
  payTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#222',
  },
  paySub: {
    fontSize: 12,
    color: '#666',
    marginTop: 2,
  },
  payMeta: {
    fontSize: 12,
    color: '#007AFF',
    fontWeight: '600',
    marginTop: 4,
  },
  payTime: {
    fontSize: 10,
    color: '#999',
    marginLeft: 8,
    maxWidth: 72,
    textAlign: 'right',
  },
  rejectReasonText: {
    marginTop: 8,
    fontSize: 12,
    color: '#b71c1c',
    fontStyle: 'italic',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 460,
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 18,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 6,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#222',
  },
  modalSub: {
    fontSize: 13,
    color: '#555',
    marginTop: 4,
    marginBottom: 14,
  },
  modalLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#333',
    marginBottom: 6,
  },
  modalInput: {
    minHeight: 90,
    borderWidth: 1,
    borderColor: '#d0d4d9',
    borderRadius: 10,
    padding: 12,
    fontSize: 14,
    color: '#222',
    textAlignVertical: 'top',
    backgroundColor: '#f9f9fb',
  },
  modalHint: {
    fontSize: 12,
    color: '#666',
    marginTop: 8,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 16,
    gap: 8,
  },
  modalBtnGhost: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
  },
  modalBtnGhostText: {
    color: '#555',
    fontWeight: '700',
  },
  modalBtnDanger: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#c62828',
  },
  modalBtnDangerText: {
    color: '#fff',
    fontWeight: '700',
  },

  // Users tab
  userCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 2,
  },
  userSearchInput: {
    marginTop: 10,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'ios' ? 10 : 8,
    fontSize: 15,
    color: '#111',
    backgroundColor: '#F8FAFC',
  },
  userWalletHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#EEF2F7',
  },
  userWalletHintText: { flex: 1, fontSize: 13, color: '#1E3A8A', fontWeight: '600' },
  userHeaderRow: { flexDirection: 'row', alignItems: 'center' },
  userAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#1a1a1a',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  userAvatarText: { color: '#fff', fontSize: 18, fontWeight: '800' },
  userName: { fontSize: 15, fontWeight: '800', color: '#1a1a1a' },
  userEmail: { fontSize: 12, color: '#666', marginTop: 2 },
  userPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
  },
  userPillVerified: { backgroundColor: '#e8f5e9' },
  userPillPending: { backgroundColor: '#fff4e5' },
  userPillAdmin: { backgroundColor: '#1a1a1a' },
  userPillText: { fontSize: 11, fontWeight: '800', color: '#1b5e20' },
  userPillTextLight: { fontSize: 11, fontWeight: '800', color: '#fff' },
  userInfoRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  userInfoText: { fontSize: 13, color: '#333' },
  cnicGrid: { flexDirection: 'row', gap: 10, marginTop: 12 },
  cnicCell: { flex: 1 },
  cnicImg: {
    width: '100%',
    height: 110,
    borderRadius: 10,
    backgroundColor: '#eee',
  },
  cnicImgEmpty: { alignItems: 'center', justifyContent: 'center' },
  cnicCellLabel: {
    marginTop: 6,
    fontSize: 11,
    fontWeight: '700',
    color: '#555',
    textAlign: 'center',
  },
  cnicEmptyHint: { marginTop: 10, fontSize: 12, color: '#888', fontStyle: 'italic' },

  // CNIC fullscreen viewer
  cnicViewerBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)' },
  cnicViewerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingTop: 48,
    paddingBottom: 12,
    gap: 12,
  },
  cnicViewerClose: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  cnicViewerTitle: { flex: 1, color: '#fff', fontSize: 15, fontWeight: '700' },
  cnicViewerImage: { flex: 1, width: '100%' },
  cnicViewerEmpty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#000',
  },
  cnicViewerEmptyText: {
    color: '#bbb',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 12,
    lineHeight: 20,
  },

  // Top-up card (admin pending transactions)
  topupCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#eee',
  },
  topupHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  topupAmount: { fontSize: 18, fontWeight: '800', color: '#111' },
  topupMeta: { fontSize: 12, color: '#777', marginTop: 2 },
  topupUserBlock: {
    marginTop: 8,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#eee',
  },
  topupUserName: { fontSize: 14, fontWeight: '700', color: '#222' },
  topupUserMeta: { fontSize: 12, color: '#666', marginTop: 2 },
  topupThumb: {
    width: '100%',
    height: 180,
    borderRadius: 10,
    marginTop: 10,
    backgroundColor: '#f1f1f1',
  },
  topupThumbHint: {
    fontSize: 11,
    color: '#999',
    textAlign: 'center',
    marginTop: 4,
  },
  topupNoReceipt: {
    fontSize: 13,
    color: '#b71c1c',
    marginTop: 10,
    fontStyle: 'italic',
  },
  topupRejectReason: {
    marginTop: 8,
    fontSize: 12,
    color: '#b71c1c',
    fontStyle: 'italic',
  },
  topupActions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 8,
  },
  actionApprove: { backgroundColor: '#16A34A' },
  actionReject: { backgroundColor: '#DC2626' },
  actionGhost: { backgroundColor: '#eee' },
  actionBusy: { opacity: 0.6 },
  actionText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  statusBadgeText: { fontSize: 10, fontWeight: '800', color: '#fff' },

  viewerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerClose: {
    position: 'absolute',
    top: 50,
    right: 20,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  viewerCaption: { position: 'absolute', top: 60, color: '#fff', fontSize: 13 },
  viewerImage: { width: '92%', height: '70%', borderRadius: 12 },

  rejectBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  rejectCard: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 20,
    paddingBottom: 36,
  },
  rejectTitle: { fontSize: 18, fontWeight: '800', color: '#111' },
  rejectSub: { marginTop: 4, fontSize: 13, color: '#666' },
  rejectInput: {
    marginTop: 14,
    minHeight: 80,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#111',
    textAlignVertical: 'top',
  },
  rejectActions: { flexDirection: 'row', gap: 10, marginTop: 16 },
});

export default AdminScreen;
