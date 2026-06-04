import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { AuthContext } from '../../context/AuthContext';
import { fetchSupportTicketThread } from '../../services/supportTicketService';
import { adminSendSupportMessage, fetchAdminTicketIdForOrder } from '../../services/adminPanelService';
import { adminSettleDispute } from '../../api/adminDisputes';
import { exitAdminSupportChat } from '../../navigation/adminNavigation';

const POLL_MS = 4000;
const BG = '#0F172A';
const TEXT = '#F8FAFC';
const MUTED = '#94A3B8';
const ACCENT = '#60A5FA';
const GOLD = '#C9A227';
const ADMIN = '#A78BFA';
const AI_TEAL = '#2DD4BF';
const RELEASE_TEAL = '#14B8A6';
const RELEASE_TEAL_DARK = '#0D9488';
const REFUND_RED = '#EF4444';
const REFUND_RED_DARK = '#DC2626';
const BTN_HIT_SLOP = { top: 12, bottom: 12, left: 8, right: 8 };

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatRs(n) {
  const x = Number(n);
  return Number.isFinite(x) ? `Rs. ${x.toLocaleString()}` : 'Rs. 0';
}

function SettlementActionBar({ escrowAmount, settling, onReleasePress, onRefundPress }) {
  return (
    <View style={styles.settlementBar}>
      <Text style={styles.settlementHint}>
        Escrow · {formatRs(escrowAmount)}
      </Text>
      <View style={styles.settlementRow}>
        <TouchableOpacity
          style={[styles.settleBtn, styles.releaseBtn]}
          onPress={onReleasePress}
          disabled={settling === 'RELEASE_TO_SELLER'}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel="Release Funds to Seller"
        >
          {settling === 'RELEASE_TO_SELLER' ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.btnLabel}>
              Release Funds to Seller
            </Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.settleBtn, styles.refundBtn]}
          onPress={onRefundPress}
          disabled={settling === 'REFUND_TO_BUYER'}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel="Refund Funds to Buyer"
        >
          {settling === 'REFUND_TO_BUYER' ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.btnLabel}>
              Refund Funds to Buyer
            </Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function AdminSupportChatScreen({ route, navigation }) {
  const { user } = useContext(AuthContext);
  const orderId = route.params?.orderId != null ? String(route.params.orderId).trim() : '';
  const listingTitle = route.params?.listingTitle || 'Dispute';
  const escrowAmount = route.params?.escrowAmount ?? 0;

  const [activeTicketId, setActiveTicketId] = useState(() => {
    const tid = route.params?.ticketId;
    return tid != null && String(tid).trim() !== '' ? String(tid).trim() : null;
  });
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [settling, setSettling] = useState(null);
  const [orderStatus, setOrderStatus] = useState(
    String(route.params?.orderStatus || 'disputed').toLowerCase()
  );
  const listRef = useRef(null);
  const adminUid = user?.id ?? user?.uid;
  const settlingRef = useRef(false);
  const showSettlementButtons = (orderStatus === 'disputed' || route.params?.showSettlementActions === true) && !!orderId;

  useFocusEffect(
    useCallback(() => {
      const p = route.params ?? {};
      setOrderStatus(String(p.orderStatus || 'disputed').toLowerCase());
      if (p.ticketId != null && String(p.ticketId).trim() !== '') {
        setActiveTicketId(String(p.ticketId).trim());
      }
    }, [route.params])
  );

  const handleBack = useCallback(() => {
    exitAdminSupportChat(navigation);
  }, [navigation]);

  const loadThread = useCallback(async () => {
    let tid = activeTicketId;
    if (!tid && orderId) {
      tid = await fetchAdminTicketIdForOrder(orderId);
      if (tid) setActiveTicketId(tid);
    }
    if (!tid) {
      setLoading(false);
      Alert.alert('No ticket', 'No support ticket found for this order.');
      return;
    }
    try {
      const thread = await fetchSupportTicketThread(tid);
      setMessages(thread.messages || []);
    } catch (e) {
      Alert.alert('Load failed', e?.message || 'Could not load ticket.');
    } finally {
      setLoading(false);
    }
  }, [activeTicketId, orderId]);

  useEffect(() => {
    void loadThread();
  }, [loadThread]);

  useEffect(() => {
    if (!activeTicketId) return undefined;
    const id = setInterval(() => {
      void fetchSupportTicketThread(activeTicketId)
        .then((t) => setMessages(t.messages || []))
        .catch(() => {});
    }, POLL_MS);
    return () => clearInterval(id);
  }, [activeTicketId]);

  const executeSettlement = useCallback(
    async (resolutionAction) => {
      if (!orderId) {
        if (Platform.OS === 'web') alert('Missing order ID.');
        else Alert.alert('Missing order', 'Order ID is required.');
        return;
      }
      if (settlingRef.current) return;

      settlingRef.current = true;
      setSettling(resolutionAction);

      const expressAction = resolutionAction === 'RELEASE_TO_SELLER' ? 'release_seller' : 'refund_buyer';

      try {
        const result = await adminSettleDispute({
          orderId,
          ticketId: activeTicketId,
          action: expressAction,
          resolutionAction,
          note: resolutionAction === 'RELEASE_TO_SELLER' ? 'Admin released escrow to seller' : 'Admin refunded escrow to buyer',
        });

        setOrderStatus(resolutionAction === 'RELEASE_TO_SELLER' ? 'completed' : 'refunded');

        // Web aur Mobile dono ke liye success message
        if (Platform.OS === 'web') {
            alert(result?.message || 'Funds successfully transferred!');
            if (navigation.canGoBack()) navigation.goBack();
            else exitAdminSupportChat(navigation);
        } else {
            Alert.alert('Success', result?.message || 'Funds successfully transferred!', [
            {
                text: 'OK',
                onPress: () => {
                if (navigation.canGoBack()) navigation.goBack();
                else exitAdminSupportChat(navigation);
                },
            },
            ]);
        }
      } catch (err) {
        const msg = err?.response?.data?.message || err?.message || 'Settlement failed. Check API and SQL RPC.';
        const code = err?.code || err?.response?.status || '';
        if (Platform.OS === 'web') {
            alert(`Network/Server Error: ${msg}${code ? `\nCode: ${code}` : ''}`);
        } else {
            Alert.alert('Network/Server Error', `${msg}${code ? `\n\nCode: ${code}` : ''}`);
        }
      } finally {
        settlingRef.current = false;
        setSettling(null);
      }
    },
    [orderId, activeTicketId, navigation]
  );

  // 🚀 WEB-SAFE POPUP LOGIC ADDED HERE
  const onReleaseFundsPress = useCallback(() => {
    console.log('--- TOUCH DETECTED ---');
    if (Platform.OS === 'web') {
      const confirmAction = window.confirm('Confirm Payout: Are you sure you want to release the escrow funds to the Seller?');
      if (confirmAction) {
        void executeSettlement('RELEASE_TO_SELLER');
      }
    } else {
      Alert.alert(
        'Confirm Payout',
        'Are you sure you want to release the escrow funds to the Seller?',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'OK', onPress: () => void executeSettlement('RELEASE_TO_SELLER') },
        ],
        { cancelable: true }
      );
    }
  }, [executeSettlement]);

  const onRefundFundsPress = useCallback(() => {
    console.log('--- TOUCH DETECTED ---');
    if (Platform.OS === 'web') {
      const confirmAction = window.confirm('Confirm Refund: Are you sure you want to refund the escrow funds back to the Buyer?');
      if (confirmAction) {
        void executeSettlement('REFUND_TO_BUYER');
      }
    } else {
      Alert.alert(
        'Confirm Refund',
        'Are you sure you want to refund the escrow funds back to the Buyer?',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'OK', onPress: () => void executeSettlement('REFUND_TO_BUYER') },
        ],
        { cancelable: true }
      );
    }
  }, [executeSettlement]);

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || !activeTicketId) return;
    setSending(true);
    setText('');
    try {
      await adminSendSupportMessage(activeTicketId, trimmed);
      await loadThread();
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    } catch (e) {
      if (Platform.OS === 'web') alert(e?.message || 'Try again.');
      else Alert.alert('Send failed', e?.message || 'Try again.');
    } finally {
      setSending(false);
    }
  };

  const settlementBarProps = {
    escrowAmount,
    settling,
    onReleasePress: onReleaseFundsPress,
    onRefundPress: onRefundFundsPress,
  };

  const renderListEmpty = useCallback(() => {
    if (loading) {
      return (
        <View style={styles.loadingEmpty}>
          <ActivityIndicator color={ACCENT} size="large" />
          <Text style={styles.loadingEmptyText}>Loading messages…</Text>
        </View>
      );
    }
    return (
      <View style={styles.loadingEmpty}>
        <Text style={styles.loadingEmptyText}>No messages yet.</Text>
      </View>
    );
  }, [loading]);

  const renderItem = ({ item }) => {
    const mine = !item.isAdmin && !item.isAi && String(item.senderId) === String(adminUid);
    const admin = !!item.isAdmin;
    const ai = !!item.isAi;
    return (
      <View style={[styles.row, admin ? styles.rowAdmin : ai ? styles.rowAi : mine ? styles.rowMine : styles.rowTheirs]}>
        {ai ? <Text style={styles.badgeAi}>AI Assistant</Text> : null}
        {admin ? <Text style={styles.badgeAdmin}>You (Admin)</Text> : null}
        <View style={[styles.bubble, admin && styles.bubbleAdmin, ai && styles.bubbleAi, mine && styles.bubbleMine]}>
          <Text style={styles.bubbleText}>{item.body}</Text>
          <Text style={styles.bubbleMeta}>{formatTime(item.createdAt)}</Text>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <TouchableOpacity onPress={handleBack} style={styles.backBtn} hitSlop={16} activeOpacity={0.7}>
            <Ionicons name="arrow-back" size={22} color={TEXT} />
          </TouchableOpacity>
          <View style={styles.headerText}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {listingTitle}
            </Text>
            <Text style={styles.headerSub}>
              Escrow {formatRs(escrowAmount)} · {orderStatus}
              {!orderId ? ' · missing orderId' : ''}
            </Text>
          </View>
        </View>

        {showSettlementButtons ? <SettlementActionBar {...settlementBarProps} /> : null}
      </View>

      <View style={styles.chatBody}>
        <FlatList
          ref={listRef}
          style={styles.list}
          data={messages}
          keyExtractor={(m) => String(m.id)}
          renderItem={renderItem}
          ListEmptyComponent={renderListEmpty}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="always"
          keyboardDismissMode="on-drag"
        />

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
        >
          <View style={styles.composer}>
            <TextInput
              style={styles.input}
              value={text}
              onChangeText={setText}
              placeholder="Message buyer/seller…"
              placeholderTextColor={MUTED}
              multiline
              editable={!sending && !settling}
            />
            <TouchableOpacity
              style={[styles.sendBtn, (!text.trim() || sending || settling) && styles.sendDisabled]}
              onPress={handleSend}
              disabled={!text.trim() || sending || !!settling}
              hitSlop={BTN_HIT_SLOP}
            >
              {sending ? (
                <ActivityIndicator color="#0F172A" />
              ) : (
                <Ionicons name="send" size={18} color="#0F172A" />
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  header: {
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.1)',
    backgroundColor: BG,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  backBtn: { padding: 8, minWidth: 48, minHeight: 48, justifyContent: 'center' },
  headerText: { flex: 1, marginLeft: 4 },
  headerTitle: { color: TEXT, fontWeight: '800', fontSize: 16 },
  headerSub: { color: MUTED, fontSize: 12, marginTop: 2 },
  
  // 🚀 Z-Index has been removed to fix Web/Mobile Layout Touch issues
  settlementBar: {
    paddingHorizontal: 12,
    paddingBottom: 12,
    paddingTop: 4,
  },
  settlementHint: {
    color: MUTED,
    fontSize: 11,
    marginBottom: 8,
    textAlign: 'center',
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  settlementRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
  },
  settleBtn: {
    width: '48%',
    minHeight: 52,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
    paddingVertical: 12,
  },
  releaseBtn: {
    backgroundColor: RELEASE_TEAL,
    borderColor: RELEASE_TEAL_DARK,
  },
  refundBtn: {
    backgroundColor: REFUND_RED,
    borderColor: REFUND_RED_DARK,
  },
  btnLabel: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 11,
    textAlign: 'center',
    lineHeight: 14,
  },
  chatBody: {
    flex: 1,
    minHeight: 0,
  },
  list: { flex: 1 },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  loadingEmpty: {
    paddingVertical: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingEmptyText: { color: MUTED, marginTop: 10, fontSize: 13 },
  row: { marginBottom: 12, maxWidth: '90%' },
  rowAdmin: { alignSelf: 'flex-end' },
  rowAi: { alignSelf: 'flex-start' },
  rowMine: { alignSelf: 'flex-end' },
  rowTheirs: { alignSelf: 'flex-start' },
  badgeAi: { color: AI_TEAL, fontSize: 11, fontWeight: '700', marginBottom: 4 },
  badgeAdmin: { color: ADMIN, fontSize: 11, fontWeight: '700', marginBottom: 4 },
  bubble: {
    borderRadius: 14,
    padding: 12,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  bubbleAdmin: { backgroundColor: 'rgba(167,139,250,0.35)' },
  bubbleAi: { backgroundColor: 'rgba(45,212,191,0.15)', borderWidth: 1, borderColor: 'rgba(45,212,191,0.4)' },
  bubbleMine: { backgroundColor: ACCENT },
  bubbleText: { color: TEXT, fontSize: 15, lineHeight: 21 },
  bubbleMeta: { color: MUTED, fontSize: 10, marginTop: 6 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.1)',
    backgroundColor: BG,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 100,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: 'rgba(255,255,255,0.08)',
    color: TEXT,
  },
  sendBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: GOLD,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: { opacity: 0.45 },
});