import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Image,
  Platform,
  useWindowDimensions,
  TextInput,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AuthContext } from '../context/AuthContext';
import { getConversationsAPI } from '../api/chat';
import { markConversationMessagesRead } from '../services/chatService';
import { fetchListingById } from '../services/listingsService';
import { getListingCoverUri, normalizeListing, resolveMediaUrl } from '../utils/listingMedia';
import { SwipeListView } from 'react-native-swipe-list-view';
import { colors, spacing } from '../theme';
import { useChatUnread } from '../context/ChatUnreadContext';

const THUMB_SIZE = 56;
const DEEP_ROYAL_BLUE = '#0B3D91';
const HEADER_BG = DEEP_ROYAL_BLUE;
const HEADER_TEXT = '#FFFFFF';
const WALLPAPER_BG = '#F4F6F8';
const ROW_BG = '#FFFFFF';
const UNREAD_ACCENT = '#25D366';
const ONLINE_GREEN = '#22C55E';
const PREVIEW_COLOR = '#64748B';
const LABEL_GREY = '#666666';
const THUMB_BORDER = 'rgba(11, 61, 145, 0.12)';
const AVATAR_INSET = THUMB_SIZE + spacing.lg + spacing.md;
const CARD_SHADOW = {
  shadowColor: '#1E293B',
  shadowOffset: { width: 0, height: 3 },
  shadowOpacity: 0.08,
  shadowRadius: 10,
  elevation: 4,
};
const PATTERN_TILE = 88;
const GAVEL_PATTERN_ICON = 'hammer-outline';
const TICK_MS = 30_000;
const READ_AT_KEY = (id) => `chatLastReadAt:${id}`;
const FILTER_ALL = 'all';
const FILTER_READ = 'read';
const FILTER_UNREAD = 'unread';
const GENERIC_TITLES = new Set(['listing', 'seller', 'user', 'chat', 'untitled listing']);

function normalizeLastMessage(lm) {
  if (!lm) return null;
  return {
    ...lm,
    text: lm.text ?? lm.body ?? lm.message ?? null,
    imageUrl: lm.imageUrl ?? lm.image_url ?? null,
    createdAt: lm.createdAt ?? lm.created_at ?? null,
    senderId: lm.senderId != null ? String(lm.senderId) : lm.sender_id != null ? String(lm.sender_id) : null,
  };
}

function lastMessagePreview(conversation) {
  const lm = normalizeLastMessage(conversation?.lastMessage);
  if (!lm) return { text: 'No messages yet', hasMessage: false };
  const raw = lm.text != null ? String(lm.text).trim() : '';
  if (raw) return { text: raw, hasMessage: true };
  if (lm.imageUrl) return { text: 'Photo', hasMessage: true };
  return { text: 'No messages yet', hasMessage: false };
}

function isSameCalendarDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** WhatsApp-style: Just now · time today · Yesterday · weekday · date */
function formatChatTimestamp(iso, now = new Date()) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';

  const diffMs = now.getTime() - d.getTime();
  if (diffMs < 60_000) return 'Just now';

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  if (isSameCalendarDay(d, now)) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (d >= startOfYesterday && d < startOfToday) return 'Yesterday';

  const weekAgo = new Date(startOfToday);
  weekAgo.setDate(weekAgo.getDate() - 6);
  if (d >= weekAgo) {
    return d.toLocaleDateString([], { weekday: 'short' });
  }

  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function pickListingObject(item) {
  if (item?.listing && typeof item.listing === 'object') return item.listing;
  return null;
}

/** True when a string is a username/placeholder, not a product title. */
function isPersonLikeTitle(title, item) {
  const t = title != null ? String(title).trim().toLowerCase() : '';
  if (!t || GENERIC_TITLES.has(t)) return true;

  const names = new Set();
  const other = item?.other;
  if (other?.name) names.add(String(other.name).trim().toLowerCase());
  if (other?.email) names.add(String(other.email).split('@')[0].trim().toLowerCase());
  if (item?.seller?.name) names.add(String(item.seller.name).trim().toLowerCase());
  if (item?.buyer?.name) names.add(String(item.buyer.name).trim().toLowerCase());
  if (item?.otherUser?.name) names.add(String(item.otherUser.name).trim().toLowerCase());

  if (names.has(t)) return true;
  return false;
}

