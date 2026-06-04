import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { AuthContext } from './AuthContext';
import { isSupabaseConfigured } from '../services/supabaseClient';
import {
  fetchUnreadMessagesCount,
  subscribeToUnreadMessages,
} from '../services/chatService';

const ChatUnreadContext = createContext({
  unreadCount: 0,
  refresh: async () => {},
});

export function ChatUnreadProvider({ children }) {
  const { user, isAuthenticated } = useContext(AuthContext);
  const userId = user?.id ?? user?.uid ?? null;
  const [unreadCount, setUnreadCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!isAuthenticated || !userId || !isSupabaseConfigured()) {
      setUnreadCount(0);
      return;
    }
    try {
      const n = await fetchUnreadMessagesCount(userId);
      setUnreadCount(n);
    } catch (e) {
      if (__DEV__) console.warn('[ChatUnreadContext] refresh failed', e?.message);
    }
  }, [isAuthenticated, userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!userId || !isAuthenticated) return undefined;
    return subscribeToUnreadMessages(userId, () => {
      void refresh();
    });
  }, [userId, isAuthenticated, refresh]);

  const value = useMemo(
    () => ({
      unreadCount,
      refresh,
    }),
    [unreadCount, refresh]
  );

  return (
    <ChatUnreadContext.Provider value={value}>{children}</ChatUnreadContext.Provider>
  );
}

export function useChatUnread() {
  return useContext(ChatUnreadContext);
}
