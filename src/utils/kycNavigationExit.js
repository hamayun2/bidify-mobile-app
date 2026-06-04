import { CommonActions } from '@react-navigation/native';
import { MAIN_APP_ROUTE } from './kycPostSubmitAuth';

/**
 * Reset to MainTabs on the nearest navigator that defines it, or walk to root.
 * Signup KYC lives on AuthStack (no MainTabs) — RootNavigator swaps to AppStack after login.
 */
/**
 * Defer stack reset so RootNavigator can swap to AppStack after auth hydration.
 */
export function scheduleDeferredMainAppReset(navigation, delayMs = 100) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(resetNavigationToMainApp(navigation));
    }, delayMs);
  });
}

const MAIN_TABS_RESET = {
  index: 0,
  routes: [{ name: MAIN_APP_ROUTE }],
};

export function resetNavigationToMainApp(navigation) {
  if (!navigation) return false;

  let nav = navigation;
  for (let depth = 0; depth < 8 && nav; depth += 1) {
    const names = nav.getState?.()?.routeNames || [];
    if (names.includes(MAIN_APP_ROUTE)) {
      nav.dispatch(CommonActions.reset(MAIN_TABS_RESET));
      return true;
    }
    nav = nav.getParent?.();
  }

  let parent = navigation.getParent?.();
  while (parent) {
    const names = parent.getState?.()?.routeNames || [];
    if (names.includes(MAIN_APP_ROUTE)) {
      parent.dispatch(CommonActions.reset(MAIN_TABS_RESET));
      return true;
    }
    parent = parent.getParent?.();
  }

  return false;
}

/** Flush any onboarding stack entry and land on MainTabs (call after auth hydration). */
export function flushOnboardingAndOpenMainApp(navigation) {
  return resetNavigationToMainApp(navigation);
}