/** Listing/product title only — never conversation title or other user's name. */
function pickProductTitle(item) {
  const listing = pickListingObject(item);
  const candidates = [
    listing?.title,
    listing?.name,
    item?.listingTitle,
    item?.listing_title,
    listing?.listing_title,
  ];
  for (const raw of candidates) {
    const t = raw != null ? String(raw).trim() : '';
    if (t && !isPersonLikeTitle(t, item)) return t;
  }
  return '';
}

function getDisplayListingTitle(item) {
  const title = pickProductTitle(item);
  if (title) return title;
  if (item?.listingId) return `Listing #${String(item.listingId).slice(0, 8)}`;
  return 'Untitled listing';
}

function pickOtherName(item) {
  const other = item?.other;
  if (other?.name && String(other.name).trim()) {
    const n = String(other.name).trim();
    if (n.toLowerCase() !== 'seller' && n.length > 1) return n;
  }
  if (other?.email && String(other.email).trim()) return String(other.email).split('@')[0];
  if (item?.seller?.name && String(item.seller.name).trim()) return String(item.seller.name).trim();
  if (item?.buyer?.name && String(item.buyer.name).trim()) return String(item.buyer.name).trim();
  return 'User';
}

function pickAvatarFallbackLetter(item) {
  return pickOtherName(item).charAt(0).toUpperCase() || 'U';
}

/** User-facing avatar URLs (profile first, listing cover as visual fallback). */
function pickUserAvatarSources(item) {
  const listing = pickListingObject(item);
  const rawCandidates = [
    item?.other?.avatarUrl,
    item?.other?.avatar_url,
    item?.other?.profile_image,
    item?.other?.profileImage,
    item?.seller?.avatarUrl,
    item?.seller?.avatar_url,
    item?.buyer?.avatarUrl,
    item?.buyer?.avatar_url,
    item?.otherUser?.avatarUrl,
    item?.listingImage,
    item?.listing_image,
    listing?.image_url,
    listing?.image,
    Array.isArray(listing?.images) ? listing.images[0] : null,
  ];

  const urls = [];
  const seen = new Set();
  const add = (raw) => {
    if (raw == null) return;
    const resolved = resolveMediaUrl(raw);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      urls.push(resolved);
    }
  };

  for (const raw of rawCandidates) add(raw);
  if (listing) {
    const cover = getListingCoverUri(normalizeListing(listing));
    if (cover && !seen.has(cover)) urls.push(cover);
  }
  return urls;
}

function pickThumbSources(item) {
  const listing = pickListingObject(item);
  const rawCandidates = [
    item?.listingImage,
    item?.listing_image,
    item?.image_url,
    listing?.image_url,
    listing?.image,
    Array.isArray(listing?.images) ? listing.images[0] : null,
    Array.isArray(listing?.image_urls) ? listing.image_urls[0] : null,
    item?.other?.avatarUrl,
    item?.other?.avatar_url,
    item?.other?.profile_image,
    item?.seller?.avatarUrl,
    item?.buyer?.avatarUrl,
  ];

  const urls = [];
  const seen = new Set();
  const add = (raw) => {
    if (raw == null) return;
    const resolved = resolveMediaUrl(raw);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      urls.push(resolved);
    }
  };

  for (const raw of rawCandidates) add(raw);
  if (listing) {
    const cover = getListingCoverUri(normalizeListing(listing));
    if (cover && !seen.has(cover)) urls.push(cover);
  }
  return urls;
}

function pickUnreadCount(item, userId, readAtMs) {
  const explicit = item?.unreadCount ?? item?.unread_count ?? item?.unread;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) {
    return Math.min(99, Math.floor(explicit));
  }
  if (explicit === 0) return 0;

  const lm = normalizeLastMessage(item?.lastMessage);
  if (!lm?.senderId || !lm.createdAt) return 0;
  const uid = userId != null ? String(userId) : '';
  if (!uid || lm.senderId === uid) return 0;

  const msgAt = new Date(lm.createdAt).getTime();
  if (!Number.isFinite(msgAt)) return 1;
  if (readAtMs == null || !Number.isFinite(readAtMs) || msgAt > readAtMs) return 1;
  return 0;
}

function isConversationUnread(item, userId, readAtMs) {
  if (item?.is_read === false || item?.isRead === false) return true;
  if (item?.is_read === true || item?.isRead === true) return false;
  return pickUnreadCount(item, userId, readAtMs) > 0;
}

