import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { fetchAdminSupportInbox } from '../../services/adminPanelService';
import { exitAdminSupportInbox, openAdminSupportChat } from '../../navigation/adminNavigation';

const BG = '#F4F6F8';
const INDIGO = '#1E3A8A';

function formatRs(n) {
  const x = Number(n);
  return Number.isFinite(x) ? `Rs. ${x.toLocaleString()}` : 'Rs. 0';
}

export default function AdminSupportInboxScreen({ navigation }) {
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const handleBack = useCallback(() => {
    exitAdminSupportInbox(navigation);
  }, [navigation]);

  const load = useCallback(async (mode = 'full') => {
    if (mode === 'pull') setRefreshing(true);
    else setLoading(true);
    try {
      setTickets(await fetchAdminSupportInbox());
    } catch {
      setTickets([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load('full');
    }, [load])
  );

  const openChat = useCallback(
    (item) => {
      openAdminSupportChat(navigation, {
        orderId: item.orderId,
        ticketId: item.id,
        listingTitle: item.listingTitle,
        escrowAmount: item.escrowAmount,
      });
    },
    [navigation]
  );

  const renderItem = ({ item }) => (
    <TouchableOpacity
      style={styles.card}
      onPress={() => openChat(item)}
      activeOpacity={0.9}
    >
      <View style={styles.row}>
        <Ionicons name="mail-unread-outline" size={22} color={INDIGO} />
        <View style={styles.flex}>
          <Text style={styles.title} numberOfLines={1}>
            {item.listingTitle}
          </Text>
          <Text style={styles.sub} numberOfLines={2}>
            {item.reason || item.subject}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color="#94A3B8" />
      </View>
      <Text style={styles.meta}>
        {item.status} · Escrow {formatRs(item.escrowAmount)} · {item.openedBy}
      </Text>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={handleBack} style={styles.back} hitSlop={12} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={22} color={INDIGO} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Support Inbox</Text>
      </View>
      <Text style={styles.hint}>Tickets awaiting human admin (AI handoff)</Text>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={INDIGO} />
      ) : (
        <FlatList
          data={tickets}
          keyExtractor={(t) => t.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load('pull')} />}
          ListEmptyComponent={<Text style={styles.empty}>No tickets awaiting admin.</Text>}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    backgroundColor: '#FFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  back: { padding: 8 },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: '800', color: INDIGO, marginLeft: 4 },
  hint: { paddingHorizontal: 16, paddingTop: 10, color: '#64748B', fontSize: 13 },
  list: { padding: 16 },
  card: {
    backgroundColor: '#FFF',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { fontWeight: '700', fontSize: 15, color: '#0F172A' },
  sub: { color: '#64748B', fontSize: 13, marginTop: 2 },
  meta: { color: '#94A3B8', fontSize: 11, marginTop: 10 },
  empty: { textAlign: 'center', color: '#94A3B8', marginTop: 40 },
});
