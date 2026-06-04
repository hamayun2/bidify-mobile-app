import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
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
  TextInput,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import { createWalletTopupSession } from '../api/wallet';
import {
  isStripePaymentSheetSupported,
  presentStripeWalletPaymentSheet,
} from '../services/stripePaymentSheet';
import { getApiPublicRoot, isAuxiliaryApiConfigured } from '../api/client';
import { WALLET_TOPUP_PRESETS_PKR } from '../constants/walletRules';
import { backToHome } from '../utils/safeBack';
import { colors, radius, spacing } from '../theme';
import { useWallet } from '../context/WalletContext';
import { AuthContext } from '../context/AuthContext';
import { normalizeVerificationStatus } from '../utils/kycVerification';
import { isAdminUser } from '../utils/userRole';
import { showPlatformAlert } from '../utils/platformAlert';
import { getListingsAPI } from '../api/listings';
import { getSupabase, isSupabaseConfigured } from '../services/supabaseClient';
import {
  fetchWalletLedgerForUser,
  mapLedgerRowsToActivity,
} from '../services/walletLedgerService';

WebBrowser.maybeCompleteAuthSession();

const MIN_TOPUP_PKR = 1000;

const HEADER_BG = '#1E3A8A';
const HEADER_TEXT = '#FFFFFF';
const WALLPAPER_BG = '#FEFDF5';
const CARD_SURFACE = '#FDFDF9';
const CREDIT_GREEN = '#059669';
const DEBIT_RED = '#DC2626';
const GOLD_CTA = '#C9A227';
const GOLD_CTA_DARK = '#A67C00';

const PATTERN_TILE = 76;
const PATTERN_ICONS = [
  'wallet-outline',
  'card-outline',
  'cash-outline',
  'lock-closed-outline',
  'lock-open-outline',
  'pricetag-outline',
  'hammer-outline',
  'shield-checkmark-outline',
];

const KIND_LABELS = {
  deposit: 'Deposit',
  topup: 'Top-up',
  token_paid: 'Bid token reserved',
  token_refund: 'Bid token refunded',
  win_hold_note: 'Auction won — token held',
  bid_lock: 'Bid lock',
  bid_refund: 'Bid refund',
  bid_hold: 'Bidify Balance',
  bid_hold_released: 'Bidify Balance released',
  listing_fee: 'Listing fee',
  escrow_refund: 'Escrow refund',
};

const KIND_ICONS = {
  deposit: 'card-outline',
  topup: 'add-circle-outline',
  token_paid: 'lock-closed',
  token_refund: 'lock-open-outline',
  win_hold_note: 'trophy-outline',
  bid_lock: 'lock-closed',
  bid_refund: 'lock-open-outline',
  bid_hold: 'lock-closed',
  bid_hold_released: 'lock-open-outline',
  listing_fee: 'pricetag-outline',
  escrow_refund: 'arrow-undo-outline',
};

const KIND_ICON_BG = {
  deposit: '#D1FAE5',
  topup: '#D1FAE5',
  token_paid: '#FEE2E2',
  token_refund: '#DBEAFE',
  win_hold_note: '#FEF3C7',
  bid_lock: '#FFEDD5',
  bid_refund: '#D1FAE5',
  bid_hold: '#FFEDD5',
  bid_hold_released: '#D1FAE5',
  listing_fee: '#FEE2E2',
  escrow_refund: '#DBEAFE',
};

const PAYMENT_METHODS = [
  {
    id: 'easypaisa',
    label: 'EasyPaisa',
    subtitle: 'Mobile wallet (Pakistan)',
    icon: 'phone-portrait-outline',
    color: '#16A34A',
    bg: '#DCFCE7',
  },
  {
    id: 'stripe',
    label: 'Stripe',
    subtitle: 'Credit / debit card (test mode)',
    icon: 'card-outline',
    color: '#5B21B6',
    bg: '#EDE9FE',
  },
];

const TX_CARD_SHADOW = {
  shadowColor: '#1E293B',
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.07,
  shadowRadius: 8,
  elevation: 3,
};

function fmtRs(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 'Rs. 0';
  return `Rs. ${x.toLocaleString()}`;
}

