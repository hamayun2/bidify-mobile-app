import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { AuthContext } from '../context/AuthContext';
import {
  ensureOrderSupportTicket,
  fetchSupportTicketThread,
  seedSupportTicketAiGreeting,
  sendSupportTicketMessage,
  requestSupportTicketHuman,
  uploadSupportTicketAttachment,
  fetchDisputeOrderStatus,
} from '../services/supportTicketService';
import { requestDisputeAiReply } from '../api/support';
import SmartImage from '../components/SmartImage';
import { isSupabaseConfigured } from '../services/supabaseClient';
import { isAuxiliaryApiConfigured } from '../api/client';

const POLL_MS = 5000;
const BG = '#0F172A';
const GLASS = 'rgba(255,255,255,0.08)';
const TEXT = '#F8FAFC';
const MUTED = '#94A3B8';
const ACCENT = '#60A5FA';
const GOLD = '#C9A227';
const ADMIN = '#A78BFA';
const AI_TEAL = '#2DD4BF';
const RESOLVED_TEAL = '#14B8A6';
const RESOLVED_RED = '#EF4444';

function formatTime(iso) {
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

function OrderResolvedBanner({ orderStatus }) {
  if (orderStatus === 'completed') {
    return (
      <View style={[styles.orderResolvedBar, styles.orderResolvedTeal]}>
        <Ionicons name="checkmark-circle" size={18} color={RESOLVED_TEAL} />
        <Text style={[styles.orderResolvedText, { color: RESOLVED_TEAL }]}>
          ORDER RESOLVED: Funds have been released to the Seller.
        </Text>
      </View>
    );
  }
  if (orderStatus === 'refunded') {
    return (
      <View style={[styles.orderResolvedBar, styles.orderResolvedRed]}>
        <Ionicons name="arrow-undo-circle" size={18} color={RESOLVED_RED} />
        <Text style={[styles.orderResolvedText, { color: RESOLVED_RED }]}>
          ORDER RESOLVED: Funds have been refunded to the Buyer.
        </Text>
      </View>
    );
  }
  return null;
}

export default function DisputeSupportChatScreen({ route, navigation }) {
  const { user } = useContext(AuthContext);
  const orderId = route.params?.orderId != null ? String(route.params.orderId) : '';
  const listingTitle = route.params?.listingTitle || 'Disputed order';
  const initialTicketId = route.params?.ticketId != null ? String(route.params.ticketId) : null;

  const [ticketId, setTicketId] = useState(initialTicketId);
  const [ticketStatus, setTicketStatus] = useState(null);
  const [humanRequired, setHumanRequired] = useState(false);
  const [requestingHuman, setRequestingHuman] = useState(false);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [pendingImageUri, setPendingImageUri] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [aiThinking, setAiThinking] = useState(false);
  const [error, setError] = useState(null);
  const [feedbackDismissed, setFeedbackDismissed] = useState(false);
  const [orderStatus, setOrderStatus] = useState(
    route.params?.orderStatus != null ? String(route.params.orderStatus).toLowerCase() : null
  );

  const listRef = useRef(null);
  const mountedRef = useRef(true);
  const humanRequiredRef = useRef(false);
  const aiInFlightRef = useRef(false);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  useEffect(() => {
    humanRequiredRef.current = humanRequired;
  }, [humanRequired]);

  const refreshOrderStatus = useCallback(async () => {
    if (!orderId) return;
    const status = await fetchDisputeOrderStatus(orderId);
    if (status && mountedRef.current) setOrderStatus(status);
  }, [orderId]);

  const applyThread = useCallback((thread) => {
    const hr = !!thread.ticket?.isHumanRequired;
    setTicketStatus(thread.ticket?.status || null);
    setHumanRequired(hr);
    humanRequiredRef.current = hr;
    setMessages(thread.messages || []);
  }, []);

  const loadThread = useCallback(async () => {
    if (!isSupabaseConfigured()) {
      setError('Sign in with Supabase to use admin support chat.');
      setLoading(false);
      return;
    }
    setError(null);
    try {
      let tid = ticketId;
      if (!tid && orderId) {
        const ensured = await ensureOrderSupportTicket(orderId);
        tid = ensured.ticketId;
        if (mountedRef.current) setTicketId(tid);
      }
      if (!tid) throw new Error('Support ticket not found.');

      await seedSupportTicketAiGreeting(tid);
      const thread = await fetchSupportTicketThread(tid);
      if (!mountedRef.current) return;
      applyThread(thread);
      await refreshOrderStatus();
    } catch (e) {
      if (mountedRef.current) setError(e?.message || 'Could not load support chat.');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [ticketId, orderId, applyThread, refreshOrderStatus]);

  useEffect(() => {
    void loadThread();
  }, [loadThread]);

  useEffect(() => {
    if (!ticketId) return undefined;
    const id = setInterval(() => {
      void fetchSupportTicketThread(ticketId)
        .then((thread) => {
          if (!mountedRef.current) return;
          applyThread(thread);
        })
        .catch(() => {});
      void refreshOrderStatus();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [ticketId, applyThread, refreshOrderStatus]);

  useEffect(() => {
    if (messages.length > 0) {
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    }
  }, [messages.length, aiThinking]);

  const pickImage = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Allow photo access to upload proof images.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
    });
    if (!result.canceled && result.assets?.[0]?.uri) {
      setPendingImageUri(result.assets[0].uri);
    }
  };

  const uid = user?.id ?? user?.uid;
  const aiMessageCount = useMemo(() => messages.filter((m) => m.isAi).length, [messages]);
  const hasAdminReply = useMemo(() => messages.some((m) => m.isAdmin), [messages]);
  const awaitingAdmin = humanRequired && !hasAdminReply;
  const orderResolved = orderStatus === 'completed' || orderStatus === 'refunded';
  const aiEnabled = !humanRequired && !awaitingAdmin && !orderResolved;
  const apiConfigured = isAuxiliaryApiConfigured();

  const showFeedbackActions =
    aiEnabled && !feedbackDismissed && aiMessageCount >= 1 && !aiThinking && !sending;

  const handleRequestHuman = useCallback(async () => {
    if (!ticketId) {
      Alert.alert('Not ready', 'Support ticket is still loading.');
      return;
    }
    setRequestingHuman(true);
    try {
      const result = await requestSupportTicketHuman(ticketId);
      const status = result?.status || 'awaiting_admin';
      setHumanRequired(true);
      humanRequiredRef.current = true;
      setTicketStatus(status);
      const thread = await fetchSupportTicketThread(ticketId);
      if (mountedRef.current) applyThread(thread);
    } catch (e) {
      Alert.alert('Admin handoff failed', e?.message || 'Could not request a human admin. Try again.');
    } finally {
      if (mountedRef.current) setRequestingHuman(false);
    }
  }, [ticketId, applyThread]);

  const triggerAiReply = useCallback(
    async (latestUserText) => {
      if (!ticketId || !orderId || !latestUserText?.trim()) return;
      if (humanRequiredRef.current || aiInFlightRef.current) return;

      if (!apiConfigured) {
        if (mountedRef.current) {
          Alert.alert(
            'AI assistant offline',
            'Set EXPO_PUBLIC_API_URL to your PC (e.g. http://192.168.x.x:4000/api) and run npm run api for continuous AI replies.'
          );
        }
        return;
      }

      aiInFlightRef.current = true;
      setAiThinking(true);
      try {
        const result = await requestDisputeAiReply({
          ticketId,
          orderId,
          userMessage: latestUserText.trim(),
        });

        if (result?.skipped) {
          if (result.reason === 'human_admin_required') {
            humanRequiredRef.current = true;
            if (mountedRef.current) setHumanRequired(true);
            const thread = await fetchSupportTicketThread(ticketId);
            if (mountedRef.current) applyThread(thread);
          }
          return;
        }

        const thread = await fetchSupportTicketThread(ticketId);
        if (mountedRef.current) applyThread(thread);
      } catch (e) {
        if (mountedRef.current) {
          Alert.alert('AI assistant', e?.message || 'Could not get AI reply. Tap Talk to Admin for help.');
        }
      } finally {
        aiInFlightRef.current = false;
        if (mountedRef.current) setAiThinking(false);
      }
    },
    [ticketId, orderId, apiConfigured, applyThread]
  );

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed && !pendingImageUri) return;
    if (!ticketId) {
      Alert.alert('Not ready', 'Support ticket is still loading.');
      return;
    }
    if (!uid) {
      Alert.alert('Sign in required', 'Please sign in to message admin support.');
      return;
    }
    if (awaitingAdmin) {
      Alert.alert('Awaiting admin', 'Please wait for a Bidify administrator to respond.');
      return;
    }

    setSending(true);
    const optimisticId = `tmp-${Date.now()}`;
    if (trimmed) {
      setMessages((prev) => [
        ...prev,
        {
          id: optimisticId,
          senderId: String(uid),
          body: trimmed,
          isAdmin: false,
          isAi: false,
          createdAt: new Date().toISOString(),
          pending: true,
        },
      ]);
    }
    setText('');
    const imageUri = pendingImageUri;
    setPendingImageUri(null);
    const messageForAi = trimmed || '[User attached a photo as proof]';

    try {
      let saved = null;
      if (trimmed) {
        saved = await sendSupportTicketMessage(ticketId, trimmed);
      } else {
        saved = await sendSupportTicketMessage(ticketId, '[Photo proof attached]');
      }

      if (imageUri && saved?.id) {
        await uploadSupportTicketAttachment(ticketId, saved.id, uid, imageUri);
      }

      const thread = await fetchSupportTicketThread(ticketId);
      if (!mountedRef.current) return;
      applyThread(thread);

      const stillAiMode = !thread.ticket?.isHumanRequired && thread.ticket?.status !== 'awaiting_admin';
      if (stillAiMode && messageForAi) {
        await triggerAiReply(messageForAi);
      }
    } catch (e) {
      Alert.alert('Could not send', e?.message || 'Try again.');
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
    } finally {
      if (mountedRef.current) setSending(false);
    }
  };

  const renderItem = ({ item }) => {
    const mine =
      !item.isAdmin &&
      !item.isAi &&
      String(item.senderId) === String(uid ?? '');
    const admin = !!item.isAdmin;
    const ai = !!item.isAi;
    return (
      <View
        style={[
          styles.row,
          ai ? styles.rowAi : admin ? styles.rowAdmin : mine ? styles.rowMine : styles.rowTheirs,
        ]}
      >
        {ai ? (
          <View style={styles.aiBadge}>
            <Ionicons name="sparkles" size={12} color={AI_TEAL} />
            <Text style={styles.aiBadgeText}>AI Assistant</Text>
          </View>
        ) : null}
        {admin ? (
          <View style={styles.adminBadge}>
            <Ionicons name="shield-checkmark" size={12} color={ADMIN} />
            <Text style={styles.adminBadgeText}>Bidify Admin</Text>
          </View>
        ) : null}
        <View
          style={[
            styles.bubble,
            ai
              ? styles.bubbleAi
              : admin
                ? styles.bubbleAdmin
                : mine
                  ? styles.bubbleMine
                  : styles.bubbleTheirs,
          ]}
        >
          <Text style={styles.bubbleText}>{item.body}</Text>
          <Text style={styles.bubbleMeta}>{formatTime(item.createdAt)}</Text>
        </View>
      </View>
    );
  };

  const renderFeedbackActions = () => {
    if (!showFeedbackActions) return null;
    return (
      <View style={styles.feedbackRow}>
        <Text style={styles.feedbackLabel}>How can we help?</Text>
        <View style={styles.feedbackButtons}>
          <TouchableOpacity
            style={styles.feedbackBtnSecondary}
            onPress={() => setFeedbackDismissed(true)}
            activeOpacity={0.85}
          >
            <Ionicons name="chatbubble-ellipses-outline" size={18} color={AI_TEAL} />
            <Text style={styles.feedbackBtnSecondaryText}>Keep chatting with AI</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.feedbackBtnPrimary}
            onPress={() => void handleRequestHuman()}
            activeOpacity={0.9}
            disabled={requestingHuman}
          >
            {requestingHuman ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <>
                <Ionicons name="person" size={18} color="#FFFFFF" />
                <Text style={styles.feedbackBtnPrimaryText}>Talk to Admin</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={styles.contextBar}>
        <Ionicons name="headset-outline" size={18} color={GOLD} />
        <View style={styles.contextTextWrap}>
          <Text style={styles.contextTitle} numberOfLines={1}>
            Admin Care · {listingTitle}
          </Text>
          <Text style={styles.contextSub}>
            {awaitingAdmin
              ? 'Awaiting human admin · AI paused'
              : humanRequired && hasAdminReply
                ? 'Admin joined · reply below'
                : aiEnabled
                  ? 'AI assistant active — every message gets a reply'
                  : 'Support chat'}
          </Text>
        </View>
      </View>

      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => { setLoading(true); void loadThread(); }}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {!apiConfigured && aiEnabled ? (
        <View style={styles.apiBanner}>
          <Ionicons name="cloud-offline-outline" size={16} color={GOLD} />
          <Text style={styles.apiBannerText}>
            AI replies need EXPO_PUBLIC_API_URL and npm run api on your PC.
          </Text>
        </View>
      ) : null}

      {loading ? (
        <ActivityIndicator color={ACCENT} style={{ marginTop: 48 }} />
      ) : (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
        >
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(item) => String(item.id)}
            renderItem={renderItem}
            contentContainerStyle={styles.list}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Ionicons name="chatbubbles-outline" size={40} color={MUTED} />
                <Text style={styles.emptyText}>
                  Describe the issue and upload photos as proof. Our AI assistant will respond to
                  every message, then a human admin if you tap Talk to Admin.
                </Text>
              </View>
            }
            ListFooterComponent={
              aiThinking ? (
                <View style={styles.aiThinkingRow}>
                  <ActivityIndicator color={AI_TEAL} size="small" />
                  <Text style={styles.aiThinkingText}>AI is thinking…</Text>
                </View>
              ) : null
            }
          />

          {pendingImageUri ? (
            <View style={styles.previewBar}>
              <SmartImage uri={pendingImageUri} style={styles.previewThumb} resizeMode="cover" />
              <Text style={styles.previewLabel}>Proof image attached</Text>
              <TouchableOpacity onPress={() => setPendingImageUri(null)}>
                <Ionicons name="close-circle" size={22} color={MUTED} />
              </TouchableOpacity>
            </View>
          ) : null}

          {renderFeedbackActions()}

          <OrderResolvedBanner orderStatus={orderStatus} />

          {orderResolved ? null : awaitingAdmin ? (
            <View style={styles.awaitingAdminBar}>
              <ActivityIndicator color={GOLD} />
              <View style={styles.awaitingAdminTextWrap}>
                <Text style={styles.awaitingAdminTitle}>Please wait for an Admin response…</Text>
                <Text style={styles.awaitingAdminSub}>
                  A Bidify administrator has been notified. Your ticket is in the admin inbox.
                  Funds remain frozen in escrow.
                </Text>
              </View>
            </View>
          ) : humanRequired && hasAdminReply ? (
            <View style={styles.composer}>
              <TouchableOpacity onPress={pickImage} style={styles.iconBtn} disabled={sending}>
                <Ionicons name="attach-outline" size={24} color={ACCENT} />
              </TouchableOpacity>
              <TextInput
                style={styles.input}
                value={text}
                onChangeText={setText}
                placeholder="Reply to admin…"
                placeholderTextColor="rgba(148,163,184,0.7)"
                multiline
                editable={!sending}
              />
              <TouchableOpacity
                style={[
                  styles.sendBtn,
                  ((!text.trim() && !pendingImageUri) || sending) && styles.sendDisabled,
                ]}
                onPress={handleSend}
                disabled={(!text.trim() && !pendingImageUri) || sending}
              >
                {sending ? (
                  <ActivityIndicator color="#0F172A" size="small" />
                ) : (
                  <Ionicons name="send" size={18} color="#0F172A" />
                )}
              </TouchableOpacity>
            </View>
          ) : aiEnabled ? (
            <View style={styles.composer}>
              <TouchableOpacity onPress={pickImage} style={styles.iconBtn} disabled={sending || aiThinking}>
                <Ionicons name="attach-outline" size={24} color={ACCENT} />
              </TouchableOpacity>
              <TextInput
                style={styles.input}
                value={text}
                onChangeText={setText}
                placeholder="Describe the issue for AI & admin…"
                placeholderTextColor="rgba(148,163,184,0.7)"
                multiline
                editable={!sending && !aiThinking}
              />
              <TouchableOpacity
                style={[
                  styles.sendBtn,
                  ((!text.trim() && !pendingImageUri) || sending || aiThinking) && styles.sendDisabled,
                ]}
                onPress={handleSend}
                disabled={(!text.trim() && !pendingImageUri) || sending || aiThinking}
              >
                {sending || aiThinking ? (
                  <ActivityIndicator color="#0F172A" size="small" />
                ) : (
                  <Ionicons name="send" size={18} color="#0F172A" />
                )}
              </TouchableOpacity>
            </View>
          ) : null}
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  flex: { flex: 1 },
  contextBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: GLASS,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  contextTextWrap: { flex: 1 },
  contextTitle: { color: TEXT, fontWeight: '800', fontSize: 15 },
  contextSub: { color: MUTED, fontSize: 12, marginTop: 2 },
  apiBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 12,
    marginTop: 8,
    padding: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(201, 162, 39, 0.15)',
  },
  apiBannerText: { flex: 1, color: GOLD, fontSize: 12, lineHeight: 17 },
  errorBanner: {
    margin: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(248,113,113,0.15)',
  },
  errorText: { color: '#FCA5A5', fontSize: 13 },
  retryText: { color: ACCENT, fontWeight: '700', marginTop: 8 },
  list: { padding: 16, paddingBottom: 8 },
  empty: { alignItems: 'center', paddingTop: 48, paddingHorizontal: 24 },
  emptyText: { color: MUTED, textAlign: 'center', marginTop: 12, lineHeight: 20 },
  row: { marginBottom: 12, maxWidth: '88%' },
  rowMine: { alignSelf: 'flex-end' },
  rowTheirs: { alignSelf: 'flex-start' },
  rowAdmin: { alignSelf: 'flex-start', maxWidth: '92%' },
  rowAi: { alignSelf: 'flex-start', maxWidth: '92%' },
  aiBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 4,
  },
  aiBadgeText: { color: AI_TEAL, fontSize: 11, fontWeight: '700' },
  aiThinkingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  aiThinkingText: { color: MUTED, fontSize: 13, fontStyle: 'italic' },
  feedbackRow: {
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 4,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
    backgroundColor: '#0B1220',
  },
  feedbackLabel: {
    color: MUTED,
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  feedbackButtons: { flexDirection: 'row', gap: 8 },
  feedbackBtnSecondary: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(45,212,191,0.45)',
    backgroundColor: 'rgba(45,212,191,0.08)',
  },
  feedbackBtnSecondaryText: { color: AI_TEAL, fontWeight: '700', fontSize: 13 },
  feedbackBtnPrimary: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#7C3AED',
    borderWidth: 1,
    borderColor: 'rgba(167,139,250,0.55)',
  },
  feedbackBtnPrimaryText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  orderResolvedBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 12,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  orderResolvedTeal: {
    backgroundColor: 'rgba(20,184,166,0.12)',
    borderColor: 'rgba(20,184,166,0.45)',
  },
  orderResolvedRed: {
    backgroundColor: 'rgba(239,68,68,0.12)',
    borderColor: 'rgba(239,68,68,0.45)',
  },
  orderResolvedText: {
    flex: 1,
    fontWeight: '800',
    fontSize: 13,
    lineHeight: 18,
  },
  awaitingAdminBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 18,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.1)',
    backgroundColor: 'rgba(201, 162, 39, 0.12)',
  },
  awaitingAdminTextWrap: { flex: 1 },
  awaitingAdminTitle: { color: GOLD, fontWeight: '800', fontSize: 15 },
  awaitingAdminSub: { color: MUTED, fontSize: 12, marginTop: 4, lineHeight: 17 },
  adminBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 4,
  },
  adminBadgeText: { color: ADMIN, fontSize: 11, fontWeight: '700' },
  bubble: {
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleMine: { backgroundColor: ACCENT },
  bubbleTheirs: { backgroundColor: GLASS, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' },
  bubbleAdmin: {
    backgroundColor: 'rgba(167,139,250,0.2)',
    borderWidth: 1,
    borderColor: 'rgba(167,139,250,0.45)',
  },
  bubbleAi: {
    backgroundColor: 'rgba(45, 212, 191, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(45, 212, 191, 0.45)',
  },
  bubbleText: { color: TEXT, fontSize: 15, lineHeight: 21 },
  bubbleMeta: { color: 'rgba(248,250,252,0.65)', fontSize: 10, marginTop: 6 },
  previewBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 12,
    marginBottom: 6,
    padding: 8,
    borderRadius: 12,
    backgroundColor: GLASS,
  },
  previewThumb: { width: 44, height: 44, borderRadius: 8 },
  previewLabel: { flex: 1, color: MUTED, fontSize: 13 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.1)',
    backgroundColor: '#0B1220',
  },
  iconBtn: { padding: 8 },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: GLASS,
    color: TEXT,
    fontSize: 15,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: GOLD,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: { opacity: 0.45 },
});
