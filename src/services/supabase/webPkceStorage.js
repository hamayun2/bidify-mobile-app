/**
 * PKCE persistence helpers for ngrok / mobile Safari OAuth returns.
 */
import { webAuthStorage } from './webAuthStorage';

const PKCE_BACKUP_PREFIX = 'bidify:pkce-backup:';
const PKCE_VAULT_KEY = 'bidify:pkce-vault';

/** Call AFTER signInWithOAuth — Supabase has written the code-verifier by then. */
export function persistPkceKeysAfterOAuthStart() {
  if (typeof localStorage === 'undefined' || typeof sessionStorage === 'undefined') return;
  try {
    const origin =
      typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '';
    const entries = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.includes('code-verifier')) continue;
      const val = localStorage.getItem(key);
      if (!val) continue;
      sessionStorage.setItem(`${PKCE_BACKUP_PREFIX}${key}`, val);
      entries.push({ key, val });
    }
    if (entries.length) {
      sessionStorage.setItem(PKCE_VAULT_KEY, JSON.stringify({ origin, entries }));
      if (__DEV__) {
        console.log('[Bidify/webPkceStorage] persisted PKCE verifier(s) for', origin);
      }
    }
  } catch (e) {
    console.warn('[Bidify/webPkceStorage] persistPkceKeysAfterOAuthStart', e?.message);
  }
}

/** @deprecated use persistPkceKeysAfterOAuthStart */
export function backupPkceKeysBeforeOAuth() {
  persistPkceKeysAfterOAuthStart();
}

export function restorePkceKeysAfterOAuth() {
  if (typeof sessionStorage === 'undefined' || typeof localStorage === 'undefined') return;
  try {
    const origin =
      typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '';

    const rawVault = sessionStorage.getItem(PKCE_VAULT_KEY);
    if (rawVault) {
      const vault = JSON.parse(rawVault);
      if (!vault?.origin || !origin || vault.origin === origin) {
        for (const row of vault?.entries || []) {
          if (row?.key && row?.val && !localStorage.getItem(row.key)) {
            localStorage.setItem(row.key, row.val);
          }
        }
      }
    }

    for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
      const key = sessionStorage.key(i);
      if (!key || !key.startsWith(PKCE_BACKUP_PREFIX)) continue;
      const storageKey = key.slice(PKCE_BACKUP_PREFIX.length);
      if (!localStorage.getItem(storageKey)) {
        const val = sessionStorage.getItem(key);
        if (val) localStorage.setItem(storageKey, val);
      }
    }
  } catch (e) {
    console.warn('[Bidify/webPkceStorage] restorePkceKeysAfterOAuth', e?.message);
  }
}

export const webPkceStorage = webAuthStorage;
