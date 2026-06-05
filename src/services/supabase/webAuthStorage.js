/**
 * Web auth storage for Expo SPA (ngrok / mobile Safari).
 * Mirrors PKCE code-verifier keys to sessionStorage so OAuth survives iOS Safari
 * clearing localStorage during the Google → Supabase → ngrok redirect chain.
 */
const PKCE_BACKUP_PREFIX = 'bidify:pkce-backup:';
const PKCE_VAULT_KEY = 'bidify:pkce-vault';

function isCodeVerifierKey(key) {
  return typeof key === 'string' && key.includes('code-verifier');
}

function readSessionBackup(key) {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const direct = sessionStorage.getItem(`${PKCE_BACKUP_PREFIX}${key}`);
    if (direct) return direct;
    const raw = sessionStorage.getItem(PKCE_VAULT_KEY);
    if (!raw) return null;
    const vault = JSON.parse(raw);
    const origin =
      typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : '';
    if (vault?.origin && origin && vault.origin !== origin) return null;
    const hit = Array.isArray(vault?.entries)
      ? vault.entries.find((e) => e?.key === key)
      : null;
    return hit?.val || null;
  } catch {
    return null;
  }
}

function mirrorCodeVerifier(key, value) {
  if (!isCodeVerifierKey(key) || !value) return;
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(`${PKCE_BACKUP_PREFIX}${key}`, value);
    const origin =
      typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : '';
    const raw = sessionStorage.getItem(PKCE_VAULT_KEY);
    let entries = [];
    try {
      const prev = raw ? JSON.parse(raw) : null;
      if (prev?.origin === origin && Array.isArray(prev.entries)) entries = prev.entries;
    } catch {
      entries = [];
    }
    const idx = entries.findIndex((e) => e?.key === key);
    const row = { key, val: value };
    if (idx >= 0) entries[idx] = row;
    else entries.push(row);
    sessionStorage.setItem(PKCE_VAULT_KEY, JSON.stringify({ origin, entries }));
  } catch (e) {
    console.warn('[Bidify/webAuthStorage] mirrorCodeVerifier', e?.message);
  }
}

export const webAuthStorage = {
  getItem: (key) => {
    try {
      if (typeof localStorage === 'undefined') return Promise.resolve(null);
      let val = localStorage.getItem(key);
      if (!val && isCodeVerifierKey(key)) {
        val = readSessionBackup(key);
        if (val) localStorage.setItem(key, val);
      }
      return Promise.resolve(val);
    } catch (e) {
      console.warn('[Bidify/webAuthStorage] getItem failed', key, e?.message);
      if (isCodeVerifierKey(key)) {
        const backup = readSessionBackup(key);
        return Promise.resolve(backup);
      }
      return Promise.resolve(null);
    }
  },
  setItem: (key, value) => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, value);
      }
      if (isCodeVerifierKey(key)) {
        mirrorCodeVerifier(key, value);
      }
    } catch (e) {
      console.warn('[Bidify/webAuthStorage] setItem failed', key, e?.message);
      if (isCodeVerifierKey(key)) {
        mirrorCodeVerifier(key, value);
      }
    }
    return Promise.resolve();
  },
  removeItem: (key) => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(key);
      }
      if (typeof sessionStorage !== 'undefined' && isCodeVerifierKey(key)) {
        sessionStorage.removeItem(`${PKCE_BACKUP_PREFIX}${key}`);
      }
    } catch (e) {
      console.warn('[Bidify/webAuthStorage] removeItem failed', key, e?.message);
    }
    return Promise.resolve();
  },
};

export { PKCE_BACKUP_PREFIX, PKCE_VAULT_KEY, isCodeVerifierKey, mirrorCodeVerifier };
