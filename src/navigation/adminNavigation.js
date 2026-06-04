import React, { useEffect } from 'react';
import { CommonActions } from '@react-navigation/native';
import { Alert, BackHandler, Platform } from 'react-native';

/** Root screen of the isolated admin stack (must match AppStack route name). */
export const ADMIN_ROOT_ROUTE = 'AdminPanel';

/**
 * Replace the entire App stack with only the admin root — no MainTabs underneath.
 * @param {import('@react-navigation/native').NavigationProp<any>} navigation
 */
export function resetToAdminPanel(navigation) {
  navigation.dispatch(
    CommonActions.reset({
      index: 0,
      routes: [{ name: ADMIN_ROOT_ROUTE }],
    })
  );
}

/**
 * Return to the main user app (clears admin screens from the stack).
 * @param {import('@react-navigation/native').NavigationProp<any>} navigation
 */
export function resetToMainApp(navigation) {
  navigation.dispatch(
    CommonActions.reset({
      index: 0,
      routes: [{ name: 'MainTabs' }],
    })
  );
}

/**
 * Enter admin from profile/menu after role check.
 * @param {import('@react-navigation/native').NavigationProp<any>} navigation
 */
export function enterAdminPanel(navigation) {
  resetToAdminPanel(navigation);
}

/**
 * Stack screen options: admin root must not show a back chevron to MainTabs.
 */
export function adminRootScreenOptions(overrides = {}) {
  return {
    title: 'Admin Panel',
    headerBackVisible: false,
    gestureEnabled: false,
    headerLeft: () => null,
    ...overrides,
  };
}

/**
 * Block hardware / gesture back on admin root; offer sign-out instead of leaking to MainTabs.
 * @param {import('@react-navigation/native').NavigationProp<any>} navigation
 * @param {() => void | Promise<void>} onSignOut
 */
export function useAdminRootBackGuard(navigation, onSignOut) {
  const promptLeaveAdmin = () => {
    Alert.alert(
      'Leave Admin Panel',
      'Sign out to leave the admin area. The back button cannot return you to the marketplace while signed in as admin.',
      [
        { text: 'Stay', style: 'cancel' },
        {
          text: 'Sign Out',
          style: 'destructive',
          onPress: () => {
            void onSignOut?.();
          },
        },
      ],
      { cancelable: true }
    );
  };

  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      promptLeaveAdmin();
      return true;
    });
    return () => sub.remove();
  }, [onSignOut]);

  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (e) => {
      const type = e.data?.action?.type;
      if (type !== 'GO_BACK' && type !== 'POP') {
        return;
      }
      e.preventDefault();
      promptLeaveAdmin();
    });
    return unsubscribe;
  }, [navigation, onSignOut]);
}

/**
 * Leave Support Inbox without landing back on AdminSupportChat (stack loop fix).
 * @param {import('@react-navigation/native').NavigationProp<any>} navigation
 */
export function exitAdminSupportInbox(navigation) {
  const state = navigation.getState?.();
  const routes = state?.routes ?? [];
  const index = typeof state?.index === 'number' ? state.index : routes.length - 1;
  const prev = index > 0 ? routes[index - 1] : null;

  if (prev?.name === 'AdminSupportChat') {
    navigation.pop(2);
    return;
  }

  const panelIndex = routes.findIndex((r) => r.name === ADMIN_ROOT_ROUTE);
  if (panelIndex >= 0 && panelIndex < index) {
    navigation.pop(index - panelIndex);
    return;
  }

  if (navigation.canGoBack()) {
    navigation.goBack();
    return;
  }

  resetToAdminPanel(navigation);
}

/**
 * Open admin dispute support chat with required route params for settlement actions.
 * @param {import('@react-navigation/native').NavigationProp<any>} navigation
 * @param {{
 *   orderId: string | number;
 *   ticketId?: string | number | null;
 *   listingTitle?: string;
 *   escrowAmount?: number;
 * }} payload
 */
export function openAdminSupportChat(navigation, payload) {
  const orderId = payload?.orderId != null ? String(payload.orderId).trim() : '';
  if (!orderId) {
    if (__DEV__) {
      console.warn('[admin] openAdminSupportChat skipped: missing orderId', payload);
    }
    return;
  }

  const ticketId =
    payload?.ticketId != null && String(payload.ticketId).trim() !== ''
      ? String(payload.ticketId).trim()
      : null;

  navigation.push('AdminSupportChat', {
    orderId,
    ticketId,
    listingTitle: payload?.listingTitle ?? 'Dispute',
    escrowAmount: Number(payload?.escrowAmount) || 0,
    orderStatus: 'disputed',
    showSettlementActions: true,
  });
}

/**
 * @param {import('@react-navigation/native').NavigationProp<any>} navigation
 */
export function exitAdminSupportChat(navigation) {
  if (navigation.canGoBack()) {
    navigation.goBack();
    return;
  }
  resetToAdminPanel(navigation);
}