function fmtTime(iso) {
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

function WalletWallpaper({ children }) {
  const { width, height } = useWindowDimensions();
  const cols = Math.ceil(width / PATTERN_TILE) + 1;
  const rows = Math.ceil((height + 120) / PATTERN_TILE) + 1;

  const tiles = useMemo(() => {
    const out = [];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        out.push({
          key: `${r}-${c}`,
          left: c * PATTERN_TILE + (r % 2 === 0 ? 4 : PATTERN_TILE / 2),
          top: r * PATTERN_TILE + 8,
          icon: PATTERN_ICONS[(r + c) % PATTERN_ICONS.length],
        });
      }
    }
    return out;
  }, [cols, rows]);

  return (
    <View style={styles.wallpaper}>
      <View style={styles.wallpaperPattern} pointerEvents="none">
        {tiles.map((t) => (
          <Ionicons
            key={t.key}
            name={t.icon}
            size={20}
            color="rgba(30, 58, 138, 0.055)"
            style={{ position: 'absolute', left: t.left, top: t.top }}
          />
        ))}
      </View>
      {children}
    </View>
  );
}

function WalletMainTabs({ activeTab, onChange }) {
  return (
    <View style={styles.mainTabs}>
      <TouchableOpacity
        style={[styles.mainTab, activeTab === 'add' && styles.mainTabActive]}
        onPress={() => onChange('add')}
        activeOpacity={0.85}
      >
        <Ionicons
          name="add-circle-outline"
          size={18}
          color={activeTab === 'add' ? '#FFFFFF' : '#64748B'}
        />
        <Text style={[styles.mainTabText, activeTab === 'add' && styles.mainTabTextActive]}>
          Add Funds
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.mainTab, activeTab === 'withdraw' && styles.mainTabActive]}
        onPress={() => onChange('withdraw')}
        activeOpacity={0.85}
      >
        <Ionicons
          name="arrow-up-circle-outline"
          size={18}
          color={activeTab === 'withdraw' ? '#FFFFFF' : '#64748B'}
        />
        <Text style={[styles.mainTabText, activeTab === 'withdraw' && styles.mainTabTextActive]}>
          Withdraw
        </Text>
      </TouchableOpacity>
    </View>
  );
}

function ComingSoonPanel({ title, subtitle, icon = 'time-outline' }) {
  return (
    <View style={styles.comingSoonPanel}>
      <View style={styles.comingSoonIconWrap}>
        <Ionicons name={icon} size={28} color="#94A3B8" />
      </View>
      <Text style={styles.comingSoonTitle}>{title}</Text>
      {subtitle ? <Text style={styles.comingSoonSub}>{subtitle}</Text> : null}
    </View>
  );
}