async function loadReadAtMap(conversationIds) {
  const map = {};
  if (!conversationIds.length) return map;
  try {
    const keys = conversationIds.map((id) => READ_AT_KEY(id));
    const pairs = await AsyncStorage.multiGet(keys);
    for (const [key, value] of pairs) {
      if (!value) continue;
      const id = key.replace('chatLastReadAt:', '');
      const t = new Date(value).getTime();
      if (Number.isFinite(t)) map[id] = t;
    }
  } catch (_) {}
  return map;
}

async function markConversationRead(conversationId) {
  if (!conversationId) return;
  try {
    await AsyncStorage.setItem(READ_AT_KEY(String(conversationId)), new Date().toISOString());
  } catch (_) {}
}

function needsListingEnrichment(item) {
  if (!item?.listingId) return false;
  const title = pickProductTitle(item);
  if (!title || isPersonLikeTitle(title, item)) return true;
  if (pickThumbSources(item).length === 0) return true;
  return false;
}

async function enrichConversationsWithListings(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return Promise.all(
    list.map(async (c) => {
      if (!needsListingEnrichment(c)) return c;
      try {
        const raw = await fetchListingById(c.listingId);
        if (!raw) return c;
        const listing = normalizeListing(raw);
        const realTitle = listing.title && !isPersonLikeTitle(listing.title, c) ? listing.title : '';
        return {
          ...c,
          listing,
          listingTitle: realTitle || c.listingTitle,
          listingImage: listing.image || c.listingImage || (listing.images?.[0] ?? null),
        };
      } catch {
        return c;
      }
    })
  );
}

function ThreadAvatar({ sources, fallbackLetter, showOnlineDot = true }) {
  const stableSources = useMemo(() => sources.filter(Boolean), [sources]);
  const [index, setIndex] = useState(0);
  const [exhausted, setExhausted] = useState(false);

  useEffect(() => {
    setIndex(0);
    setExhausted(false);
  }, [stableSources.join('|')]);

  const letter = (fallbackLetter || 'U').charAt(0).toUpperCase();
  const uri = !exhausted && stableSources.length > 0 ? stableSources[index] : null;

  const avatarInner = !uri ? (
    <View style={styles.thumb}>
      <Text style={styles.thumbLetter}>{letter}</Text>
    </View>
  ) : (
    <View style={styles.thumb}>
      <Image
        key={uri}
        source={{ uri }}
        style={styles.thumbImage}
        resizeMode="cover"
        onError={() => {
          if (index + 1 < stableSources.length) setIndex((i) => i + 1);
          else setExhausted(true);
        }}
      />
    </View>
  );

  return (
    <View style={styles.avatarWrap}>
      {avatarInner}
      {showOnlineDot ? <View style={styles.onlineDot} accessibilityLabel="Active" /> : null}
    </View>
  );
}

/** Faint tiled doodles (WhatsApp-style) on cream wallpaper — Bidify auction motifs. */
function ChatWallpaper({ children }) {
  const { width, height } = useWindowDimensions();
  const cols = Math.ceil(width / PATTERN_TILE) + 1;
  const rows = Math.ceil((height + 120) / PATTERN_TILE) + 1;

  const tiles = useMemo(() => {
    const out = [];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const stagger = r % 2 === 0 ? 6 : PATTERN_TILE / 2;
        out.push({
          key: `${r}-${c}`,
          left: c * PATTERN_TILE + stagger,
          top: r * PATTERN_TILE + 10,
          size: 22 + ((r + c) % 3) * 4,
          opacity: 0.04 + ((r + c) % 4) * 0.012,
          rotate: ((r * 3 + c * 5) % 8) * 6 - 20,
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
            name={GAVEL_PATTERN_ICON}
            size={t.size}
            color={`rgba(11, 61, 145, ${t.opacity})`}
            style={{
              position: 'absolute',
              left: t.left,
              top: t.top,
              transform: [{ rotate: `${t.rotate}deg` }],
            }}
          />
        ))}
      </View>
      {children}
    </View>
  );
}

function UnreadBadge({ count }) {
  if (!count || count < 1) return null;
  const label = count > 99 ? '99+' : String(count);
  return (
    <View style={styles.unreadBadge}>
      <Text style={styles.unreadBadgeText}>{label}</Text>
    </View>
  );
}

