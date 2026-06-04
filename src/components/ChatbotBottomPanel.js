import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  Animated,
  ActivityIndicator,
  Modal,
  Pressable,
  PanResponder,
  useWindowDimensions,
  Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { spacing } from '../theme';
import { fetchGeminiReply } from '../services/geminiChatService';
import { FormattedChatText } from '../utils/formatChatMarkdown';

const CHAT_BG = '#F4F6F8';
const INDIGO = '#1E3A8A';
const DEFAULT_WIDTH_RATIO = 0.85;
const DEFAULT_HEIGHT_RATIO = 0.45;
const CHAT_STORAGE_KEY = 'bidify_ai_chat_history';

function getWelcomeMessages() {
  return [
    {
      id: '1',
      text: "Hello! I am Bidify's AI assistant. How can I help you today?",
      sender: 'bot',
    },
  ];
}

let messageIdCounter = 2;
function nextMessageId() {
  return String(messageIdCounter++);
}

function syncMessageIdCounter(msgs) {
  const maxId = (msgs || []).reduce((max, m) => {
    const n = parseInt(String(m?.id), 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 1);
  messageIdCounter = maxId + 1;
}

async function persistMessages(msgs) {
  try {
    await AsyncStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(msgs));
  } catch (_) {
    /* ignore storage errors */
  }
}

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

function BotAvatar() {
  return (
    <View style={styles.botAvatar}>
      <Ionicons name="hardware-chip-outline" size={16} color={INDIGO} />
    </View>
  );
}

function MessageBubble({ message }) {
  const isUser = message.sender === 'user';
  if (isUser) {
    return (
      <View style={[styles.bubbleRow, styles.bubbleRowUser]}>
        <View style={[styles.bubble, styles.bubbleUser]}>
          <Text style={[styles.bubbleText, styles.bubbleTextUser]}>{message.text}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.bubbleRow, styles.bubbleRowBot]}>
      <BotAvatar />
      <View style={[styles.bubble, styles.bubbleBot]}>
        <FormattedChatText
          text={message.text}
          style={[styles.bubbleText, styles.bubbleTextBot]}
          boldStyle={styles.bubbleTextBold}
        />
      </View>
    </View>
  );
}

function TypingIndicator() {
  const dot1 = useRef(new Animated.Value(0.35)).current;
  const dot2 = useRef(new Animated.Value(0.35)).current;
  const dot3 = useRef(new Animated.Value(0.35)).current;

  useEffect(() => {
    const pulse = (anim, delay) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(anim, { toValue: 1, duration: 380, useNativeDriver: true }),
          Animated.timing(anim, { toValue: 0.35, duration: 380, useNativeDriver: true }),
        ])
      );

    const a1 = pulse(dot1, 0);
    const a2 = pulse(dot2, 120);
    const a3 = pulse(dot3, 240);
    a1.start();
    a2.start();
    a3.start();
    return () => {
      a1.stop();
      a2.stop();
      a3.stop();
    };
  }, [dot1, dot2, dot3]);

  return (
    <View style={[styles.bubbleRow, styles.bubbleRowBot]}>
      <BotAvatar />
      <View style={[styles.bubble, styles.bubbleBot, styles.typingBubble]}>
        <View style={styles.typingDots}>
          <Animated.View style={[styles.typingDot, { opacity: dot1 }]} />
          <Animated.View style={[styles.typingDot, { opacity: dot2 }]} />
          <Animated.View style={[styles.typingDot, { opacity: dot3 }]} />
        </View>
      </View>
    </View>
  );
}

