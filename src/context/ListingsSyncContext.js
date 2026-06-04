import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Alert, Platform } from 'react-native';
import { getListingsAPI } from '../api/listings';
import { isSupabaseConfigured, getSupabase } from '../services/supabaseClient';
import { isAuctionListing, isStandardListing } from '../utils/listingMedia';
import { AuthContext } from './AuthContext';
import { useWallet } from './WalletContext';
import { MIN_AUCTION_LISTING_FEE_PKR } from '../constants/auctionListingFee';
import { callDeleteListingApi, refetchSellerProfileStats } from '../services/deleteListingPipeline';
import {
  scanEndedAuctionsFromListings,
  triggerResolveExpiredBatch,
} from '../services/auctionResolveScheduler';

const ListingsSyncContext = createContext(null);

/** Normalize listing id from API rows (id, _id, listing_id). */
export function resolveListingId(listing) {
  if (!listing) return '';
  const raw = listing.id ?? listing._id ?? listing.listing_id ?? listing.listingId;
  return raw != null && String(raw).trim() !== '' ? String(raw).trim() : '';
}

export function ListingsSyncProvider({ children }) {
  const { user } = useContext(AuthContext);
  const { refresh: refreshWallet } = useWallet();

  const [listings, setListings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [syncGeneration, setSyncGeneration] = useState(0);
  const [profileSyncGeneration, setProfileSyncGeneration] = useState(0);
  const [deletedListingIds, setDeletedListingIds] = useState([]);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deletingListingId, setDeletingListingId] = useState(null);

  const hasLoadedOnce = useRef(false);
  const deletedIdsRef = useRef(new Set());
  const deleteTargetRef = useRef(null);

  useEffect(() => {
    deleteTargetRef.current = deleteTarget;
  }, [deleteTarget]);

  const filterDeletedListings = useCallback(
    (list) => {
      if (!deletedIdsRef.current.size) return Array.isArray(list) ? list : [];
      return (Array.isArray(list) ? list : []).filter(
        (row) => row?.id != null && !deletedIdsRef.current.has(String(row.id))
      );
    },
    [deletedListingIds]
  );

  const load = useCallback(
    async (mode = 'initial') => {
      if (mode === 'pull') setRefreshing(true);
      else if (mode === 'silent') {
        /* no spinner */
      } else if (mode === 'initial' && !hasLoadedOnce.current) {
        setLoading(true);
      }

      setError(null);
      try {
        const data = await getListingsAPI();
        const rows = filterDeletedListings(data);
        setListings(rows);
        scanEndedAuctionsFromListings(rows);
        void triggerResolveExpiredBatch();
        return rows;
      } catch (e) {
        const msg = e?.message || 'Could not load listings';
        setError(msg);
        if (!hasLoadedOnce.current) setListings([]);
        throw e;
      } finally {
        setLoading(false);
        setRefreshing(false);
        hasLoadedOnce.current = true;
      }
    },
    [filterDeletedListings]
  );

  useEffect(() => {
    void load('initial');
  }, [load]);

  useEffect(() => {
    if (!isSupabaseConfigured()) return undefined;
    const supabase = getSupabase();
    const channel = supabase
      .channel('listings-sync-marketplace')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'listings' }, () => {
        void load('silent');
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [load]);

  useEffect(() => {
    if (!isSupabaseConfigured() || listings.length === 0) return undefined;
    const id = setInterval(() => {
      scanEndedAuctionsFromListings(listings);
      void triggerResolveExpiredBatch();
    }, 45_000);
    return () => clearInterval(id);
  }, [listings]);

  /**
   * Bump sync version and refetch marketplace feed from server (Home, Explore, Profile).
   */
  const invalidateMarketplaceListings = useCallback(async () => {
    setSyncGeneration((g) => g + 1);
    await load('pull');
  }, [load]);

  /** Notify other screens without pull-to-refresh flicker (e.g. after delete). */
  const bumpMarketplaceSync = useCallback(() => {
    setSyncGeneration((g) => g + 1);
  }, []);

  /**
   * Call only after DELETE API returns success + deleted:true.
   */
  const notifyListingDeleted = useCallback(
    async ({ listingId, sellerId } = {}) => {
      const id = listingId != null ? String(listingId) : '';
      const sid = sellerId != null ? String(sellerId) : '';

      if (id) {
        deletedIdsRef.current.add(id);
        setDeletedListingIds(Array.from(deletedIdsRef.current));
        setListings((prev) => prev.filter((l) => String(l.id) !== id));
      }

      if (sid) {
        setProfileSyncGeneration((g) => g + 1);
      }

      await invalidateMarketplaceListings();
    },
    [invalidateMarketplaceListings]
  );

  const refresh = useCallback(() => load('pull'), [load]);
  const reload = load;

  const openDeleteListingModal = useCallback((listing) => {
    const id = resolveListingId(listing);
    if (!id) {
      console.warn('[openDeleteListingModal] listing has no id', listing);
      return;
    }
    setDeletingListingId(null);
    const sellerId = String(listing.sellerId ?? listing.seller_id ?? '').trim();
    setDeleteTarget({ ...listing, id, sellerId: sellerId || listing.sellerId });
    console.log('[openDeleteListingModal] deleteTarget set', {
      id,
      sellerId: sellerId || listing.sellerId,
      rawKeys: { id: listing.id, _id: listing._id, listing_id: listing.listing_id },
    });
  }, []);

  const closeDeleteListingModal = useCallback(() => {
    if (deletingListingId) return;
    setDeleteTarget(null);
  }, [deletingListingId]);

  /**
   * Full delete lifecycle — wired from DeleteListingConfirmModal.handleDelete → performDelete.
   * File: src/context/ListingsSyncContext.js (this function)
   */
  const performDelete = useCallback(async (listingIdFromModal) => {
    console.log('Context received ID:', listingIdFromModal);
    const targetId = String(
      listingIdFromModal || resolveListingId(deleteTargetRef.current) || ''
    );
    console.log('[performDelete] invoked — ListingsSyncContext.js', {
      listingIdFromModal,
      targetId,
      refId: resolveListingId(deleteTargetRef.current),
    });
    const target = deleteTargetRef.current;
    const sellerId = String(
      target?.sellerId ?? target?.seller_id ?? user?.id ?? ''
    ).trim();
    if (!targetId || !sellerId) {
      console.warn('[performDelete] aborted — missing listing or user', {
        targetId,
        listingIdFromModal,
        refId: resolveListingId(deleteTargetRef.current),
        sellerId,
        targetSellerId: target?.sellerId,
        userId: user?.id,
      });
      throw new Error('Missing listing or signed-in user.');
    }

    console.log('[performDelete] starting delete', {
      listingId: targetId,
      sellerId,
      idType: typeof targetId,
    });
    setDeletingListingId(targetId);

    try {
      const result = await callDeleteListingApi(sellerId, targetId);

      deletedIdsRef.current.add(targetId);
      setDeletedListingIds(Array.from(deletedIdsRef.current));
      setListings((prev) => prev.filter((l) => String(l.id) !== targetId));
      setDeleteTarget(null);

      await refetchSellerProfileStats(sellerId);
      setProfileSyncGeneration((g) => g + 1);
      bumpMarketplaceSync();
      await refreshWallet?.();

      const successBody = result?.feeRefunded
        ? `Your listing has been deleted.\n\nRs. ${MIN_AUCTION_LISTING_FEE_PKR.toLocaleString()} has been released back to your wallet.`
        : 'Your listing has been deleted.';
      Alert.alert('Listing deleted', successBody, [{ text: 'OK' }]);

      return result;
    } catch (e) {
      console.error('CRITICAL ERROR IN performDelete:', e);
      const msg = e?.response?.data?.message || e?.message || 'Could not delete listing.';
      if (Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.alert === 'function') {
        window.alert(`Error: ${msg}`);
      } else if (typeof globalThis.alert === 'function') {
        globalThis.alert(`Error: ${msg}`);
      } else {
        Alert.alert('Error', msg);
      }
      throw e;
    } finally {
      setDeletingListingId(null);
    }
  }, [user?.id, bumpMarketplaceSync, refreshWallet]);

  const auctions = useMemo(() => listings.filter(isAuctionListing), [listings]);
  const standards = useMemo(() => listings.filter(isStandardListing), [listings]);

  const value = useMemo(
    () => ({
      listings,
      auctions,
      standards,
      loading,
      refreshing,
      error,
      refresh,
      reload,
      syncGeneration,
      profileSyncGeneration,
      deletedListingIds,
      filterDeletedListings,
      notifyListingDeleted,
      invalidateMarketplaceListings,
      openDeleteListingModal,
      closeDeleteListingModal,
      performDelete,
      deletingListingId,
      deleteTarget,
      deleteModalVisible: !!deleteTarget,
    }),
    [
      listings,
      auctions,
      standards,
      loading,
      refreshing,
      error,
      refresh,
      reload,
      syncGeneration,
      profileSyncGeneration,
      deletedListingIds,
      filterDeletedListings,
      notifyListingDeleted,
      invalidateMarketplaceListings,
      openDeleteListingModal,
      closeDeleteListingModal,
      performDelete,
      deletingListingId,
      deleteTarget,
    ]
  );

  return <ListingsSyncContext.Provider value={value}>{children}</ListingsSyncContext.Provider>;
}

export function useListingsSync() {
  const ctx = useContext(ListingsSyncContext);
  if (!ctx) {
    throw new Error('useListingsSync must be used within ListingsSyncProvider');
  }
  return ctx;
}

/** Marketplace listings hook (Home, etc.). */
export function useListings() {
  return useListingsSync();
}

/** Re-run local fetch when marketplace sync generation changes (Explore, ProfileView). */
export function useMarketplaceSyncVersion() {
  const ctx = useContext(ListingsSyncContext);
  return ctx?.syncGeneration ?? 0;
}

/** Re-fetch seller profile / Total Ads after delete. */
export function useProfileSyncVersion() {
  const ctx = useContext(ListingsSyncContext);
  return ctx?.profileSyncGeneration ?? 0;
}

/** Total ads from server count and loaded listing rows (no client-side cache hacks). */
export function reconcileSellerAdCount(_sellerId, serverCount, listingsLength) {
  const server = Number(serverCount) || 0;
  const len = Number(listingsLength) || 0;
  if (len === 0) return 0;
  if (server <= 0) return len;
  return Math.min(server, len);
}

export default ListingsSyncContext;