function ChatListToolbar({ searchQuery, onSearchChange, activeFilter, onFilterChange }) {
  const filters = [
    { id: FILTER_ALL, label: 'All' },
    { id: FILTER_READ, label: 'Read' },
    { id: FILTER_UNREAD, label: 'Unread' },
  ];

  return (
    <View style={styles.toolbar}>
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={18} color={colors.textFaint} style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search by listing title"
          placeholderTextColor={colors.textFaint}
          value={searchQuery}
          onChangeText={onSearchChange}
          returnKeyType="search"
          clearButtonMode="while-editing"
          autoCorrect={false}
          autoCapitalize="none"
        />
        {searchQuery.length > 0 ? (
          <TouchableOpacity
            onPress={() => onSearchChange('')}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel="Clear search"
          >
            <Ionicons name="close-circle" size={18} color={colors.textFaint} />
          </TouchableOpacity>
        ) : null}
      </View>
      <View style={styles.filterRow}>
        {filters.map((f) => {
          const active = activeFilter === f.id;
          return (
            <TouchableOpacity
              key={f.id}
              style={[styles.filterChip, active && styles.filterChipActive]}
              onPress={() => onFilterChange(f.id)}
              activeOpacity={0.8}
            >
              <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                {f.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function ChatRowSeparator() {
  return <View style={styles.rowSeparator} />;
}

function SelectionCheckbox({ selected, onPress }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={styles.selectCheckboxHit}
      hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
      activeOpacity={0.7}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={selected ? 'Deselect chat' : 'Select chat'}
    >
      {selected ? (
        <View style={styles.selectCircleFilled}>
          <Ionicons name="checkmark" size={15} color="#FFFFFF" />
        </View>
      ) : (
        <View style={styles.selectCircleEmpty} />
      )}
    </TouchableOpacity>
  );
}

function ChatListHeader({
  onBack,
  isSelectionMode,
  onEdit,
  onCancel,
  onSelectAll,
  onDeleteSelected,
  onClearAll,
  hasSelection,
}) {
  if (isSelectionMode) {
    return (
      <View style={[styles.header, styles.headerSelection]}>
        <TouchableOpacity
          onPress={onCancel}
          style={styles.headerSideBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel="Cancel selection"
        >
          <Text style={styles.headerActionText}>Cancel</Text>
        </TouchableOpacity>
        <Text style={[styles.headerTitle, styles.headerTitleSelection]} numberOfLines={1}>
          Select chats
        </Text>
        <View style={styles.headerBulkActions}>
          <TouchableOpacity
            onPress={onSelectAll}
            style={styles.headerBulkTextBtn}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            accessibilityRole="button"
            accessibilityLabel="Select all chats"
          >
            <Text style={styles.headerBulkText}>Select All</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onDeleteSelected}
            style={[styles.headerIconBtn, !hasSelection && styles.headerIconBtnDisabled]}
            disabled={!hasSelection}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            accessibilityRole="button"
            accessibilityLabel="Delete selected chats"
          >
            <Ionicons
              name="trash-outline"
              size={22}
              color={hasSelection ? HEADER_TEXT : 'rgba(255,255,255,0.45)'}
            />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onClearAll}
            style={styles.headerBulkTextBtn}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            accessibilityRole="button"
            accessibilityLabel="Clear all chats from list"
          >
            <Text style={styles.headerBulkText}>Clear All</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.header}>
      <TouchableOpacity
        onPress={onBack}
        style={styles.headerSideBtn}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        accessibilityRole="button"
        accessibilityLabel="Go back"
      >
        <Ionicons name="chevron-back" size={26} color={HEADER_TEXT} />
      </TouchableOpacity>
      <Text style={styles.headerTitle}>Chats</Text>
      <TouchableOpacity
        onPress={onEdit}
        style={styles.headerSideBtn}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        accessibilityRole="button"
        accessibilityLabel="Edit chats"
      >
        <Text style={styles.headerActionText}>Edit</Text>
      </TouchableOpacity>
    </View>
  );
}

function ConversationRow({
  item,
  userId,
  readAtMs,
  now,
  onPress,
  onToggleSelect,
  isSelectionMode = false,
  isSelected = false,
}) {
  const otherName = pickOtherName(item);
  const thumbSources = useMemo(() => pickUserAvatarSources(item), [item]);
  const fallbackLetter = pickAvatarFallbackLetter(item);
  const lm = normalizeLastMessage(item.lastMessage);
  const { text: previewBase, hasMessage } = lastMessagePreview(item);
  const isMine = lm?.senderId && String(lm.senderId) === String(userId || '');
  const preview = hasMessage && isMine ? `You: ${previewBase}` : previewBase;
  const unread = pickUnreadCount(item, userId, readAtMs);
  const when = formatChatTimestamp(lm?.createdAt || item.createdAt, now);

  const rowMain = (
    <>
      <ThreadAvatar sources={thumbSources} fallbackLetter={fallbackLetter} />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text
            style={[styles.userName, unread > 0 && styles.userNameUnread]}
            numberOfLines={1}
          >
            {otherName}
          </Text>
          {when ? (
            <Text style={[styles.rowTime, unread > 0 && styles.rowTimeUnread]}>{when}</Text>
          ) : null}
        </View>
        <View style={styles.previewRow}>
          <Text
            style={[styles.rowPreview, unread > 0 && styles.rowPreviewUnread]}
            numberOfLines={1}
          >
            {preview}
          </Text>
          <UnreadBadge count={unread} />
        </View>
      </View>
    </>
  );

  if (isSelectionMode) {
    return (
      <View style={[styles.chatRow, isSelected && styles.chatRowSelected]}>
        <SelectionCheckbox selected={isSelected} onPress={onToggleSelect} />
        <TouchableOpacity
          style={styles.chatRowSelectable}
          onPress={onPress}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={`${isSelected ? 'Deselect' : 'Select'} chat with ${otherName}`}
        >
          {rowMain}
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <TouchableOpacity style={styles.chatRow} onPress={onPress} activeOpacity={0.65}>
      {rowMain}
    </TouchableOpacity>
  );
}

const ChatListScreen = ({ navigation }) => {
  const { user, isAuthenticated } = useContext(AuthContext);
  const { refresh: refreshChatTabBadge } = useChatUnread();
  const [conversations, setConversations] = useState([]);
  const [readAtByConvo, setReadAtByConvo] = useState({});
  const [now, setNow] = useState(() => new Date());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState(FILTER_ALL);
  const [dismissedChatIds, setDismissedChatIds] = useState(() => new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedChatIds, setSelectedChatIds] = useState([]);
  const hasLoadedOnceRef = React.useRef(false);

  const selectedChatIdSet = useMemo(
    () => new Set(selectedChatIds.map(String)),
    [selectedChatIds]
  );

  const exitSelectionMode = useCallback(() => {
    setIsSelectionMode(false);
    setSelectedChatIds([]);
  }, []);

  const enterSelectionMode = useCallback(() => {
    setIsSelectionMode(true);
    setSelectedChatIds([]);
  }, []);

  const toggleChatSelection = useCallback((chatId) => {
    const id = String(chatId);
    if (!id) return;
    setSelectedChatIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }, []);

  const deleteSelectedChats = useCallback(() => {
    if (selectedChatIds.length === 0) return;
    const ids = [...selectedChatIds];
    setDismissedChatIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(String(id));
      return next;
    });
    exitSelectionMode();
  }, [selectedChatIds, exitSelectionMode]);

  const confirmDeleteSelectedChats = useCallback(() => {
    if (selectedChatIds.length === 0) return;
    Alert.alert('Delete selected chats?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: deleteSelectedChats,
      },
    ]);
  }, [selectedChatIds.length, deleteSelectedChats]);

  const filteredConversations = useMemo(() => {
    let list = conversations;
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter((item) => getDisplayListingTitle(item).toLowerCase().includes(q));
    }
    if (activeFilter === FILTER_UNREAD) {
      list = list.filter((item) =>
        isConversationUnread(item, user?.id, readAtByConvo[String(item.id)])
      );
    } else if (activeFilter === FILTER_READ) {
      list = list.filter(
        (item) => !isConversationUnread(item, user?.id, readAtByConvo[String(item.id)])
      );
    }
    return list;
  }, [conversations, searchQuery, activeFilter, readAtByConvo, user?.id]);

  const visibleConversations = useMemo(
    () => filteredConversations.filter((c) => !dismissedChatIds.has(String(c.id))),
    [filteredConversations, dismissedChatIds]
  );

  const selectAllChats = useCallback(() => {
    setSelectedChatIds(visibleConversations.map((c) => String(c.id)));
  }, [visibleConversations]);

  const clearAllChats = useCallback(() => {
    if (visibleConversations.length === 0) {
      exitSelectionMode();
      return;
    }
    setDismissedChatIds((prev) => {
      const next = new Set(prev);
      for (const c of visibleConversations) {
        if (c?.id != null) next.add(String(c.id));
      }
      return next;
    });
    exitSelectionMode();
  }, [visibleConversations, exitSelectionMode]);

  const confirmClearAllChats = useCallback(() => {
    if (visibleConversations.length === 0) return;
    Alert.alert('Clear all chats?', 'All chats will be removed from your list.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear All', style: 'destructive', onPress: clearAllChats },
    ]);
  }, [visibleConversations.length, clearAllChats]);

  const deleteChat = useCallback((conversationId) => {
    if (!conversationId) return;
    setDismissedChatIds((prev) => {
      const next = new Set(prev);
      next.add(String(conversationId));
      return next;
    });
  }, []);

  const handleDeleteChat = useCallback(
    (chatId, rowMap) => {
      const id = chatId != null ? String(chatId) : '';
      if (!id) return;
      Alert.alert('Delete Chat', 'Are you sure you want to delete this chat?', [
        {
          text: 'Cancel',
          style: 'cancel',
          onPress: () => {
            try {
              rowMap?.closeRowKey?.(id);
            } catch (_) {
              /* ignore */
            }
          },
        },
        {
          text: 'Yes',
          style: 'destructive',
          onPress: () => {
            deleteChat(id);
            try {
              rowMap?.closeRowKey?.(id);
            } catch (_) {
              /* ignore */
            }
          },
        },
      ]);
    },
    [deleteChat]
  );

  const handleBack = useCallback(() => {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.navigate('Home');
  }, [navigation]);

  const refreshReadMap = useCallback(async (rows) => {
    const ids = (rows || []).map((c) => String(c.id));
    const map = await loadReadAtMap(ids);
    setReadAtByConvo(map);
  }, []);

  const load = useCallback(
    async (showSpinner = true) => {
      if (!isAuthenticated) {
        setConversations([]);
        setReadAtByConvo({});
        setLoading(false);
        return;
      }
      if (showSpinner && !hasLoadedOnceRef.current) setLoading(true);
      setErrorText('');
      try {
        const rows = await getConversationsAPI(user?.id);
        const enriched = await enrichConversationsWithListings(rows);
        enriched.sort((a, b) => {
          const ta = new Date(
            normalizeLastMessage(a.lastMessage)?.createdAt || a.createdAt || 0
          ).getTime();
          const tb = new Date(
            normalizeLastMessage(b.lastMessage)?.createdAt || b.createdAt || 0
          ).getTime();
          return tb - ta;
        });
        setConversations(enriched);
        await refreshReadMap(enriched);
      } catch (e) {
        setErrorText(e?.message || 'Could not load chats');
      } finally {
        hasLoadedOnceRef.current = true;
        setLoading(false);
        setRefreshing(false);
      }
    },
    [isAuthenticated, user?.id, refreshReadMap]
  );

  useFocusEffect(
    useCallback(() => {
      load(true);
      void refreshChatTabBadge();
    }, [load, refreshChatTabBadge])
  );

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const openChat = useCallback(
    async (item) => {
      await markConversationRead(item.id);
      if (user?.id) {
        await markConversationMessagesRead(item.id, user.id);
      }
      setReadAtByConvo((prev) => ({ ...prev, [String(item.id)]: Date.now() }));
      setConversations((prev) =>
        prev.map((c) =>
          String(c.id) === String(item.id) ? { ...c, unreadCount: 0 } : c
        )
      );
      void refreshChatTabBadge();
      const listing = pickListingObject(item);
      navigation.navigate('Chat', {
        conversationId: item.id,
        listingId: item.listingId,
        title: pickOtherName(item),
        listingTitle: getDisplayListingTitle(item),
        listingImage:
          item.listingImage ||
          item.listing_image ||
          listing?.image_url ||
          listing?.image ||
          null,
      });
    },
    [navigation, user?.id, refreshChatTabBadge]
  );

  const handleRowPress = useCallback(
    (item) => {
      if (isSelectionMode) {
        toggleChatSelection(item.id);
        return;
      }
      void openChat(item);
    },
    [isSelectionMode, toggleChatSelection, openChat]
  );

  useEffect(() => {
    if (!isSelectionMode) return;
    setSelectedChatIds((prev) =>
      prev.filter((id) => visibleConversations.some((c) => String(c.id) === String(id)))
    );
  }, [visibleConversations, isSelectionMode]);

  const renderHiddenChatRow = useCallback(
    (rowData, rowMap) => {
      if (isSelectionMode) return null;
      const item = rowData?.item;
      if (!item?.id) return null;
      return (
        <View style={styles.hiddenRow}>
          <TouchableOpacity
            style={styles.deleteBtn}
            onPress={() => handleDeleteChat(item.id, rowMap)}
            activeOpacity={0.88}
            accessibilityRole="button"
            accessibilityLabel="Delete chat from list"
          >
            <Ionicons name="trash-outline" size={22} color="#FFFFFF" />
            <Text style={styles.deleteBtnText}>Delete</Text>
          </TouchableOpacity>
        </View>
      );
    },
    [handleDeleteChat, isSelectionMode]
  );

  if (!isAuthenticated) {
    return (
      <SafeAreaView style={styles.safeTop} edges={['top']}>
        <ChatListHeader onBack={handleBack} />
        <View style={styles.screenBody}>
        <ChatWallpaper>
        <View style={styles.emptyWrap}>
          <View style={styles.emptyIconCircle}>
            <Ionicons name="chatbubbles-outline" size={32} color={colors.textFaint} />
          </View>
          <Text style={styles.emptyTitle}>Sign in to chat</Text>
          <Text style={styles.emptyText}>You need an account to message sellers.</Text>
        </View>
        </ChatWallpaper>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeTop} edges={['top']}>
      <ChatListHeader
        onBack={handleBack}
        isSelectionMode={isSelectionMode}
        onEdit={enterSelectionMode}
        onCancel={exitSelectionMode}
        onSelectAll={selectAllChats}
        onDeleteSelected={confirmDeleteSelectedChats}
        onClearAll={confirmClearAllChats}
        hasSelection={selectedChatIds.length > 0}
      />
      <View style={styles.screenBody}>
      <ChatWallpaper>
      {!loading ? (
        <ChatListToolbar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
        />
      ) : null}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={HEADER_BG} />
        </View>
      ) : (
        <SwipeListView
          style={styles.list}
          data={visibleConversations}
          keyExtractor={(item) => String(item.id)}
          ItemSeparatorComponent={ChatRowSeparator}
          contentContainerStyle={
            visibleConversations.length === 0 ? styles.emptyContainer : styles.listContent
          }
          showsVerticalScrollIndicator
          keyboardShouldPersistTaps="handled"
          closeOnRowPress={!isSelectionMode}
          closeOnRowBeginSwipe={!isSelectionMode}
          rightOpenValue={isSelectionMode ? 0 : -75}
          disableRightSwipe={isSelectionMode}
          disableLeftSwipe
          recalculateHiddenLayout
          useNativeDriver={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                load(false);
              }}
              tintColor={colors.textMuted}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <View style={styles.emptyIconCircle}>
                <Ionicons name="chatbubble-ellipses-outline" size={32} color={colors.textFaint} />
              </View>
              <Text style={styles.emptyTitle}>
                {conversations.length === 0 ? 'No chats yet' : 'No matching chats'}
              </Text>
              <Text style={styles.emptyText}>
                {conversations.length === 0
                  ? 'Open a listing and tap "Chat with seller" to start a conversation.'
                  : 'Try a different search or filter.'}
              </Text>
              {errorText ? <Text style={styles.errorText}>{errorText}</Text> : null}
            </View>
          }
          renderItem={({ item }) => {
            const chatId = String(item.id);
            return (
              <ConversationRow
                item={item}
                userId={user?.id}
                readAtMs={readAtByConvo[chatId]}
                now={now}
                isSelectionMode={isSelectionMode}
                isSelected={selectedChatIdSet.has(chatId)}
                onPress={() => handleRowPress(item)}
                onToggleSelect={() => toggleChatSelection(item.id)}
              />
            );
          }}
          renderHiddenItem={renderHiddenChatRow}
        />
      )}
      </ChatWallpaper>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeTop: {
    flex: 1,
    backgroundColor: HEADER_BG,
  },
  screenBody: {
    flex: 1,
    backgroundColor: WALLPAPER_BG,
  },
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 14,
    backgroundColor: HEADER_BG,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.15,
        shadowRadius: 4,
      },
      android: { elevation: 4 },
    }),
  },
  headerSideBtn: {
    minWidth: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    zIndex: 2,
  },
  headerSelection: {
    paddingHorizontal: 6,
  },
  headerTitle: {
    position: 'absolute',
    left: 56,
    right: 56,
    textAlign: 'center',
    fontSize: 19,
    fontWeight: '800',
    color: HEADER_TEXT,
    letterSpacing: 1.6,
  },
  headerTitleSelection: {
    left: 72,
    right: 168,
    fontSize: 17,
    letterSpacing: 0.4,
  },
  headerBulkActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 2,
    flexShrink: 0,
    maxWidth: 168,
  },
  headerBulkTextBtn: {
    paddingHorizontal: 4,
    paddingVertical: 6,
    justifyContent: 'center',
  },
  headerBulkText: {
    fontSize: 11,
    fontWeight: '700',
    color: HEADER_TEXT,
  },
  headerIconBtn: {
    width: 36,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerIconBtnDisabled: {
    opacity: 0.55,
  },
  headerActionText: {
    fontSize: 16,
    fontWeight: '700',
    color: HEADER_TEXT,
  },
  toolbar: {
    paddingHorizontal: 15,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ROW_BG,
    borderRadius: 14,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? 11 : 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(11, 61, 145, 0.1)',
    ...CARD_SHADOW,
  },
  searchIcon: { marginRight: spacing.sm },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: colors.text,
    paddingVertical: 0,
  },
  filterRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  filterChip: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 12,
    backgroundColor: ROW_BG,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(11, 61, 145, 0.12)',
    alignItems: 'center',
  },
  filterChipActive: {
    backgroundColor: HEADER_BG,
    borderColor: HEADER_BG,
  },
  filterChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textMuted,
  },
  filterChipTextActive: {
    color: HEADER_TEXT,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  listContent: {
    paddingTop: 4,
    paddingBottom: spacing.xxl,
    backgroundColor: ROW_BG,
  },
  emptyContainer: { flexGrow: 1, justifyContent: 'center' },
  emptyWrap: {
    alignItems: 'center',
    paddingHorizontal: spacing.xxxl,
    paddingVertical: spacing.xxxl,
    gap: spacing.sm,
  },
  emptyIconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: ROW_BG,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
    ...CARD_SHADOW,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
    letterSpacing: -0.2,
  },
  emptyText: {
    fontSize: 14,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 20,
  },
  errorText: { marginTop: spacing.md, color: colors.danger, fontSize: 13 },
  chatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: 18,
    backgroundColor: ROW_BG,
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
  },
  chatRowSelectable: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minWidth: 0,
  },
  chatRowSelected: {
    backgroundColor: '#F0F8FF',
  },
  selectCheckboxHit: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 2,
  },
  selectCircleEmpty: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#C5CED8',
    backgroundColor: 'transparent',
  },
  selectCircleFilled: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: DEEP_ROYAL_BLUE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hiddenRow: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'stretch',
    backgroundColor: ROW_BG,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
  },
  rowFront: {
    backgroundColor: ROW_BG,
  },
  deleteBtn: {
    width: 75,
    backgroundColor: '#DC2626',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  deleteBtnText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 4,
  },
  rowSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#E5E7EB',
    marginLeft: AVATAR_INSET,
  },
  avatarWrap: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    position: 'relative',
  },
  onlineDot: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: ONLINE_GREEN,
    borderWidth: 2,
    borderColor: ROW_BG,
  },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    backgroundColor: '#E8EEF7',
    borderWidth: 2,
    borderColor: THUMB_BORDER,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbImage: {
    ...StyleSheet.absoluteFillObject,
    width: THUMB_SIZE,
    height: THUMB_SIZE,
  },
  thumbLetter: {
    fontSize: 20,
    fontWeight: '700',
    color: DEEP_ROYAL_BLUE,
  },
  rowBody: { flex: 1, minWidth: 0, justifyContent: 'center' },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: 4,
  },
  userName: {
    flex: 1,
    fontSize: 16,
    fontWeight: '700',
    color: '#000000',
    letterSpacing: -0.2,
  },
  userNameUnread: {
    fontWeight: '800',
  },
  rowTime: {
    fontSize: 12,
    fontWeight: '500',
    color: LABEL_GREY,
    marginLeft: spacing.sm,
    flexShrink: 0,
  },
  rowTimeUnread: {
    color: UNREAD_ACCENT,
    fontWeight: '600',
  },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  rowPreview: {
    flex: 1,
    fontSize: 14,
    lineHeight: 18,
    color: PREVIEW_COLOR,
    fontWeight: '400',
  },
  rowPreviewUnread: {
    color: '#334155',
    fontWeight: '600',
  },
  unreadBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: UNREAD_ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  unreadBadgeText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
});

export default ChatListScreen;