export default function ChatbotBottomPanel({ visible, onClose }) {
  const { width: screenW, height: screenH } = useWindowDimensions();

  const defaultWidth = screenW * DEFAULT_WIDTH_RATIO;
  const defaultHeight = screenH * DEFAULT_HEIGHT_RATIO;
  const minWidth = screenW * 0.55;
  const maxWidth = screenW * 0.95;
  const minHeight = screenH * 0.3;
  const maxHeight = screenH * 0.85;

  const [messages, setMessages] = useState(getWelcomeMessages);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [cardWidth, setCardWidth] = useState(defaultWidth);
  const [cardHeight, setCardHeight] = useState(defaultHeight);
  const [storageReady, setStorageReady] = useState(false);
  const listRef = useRef(null);
  const resizeStartRef = useRef({ w: defaultWidth, h: defaultHeight });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(CHAT_STORAGE_KEY);
        if (!cancelled && raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            setMessages(parsed);
            syncMessageIdCounter(parsed);
          }
        }
      } catch (_) {
        /* fallback to welcome message */
      } finally {
        if (!cancelled) setStorageReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    persistMessages(messages);
  }, [messages, storageReady]);

  const handleClearChat = useCallback(() => {
    Alert.alert(
      'Clear Conversation?',
      'Are you sure you want to delete all messages with Bidify AI?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            const welcome = getWelcomeMessages();
            messageIdCounter = 2;
            setMessages(welcome);
            persistMessages(welcome);
          },
        },
      ]
    );
  }, []);

  useEffect(() => {
    if (!visible) {
      setIsFullScreen(false);
      setCardWidth(screenW * DEFAULT_WIDTH_RATIO);
      setCardHeight(screenH * DEFAULT_HEIGHT_RATIO);
    }
  }, [visible, screenW, screenH]);

  useEffect(() => {
    setCardWidth(screenW * DEFAULT_WIDTH_RATIO);
    setCardHeight(screenH * DEFAULT_HEIGHT_RATIO);
  }, [screenW, screenH]);

  const scrollToEnd = useCallback((animated = true) => {
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd?.({ animated });
    });
  }, []);

  useEffect(() => {
    if (visible) scrollToEnd(false);
  }, [messages, isTyping, visible, scrollToEnd]);

  const resizePanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !isFullScreen,
        onMoveShouldSetPanResponder: () => !isFullScreen,
        onPanResponderGrant: () => {
          resizeStartRef.current = { w: cardWidth, h: cardHeight };
        },
        onPanResponderMove: (_, gesture) => {
          const nextW = clamp(resizeStartRef.current.w + gesture.dx, minWidth, maxWidth);
          const nextH = clamp(resizeStartRef.current.h + gesture.dy, minHeight, maxHeight);
          setCardWidth(nextW);
          setCardHeight(nextH);
        },
      }),
    [isFullScreen, cardWidth, cardHeight, minWidth, maxWidth, minHeight, maxHeight]
  );

  const sendMessage = useCallback(
    async (userText) => {
      const trimmed = String(userText || '').trim();
      if (!trimmed || isTyping) return;

      const userMessage = { id: nextMessageId(), text: trimmed, sender: 'user' };
      const historyWithUser = [...messages, userMessage];

      setMessages(historyWithUser);
      setInput('');
      setIsTyping(true);

      try {
        const replyText = await fetchGeminiReply(historyWithUser);
        setMessages((prev) => [
          ...prev,
          { id: nextMessageId(), text: replyText, sender: 'bot' },
        ]);
      } catch (err) {
        const fallback =
          err?.message ||
          'Sorry, I could not reach Bidify AI right now. Please try again in a moment.';
        setMessages((prev) => [
          ...prev,
          { id: nextMessageId(), text: fallback, sender: 'bot' },
        ]);
      } finally {
        setIsTyping(false);
      }
    },
    [messages, isTyping]
  );

  const handleSend = () => sendMessage(input);
  const canSend = input.trim().length > 0 && !isTyping;

  const cardStyle = isFullScreen
    ? styles.chatCardFull
    : [
        styles.chatCardCompact,
        {
          width: cardWidth,
          height: cardHeight,
          borderRadius: 20,
        },
      ];

  const modalStyle = isFullScreen ? styles.modalRootFull : styles.modalRootCompact;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable
        style={modalStyle}
        onPress={isFullScreen ? undefined : onClose}
        accessibilityLabel="Close chat"
      >
        <Pressable style={cardStyle} onPress={() => {}}>
          <View style={styles.panelHeader}>
            <LinearGradient
              colors={['#1E3A8A', '#6B21A8']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.headerIcon}
            >
              <Ionicons name="sparkles" size={18} color="#FFFFFF" />
            </LinearGradient>
            <Text style={styles.panelTitle}>Bidify AI</Text>
            <View style={styles.headerActions}>
              <TouchableOpacity
                style={styles.clearPill}
                onPress={handleClearChat}
                activeOpacity={0.88}
                accessibilityLabel="Clear all chat"
              >
                <Ionicons name="trash-outline" size={14} color="#64748B" />
                <Text style={styles.clearPillText}>Clear Chat</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setIsFullScreen((v) => !v)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                accessibilityLabel={isFullScreen ? 'Minimize chat' : 'Maximize chat'}
              >
                <Ionicons
                  name={isFullScreen ? 'contract-outline' : 'expand-outline'}
                  size={22}
                  color="#64748B"
                />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onClose}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                accessibilityLabel="Close"
              >
                <Ionicons name="close" size={24} color="#64748B" />
              </TouchableOpacity>
            </View>
          </View>

          <KeyboardAvoidingView
            style={styles.panelBody}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={Platform.OS === 'ios' ? (isFullScreen ? 0 : 24) : 0}
          >
            <FlatList
              ref={listRef}
              style={styles.messageList}
              data={messages}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => <MessageBubble message={item} />}
              contentContainerStyle={styles.listContent}
              showsVerticalScrollIndicator={false}
              onContentSizeChange={() => scrollToEnd(true)}
              ListFooterComponent={isTyping ? <TypingIndicator /> : null}
            />

            <View
              style={[
                styles.inputFooter,
                !isFullScreen && styles.inputFooterCompact,
              ]}
            >
              <View style={styles.inputBar}>
                <TextInput
                  style={styles.input}
                  placeholder="Ask Bidify AI..."
                  placeholderTextColor="#94A3B8"
                  value={input}
                  onChangeText={setInput}
                  multiline
                  maxLength={2000}
                  editable={!isTyping}
                  returnKeyType="send"
                  onSubmitEditing={handleSend}
                  blurOnSubmit={false}
                />
                <TouchableOpacity
                  style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
                  onPress={handleSend}
                  disabled={!canSend}
                  activeOpacity={0.88}
                  accessibilityLabel="Send message"
                >
                  {isTyping ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <Ionicons name="send" size={18} color="#FFFFFF" />
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>

          {!isFullScreen ? (
            <View style={styles.resizeHandle} {...resizePanResponder.panHandlers}>
              <View style={styles.resizeLineA} />
              <View style={styles.resizeLineB} />
              <Ionicons
                name="resize-outline"
                size={14}
                color="#94A3B8"
                style={styles.resizeIcon}
              />
            </View>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const cardShadow = Platform.select({
  ios: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
  },
  android: { elevation: 8 },
});

const styles = StyleSheet.create({
  modalRootCompact: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
    paddingHorizontal: spacing.md,
  },
  modalRootFull: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  chatCardCompact: {
    backgroundColor: '#FFFFFF',
    overflow: 'hidden',
    ...cardShadow,
  },
  chatCardFull: {
    width: '100%',
    height: '100%',
    borderRadius: 0,
    backgroundColor: '#FFFFFF',
    overflow: 'hidden',
  },
  panelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E2E8F0',
    backgroundColor: '#FFFFFF',
  },
  headerIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  panelTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '800',
    color: '#0F172A',
    letterSpacing: -0.3,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexShrink: 0,
  },
  clearPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  clearPillText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748B',
    marginLeft: 4,
  },
  panelBody: {
    flex: 1,
    backgroundColor: CHAT_BG,
    minHeight: 0,
  },
  inputFooter: {
    flexShrink: 0,
    backgroundColor: CHAT_BG,
    paddingTop: 4,
  },
  inputFooterCompact: {
    paddingRight: 28,
    paddingBottom: 2,
  },
  messageList: {
    flex: 1,
    backgroundColor: CHAT_BG,
  },
  listContent: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    flexGrow: 1,
  },
  bubbleRow: {
    marginBottom: 8,
    maxWidth: '90%',
  },
  bubbleRowUser: {
    alignSelf: 'flex-end',
  },
  bubbleRowBot: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    maxWidth: '94%',
  },
  botAvatar: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#EEF2FF',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  bubble: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 16,
    flexShrink: 1,
  },
  bubbleUser: {
    backgroundColor: INDIGO,
    borderBottomRightRadius: 5,
  },
  bubbleBot: {
    backgroundColor: '#FFFFFF',
    borderBottomLeftRadius: 5,
    flex: 1,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06,
        shadowRadius: 3,
      },
      android: { elevation: 1 },
    }),
  },
  bubbleText: {
    fontSize: 14,
    lineHeight: 20,
  },
  bubbleTextUser: {
    color: '#FFFFFF',
    fontWeight: '500',
  },
  bubbleTextBot: {
    color: '#334155',
    fontWeight: '500',
  },
  bubbleTextBold: {
    fontWeight: '800',
    color: '#0F172A',
  },
  typingBubble: {
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  typingDots: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  typingDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#94A3B8',
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginHorizontal: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    overflow: 'visible',
  },
  input: {
    flex: 1,
    fontSize: 14,
    color: '#0F172A',
    maxHeight: 80,
    paddingTop: Platform.OS === 'ios' ? 8 : 6,
    paddingBottom: Platform.OS === 'ios' ? 8 : 6,
    fontWeight: '500',
    textAlignVertical: 'center',
  },
  sendBtn: {
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: INDIGO,
    flexShrink: 0,
  },
  sendBtnDisabled: {
    backgroundColor: '#94A3B8',
    opacity: 0.7,
  },
  resizeHandle: {
    position: 'absolute',
    right: 0,
    bottom: 72,
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderTopLeftRadius: 12,
    backgroundColor: 'rgba(241,245,249,0.95)',
  },
  resizeLineA: {
    position: 'absolute',
    right: 8,
    bottom: 10,
    width: 12,
    height: 2,
    backgroundColor: '#CBD5E1',
    transform: [{ rotate: '-45deg' }],
  },
  resizeLineB: {
    position: 'absolute',
    right: 12,
    bottom: 14,
    width: 8,
    height: 2,
    backgroundColor: '#CBD5E1',
    transform: [{ rotate: '-45deg' }],
  },
  resizeIcon: {
    position: 'absolute',
    right: 6,
    bottom: 6,
  },
});
