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
import { fetchAdminDisputedOrders } from '../../services/adminPanelService';
import { openAdminSupportChat } from '../../navigation/adminNavigation';

const BG = '#F4F6F8';
const INDIGO = '#1E3A8A';

function formatRs(n) {
  const x = Number(n);
  return Number.isFinite(x) ? `Rs. ${x.toLocaleString()}` : 'Rs. 0';
}

export default function AdminDisputesScreen({ navigation }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (mode = 'full') => {
    if (mode === 'pull') setRefreshing(true);
    else setLoading(true);
    try {
      const rows = await fetchAdminDisputedOrders();
      setOrders(rows);
    } catch (e) {
      setOrders([]);
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
        orderId: item.id,
        ticketId: item.supportTicketId ?? null,
        listingTitle: item.listingTitle,
        escrowAmount: item.escrowAmount,
      });
    },
    [navigation]
  );

  const renderItem = ({ item }) => (
    <TouchableOpacity style={styles.card} onPress={() => openChat(item)} activeOpacity={0.9}>
      <View style={styles.cardTop}>
        <Text style={styles.cardTitle} numberOfLines={2}>{item.listingTitle}</Text>
        <View style={styles.disputePill}>
          <Text style={styles.disputePillText}>DISPUTED</Text>
        </View>
      </View>
      <Text style={styles.meta}>Escrow locked: {formatRs(item.escrowAmount)}</Text>
      <Text style={styles.meta}>Winning bid: {formatRs(item.winningBidAmount)}</Text>
      <Text style={styles.metaSmall}>Buyer: {item.buyerId?.slice(0, 8)}… · Seller: {item.sellerId?.slice(0, 8)}…</Text>
      {item.isHumanRequired ? (
        <View style={styles.humanRow}>
          <Ionicons name="person" size={14} color="#B45309" />
          <Text style={styles.humanText}>Human support requested</Text>
        </View>
      ) : null}
      <Text style={styles.openChat}>Open support chat →</Text>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.back}>
          <Ionicons name="arrow-back" size={22} color={INDIGO} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Dispute Resolution Hub</Text>
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={INDIGO} />
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(o) => o.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load('pull')} />}
          ListEmptyComponent={
            <Text style={styles.empty}>No active disputed orders.</Text>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
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
  list: { padding: 16 },
  card: {
    backgroundColor: '#FFF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  cardTitle: { flex: 1, fontSize: 16, fontWeight: '700', color: '#0F172A' },
  disputePill: { backgroundColor: '#FEE2E2', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  disputePillText: { color: '#B91C1C', fontSize: 10, fontWeight: '800' },
  meta: { color: '#475569', marginTop: 8, fontSize: 14 },
  metaSmall: { color: '#94A3B8', marginTop: 4, fontSize: 11 },
  humanRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  humanText: { color: '#B45309', fontWeight: '600', fontSize: 13 },
  openChat: { color: INDIGO, fontWeight: '700', marginTop: 12, fontSize: 14 },
  empty: { textAlign: 'center', color: '#94A3B8', marginTop: 40 },
});
