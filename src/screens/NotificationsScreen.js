import React, { useCallback, useContext, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { AuthContext } from '../context/AuthContext';
import { useNotifications } from '../context/NotificationsContext';
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../services/notificationService';
import { getNotificationDisplayText } from '../utils/notificationDisplayText';

const DEEP_ROYAL_BLUE = '#0B3D91';
const SCREEN_BG = '#F4F6F8';
const CARD_BORDER = '#E2E8F0';
const H_PAD = 16;
const CARD_GAP = 12;

const cardShadow = Platform.select({
  ios: {
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
  },
  android: { elevation: 2 },
  default: {},
});

function formatWhen(iso) {
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

export default function NotificationsScreen() {
  const navigation = useNavigation();
  const { user } = useContext(AuthContext);
  const { refresh: refreshBadge } = useNotifications();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const uid = user?.id ?? user?.uid;
    if (!uid) {
      setRows([]);
      setLoading(false);
      return;
    }
    try {
      const data = await fetchNotifications(uid);
      setRows(data);
    } catch (e) {
      console.error('[NotificationsScreen] load failed', e?.message);
      setRows([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user?.id, user?.uid]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void load();
      return undefined;
    }, [load])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    await refreshBadge();
  }, [load, refreshBadge]);

  const openRow = async (item) => {
    if (!item.is_read) {
      await markNotificationRead(item.id);
      await refreshBadge();
      setRows((prev) =>
        prev.map((r) => (r.id === item.id ? { ...r, is_read: true } : r))
      );
    }
  };

  const clearAll = async () => {
    const uid = user?.id ?? user?.uid;
    if (!uid) return;
    await markAllNotificationsRead(uid);
    await refreshBadge();
    setRows((prev) => prev.map((r) => ({ ...r, is_read: true })));
  };

  const unreadCount = rows.filter((r) => !r.is_read).length;

  return (
    <View style={styles.screen}>
      <SafeAreaView style={styles.headerSafe} edges={['top']}>
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={styles.headerIconBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="chevron-back" size={26} color="#FFFFFF" />
          </TouchableOpacity>

          <View style={styles.headerTitleWrap} pointerEvents="none">
            <Text style={styles.headerTitle}>NOTIFICATION CENTER</Text>
          </View>

          <TouchableOpacity
            onPress={clearAll}
            style={styles.clearAllBtn}
            disabled={rows.length === 0}
            accessibilityRole="button"
            accessibilityLabel="Clear all notifications"
          >
            <Text style={[styles.clearAllText, rows.length === 0 && styles.clearAllTextDisabled]}>
              Clear All
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      {loading && !refreshing ? (
        <View style={styles.loaderWrap}>
          <ActivityIndicator color={DEEP_ROYAL_BLUE} size="large" />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => String(item.id)}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={DEEP_ROYAL_BLUE}
            />
          }
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={
            unreadCount > 0 ? (
              <Text style={styles.listHint}>
                {unreadCount} unread {unreadCount === 1 ? 'notification' : 'notifications'}
              </Text>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <View style={styles.emptyIconCircle}>
                <Ionicons name="notifications-off-outline" size={36} color="#94A3B8" />
              </View>
              <Text style={styles.emptyTitle}>No notifications yet</Text>
              <Text style={styles.emptySub}>
                Wallet and bid updates will appear here.
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            const { title, body } = getNotificationDisplayText(item);
            const unread = !item.is_read;
            return (
              <TouchableOpacity
                style={[styles.card, cardShadow, unread && styles.cardUnread]}
                onPress={() => openRow(item)}
                activeOpacity={0.88}
              >
                <View style={styles.cardTopRow}>
                  <View style={styles.cardIconWrap}>
                    <Ionicons
                      name={
                        item?.metadata?.type === 'wallet_topup'
                          ? 'wallet-outline'
                          : item?.metadata?.type === 'wallet_bid_refund'
                            ? 'arrow-undo-outline'
                            : 'hammer-outline'
                      }
                      size={18}
                      color={DEEP_ROYAL_BLUE}
                    />
                  </View>
                  <View style={styles.cardHeadText}>
                    <View style={styles.cardTitleRow}>
                      <Text style={styles.cardTitle} numberOfLines={1}>
                        {title}
                      </Text>
                      {unread ? <View style={styles.unreadDot} /> : null}
                    </View>
                    <Text style={styles.cardTime}>{formatWhen(item.created_at)}</Text>
                  </View>
                </View>
                <Text style={styles.cardBody} numberOfLines={3}>
                  {body}
                </Text>
              </TouchableOpacity>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: SCREEN_BG,
  },
  headerSafe: {
    backgroundColor: DEEP_ROYAL_BLUE,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 8,
    paddingBottom: 16,
    paddingHorizontal: H_PAD,
    minHeight: 56,
  },
  headerIconBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  headerTitleWrap: {
    position: 'absolute',
    left: 56,
    right: 56,
    top: 8,
    bottom: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 1.2,
    textAlign: 'center',
  },
  clearAllBtn: {
    minWidth: 72,
    height: 44,
    alignItems: 'flex-end',
    justifyContent: 'center',
    zIndex: 2,
  },
  clearAllText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: 0.2,
  },
  clearAllTextDisabled: {
    opacity: 0.45,
  },
  loaderWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: {
    paddingHorizontal: H_PAD,
    paddingTop: CARD_GAP,
    paddingBottom: 32,
  },
  listHint: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748B',
    marginBottom: CARD_GAP,
    letterSpacing: 0.2,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    marginBottom: CARD_GAP,
    borderWidth: 1,
    borderColor: CARD_BORDER,
  },
  cardUnread: {
    borderColor: '#93C5FD',
    backgroundColor: '#FFFFFF',
  },
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 10,
    gap: 12,
  },
  cardIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#EEF2FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardHeadText: {
    flex: 1,
    minWidth: 0,
  },
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cardTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    color: '#0F172A',
    letterSpacing: -0.2,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#EF4444',
  },
  cardBody: {
    fontSize: 14,
    color: '#475569',
    lineHeight: 21,
    fontWeight: '500',
  },
  cardTime: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 2,
    fontWeight: '600',
  },
  empty: {
    alignItems: 'center',
    marginTop: 56,
    paddingHorizontal: 24,
  },
  emptyIconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: CARD_BORDER,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    ...cardShadow,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: 6,
  },
  emptySub: {
    fontSize: 14,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 20,
  },
});
