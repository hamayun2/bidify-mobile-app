/**
 * Defensive back-navigation helpers so no screen can ever leave the user
 * stuck. A `goBack()` call fails silently if there's no history (common on
 * web hard reloads, deep links, or after auth state changes). These helpers
 * always fall back to a known safe target.
 */

export function backToOr(navigation, fallback = 'Login') {
  if (!navigation) return false;
  try {
    if (typeof navigation.canGoBack === 'function' && navigation.canGoBack()) {
      navigation.goBack();
      return true;
    }
  } catch (_) {
    /* ignore — fall through */
  }
  try {
    navigation.navigate(fallback);
    return true;
  } catch (_) {
    return false;
  }
}

/** Auth-stack back: prefer goBack, otherwise jump to Login. */
export function backToLogin(navigation) {
  return backToOr(navigation, 'Login');
}

/** App-stack back: prefer goBack, otherwise jump to MainTabs (Home). */
export function backToHome(navigation) {
  return backToOr(navigation, 'MainTabs');
}
