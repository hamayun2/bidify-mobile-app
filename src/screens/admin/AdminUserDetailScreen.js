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
import { fetchAdminUserWalletLedger } from '../../services/adminPanelService';

const INDIGO = '#1E3A8A';

function formatRs(n) {
  const x = Number(n);
  return Number.isFinite(x) ? `Rs. ${x.toLocaleString()}` : 'Rs. 0';
}

export default function AdminUserDetailScreen({ route, navigation }) {
  const userId = route.params?.userId;
  const displayName = route.params?.displayName || 'User';

  const [profile, setProfile] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (mode = 'full') => {
    if (!userId) return;
    if (mode === 'pull') setRefreshing(true);
    else setLoading(true);
    try {
      const data = await fetchAdminUserWalletLedger(userId, 150);
      setProfile(data.profile);
      setLedger(data.ledger);
    } catch {
      setProfile(null);
      setLedger([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [userId]);

  useFocusEffect(
    useCallback(() => {
      void load('full');
    }, [load])
  );

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.back}>
          <Ionicons name="arrow-back" size={22} color={INDIGO} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{displayName}</Text>
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={INDIGO} />
      ) : (
        <FlatList
          data={ledger}
          keyExtractor={(e) => e.id}
          ListHeaderComponent={
            profile ? (
              <View style={styles.profileCard}>
                <Text style={styles.email}>{profile.email}</Text>
                <Text style={styles.balance}>Wallet: {formatRs(profile.walletBalance)}</Text>
                <Text style={styles.balanceSub}>
                  Held {formatRs(profile.heldBalance)} · Locked {formatRs(profile.lockedBalance)}
                </Text>
                <Text style={styles.uid}>ID: {profile.id}</Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <View style={styles.ledgerRow}>
              <Text style={styles.ledgerType}>{item.entryType}</Text>
              <Text style={[styles.ledgerAmt, item.amount < 0 && styles.neg]}>
                {item.amount >= 0 ? '+' : ''}
                {formatRs(item.amount)}
              </Text>
              <Text style={styles.ledgerDesc} numberOfLines={2}>{item.description}</Text>
              <Text style={styles.ledgerTime}>{item.createdAt}</Text>
            </View>
          )}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load('pull')} />}
          ListEmptyComponent={<Text style={styles.empty}>No ledger entries.</Text>}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F4F6F8' },
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
  profileCard: {
    backgroundColor: '#FFF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  email: { fontWeight: '700', fontSize: 16, color: '#0F172A' },
  balance: { marginTop: 10, fontSize: 18, fontWeight: '800', color: INDIGO },
  balanceSub: { color: '#64748B', marginTop: 4 },
  uid: { color: '#94A3B8', fontSize: 11, marginTop: 8 },
  ledgerRow: {
    backgroundColor: '#FFF',
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  ledgerType: { fontWeight: '700', color: INDIGO, fontSize: 12, textTransform: 'uppercase' },
  ledgerAmt: { fontSize: 16, fontWeight: '800', color: '#059669', marginTop: 4 },
  neg: { color: '#DC2626' },
  ledgerDesc: { color: '#475569', marginTop: 4, fontSize: 13 },
  ledgerTime: { color: '#94A3B8', fontSize: 11, marginTop: 4 },
  empty: { textAlign: 'center', color: '#94A3B8', marginTop: 24 },
});
