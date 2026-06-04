import React, { useEffect, useState, useCallback, useContext } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import { Ionicons } from '@expo/vector-icons';
import { useRoute, useNavigation } from '@react-navigation/native';
import { AuthContext } from '../context/AuthContext';
import { getPaymentGatewayConfig, hasConfiguredPaymentGateways } from '../config/paymentGateways';
import {
  createStripeCheckoutSession,
  createEasypaisaSession,
  createJazzCashSession,
} from '../api/paymentGateway';
import { buyNowAPI } from '../api/listings';

WebBrowser.maybeCompleteAuthSession();

function errMessage(e, fallback = 'Request failed') {
  const d = e?.response?.data;
  if (typeof d === 'string' && d.trim()) return d;
  if (d && typeof d === 'object' && d.message != null) return String(d.message);
  if (e?.message) return String(e.message);
  return fallback;
}

const PROVIDER_LABELS = { stripe: 'Stripe', easypaisa: 'Easypaisa', jazzcash: 'JazzCash' };

function buildPayload(listing, amount, buyerId, buyerName, gateway) {
  return {
    gateway,
    listingId: listing?.id,
    listingTitle: listing?.title,
    amount: Math.round(Number(amount)),
    currency: 'PKR',
    buyerId: buyerId != null ? String(buyerId) : undefined,
    buyerName: buyerName || undefined,
    platform: Platform.OS,
  };
}

