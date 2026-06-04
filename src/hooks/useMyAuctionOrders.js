import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, DeviceEventEmitter } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { AuthContext } from '../context/AuthContext';
import { getSupabase, isSupabaseConfigured } from '../services/supabaseClient';
import {
  fetchMyAuctionOrders,
  resolveOrderRole,
  subscribeToMyAuctionOrders,
} from '../services/auctionOrdersService';
import { AUCTION_RESOLVED_EVENT } from '../services/auctionResolveScheduler';

const POLL_MS = 12_000;
const FETCH_TIMEOUT_MS = 25_000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

/**
 * Loads public.auction_orders for the signed-in user (buyer + seller).
 */
export default function useMyAuctionOrders() {
  const { user } = useContext(AuthContext);
  const [sessionUserId, setSessionUserId] = useState(null);
  const [buckets, setBuckets] = useState({ pending: [], completed: [], other: [], all: [] });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const focusedRef = useRef(false);
  const inFlightRef = useRef(false);
  const initialLoadDoneRef = useRef(false);

  const contextUserId = user?.id ?? user?.uid ?? null;
  const effectiveUserId = sessionUserId || contextUserId;

  const resolveUid = useCallback(async () => {
    if (!isSupabaseConfigured()) return null;
    const supabase = getSupabase();
    const { data: sessionData } = await supabase.auth.getSession();
    const id = sessionData?.session?.user?.id
      ? String(sessionData.session.user.id).trim()
      : null;
    if (id) {
      setSessionUserId((prev) => (prev === id ? prev : id));
    }
    return id || contextUserId || null;
  }, [contextUserId]);

  const loadOrders = useCallback(
    async (mode = 'normal', opts = {}) => {
      const showFullScreenLoader = mode === 'normal' && !initialLoadDoneRef.current;
      const showRefresh = mode === 'pull';
      const skipSync = opts.skipSync !== undefined ? !!opts.skipSync : mode !== 'pull';

      if (!isSupabaseConfigured()) {
        setError('Sign in with Supabase to view orders.');
        setBuckets({ pending: [], completed: [], other: [], all: [] });
        setLoading(false);
        setRefreshing(false);
        initialLoadDoneRef.current = true;
        return;
      }

      const uid = await resolveUid();
      if (!uid) {
        setBuckets({ pending: [], completed: [], other: [], all: [] });
        setLoading(false);
        setRefreshing(false);
        return;
      }

      if (showFullScreenLoader) setLoading(true);
      if (showRefresh) setRefreshing(true);
      setError(null);

      if (inFlightRef.current && mode === 'silent') {
        return;
      }
      inFlightRef.current = true;

      try {
        const data = await withTimeout(
          fetchMyAuctionOrders(uid, { skipSync }),
          FETCH_TIMEOUT_MS,
          'fetchMyAuctionOrders'
        );

        const withRoles = (list) =>
          (list || []).map((o) => ({
            ...o,
            role: resolveOrderRole(o, uid),
          }));

        setBuckets({
          pending: withRoles(data.pending),
          completed: withRoles(data.completed),
          other: withRoles(data.other),
          all: withRoles(data.all),
        });

        if (__DEV__) {
          console.log('[MyOrders] loaded', {
            uid,
            total: data?.all?.length ?? 0,
            skipSync,
            mode,
          });
        }
      } catch (e) {
        const msg = e?.message || 'Could not load orders.';
        console.error('[MyOrders] loadOrders failed', {
          mode,
          skipSync,
          message: msg,
          code: e?.code,
          details: e?.details,
        });
        setError(msg);
        setBuckets({ pending: [], completed: [], other: [], all: [] });
      } finally {
        inFlightRef.current = false;
        initialLoadDoneRef.current = true;
        setLoading(false);
        setRefreshing(false);
      }
    },
    [resolveUid]
  );

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      void loadOrders('normal', { skipSync: false });

      const pollId = setInterval(() => {
        if (focusedRef.current && AppState.currentState === 'active') {
          void loadOrders('silent', { skipSync: false });
        }
      }, POLL_MS);

      return () => {
        focusedRef.current = false;
        clearInterval(pollId);
      };
    }, [loadOrders])
  );

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(AUCTION_RESOLVED_EVENT, () => {
      void loadOrders('silent', { skipSync: false });
    });
    return () => sub.remove();
  }, [loadOrders]);

  useEffect(() => {
    if (!effectiveUserId) return undefined;
    return subscribeToMyAuctionOrders(effectiveUserId, () => {
      void loadOrders('silent', { skipSync: true });
    });
  }, [effectiveUserId, loadOrders]);

  const flatOrders = useMemo(() => {
    if (buckets.all?.length) return buckets.all;
    return [...(buckets.pending || []), ...(buckets.other || []), ...(buckets.completed || [])];
  }, [buckets]);

  const pendingCount = useMemo(
    () => flatOrders.filter((o) => o.isPending).length,
    [flatOrders]
  );

  return {
    buckets,
    setBuckets,
    flatOrders,
    pendingCount,
    loading,
    refreshing,
    error,
    effectiveUserId,
    sessionUserId,
    loadOrders,
    refresh: () => loadOrders('pull', { skipSync: false }),
  };
}
