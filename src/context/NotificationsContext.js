import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { AuthContext } from './AuthContext';
import { useToast } from '../components/InAppToast';
import { isSupabaseConfigured } from '../services/supabaseClient';
import {
  fetchUnreadNotificationCount,
  subscribeToNotifications,
} from '../services/notificationService';
import { getNotificationDisplayText } from '../utils/notificationDisplayText';

const NotificationsContext = createContext({
  unreadCount: 0,
  refresh: async () => {},
});

export function NotificationsProvider({ children }) {
  const { user, isAuthenticated } = useContext(AuthContext);
  const { showToast } = useToast();
  const userId = user?.id ?? user?.uid ?? null;
  const [unreadCount, setUnreadCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!isAuthenticated || !userId || !isSupabaseConfigured()) {
      setUnreadCount(0);
      return;
    }
    try {
      const n = await fetchUnreadNotificationCount(userId);
      setUnreadCount(n);
    } catch (e) {
      console.error('[NotificationsContext] refresh failed', e?.message);
    }
  }, [isAuthenticated, userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!userId || !isAuthenticated) return undefined;
    return subscribeToNotifications(userId, {
      onRefresh: refresh,
      onInsert: (row) => {
        const { body, title } = getNotificationDisplayText(row);
        const toastText = body || title;
        if (toastText) showToast(toastText);
      },
    });
  }, [userId, isAuthenticated, refresh, showToast]);

  const value = useMemo(
    () => ({
      unreadCount,
      refresh,
    }),
    [unreadCount, refresh]
  );

  return (
    <NotificationsContext.Provider value={value}>
      {children}
    </NotificationsContext.Provider>
  );
}

export function useNotifications() {
  return useContext(NotificationsContext);
}
