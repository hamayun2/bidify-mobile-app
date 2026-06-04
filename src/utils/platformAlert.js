import { Alert, Platform } from 'react-native';

/**
 * Web-safe alert — avoids Alert.alert on web (can freeze the UI thread).
 */
export function showPlatformAlert(title, message) {
  const body = [title, message].filter(Boolean).join('\n\n');
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && typeof window.alert === 'function') {
      window.alert(body);
    }
    return;
  }
  Alert.alert(title || 'Notice', message || '');
}

/**
 * Web-safe confirm. Returns a Promise<boolean> on all platforms.
 */
export function showPlatformConfirm(title, message) {
  const body = [title, message].filter(Boolean).join('\n\n');
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      return Promise.resolve(window.confirm(body));
    }
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    Alert.alert(title || 'Confirm', message || '', [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'OK', onPress: () => resolve(true) },
    ]);
  });
}
