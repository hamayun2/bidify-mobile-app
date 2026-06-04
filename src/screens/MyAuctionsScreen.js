import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Platform,
  Modal,
  TextInput,
  Alert,
  Pressable,
  KeyboardAvoidingView,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { AuthContext } from '../context/AuthContext';
import {
  getMyListingsAPI,
  updateMyListingAPI,
} from '../api/listings';
import { uploadListingImage } from '../services/storageService';
import { isAuctionListing, resolveListingCoverForDisplay } from '../utils/listingMedia';
import { getListingDisplayTitle } from '../components/listings/AuctionListingCard';
import { ListingCoverImage } from '../components/ListingCoverImage';
import {
  partitionMyAuctions,
  sortMyAuctions,
  isMyAuctionEnded,
} from '../utils/myAuctionsHelpers';
import {
  canEditMyListing,
  canDeleteMyListing,
  isAuctionLiveOrActive,
} from '../utils/auctionLifecycle';
import { useAuctionClockTick } from '../hooks/useAuctionClockTick';
import {
  useListingsSync,
  useMarketplaceSyncVersion,
  resolveListingId,
} from '../context/ListingsSyncContext';
import { spacing } from '../theme';

const SCREEN_BG = '#F4F6F8';
const INDIGO = '#1E3A8A';

const MAIN_TABS = [
  { key: 'active', label: 'Active' },
  { key: 'ended', label: 'Ended' },
];

const SORT_OPTIONS = [
  { key: 'newest', label: 'Newest' },
  { key: 'oldest', label: 'Oldest' },
];

function formatRs(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 'Rs. 0';
  return `Rs. ${v.toLocaleString()}`;
}

function formatEndLabel(listing) {
  const endRaw = listing?.endTime;
  if (!endRaw) return 'No end time';
  const end = new Date(endRaw);
  if (Number.isNaN(end.getTime())) return 'No end time';
  if (isMyAuctionEnded(listing)) return `Ended ${end.toLocaleDateString()}`;
  return `Ends ${end.toLocaleString()}`;
}

