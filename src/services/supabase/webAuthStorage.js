/**
 * Web session storage — localStorage works on mobile Safari when third-party cookies are blocked.
 * Native apps continue using AsyncStorage via supabaseClient.
 */
export const webAuthStorage = {
  getItem: (key) => {
    try {
      if (typeof localStorage === 'undefined') return Promise.resolve(null);
      return Promise.resolve(localStorage.getItem(key));
    } catch (e) {
      console.warn('[Bidify/webAuthStorage] getItem failed', key, e?.message);
      return Promise.resolve(null);
    }
  },
  setItem: (key, value) => {
    try {
      if (typeof localStorage === 'undefined') return Promise.resolve();
      localStorage.setItem(key, value);
    } catch (e) {
      console.warn('[Bidify/webAuthStorage] setItem failed', key, e?.message);
    }
    return Promise.resolve();
  },
  removeItem: (key) => {
    try {
      if (typeof localStorage === 'undefined') return Promise.resolve();
      localStorage.removeItem(key);
    } catch (e) {
      console.warn('[Bidify/webAuthStorage] removeItem failed', key, e?.message);
    }
    return Promise.resolve();
  },
};
