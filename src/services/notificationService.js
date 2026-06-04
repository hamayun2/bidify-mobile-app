import { getSupabase, isSupabaseConfigured } from './supabaseClient';
import { logPostgrestError } from './supabaseErrors';

/** Chat alerts use the Chats tab badge only — never the global bell. */
export const CHAT_NOTIFICATION_TYPE = 'chat_message';

export function isChatNotificationRow(row) {
  const t = row?.metadata?.type;
  return t === CHAT_NOTIFICATION_TYPE;
}

export function isBellNotificationRow(row) {
  return !isChatNotificationRow(row);
}

export async function fetchUnreadNotificationCount(userId) {
  if (!isSupabaseConfigured() || !userId) return 0;
  const supabase = getSupabase();
  const uid = String(userId).trim();

  const { data, error } = await supabase
    .from('notifications')
    .select('id, metadata')
    .eq('user_id', uid)
    .eq('is_read', false);

  if (error) {
    logPostgrestError('notifications.count unread', error, { userId: uid });
    console.error('[notifications] unread count failed', error.message);
    return 0;
  }
  return (Array.isArray(data) ? data : []).filter(isBellNotificationRow).length;
}

export async function fetchNotifications(userId, limit = 40) {
  if (!isSupabaseConfigured() || !userId) return [];
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('notifications')
    .select('id, user_id, title, body, is_read, metadata, created_at')
    .eq('user_id', String(userId).trim())
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    logPostgrestError('notifications.select', error);
    throw new Error(error.message || 'Could not load notifications.');
  }
  const rows = Array.isArray(data) ? data : [];
  return rows.filter(isBellNotificationRow);
}

export async function markNotificationRead(notificationId) {
  if (!isSupabaseConfigured() || !notificationId) return;
  const supabase = getSupabase();
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('id', String(notificationId));
  if (error) logPostgrestError('notifications.update read', error);
}

export async function markAllNotificationsRead(userId) {
  if (!isSupabaseConfigured() || !userId) return;
  const supabase = getSupabase();
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', String(userId).trim())
    .eq('is_read', false);
  if (error) logPostgrestError('notifications.update read all', error);
}

/**
 * Realtime: wallet/bid notifications for header bell + toast (excludes chat).
 */
export function subscribeToNotifications(userId, { onRefresh, onInsert } = {}) {
  if (!isSupabaseConfigured() || !userId) return () => {};

  const supabase = getSupabase();
  const uid = String(userId).trim();
  let debounce = null;

  const scheduleRefresh = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      onRefresh?.();
    }, 300);
  };

  const channel = supabase
    .channel(`notifications:${uid}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${uid}`,
      },
      (payload) => {
        const row = payload?.new;
        if (row && isBellNotificationRow(row)) {
          onInsert?.(row);
        }
        scheduleRefresh();
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${uid}`,
      },
      scheduleRefresh
    )
    .subscribe();

  return () => {
    if (debounce) clearTimeout(debounce);
    supabase.removeChannel(channel);
  };
}
