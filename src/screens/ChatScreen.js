import React, { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { startConversationAPI, getMessagesAPI, sendMessageAPI } from '../api/chat';
import { fetchChatPartnerProfile, markConversationMessagesRead } from '../services/chatService';
import { useFocusEffect } from '@react-navigation/native';
import { resolveMediaUrl } from '../utils/listingMedia';
import SmartImage from '../components/SmartImage';
import AvatarImage from '../components/AvatarImage';
import { isLikelyOffline } from '../api/networkStatus';
import { isKycVerified, KYC_CHAT_LOCKED_HINT } from '../utils/kycVerification';

const POLL_INTERVAL_MS = 6000;
const POLL_MAX_INTERVAL_MS = 60000;
const WA_BG = '#ECE5DD';
const WA_INCOMING = '#FFFFFF';
const WA_OUTGOING = '#DCF8C6';
const BUBBLE_RADIUS = 18;

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function ChatNavHeader({ name, avatarUrl, email, onPress, disabled }) {
  const displayName = name || 'Chat';
  const resolvedAvatar = resolveMediaUrl(avatarUrl);
  const canOpenProfile = !disabled && typeof onPress === 'function';

  const inner = (
    <>
      <AvatarImage
        uri={resolvedAvatar}
        size={40}
        name={displayName}
        email={email}
        style={styles.navAvatar}
      />
      <View style={styles.navHeaderTextCol}>
        <Text style={styles.navHeaderName} numberOfLines={1}>
          {displayName}
        </Text>
        <Text style={styles.navHeaderStatus}>online</Text>
      </View>
    </>
  );

  if (!canOpenProfile) {
    return <View style={styles.navHeaderRow}>{inner}</View>;
  }

  return (
    <TouchableOpacity
      style={styles.navHeaderRow}
      onPress={onPress}
      activeOpacity={0.72}
      accessibilityRole="button"
      accessibilityLabel={`View profile, ${displayName}`}
      accessibilityHint="Opens public seller profile"
      hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
    >
      {inner}
    </TouchableOpacity>
  );
}

function BubbleTail({ side, color }) {
  if (side === 'right') {
    return (
      <View
        style={[
          styles.bubbleTail,
          styles.bubbleTailRight,
          { borderLeftColor: color },
        ]}
      />
    );
  }
  return (
    <View
      style={[
        styles.bubbleTail,
        styles.bubbleTailLeft,
        { borderRightColor: color },
      ]}
    />
  );
}

function MessageStatusTicks({ mine, read, pending, failed }) {
  if (failed) {
    return <Ionicons name="alert-circle-outline" size={14} color="#E53935" />;
  }
  if (pending) {
    return <Ionicons name="time-outline" size={14} color="#8696A0" />;
  }
  if (!mine) {
    return <Ionicons name="checkmark-done" size={16} color="#8696A0" />;
  }
  const color = read ? '#53BDEB' : '#8696A0';
  return <Ionicons name="checkmark-done" size={16} color={color} />;
}

function MessageBubble({ item, mine, partnerAvatar, partnerEmail, partnerName }) {
  const imgUri = resolveMediaUrl(item.imageUrl);
  const bubbleColor = mine ? WA_OUTGOING : WA_INCOMING;
  const timeLabel = formatTime(item.createdAt);

  return (
    <View style={[styles.bubbleRow, mine ? styles.bubbleRowMine : styles.bubbleRowTheirs]}>
      <View style={[styles.bubbleWrap, mine ? styles.bubbleWrapMine : styles.bubbleWrapTheirs]}>
        <View
          style={[
            styles.bubble,
            mine ? styles.bubbleMine : styles.bubbleTheirs,
            item.failed ? styles.bubbleFailed : null,
          ]}
        >
          {imgUri ? (
            <SmartImage
              uri={imgUri}
              style={styles.bubbleImage}
              resizeMode="cover"
              placeholder={
                <View style={styles.bubbleImageError}>
                  <Ionicons name="image-outline" size={28} color="#aaa" />
                  <Text style={styles.bubbleImageErrorText}>Image unavailable</Text>
                </View>
              }
            />
          ) : null}
          {!mine && item.text ? (
            <View style={styles.incomingLeadRow}>
              <AvatarImage
                uri={partnerAvatar}
                size={22}
                name={partnerName}
                email={partnerEmail}
                style={styles.inBubbleAvatar}
              />
              <View style={styles.incomingDot} />
              <Text style={styles.bubbleTextTheirs} numberOfLines={0}>
                {item.text}
              </Text>
            </View>
          ) : mine && item.text ? (
            <Text style={styles.bubbleTextMine}>{item.text}</Text>
          ) : null}
          <View style={styles.bubbleFooter}>
            {item.pending ? (
              <Text style={styles.bubbleMetaPending}>sending…</Text>
            ) : null}
            {item.failed ? (
              <Text style={styles.bubbleMetaFailed}>failed</Text>
            ) : null}
            <Text style={styles.bubbleTime}>{timeLabel}</Text>
            <MessageStatusTicks
              mine={mine}
              read={item.isRead === true}
              pending={item.pending}
              failed={item.failed}
            />
          </View>
        </View>
        <BubbleTail side={mine ? 'right' : 'left'} color={bubbleColor} />
      </View>
    </View>
  );
}

function resolveListingIdFromParams(params) {
  if (params?.listingId != null && String(params.listingId).trim()) {
    const id = String(params.listingId).trim();
    if (id !== '[object Object]') return id;
  }
  const raw = params?.listing;
  if (typeof raw === 'string' && raw.trim() && raw !== '[object Object]') return raw.trim();
  if (raw && typeof raw === 'object' && raw.id != null) return String(raw.id);
  return null;
}

const ChatScreen = ({ route, navigation }) => {
  const { user } = useContext(AuthContext);
  const initialConvoId = route.params?.conversationId || null;
  const routeListingId = resolveListingIdFromParams(route.params);
  const headerTitle = route.params?.title || 'Chat';
  const listingTitle = route.params?.listingTitle || '';

  const [conversation, setConversation] = useState(
    initialConvoId
      ? { id: initialConvoId, listingTitle, listingImage: route.params?.listingImage }
      : null
  );
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [pendingImageUri, setPendingImageUri] = useState(null);
  const [sending, setSending] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [errorBanner, setErrorBanner] = useState('');
  const [partnerDisplay, setPartnerDisplay] = useState({
    name: route.params?.title || '',
    avatarUrl: null,
    email: null,
  });

  const listRef = useRef(null);
  const lastIsoRef = useRef(null);
  const mountedRef = useRef(true);

  const otherUserId = useMemo(() => {
    if (conversation?.other?.id) return String(conversation.other.id);
    const uid = user?.id != null ? String(user.id) : '';
    if (!conversation || !uid) return null;
    if (conversation.buyerId && String(conversation.buyerId) !== uid) {
      return String(conversation.buyerId);
    }
    if (conversation.sellerId && String(conversation.sellerId) !== uid) {
      return String(conversation.sellerId);
    }
    return null;
  }, [conversation, user?.id]);

  const headerPartnerName =
    partnerDisplay.name || conversation?.other?.name || headerTitle || 'Chat';
  const headerPartnerAvatar =
    partnerDisplay.avatarUrl ?? conversation?.other?.avatarUrl ?? null;
  const headerPartnerEmail = partnerDisplay.email ?? conversation?.other?.email ?? null;

  const openPartnerProfile = useCallback(() => {
    if (!otherUserId) return;
    navigation.navigate('PublicProfileView', {
      userId: otherUserId,
      sellerId: otherUserId,
      sellerName: headerPartnerName || 'User',
    });
  }, [navigation, otherUserId, headerPartnerName]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerStyle: {
        backgroundColor: '#FFFFFF',
      },
      headerShadowVisible: true,
      headerTitle: () => (
        <ChatNavHeader
          name={headerPartnerName}
          avatarUrl={headerPartnerAvatar}
          email={headerPartnerEmail}
          onPress={openPartnerProfile}
          disabled={!otherUserId}
        />
      ),
      headerTitleAlign: 'left',
    });
  }, [
    navigation,
    headerPartnerName,
    headerPartnerAvatar,
    headerPartnerEmail,
    openPartnerProfile,
    otherUserId,
  ]);

  useEffect(() => {
    if (!otherUserId) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const profile = await fetchChatPartnerProfile(otherUserId);
        if (!cancelled && profile) {
          setPartnerDisplay({
            name: profile.name,
            avatarUrl: profile.avatarUrl,
            email: profile.email,
          });
        }
      } catch (e) {
        if (__DEV__) console.warn('[ChatScreen] partner profile load', e?.message || e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [otherUserId]);

  useEffect(() => () => { mountedRef.current = false; }, []);

  const initialize = useCallback(async () => {
    setInitializing(true);
    setErrorBanner('');
    try {
      let convo = conversation;
      if (!convo?.id && (routeListingId || route.params?.listing)) {
        convo = await startConversationAPI({
          listingId: routeListingId,
          listing: route.params?.listing,
          buyer: user,
        });
        if (mountedRef.current) setConversation(convo);
      }
      if (!convo?.id) {
        setErrorBanner(
          routeListingId
            ? 'Could not open chat for this listing.'
            : 'No conversation context. Open this chat from a listing.'
        );
        return;
      }
      const { messages: rows, conversation: serverConvo } = await getMessagesAPI(convo.id);
      if (!mountedRef.current) return;
      setMessages(rows);
      if (serverConvo) setConversation(serverConvo);
      if (convo?.other?.name || convo?.other?.avatarUrl) {
        setPartnerDisplay((prev) => ({
          name: convo.other.name || prev.name,
          avatarUrl: convo.other.avatarUrl ?? prev.avatarUrl,
          email: convo.other.email ?? prev.email,
        }));
      }
      if (rows.length > 0) lastIsoRef.current = rows[rows.length - 1].createdAt;
    } catch (e) {
      const msg = e?.message || 'Failed to open chat';
      setErrorBanner(msg === 'Listing not found.' ? 'Listing not found.' : msg);
    } finally {
      if (mountedRef.current) setInitializing(false);
    }
  }, [conversation, routeListingId, route.params?.listing, user]);

  useEffect(() => {
    initialize();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useFocusEffect(
    useCallback(() => {
      if (!conversation?.id || !user?.id) return undefined;
      void markConversationMessagesRead(conversation.id, user.id);
      return undefined;
    }, [conversation?.id, user?.id])
  );

  useEffect(() => {
    if (!conversation?.id) return undefined;
    let cancelled = false;
    let timer = null;
    let interval = POLL_INTERVAL_MS;

    const tick = async () => {
      if (cancelled) return;
      if (isLikelyOffline()) {
        interval = Math.min(POLL_MAX_INTERVAL_MS, Math.max(interval, 15000));
        timer = setTimeout(tick, interval);
        return;
      }
      try {
        const { messages: incoming } = await getMessagesAPI(conversation.id, lastIsoRef.current);
        if (cancelled || !mountedRef.current) return;
        if (Array.isArray(incoming) && incoming.length > 0) {
          setMessages((prev) => {
            const seen = new Set(prev.map((m) => String(m.id)));
            const merged = prev.slice();
            for (const m of incoming) {
              if (!seen.has(String(m.id))) merged.push(m);
            }
            return merged;
          });
          lastIsoRef.current = incoming[incoming.length - 1].createdAt;
        }
        interval = POLL_INTERVAL_MS;
      } catch {
        interval = Math.min(POLL_MAX_INTERVAL_MS, interval * 2);
      } finally {
        if (!cancelled) timer = setTimeout(tick, interval);
      }
    };

    timer = setTimeout(tick, interval);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [conversation?.id]);

  useEffect(() => {
    if (messages.length > 0) {
      requestAnimationFrame(() => {
        listRef.current?.scrollToEnd({ animated: true });
      });
    }
  }, [messages.length]);

  const pickImage = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Permission needed', 'Allow photo library access to attach images.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 1,
        allowsEditing: false,
        exif: false,
      });
      if (!result.canceled && result.assets?.[0]?.uri) {
        setPendingImageUri(result.assets[0].uri);
      }
    } catch (e) {
      Alert.alert('Image error', e?.message || 'Could not open gallery.');
    }
  };

  const chatLocked = !isKycVerified(user);

  const handleSend = async () => {
    if (chatLocked) return;
    const trimmed = text.trim();
    if (!trimmed && !pendingImageUri) return;
    if (!conversation?.id) {
      Alert.alert('Not ready', 'Conversation is still loading.');
      return;
    }
    setSending(true);
    const optimistic = {
      id: `tmp-${Date.now()}`,
      conversationId: String(conversation.id),
      senderId: user?.id != null ? String(user.id) : 'me',
      text: trimmed || null,
      imageUrl: pendingImageUri || null,
      createdAt: new Date().toISOString(),
      pending: true,
    };
    setMessages((prev) => [...prev, optimistic]);
    setText('');
    const imageToSend = pendingImageUri;
    setPendingImageUri(null);
    try {
      const saved = await sendMessageAPI(conversation.id, {
        text: trimmed,
        imageUri: imageToSend,
        sender: user,
      });
      if (saved && mountedRef.current) {
        setMessages((prev) =>
          prev.map((m) => (m.id === optimistic.id ? { ...saved, pending: false } : m))
        );
        if (saved.createdAt) lastIsoRef.current = saved.createdAt;
      }
    } catch (e) {
      console.error('SUPABASE CHAT ERROR:', e);
      const errForAlert =
        e && typeof e === 'object' && (e.code != null || e.details != null || e.hint != null)
          ? {
              message: e.message,
              code: e.code,
              details: e.details,
              hint: e.hint,
            }
          : e?.message || e;
      Alert.alert('Supabase Error', JSON.stringify(errForAlert));
      if (mountedRef.current) {
        setMessages((prev) => prev.map((m) => (m.id === optimistic.id ? { ...m, failed: true, pending: false } : m)));
      }
    } finally {
      if (mountedRef.current) setSending(false);
    }
  };

  const renderItem = ({ item }) => {
    const mine = String(item.senderId) === String(user?.id || '');
    return (
      <MessageBubble
        item={item}
        mine={mine}
        partnerAvatar={headerPartnerAvatar}
        partnerEmail={headerPartnerEmail}
        partnerName={headerPartnerName}
      />
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      {listingTitle ? (
        <View style={styles.contextBar}>
          <Ionicons name="pricetag-outline" size={14} color="#555" />
          <Text style={styles.contextBarText} numberOfLines={1}>
            About: {listingTitle}
          </Text>
        </View>
      ) : null}
      {errorBanner ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>{errorBanner}</Text>
        </View>
      ) : null}
      {initializing ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color="#007AFF" />
        </View>
      ) : (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 80 : 0}
        >
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(item) => String(item.id)}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={
              <View style={styles.emptyWrap}>
                {chatLocked ? (
                  <>
                    <Ionicons name="lock-closed-outline" size={42} color="#94A3B8" />
                    <Text style={styles.chatLockedText}>{KYC_CHAT_LOCKED_HINT}</Text>
                  </>
                ) : (
                  <>
                    <Ionicons name="chatbubble-ellipses-outline" size={42} color="#bbb" />
                    <Text style={styles.emptyText}>Say hi to get the conversation started.</Text>
                  </>
                )}
              </View>
            }
          />
          {chatLocked ? (
            <View style={styles.chatLockedBar}>
              <Text style={styles.chatLockedBarText}>{KYC_CHAT_LOCKED_HINT}</Text>
            </View>
          ) : null}
          {pendingImageUri ? (
            <View style={styles.previewBar}>
              <SmartImage
                uri={pendingImageUri}
                style={styles.previewThumb}
                resizeMode="cover"
                showLoader={false}
              />
              <Text style={styles.previewText} numberOfLines={1}>
                Photo attached
              </Text>
              <TouchableOpacity onPress={() => setPendingImageUri(null)} style={styles.previewRemove}>
                <Ionicons name="close-circle" size={22} color="#888" />
              </TouchableOpacity>
            </View>
          ) : null}
          <View style={[styles.composerOuter, chatLocked && styles.composerLocked]}>
            <View style={styles.composerPill}>
              <TouchableOpacity
                onPress={pickImage}
                style={styles.composerIconBtn}
                disabled={sending || chatLocked}
                accessibilityLabel="Attach file"
              >
                <Ionicons
                  name="attach"
                  size={24}
                  color={sending || chatLocked ? '#A0A0A0' : '#54656F'}
                />
              </TouchableOpacity>
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder={chatLocked ? KYC_CHAT_LOCKED_HINT : 'Message'}
                placeholderTextColor="#8696A0"
                style={[styles.composerInput, chatLocked && styles.inputLocked]}
                multiline
                editable={!sending && !chatLocked}
              />
              <TouchableOpacity
                onPress={pickImage}
                style={styles.composerIconBtn}
                disabled={sending || chatLocked}
                accessibilityLabel="Camera"
              >
                <Ionicons
                  name="camera-outline"
                  size={24}
                  color={sending || chatLocked ? '#A0A0A0' : '#54656F'}
                />
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              onPress={handleSend}
              style={[
                styles.sendFab,
                chatLocked || (!text.trim() && !pendingImageUri) || sending
                  ? styles.sendFabDisabled
                  : null,
              ]}
              disabled={chatLocked || (!text.trim() && !pendingImageUri) || sending}
              accessibilityLabel="Send message"
            >
              <Ionicons name="send" size={22} color="#FFFFFF" />
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: WA_BG },
  flex: { flex: 1, backgroundColor: WA_BG },
  navHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    maxWidth: Platform.OS === 'web' ? 320 : 260,
    paddingRight: 4,
  },
  navHeaderTextCol: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
  },
  navAvatar: {
    borderWidth: 0,
  },
  navHeaderName: {
    fontSize: 18,
    fontWeight: '800',
    color: '#111B21',
    letterSpacing: -0.2,
  },
  navHeaderStatus: {
    fontSize: 13,
    fontWeight: '500',
    color: '#25D366',
    marginTop: 2,
  },
  contextBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#f5f7fa',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e6ea',
  },
  contextBarText: { fontSize: 13, color: '#444', flex: 1 },
  errorBanner: {
    backgroundColor: '#fdecea',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  errorBannerText: { color: '#b71c1c', fontSize: 13 },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  listContent: { paddingHorizontal: 10, paddingTop: 8, paddingBottom: 18, flexGrow: 1 },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  emptyText: { color: '#667781', fontSize: 14 },
  bubbleRow: { flexDirection: 'row', marginBottom: 10 },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubbleRowTheirs: { justifyContent: 'flex-start' },
  bubbleWrap: {
    position: 'relative',
    maxWidth: '82%',
  },
  bubbleWrapMine: {
    alignItems: 'flex-end',
    paddingRight: 4,
  },
  bubbleWrapTheirs: {
    alignItems: 'flex-start',
    paddingLeft: 4,
  },
  bubble: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    paddingBottom: 6,
    borderRadius: BUBBLE_RADIUS,
    minWidth: 72,
  },
  bubbleMine: {
    backgroundColor: WA_OUTGOING,
    borderTopLeftRadius: BUBBLE_RADIUS,
    borderTopRightRadius: BUBBLE_RADIUS,
    borderBottomLeftRadius: BUBBLE_RADIUS,
    borderBottomRightRadius: 4,
  },
  bubbleTheirs: {
    backgroundColor: WA_INCOMING,
    borderTopLeftRadius: BUBBLE_RADIUS,
    borderTopRightRadius: BUBBLE_RADIUS,
    borderBottomRightRadius: BUBBLE_RADIUS,
    borderBottomLeftRadius: 4,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06,
        shadowRadius: 2,
      },
      android: { elevation: 1 },
      default: {},
    }),
  },
  bubbleFailed: { borderWidth: 1, borderColor: '#e57373' },
  bubbleTail: {
    position: 'absolute',
    bottom: 0,
    width: 0,
    height: 0,
    borderTopWidth: 8,
    borderTopColor: 'transparent',
  },
  bubbleTailRight: {
    right: -1,
    borderLeftWidth: 10,
  },
  bubbleTailLeft: {
    left: -1,
    borderRightWidth: 10,
  },
  incomingLeadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 2,
  },
  inBubbleAvatar: {
    borderWidth: 0,
  },
  incomingDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: '#8696A0',
    flexShrink: 0,
  },
  bubbleTextMine: {
    fontSize: 15.5,
    lineHeight: 21,
    color: '#111B21',
    marginBottom: 2,
  },
  bubbleTextTheirs: {
    flex: 1,
    fontSize: 15.5,
    lineHeight: 21,
    color: '#111B21',
  },
  bubbleFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    alignSelf: 'flex-end',
    gap: 4,
    marginTop: 2,
    minHeight: 16,
  },
  bubbleTime: {
    fontSize: 11,
    color: '#8696A0',
    fontWeight: '500',
  },
  bubbleMetaPending: {
    fontSize: 10,
    color: '#8696A0',
    fontStyle: 'italic',
  },
  bubbleMetaFailed: {
    fontSize: 10,
    color: '#E53935',
    fontWeight: '600',
  },
  bubbleImage: {
    width: 220,
    height: 220,
    borderRadius: 10,
    marginBottom: 6,
    backgroundColor: '#e8e8e8',
  },
  bubbleImageError: {
    width: 220,
    height: 220,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f5f5f5',
    gap: 6,
  },
  bubbleImageErrorText: { color: '#999', fontSize: 12, fontWeight: '600' },
  previewBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#f8f9fa',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e0e0e0',
  },
  previewThumb: { width: 44, height: 44, borderRadius: 8, backgroundColor: '#e0e0e0' },
  previewText: { flex: 1, color: '#444' },
  previewRemove: { padding: 4 },
  composerOuter: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 8,
    paddingVertical: 8,
    paddingBottom: Platform.OS === 'ios' ? 6 : 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#D1D7DB',
    backgroundColor: '#F0F2F5',
    gap: 8,
  },
  composerPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    minHeight: 44,
    maxHeight: 132,
    borderRadius: 24,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 4,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#E9EDEF',
  },
  composerIconBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  composerInput: {
    flex: 1,
    minHeight: 36,
    maxHeight: 108,
    fontSize: 16,
    lineHeight: 22,
    color: '#111B21',
    paddingHorizontal: 6,
    paddingVertical: Platform.OS === 'ios' ? 8 : 6,
    textAlignVertical: 'center',
  },
  sendFab: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#25D366',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.15,
        shadowRadius: 4,
      },
      android: { elevation: 3 },
      default: {},
    }),
  },
  sendFabDisabled: {
    backgroundColor: '#A0D9B8',
  },
  chatLockedText: {
    marginTop: 12,
    textAlign: 'center',
    color: '#64748B',
    fontSize: 14,
    lineHeight: 20,
    paddingHorizontal: 24,
    fontWeight: '600',
  },
  chatLockedBar: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#F1F5F9',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e0e0e0',
  },
  chatLockedBarText: {
    textAlign: 'center',
    color: '#64748B',
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  composerLocked: { opacity: 0.72 },
  inputLocked: { backgroundColor: '#F8FAFC', color: '#94A3B8' },
});

export default ChatScreen;