export default function MyAuctionsScreen({ embedded = false }) {
  const navigation = useNavigation();
  const { user } = useContext(AuthContext);
  const {
    openDeleteListingModal,
    deletingListingId,
    deletedListingIds,
  } = useListingsSync();
  const marketplaceSyncVersion = useMarketplaceSyncVersion();
  const [allAuctions, setAllAuctions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  const [activeTab, setActiveTab] = useState('active');
  const [sortOrder, setSortOrder] = useState('newest');
  const [editTarget, setEditTarget] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editPrice, setEditPrice] = useState('');
  const [editBuyNow, setEditBuyNow] = useState('');
  const [editPhotoUri, setEditPhotoUri] = useState(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const clockTick = useAuctionClockTick(30000);

  const loadAuctions = useCallback(
    async (mode = 'normal') => {
      if (!user?.id) {
        setAllAuctions([]);
        setLoading(false);
        setRefreshing(false);
        return;
      }
      if (mode === 'pull') setRefreshing(true);
      else if (mode === 'silent') {
        /* no spinner — keep list visible after delete */
      } else setLoading(true);
      setFetchError(null);
      try {
        const rows = await getMyListingsAPI(user.id);
        const { all } = partitionMyAuctions(rows);
        setAllAuctions(all);
      } catch (e) {
        setFetchError(e?.message || 'Could not load your auctions.');
        setAllAuctions([]);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [user?.id]
  );

  useFocusEffect(
    useCallback(() => {
      loadAuctions('normal');
    }, [loadAuctions])
  );

  useEffect(() => {
    if (!deletedListingIds?.length) return;
    const removed = new Set(deletedListingIds.map(String));
    setAllAuctions((prev) => prev.filter((item) => item?.id != null && !removed.has(String(item.id))));
  }, [deletedListingIds]);

  useEffect(() => {
    if (marketplaceSyncVersion > 0) {
      void loadAuctions('silent');
    }
  }, [marketplaceSyncVersion, loadAuctions]);

  const { active, ended } = useMemo(
    () => partitionMyAuctions(allAuctions),
    [allAuctions, clockTick]
  );

  const counts = useMemo(
    () => ({ active: active.length, ended: ended.length }),
    [active, ended]
  );

  const visible = useMemo(() => {
    const bucket = activeTab === 'ended' ? ended : active;
    return sortMyAuctions(bucket, sortOrder);
  }, [activeTab, active, ended, sortOrder]);

  const openEdit = (listing) => {
    if (!canEditMyListing(listing)) {
      Alert.alert(
        'Cannot edit',
        isMyAuctionEnded(listing)
          ? 'This auction has ended. Edits are locked after the timer expires.'
          : 'Live auctions cannot be edited. Only draft or pre-live listings can be changed.'
      );
      return;
    }
    setEditTarget(listing);
    setEditTitle(String(listing?.title || ''));
    setEditDescription(String(listing?.description || ''));
    setEditPrice(String(listing?.price ?? listing?.currentBid ?? ''));
    setEditBuyNow(listing?.buyNowPrice != null ? String(listing.buyNowPrice) : '');
    setEditPhotoUri(null);
  };

  const closeEdit = () => {
    if (savingEdit) return;
    setEditTarget(null);
    setEditPhotoUri(null);
  };

  const pickEditPhoto = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Allow photo library access to update listing images.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
      allowsEditing: true,
    });
    if (!result.canceled && result.assets?.[0]?.uri) {
      setEditPhotoUri(result.assets[0].uri);
    }
  };

  const handleSaveEdit = async () => {
    if (!editTarget?.id || !user?.id) return;
    const price = Number(editPrice);
    if (!editTitle.trim()) {
      Alert.alert('Title required', 'Enter a title for your auction.');
      return;
    }
    if (!Number.isFinite(price) || price <= 0) {
      Alert.alert('Invalid price', 'Enter a valid starting price.');
      return;
    }
    setSavingEdit(true);
    try {
      const patch = {
        title: editTitle.trim(),
        description: editDescription.trim(),
        price,
      };
      if (editBuyNow.trim()) {
        patch.buyNowPrice = Number(editBuyNow);
      }
      if (editPhotoUri) {
        const url = await uploadListingImage(user.id, editPhotoUri, 0);
        if (url) patch.images = [url];
      }
      const updated = await updateMyListingAPI(user.id, editTarget.id, patch);
      setAllAuctions((prev) =>
        prev.map((l) => (String(l.id) === String(updated.id) ? { ...l, ...updated } : l))
      );
      setEditTarget(null);
    } catch (e) {
      Alert.alert('Update failed', e?.message || 'Could not update auction.');
    } finally {
      setSavingEdit(false);
    }
  };

  const openDeleteModal = (listing) => {
    if (!resolveListingId(listing) || !user?.id) return;
    if (!canDeleteMyListing(listing)) {
      Alert.alert(
        'Cannot delete',
        isAuctionListing(listing) && isAuctionLiveOrActive(listing)
          ? 'Live auctions cannot be deleted. Wait until the auction ends or contact support.'
          : 'This listing cannot be deleted.'
      );
      return;
    }
    const listingId = resolveListingId(listing);
    console.log('[MyAuctionsScreen] Delete clicked — storing listing id', {
      listingId,
      sellerId: user?.id,
      raw: { id: listing?.id, _id: listing?._id },
    });
    if (!listingId) {
      Alert.alert('Delete error', 'This listing has no id — cannot delete.');
      return;
    }
    openDeleteListingModal(listing);
  };

  const renderItem = ({ item }) => {
    const cover = resolveListingCoverForDisplay(item);
    const title = getListingDisplayTitle(item) || 'Untitled auction';
    const ended = isMyAuctionEnded(item);
    const busy = deletingListingId === item.id;
    const isAuction = isAuctionListing(item);
    const typeLabel = isAuction ? 'Auction' : 'Buy Now';
    const showEdit = canEditMyListing(item);
    const showDelete = canDeleteMyListing(item);

    return (
      <View style={styles.card}>
        <TouchableOpacity
          style={styles.cardMain}
          activeOpacity={0.9}
          onPress={() => navigation.navigate('ListingDetail', { listing: item })}
        >
          {cover ? (
            <ListingCoverImage uri={cover} style={styles.cardImage} recycleKey={item.id} />
          ) : (
            <View style={[styles.cardImage, styles.cardImagePlaceholder]}>
              <Ionicons name="image-outline" size={32} color="#94A3B8" />
            </View>
          )}
          <View style={styles.cardBody}>
            <Text style={styles.cardTitle} numberOfLines={2}>
              {title}
            </Text>
            <Text style={styles.cardMeta}>
              {typeLabel} · {isAuction ? 'Start' : 'Price'} {formatRs(item.price || item.currentBid)}
              {isAuction ? ` · ${formatEndLabel(item)}` : ''}
            </Text>
            <View style={[styles.statusPill, ended ? styles.statusEnded : styles.statusLive]}>
              <Text style={styles.statusPillText}>{ended ? 'Ended' : 'Live'}</Text>
            </View>
          </View>
        </TouchableOpacity>
        {(showEdit || showDelete) ? (
          <View style={styles.cardActions}>
            {showEdit ? (
              <Pressable
                style={({ pressed }) => [
                  styles.actionBtnEdit,
                  pressed && styles.actionBtnPressed,
                ]}
                onPress={() => openEdit(item)}
                disabled={busy}
              >
                <Ionicons name="create-outline" size={18} color={INDIGO} />
                <Text style={styles.actionBtnEditText}>Edit</Text>
              </Pressable>
            ) : null}
            {showEdit && showDelete ? <View style={styles.actionDivider} /> : null}
            {showDelete ? (
              <Pressable
                style={({ pressed }) => [
                  styles.actionBtnDelete,
                  pressed && styles.actionBtnPressed,
                ]}
                onPress={() => openDeleteModal(item)}
                disabled={busy}
              >
                {busy ? (
                  <ActivityIndicator size="small" color="#DC2626" />
                ) : (
                  <>
                    <Ionicons name="trash-outline" size={18} color="#DC2626" />
                    <Text style={styles.actionBtnDeleteText}>Delete</Text>
                  </>
                )}
              </Pressable>
            ) : null}
          </View>
        ) : (
          <View style={styles.lockedNote}>
            <Ionicons name="lock-closed-outline" size={14} color="#64748B" />
            <Text style={styles.lockedNoteText}>
              {ended
                ? 'Auction ended — no edits or deletes'
                : 'Live auction — locked while bidding is open'}
            </Text>
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={styles.root}>
      <View style={styles.tabBar}>
        {MAIN_TABS.map((t) => {
          const selected = activeTab === t.key;
          return (
            <TouchableOpacity
              key={t.key}
              style={[styles.tab, selected && styles.tabActive]}
              onPress={() => setActiveTab(t.key)}
              activeOpacity={0.88}
            >
              <Text style={[styles.tabText, selected && styles.tabTextActive]}>
                {t.label} ({counts[t.key]})
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={styles.sortRow}>
        <Text style={styles.sortLabel}>Sort</Text>
        {SORT_OPTIONS.map((opt) => {
          const selected = sortOrder === opt.key;
          return (
            <TouchableOpacity
              key={opt.key}
              style={[styles.sortChip, selected && styles.sortChipActive]}
              onPress={() => setSortOrder(opt.key)}
            >
              <Text style={[styles.sortChipText, selected && styles.sortChipTextActive]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {loading ? (
        <ActivityIndicator style={styles.loader} color={INDIGO} />
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadAuctions('pull')}
              tintColor={INDIGO}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="hammer-outline" size={36} color="#94A3B8" />
              <Text style={styles.emptyTitle}>
                {fetchError
                  ? 'Could not load auctions'
                  : activeTab === 'active'
                  ? 'No active auctions'
                  : 'No ended auctions'}
              </Text>
              <Text style={styles.emptySub}>
                {fetchError ||
                  (activeTab === 'active'
                    ? 'Post from the Sell tab to manage listings here.'
                    : 'Ended auctions and sold buy-now posts appear here.')}
              </Text>
            </View>
          }
        />
      )}

      <Modal visible={!!editTarget} transparent animationType="slide" onRequestClose={closeEdit}>
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              Edit {isAuctionListing(editTarget) ? 'auction' : 'listing'}
            </Text>
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.fieldLabel}>Photo</Text>
              <TouchableOpacity style={styles.photoPickBtn} onPress={pickEditPhoto} activeOpacity={0.85}>
                <Ionicons name="image-outline" size={20} color={INDIGO} />
                <Text style={styles.photoPickText}>
                  {editPhotoUri ? 'Change selected photo' : 'Choose new photo'}
                </Text>
              </TouchableOpacity>
              <Text style={styles.fieldLabel}>Title</Text>
              <TextInput
                style={styles.fieldInput}
                value={editTitle}
                onChangeText={setEditTitle}
                placeholder="Title"
              />
              <Text style={styles.fieldLabel}>Description</Text>
              <TextInput
                style={[styles.fieldInput, styles.fieldInputMultiline]}
                value={editDescription}
                onChangeText={setEditDescription}
                placeholder="Description"
                multiline
              />
              <Text style={styles.fieldLabel}>Starting price (Rs.)</Text>
              <TextInput
                style={styles.fieldInput}
                value={editPrice}
                onChangeText={(t) => setEditPrice(t.replace(/\D/g, ''))}
                keyboardType="number-pad"
                placeholder="10000"
              />
              <Text style={styles.fieldLabel}>Buy now price (optional)</Text>
              <TextInput
                style={styles.fieldInput}
                value={editBuyNow}
                onChangeText={(t) => setEditBuyNow(t.replace(/\D/g, ''))}
                keyboardType="number-pad"
                placeholder="Optional"
              />
            </ScrollView>
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancel} onPress={closeEdit} disabled={savingEdit}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalSave}
                onPress={handleSaveEdit}
                disabled={savingEdit}
              >
                {savingEdit ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.modalSaveText}>Save</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  tabBar: {
    flexDirection: 'row',
    marginHorizontal: spacing.xl,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 4,
    marginBottom: spacing.md,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 4,
      },
      android: { elevation: 2 },
    }),
  },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 10 },
  tabActive: { backgroundColor: SCREEN_BG },
  tabText: { fontSize: 13, fontWeight: '600', color: '#64748B' },
  tabTextActive: { color: INDIGO, fontWeight: '700' },
  sortRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    marginBottom: spacing.md,
    gap: 8,
  },
  sortLabel: { fontSize: 13, fontWeight: '700', color: '#64748B', marginRight: 4 },
  sortChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: '#E2E8F0',
  },
  sortChipActive: { backgroundColor: INDIGO },
  sortChipText: { fontSize: 12, fontWeight: '600', color: '#475569' },
  sortChipTextActive: { color: '#FFFFFF' },
  loader: { marginTop: 48 },
  list: { paddingHorizontal: spacing.xl, paddingBottom: 48 },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    marginBottom: spacing.md,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.05,
        shadowRadius: 6,
      },
      android: { elevation: 2 },
    }),
  },
  cardMain: { flexDirection: 'row', padding: spacing.md },
  cardImage: { width: 80, height: 80, borderRadius: 12, backgroundColor: '#EDE9E3' },
  cardImagePlaceholder: { alignItems: 'center', justifyContent: 'center' },
  cardBody: { flex: 1, marginLeft: spacing.md },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#0F172A', marginBottom: 6 },
  cardMeta: { fontSize: 13, color: '#64748B', marginBottom: 8 },
  statusPill: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
  },
  statusLive: { backgroundColor: '#DCFCE7' },
  statusEnded: { backgroundColor: '#E2E8F0' },
  statusPillText: { fontSize: 11, fontWeight: '700', color: '#334155' },
  cardActions: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
    paddingHorizontal: 10,
    paddingVertical: 10,
    gap: 10,
    backgroundColor: '#FAFAFA',
  },
  actionBtnEdit: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: '#EEF2FF',
    borderWidth: 1,
    borderColor: INDIGO,
  },
  actionBtnEditText: {
    fontSize: 14,
    fontWeight: '700',
    color: INDIGO,
  },
  actionDivider: {
    width: 1,
    alignSelf: 'stretch',
    backgroundColor: '#E2E8F0',
    marginVertical: 2,
  },
  actionBtnDelete: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#DC2626',
  },
  actionBtnDeleteText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#DC2626',
  },
  actionBtnPressed: { opacity: 0.82 },
  lockedNote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E2E8F0',
    backgroundColor: '#F8FAFC',
  },
  lockedNoteText: { fontSize: 12, fontWeight: '600', color: '#64748B', flex: 1 },
  empty: { alignItems: 'center', paddingTop: 56, paddingHorizontal: spacing.xxl },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: '#0F172A', marginTop: spacing.md },
  emptySub: { fontSize: 14, color: '#64748B', marginTop: 6, textAlign: 'center', lineHeight: 20 },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: spacing.xl,
    maxHeight: '85%',
  },
  modalTitle: { fontSize: 20, fontWeight: '800', color: '#0F172A', marginBottom: spacing.md },
  fieldLabel: { fontSize: 12, fontWeight: '700', color: '#64748B', marginBottom: 6, marginTop: 8 },
  fieldInput: {
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#0F172A',
    backgroundColor: '#F8FAFC',
  },
  fieldInputMultiline: { minHeight: 88, textAlignVertical: 'top' },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: spacing.lg },
  modalCancel: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
  },
  modalCancelText: { fontWeight: '700', color: '#475569' },
  modalSave: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: INDIGO,
    alignItems: 'center',
  },
  modalSaveText: { fontWeight: '700', color: '#FFFFFF' },
  photoPickBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    marginBottom: spacing.sm,
  },
  photoPickText: { fontSize: 14, fontWeight: '600', color: INDIGO },
});