function PremiumBalanceCard({
  balance,
  heldBalance,
  lockedBalance,
  loading,
  error,
  onAddFunds,
  topupLocked,
}) {
  const escrowTotal =
    (Number(heldBalance) || 0) + (Number(lockedBalance) || 0);
  return (
    <View style={styles.balanceCardOuter}>
      <View style={styles.balanceGradientBase} />
      <View style={styles.balanceOrbA} />
      <View style={styles.balanceOrbB} />
      <View style={styles.balanceCardContent}>
        <View style={styles.balanceLabelRow}>
          <Ionicons name="wallet-outline" size={16} color="rgba(255,255,255,0.85)" />
          <Text style={styles.balanceLabel}>Spendable balance</Text>
        </View>
        {loading && balance === 0 ? (
          <ActivityIndicator color="#FFFFFF" style={styles.balanceSpinner} />
        ) : (
          <Text style={styles.balanceValue}>{fmtRs(balance)}</Text>
        )}
        <Text style={styles.balanceSub}>
          Bidify Balance: {fmtRs(escrowTotal)}
        </Text>
        {error ? <Text style={styles.balanceError}>{error}</Text> : null}
        <Pressable
          style={({ pressed }) => [
            styles.addFundsBtn,
            topupLocked && styles.addFundsBtnDisabled,
            pressed && !topupLocked && styles.addFundsBtnPressed,
          ]}
          onPress={onAddFunds}
          accessibilityRole="button"
          accessibilityLabel="Add funds"
        >
          <Ionicons name="add-circle-outline" size={20} color="#FFFFFF" />
          <Text style={styles.addFundsBtnText}>
            {topupLocked ? 'Top-up locked' : 'Add funds'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const WalletScreen = () => {
  const navigation = useNavigation();
  const { user } = useContext(AuthContext);
  const { balance, heldBalance, loading, error, refresh } = useWallet();
  const [activityRows, setActivityRows] = useState([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [lockedBalance, setLockedBalance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [mainTab, setMainTab] = useState('add');
  const [topupAmount, setTopupAmount] = useState('5000');
  const [amountError, setAmountError] = useState('');
  const [busyProvider, setBusyProvider] = useState(null);
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState(null);

  const resolveWalletScreenUserId = useCallback(async () => {
    const fromContext = user?.id ?? user?.uid ?? null;
    if (!isSupabaseConfigured()) {
      return fromContext != null ? String(fromContext).trim() : '';
    }
    try {
      const supabase = getSupabase();
      const { data } = await supabase.auth.getSession();
      const sessionUid = data?.session?.user?.id
        ? String(data.session.user.id).trim()
        : '';
      if (sessionUid) return sessionUid;
    } catch (e) {
      console.warn('[WalletScreen] resolveWalletScreenUserId', e?.message);
    }
    return fromContext != null ? String(fromContext).trim() : '';
  }, [user?.id, user?.uid]);

  const loadActivity = useCallback(async () => {
    const uid = await resolveWalletScreenUserId();
    if (!uid || !isSupabaseConfigured()) {
      console.warn('[WalletScreen] loadActivity — user_id missing', { uid });
      setActivityRows([]);
      return;
    }

    setActivityLoading(true);
    try {
      const [ledgerRows, listings] = await Promise.all([
        fetchWalletLedgerForUser(uid, 60),
        getListingsAPI().catch(() => []),
      ]);

      console.log('[WalletScreen] Supabase wallet_ledger fetch', {
        user_id: uid,
        ledgerCount: ledgerRows.length,
        ledgerSample: ledgerRows[0] ?? null,
      });

      const listingTitleById = {};
      for (const l of listings) {
        if (l?.id) listingTitleById[String(l.id)] = l.title || 'Listing';
      }

      const merged = mapLedgerRowsToActivity(ledgerRows, listingTitleById).sort((a, b) => {
        const ta = new Date(a.createdAt || 0).getTime();
        const tb = new Date(b.createdAt || 0).getTime();
        return tb - ta;
      });

      console.log('[WalletScreen] activityRows for UI', {
        mergedCount: merged.length,
        kinds: merged.slice(0, 8).map((x) => x.kind),
      });

      setActivityRows(merged);
    } catch (e) {
      console.error('Wallet Fetch Error:', e);
      setActivityRows([]);
    } finally {
      setActivityLoading(false);
    }
  }, [resolveWalletScreenUserId]);

  const reloadLockedBalance = useCallback(async () => {
    if (!user?.id || !isSupabaseConfigured()) {
      setLockedBalance(0);
      return;
    }
    try {
      const supabase = getSupabase();
      const { data } = await supabase
        .from('profiles')
        .select('locked_balance')
        .eq('id', user.id)
        .maybeSingle();
      setLockedBalance(Number(data?.locked_balance ?? 0) || 0);
    } catch {
      setLockedBalance(0);
    }
  }, [user?.id]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([refresh(), reloadLockedBalance(), loadActivity()]);
    } finally {
      setRefreshing(false);
    }
  }, [refresh, reloadLockedBalance, loadActivity]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity, user?.id, user?.uid]);

  useFocusEffect(
    useCallback(() => {
      void (async () => {
        await Promise.all([refresh(), reloadLockedBalance(), loadActivity()]);
      })();
    }, [refresh, reloadLockedBalance, loadActivity])
  );

  const validateAmount = (raw) => {
    const n = parseInt(String(raw).replace(/\D/g, ''), 10);
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, message: 'Enter a positive amount.' };
    }
    if (n < MIN_TOPUP_PKR) {
      return {
        ok: false,
        message: `Minimum top-up is Rs. ${MIN_TOPUP_PKR.toLocaleString()}.`,
      };
    }
    return { ok: true, amount: n };
  };

  const onAmountChange = (t) => {
    setTopupAmount(t.replace(/\D/g, ''));
    if (amountError) setAmountError('');
  };

  const peekValidatedAmount = () => {
    const r = validateAmount(topupAmount);
    return r.ok ? r.amount : null;
  };

  const getValidatedAmount = () => {
    const r = validateAmount(topupAmount);
    if (!r.ok) {
      setAmountError(r.message);
      return null;
    }
    setAmountError('');
    return r.amount;
  };

  const isTopupKycVerified =
    isAdminUser(user) || normalizeVerificationStatus(user) === 'verified';
  const topupLocked = !isTopupKycVerified;

  const blockTopupIfNotVerified = useCallback(() => {
    if (isTopupKycVerified) return true;
    showPlatformAlert(
      'Verification required',
      'Identity verification is in progress or failed. Please check your status.'
    );
    return false;
  }, [isTopupKycVerified]);

  const handleAddFundsPress = useCallback(() => {
    if (!blockTopupIfNotVerified()) return;
    setMainTab('add');
    setSelectedPaymentMethod(null);
    setAmountError('');
  }, [blockTopupIfNotVerified]);

  const handleMainTabChange = (tab) => {
    if (tab === 'add' && !blockTopupIfNotVerified()) return;
    setMainTab(tab);
    setSelectedPaymentMethod(null);
    setAmountError('');
  };

  const syncWalletAfterPayment = useCallback(
    async (creditedAmount, newBalanceHint) => {
      const [refreshed] = await Promise.all([
        refresh(),
        reloadLockedBalance(),
        loadActivity(),
      ]);
      const credited = Number(creditedAmount) || 0;
      const latestBalance =
        newBalanceHint != null
          ? Number(newBalanceHint)
          : refreshed?.balance != null
            ? Number(refreshed.balance)
            : null;
      const balanceLine =
        latestBalance != null && Number.isFinite(latestBalance)
          ? `\nNew balance: Rs. ${latestBalance.toLocaleString()}.`
          : '';
      Alert.alert(
        'Payment Successful!',
        `Funds added to your wallet.\nRs. ${credited.toLocaleString()} credited.${balanceLine}`,
        [{ text: 'OK' }]
      );
      setTopupAmount('5000');
      setSelectedPaymentMethod(null);
      setMainTab('add');
    },
    [refresh, reloadLockedBalance, loadActivity]
  );

  const paymentErrorMessage = (e) => {
    const msg = String(e?.message || e?.response?.data?.message || '').toLowerCase();
    if (
      msg.includes('network') ||
      msg.includes('connection refused') ||
      msg.includes('econnrefused') ||
      msg.includes('failed to fetch') ||
      e?.code === 'ECONNREFUSED'
    ) {
      return (
        'Connection failed. Make sure the API is running (npm run api on port 4000) and EXPO_PUBLIC_API_URL matches your machine.'
      );
    }
    return e?.message || e?.response?.data?.message || 'Top-up failed. Please try again.';
  };

  const handleSelectMethod = (provider) => {
    if (!blockTopupIfNotVerified()) return;
    if (!getValidatedAmount()) return;
    setSelectedPaymentMethod(provider);
    if (amountError) setAmountError('');
  };

  const handlePayNow = useCallback(async () => {
    const stripeKeyPreview = String(
      process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY || ''
    ).slice(0, 5);
    const pendingAmountPreview = getValidatedAmount();
    console.log('[Bidify/Wallet] Pay Now — start', {
      stripeKeyPrefix: stripeKeyPreview || '(undefined)',
      amountPkr: pendingAmountPreview ?? null,
      provider: selectedPaymentMethod,
      platform: Platform.OS,
    });

    if (!blockTopupIfNotVerified()) return;
    const pendingAmount = pendingAmountPreview;
    if (!pendingAmount) return;

    const provider = selectedPaymentMethod;
    if (!provider) {
      Alert.alert('Select payment method', 'Choose Stripe or EasyPaisa before paying.');
      return;
    }
    if (provider === 'easypaisa') {
      Alert.alert('Coming soon', 'EasyPaisa top-up is not available yet.');
      return;
    }

    setBusyProvider(provider);
    try {
      if (provider === 'stripe' && isStripePaymentSheetSupported()) {
        const sheetResult = await presentStripeWalletPaymentSheet(pendingAmount);
        if (sheetResult?.cancelled) return;
        if (sheetResult?.ok) {
          await syncWalletAfterPayment(sheetResult.amount || pendingAmount, sheetResult.walletBalance);
          return;
        }
      }

      if (!isAuxiliaryApiConfigured()) {
        throw new Error(
          'Wallet API not configured. Set EXPO_PUBLIC_API_URL and run: npm run api'
        );
      }

      const session = await createWalletTopupSession(provider, pendingAmount);
      if (!session.url) throw new Error('Server did not return a payment URL.');

      const returnBase = getApiPublicRoot();
      const returnUrl = `${returnBase}/payments/stripe/wallet-return`;

      let creditedAmount = session.amount || pendingAmount;
      let balanceHint =
        session.walletBalance != null ? Number(session.walletBalance) : null;

      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        const popup = window.open(session.url, 'bidify_stripe_checkout', 'width=480,height=720');
        if (!popup) {
          throw new Error('Pop-up blocked. Allow pop-ups for this site and try again.');
        }
        const webResult = await new Promise((resolve) => {
          const onMessage = (ev) => {
            if (ev?.data?.type === 'bidify-wallet-topup' && ev.data.success) {
              window.removeEventListener('message', onMessage);
              resolve(ev.data);
            }
          };
          window.addEventListener('message', onMessage);
          const poll = setInterval(() => {
            if (popup.closed) {
              clearInterval(poll);
              window.removeEventListener('message', onMessage);
              resolve(null);
            }
          }, 500);
        });
        if (!webResult?.success) {
          throw new Error('Payment was not completed. Try again.');
        }
        creditedAmount = webResult.amount || creditedAmount;
        balanceHint = webResult.balance != null ? Number(webResult.balance) : balanceHint;
      } else if (typeof WebBrowser.openAuthSessionAsync === 'function') {
        const authResult = await WebBrowser.openAuthSessionAsync(session.url, returnUrl);
        if (authResult?.type === 'cancel' || authResult?.type === 'dismiss') {
          return;
        }
        if (authResult?.type !== 'success') {
          throw new Error('Payment was not completed. Try again.');
        }
      } else {
        await WebBrowser.openBrowserAsync(session.url, {
          enableBarCollapsing: true,
          showTitle: true,
        });
      }

      await syncWalletAfterPayment(creditedAmount, balanceHint);
    } catch (e) {
      Alert.alert('Payment failed', paymentErrorMessage(e));
    } finally {
      setBusyProvider(null);
    }
  }, [blockTopupIfNotVerified, selectedPaymentMethod, syncWalletAfterPayment]);

  const renderAddFundsPanel = () => {
    const amountPreview = peekValidatedAmount();
    if (topupLocked) {
      return (
        <View style={styles.actionPanel}>
          <View style={styles.kycLockBanner}>
            <Ionicons name="lock-closed-outline" size={22} color={HEADER_BG} />
            <Text style={styles.kycLockText}>
              Identity verification is in progress or failed. Please check your status.
            </Text>
          </View>
        </View>
      );
    }
    return (
      <View style={styles.actionPanel}>
        <Text style={styles.actionPanelTitle}>Top-up amount</Text>
        <View style={styles.presetRow}>
          {WALLET_TOPUP_PRESETS_PKR.map((amt) => (
            <TouchableOpacity
              key={amt}
              style={[
                styles.presetChip,
                String(topupAmount) === String(amt) && styles.presetChipActive,
              ]}
              onPress={() => {
                setTopupAmount(String(amt));
                if (amountError) setAmountError('');
              }}
            >
              <Text
                style={[
                  styles.presetChipText,
                  String(topupAmount) === String(amt) && styles.presetChipTextActive,
                ]}
              >
                {fmtRs(amt)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <TextInput
          style={styles.amountInput}
          keyboardType="number-pad"
          placeholder="Custom amount (min Rs. 1,000)"
          placeholderTextColor="#94A3B8"
          value={topupAmount}
          onChangeText={onAmountChange}
        />
        {amountError ? <Text style={styles.fieldError}>{amountError}</Text> : null}

        <Text style={styles.paymentSectionLabel}>Payment method</Text>
        {amountPreview ? (
          <Text style={styles.amountPreview}>Amount: {fmtRs(amountPreview)}</Text>
        ) : null}
        {PAYMENT_METHODS.map((m) => (
          <TouchableOpacity
            key={m.id}
            style={[
              styles.methodRow,
              selectedPaymentMethod === m.id && styles.methodRowSelected,
            ]}
            onPress={() => handleSelectMethod(m.id)}
            disabled={!!busyProvider}
            activeOpacity={0.85}
          >
            <View style={[styles.methodIcon, { backgroundColor: m.bg }]}>
              <Ionicons name={m.icon} size={22} color={m.color} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.methodLabel}>{m.label}</Text>
              <Text style={styles.methodSub}>{m.subtitle}</Text>
            </View>
            {busyProvider === m.id ? (
              <ActivityIndicator color={HEADER_BG} />
            ) : (
              <Ionicons name="chevron-forward" size={20} color="#999" />
            )}
          </TouchableOpacity>
        ))}

        {selectedPaymentMethod === 'easypaisa' ? (
          <ComingSoonPanel
            title="EasyPaisa Integration - Coming Soon..."
            subtitle="Mobile wallet top-ups will be available in a future update."
            icon="phone-portrait-outline"
          />
        ) : null}

        {selectedPaymentMethod && selectedPaymentMethod !== 'easypaisa' ? (
          <Pressable
            style={({ pressed }) => [
              styles.payNowBtn,
              (!!busyProvider || !amountPreview) && styles.payNowBtnDisabled,
              pressed && !busyProvider && amountPreview && styles.payNowBtnPressed,
            ]}
            onPress={handlePayNow}
            disabled={!!busyProvider || !amountPreview}
            accessibilityRole="button"
            accessibilityLabel="Pay now"
          >
            {busyProvider ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <>
                <Ionicons name="card-outline" size={20} color="#FFFFFF" />
                <Text style={styles.payNowBtnText}>Pay Now</Text>
              </>
            )}
          </Pressable>
        ) : null}
      </View>
    );
  };

  const renderTx = ({ item }) => {
    const label = item.title || KIND_LABELS[item.kind] || item.kind || 'Transaction';
    const icon = KIND_ICONS[item.kind] || 'cash-outline';
    const iconBg = KIND_ICON_BG[item.kind] || '#F1F5F9';
    const isCredit =
      typeof item.isCredit === 'boolean'
        ? item.isCredit
        : item.kind === 'deposit' ||
          item.kind === 'topup' ||
          item.kind === 'token_refund' ||
          item.kind === 'bid_refund' ||
          item.kind === 'bid_hold_released';
    const isDebit = !isCredit;
    const sign = isCredit ? '+' : '−';
    const iconColor = isDebit ? DEBIT_RED : CREDIT_GREEN;

    return (
      <View style={styles.txCard}>
        <View style={styles.txRow}>
          <View style={styles.txIconFrame}>
            <View style={[styles.txIcon, { backgroundColor: iconBg }]}>
              <Ionicons name={icon} size={20} color={iconColor} />
            </View>
          </View>
          <View style={styles.txBody}>
            <Text style={styles.txTitle}>{label}</Text>
            {item.note ? (
              <Text style={styles.txNote} numberOfLines={2}>
                {item.note}
              </Text>
            ) : null}
            <Text style={styles.txTime}>{fmtTime(item.createdAt)}</Text>
          </View>
          <Text
            style={[
              styles.txAmount,
              isDebit && styles.txAmountDebit,
              isCredit && styles.txAmountCredit,
            ]}
          >
            {sign}
            {fmtRs(item.amount)}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.safeTop} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => backToHome(navigation)}
          style={styles.backBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="chevron-back" size={26} color={HEADER_TEXT} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Wallet</Text>
        <View style={styles.headerSpacer} />
      </View>

      <WalletWallpaper>
        <FlatList
          style={styles.list}
          data={activityRows}
          keyExtractor={(item, i) => String(item.id || `activity-${i}`)}
          renderItem={renderTx}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={HEADER_BG}
            />
          }
          ListHeaderComponent={
            <>
              <PremiumBalanceCard
                balance={balance}
                heldBalance={heldBalance}
                lockedBalance={lockedBalance}
                loading={loading}
                error={error}
                topupLocked={topupLocked}
                onAddFunds={handleAddFundsPress}
              />
              <WalletMainTabs activeTab={mainTab} onChange={handleMainTabChange} />
              {mainTab === 'add' ? (
                renderAddFundsPanel()
              ) : (
                <View style={styles.actionPanel}>
                  <ComingSoonPanel
                    title="Coming Soon..."
                    subtitle="Withdrawals will be available soon."
                    icon="arrow-up-circle-outline"
                  />
                </View>
              )}
              <View style={styles.sectionHeaderRow}>
                <Text style={styles.sectionTitle}>Recent activity</Text>
                <Ionicons name="time-outline" size={18} color="#64748B" />
              </View>
            </>
          }
          ListEmptyComponent={
            activityLoading ? (
              <ActivityIndicator color={HEADER_BG} style={{ marginVertical: 24 }} />
            ) : activityRows.length === 0 ? (
              <View style={styles.emptyCard}>
                <Ionicons name="receipt-outline" size={28} color="#94A3B8" />
                <Text style={styles.emptyText}>
                  No activity yet. Add funds via Stripe or place a bid to see transactions here.
                </Text>
              </View>
            ) : null
          }
        />
      </WalletWallpaper>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeTop: {
    flex: 1,
    backgroundColor: HEADER_BG,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xs,
    paddingBottom: spacing.md,
    backgroundColor: HEADER_BG,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.22,
        shadowRadius: 5,
      },
      android: { elevation: 6 },
    }),
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: HEADER_TEXT,
    letterSpacing: -0.2,
    flex: 1,
    textAlign: 'center',
  },
  headerSpacer: { width: 40 },
  wallpaper: {
    flex: 1,
    backgroundColor: WALLPAPER_BG,
  },
  wallpaperPattern: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  list: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  listContent: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: 40,
  },
  balanceCardOuter: {
    borderRadius: 20,
    marginBottom: spacing.lg,
    overflow: 'hidden',
    minHeight: 200,
    ...Platform.select({
      ios: {
        shadowColor: '#1E3A8A',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.28,
        shadowRadius: 14,
      },
      android: { elevation: 8 },
    }),
  },
  balanceGradientBase: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#2563EB',
  },
  balanceOrbA: {
    position: 'absolute',
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: 'rgba(99, 102, 241, 0.55)',
    top: -48,
    right: -36,
  },
  balanceOrbB: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: 'rgba(30, 58, 138, 0.45)',
    bottom: -40,
    left: -24,
  },
  balanceCardContent: {
    padding: spacing.lg,
    paddingTop: spacing.lg + 4,
    paddingBottom: spacing.lg + 2,
  },
  balanceLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  balanceLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.88)',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  balanceSpinner: { marginVertical: 16 },
  balanceValue: {
    fontSize: 42,
    fontWeight: '900',
    color: '#FFFFFF',
    letterSpacing: -1.2,
    marginVertical: 4,
  },
  balanceSub: {
    fontSize: 13,
    lineHeight: 18,
    color: 'rgba(255,255,255,0.78)',
    marginBottom: spacing.md,
  },
  balanceError: {
    color: '#FECACA',
    fontSize: 13,
    marginBottom: spacing.sm,
  },
  addFundsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: GOLD_CTA,
    borderRadius: 14,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: GOLD_CTA_DARK,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.2,
        shadowRadius: 6,
      },
      android: { elevation: 4 },
    }),
  },
  addFundsBtnText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 0.2,
  },
  addFundsBtnDisabled: {
    opacity: 0.55,
    backgroundColor: '#94A3B8',
    borderColor: '#64748B',
  },
  addFundsBtnUnderReview: {
    opacity: 0.5,
    backgroundColor: '#94A3B8',
    borderColor: '#64748B',
  },
  addFundsBtnPressed: {
    opacity: 0.92,
    transform: [{ scale: 0.98 }],
  },
  kycLockBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: '#EFF6FF',
    borderRadius: 12,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  kycLockText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    color: '#1E3A8A',
    fontWeight: '600',
  },
  mainTabs: {
    flexDirection: 'row',
    backgroundColor: '#EEF2F7',
    borderRadius: 14,
    padding: 4,
    marginBottom: spacing.md,
    gap: 4,
  },
  mainTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 11,
  },
  mainTabActive: {
    backgroundColor: HEADER_BG,
    ...Platform.select({
      ios: {
        shadowColor: '#1E3A8A',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 4,
      },
      android: { elevation: 3 },
    }),
  },
  mainTabText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#64748B',
  },
  mainTabTextActive: {
    color: '#FFFFFF',
  },
  actionPanel: {
    backgroundColor: CARD_SURFACE,
    borderRadius: 16,
    padding: spacing.md,
    marginBottom: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(30, 58, 138, 0.08)',
    ...TX_CARD_SHADOW,
  },
  actionPanelTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#1E293B',
    marginBottom: spacing.sm,
    letterSpacing: -0.2,
  },
  paymentSectionLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: '#475569',
    marginTop: spacing.sm,
    marginBottom: 4,
  },
  amountPreview: {
    fontSize: 13,
    color: '#64748B',
    marginBottom: spacing.sm,
  },
  comingSoonPanel: {
    marginTop: spacing.md,
    paddingVertical: spacing.xl + 8,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F8FAFC',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderStyle: 'dashed',
  },
  comingSoonIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  comingSoonTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#94A3B8',
    textAlign: 'center',
    fontStyle: 'italic',
    letterSpacing: 0.15,
  },
  comingSoonSub: {
    marginTop: 6,
    fontSize: 13,
    color: '#CBD5E1',
    textAlign: 'center',
    lineHeight: 18,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
    paddingHorizontal: 2,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#1E293B',
    letterSpacing: -0.35,
  },
  emptyCard: {
    backgroundColor: CARD_SURFACE,
    borderRadius: 14,
    padding: spacing.xl,
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(30, 58, 138, 0.08)',
    ...TX_CARD_SHADOW,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  txCard: {
    backgroundColor: CARD_SURFACE,
    borderRadius: 14,
    marginBottom: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(30, 58, 138, 0.08)',
    ...TX_CARD_SHADOW,
  },
  txRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
  },
  txIconFrame: {
    width: 50,
    height: 50,
    borderRadius: 25,
    borderWidth: 1.5,
    borderColor: 'rgba(30, 58, 138, 0.12)',
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  txIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  txBody: {
    flex: 1,
    minWidth: 0,
    paddingRight: spacing.sm,
  },
  txTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1E293B',
    letterSpacing: -0.15,
  },
  txNote: {
    fontSize: 13,
    color: '#64748B',
    marginTop: 3,
    lineHeight: 18,
  },
  txTime: {
    fontSize: 11,
    fontWeight: '500',
    color: '#94A3B8',
    marginTop: 5,
  },
  txAmount: {
    fontSize: 15,
    fontWeight: '800',
    color: '#475569',
    letterSpacing: -0.2,
  },
  txAmountDebit: { color: DEBIT_RED },
  txAmountCredit: { color: CREDIT_GREEN },
  presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  presetChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#f0f0f0',
  },
  presetChipActive: { backgroundColor: HEADER_BG },
  presetChipText: { fontWeight: '600', color: colors.text },
  presetChipTextActive: { color: '#fff' },
  amountInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 14,
    fontSize: 18,
    marginBottom: 8,
    backgroundColor: '#FFFFFF',
  },
  fieldError: { color: colors.danger, marginBottom: 8 },
  methodRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 4,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  methodRowSelected: {
    backgroundColor: '#F8FAFC',
    borderRadius: 10,
    borderBottomColor: 'transparent',
  },
  methodIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  methodLabel: { fontWeight: '700', fontSize: 16 },
  methodSub: { fontSize: 12, color: colors.textMuted },
  payNowBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: spacing.lg,
    paddingVertical: 16,
    borderRadius: 12,
    backgroundColor: HEADER_BG,
  },
  payNowBtnPressed: { opacity: 0.88 },
  payNowBtnDisabled: { opacity: 0.45 },
  payNowBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
});

export default WalletScreen;