const PaymentCheckoutScreen = () => {
  const navigation = useNavigation();
  const route = useRoute();
  const { user } = useContext(AuthContext);
  const listing = route.params?.listing;
  const amount = route.params?.amount;
  const buyerId = route.params?.buyerId ?? user?.id;
  const buyerName = route.params?.buyerName ?? user?.name ?? user?.email;

  const [busy, setBusy] = useState(null);
  const [lastResult, setLastResult] = useState(null);

  const config = getPaymentGatewayConfig();
  const gatewaysOn = hasConfiguredPaymentGateways();

  useEffect(() => {
    if (!listing || amount == null || !Number.isFinite(Number(amount))) {
      Alert.alert('Invalid checkout', 'Missing listing or amount.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    }
  }, [listing, amount, navigation]);

  const openReceiptUrl = useCallback(async (url) => {
    if (!url) return;
    try {
      await WebBrowser.openBrowserAsync(url, { enableBarCollapsing: true, showTitle: true });
    } catch {
    }
  }, []);

  const handleGateway = useCallback(
    async (provider, fn) => {
      setBusy(provider);
      try {
        const result = await fn(buildPayload(listing, amount, buyerId, buyerName, provider));
        setLastResult({ provider, ...result });
        const label = PROVIDER_LABELS[provider] || provider;
        const lines = [
          `Payment of Rs. ${Number(result.amount ?? amount).toLocaleString()} via ${label} completed.`,
        ];
        if (Number(result.heldCredit) > 0) {
          lines.push(`Held bid token of Rs. ${Number(result.heldCredit).toLocaleString()} applied.`);
        }
        if (Number(result.due) > 0) {
          lines.push(`Wallet debited: Rs. ${Number(result.due).toLocaleString()}.`);
        }
        if (result.walletBalance != null) {
          lines.push(`New wallet balance: Rs. ${Number(result.walletBalance).toLocaleString()}.`);
        }
        Alert.alert(`${label} payment successful`, lines.join('\n'), [
          { text: 'View receipt', onPress: () => openReceiptUrl(result.url) },
          { text: 'Done', style: 'cancel', onPress: () => navigation.goBack() },
        ]);
      } catch (e) {
        Alert.alert(
          `${PROVIDER_LABELS[provider] || provider} payment failed`,
          errMessage(e, 'Could not complete payment')
        );
      } finally {
        setBusy(null);
      }
    },
    [amount, buyerId, buyerName, listing, navigation, openReceiptUrl]
  );

  const onStripe = () => handleGateway('stripe', createStripeCheckoutSession);
  const onEasypaisa = () => handleGateway('easypaisa', createEasypaisaSession);
  const onJazzcash = () => handleGateway('jazzcash', createJazzCashSession);

  const onSimplePay = () => {
    Alert.alert(
      'Simple pay (no gateway)',
      'Use this only for testing when your payment API is not ready. It records the sale in the app without a real processor.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Record purchase',
          onPress: async () => {
            setBusy('simple');
            try {
              await buyNowAPI(listing.id, {
                listingTitle: listing.title,
                amount: Number(amount),
                buyerId,
                buyerName,
              });
              Alert.alert('Done', 'Purchase recorded.', [
                { text: 'OK', onPress: () => navigation.goBack() },
              ]);
            } catch (e) {
              Alert.alert('Error', e?.message || 'Failed');
            } finally {
              setBusy(null);
            }
          },
        },
      ]
    );
  };

  if (!listing) return null;

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>Pay securely</Text>
        <Text style={styles.amount}>Rs. {Number(amount).toLocaleString()}</Text>
        <Text style={styles.listingTitle} numberOfLines={2}>
          {listing.title}
        </Text>

        <View style={styles.notice}>
          <Ionicons name="shield-checkmark-outline" size={20} color="#1565c0" />
          <Text style={styles.noticeText}>
            Sandbox mode: tapping a gateway debits your in-app wallet and records the sale on the
            server. Add real credentials in .env and replace the server payment routes to go live.
          </Text>
        </View>

        {lastResult ? (
          <View style={styles.successBox}>
            <Ionicons name="checkmark-circle" size={22} color="#1b5e20" />
            <Text style={styles.successText}>
              {PROVIDER_LABELS[lastResult.provider] || lastResult.provider} payment of Rs.{' '}
              {Number(lastResult.amount ?? amount).toLocaleString()} completed.
              {lastResult.walletBalance != null
                ? `\nWallet balance: Rs. ${Number(lastResult.walletBalance).toLocaleString()}.`
                : ''}
            </Text>
          </View>
        ) : null}

        {!gatewaysOn ? (
          <View style={styles.emptyGateways}>
            <Text style={styles.emptyText}>
              No gateway enabled. Set EXPO_PUBLIC_PAYMENTS_STRIPE_ENABLED, EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY,
              or Easypaisa / JazzCash flags in `.env`, then restart Expo.
            </Text>
          </View>
        ) : null}

        {config.stripe.enabled ? (
          <TouchableOpacity
            style={styles.row}
            onPress={onStripe}
            disabled={busy != null}
            activeOpacity={0.85}
          >
            <View style={[styles.iconWrap, { backgroundColor: '#ede7f6' }]}>
              <Ionicons name="card-outline" size={26} color="#5e35b1" />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>Stripe</Text>
              <Text style={styles.rowSub}>
                {config.stripe.publishableKey
                  ? `${config.stripe.publishableKey.slice(0, 12)}…`
                  : 'Checkout URL from your API'}
              </Text>
            </View>
            {busy === 'stripe' ? <ActivityIndicator /> : <Ionicons name="chevron-forward" size={22} color="#999" />}
          </TouchableOpacity>
        ) : null}

        {config.easypaisa.enabled ? (
          <TouchableOpacity
            style={styles.row}
            onPress={onEasypaisa}
            disabled={busy != null}
            activeOpacity={0.85}
          >
            <View style={[styles.iconWrap, { backgroundColor: '#e8f5e9' }]}>
              <Ionicons name="phone-portrait-outline" size={26} color="#2e7d32" />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>Easypaisa</Text>
              <Text style={styles.rowSub}>
                {config.easypaisa.storeId ? `Store ${config.easypaisa.storeId}` : 'Hosted payment via your server'}
              </Text>
            </View>
            {busy === 'easypaisa' ? (
              <ActivityIndicator />
            ) : (
              <Ionicons name="chevron-forward" size={22} color="#999" />
            )}
          </TouchableOpacity>
        ) : null}

        {config.jazzcash.enabled ? (
          <TouchableOpacity
            style={styles.row}
            onPress={onJazzcash}
            disabled={busy != null}
            activeOpacity={0.85}
          >
            <View style={[styles.iconWrap, { backgroundColor: '#fff3e0' }]}>
              <Ionicons name="wallet-outline" size={26} color="#ef6c00" />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>JazzCash</Text>
              <Text style={styles.rowSub}>
                {config.jazzcash.merchantId
                  ? `Merchant ${config.jazzcash.merchantId}`
                  : 'Hosted payment via your server'}
              </Text>
            </View>
            {busy === 'jazzcash' ? (
              <ActivityIndicator />
            ) : (
              <Ionicons name="chevron-forward" size={22} color="#999" />
            )}
          </TouchableOpacity>
        ) : null}

        <TouchableOpacity
          style={styles.simpleBtn}
          onPress={onSimplePay}
          disabled={busy != null}
        >
          <Text style={styles.simpleBtnText}>Pay without gateway (test)</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#f5f5f7',
  },
  scroll: {
    padding: 20,
    paddingBottom: 40,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: '#1a1a1a',
  },
  amount: {
    fontSize: 28,
    fontWeight: '800',
    color: '#007AFF',
    marginTop: 6,
  },
  listingTitle: {
    fontSize: 15,
    color: '#555',
    marginTop: 8,
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: '#e3f2fd',
    padding: 12,
    borderRadius: 12,
    marginTop: 18,
    marginBottom: 8,
  },
  noticeText: {
    flex: 1,
    fontSize: 12,
    color: '#0d47a1',
    lineHeight: 17,
  },
  emptyGateways: {
    paddingVertical: 10,
  },
  emptyText: {
    fontSize: 13,
    color: '#666',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    marginTop: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 2,
  },
  iconWrap: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: {
    flex: 1,
    marginLeft: 12,
  },
  rowTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#222',
  },
  rowSub: {
    fontSize: 12,
    color: '#666',
    marginTop: 2,
  },
  simpleBtn: {
    marginTop: 28,
    paddingVertical: 14,
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#ccc',
    backgroundColor: '#fff',
  },
  simpleBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#555',
  },
  successBox: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    backgroundColor: '#e8f5e9',
    borderRadius: 12,
    padding: 12,
    marginTop: 12,
  },
  successText: {
    flex: 1,
    color: '#1b5e20',
    fontSize: 13,
    lineHeight: 18,
  },
});

export default PaymentCheckoutScreen;
