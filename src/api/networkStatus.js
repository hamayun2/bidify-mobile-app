/**
 * Lightweight reachability tracker so screens fall back to mock data
 * instantly instead of waiting on per-request axios timeouts.
 *
 * - markOffline(): call from interceptor / catch when a request times out.
 * - markOnline(): call when any request succeeds.
 * - isLikelyOffline(): true while we are inside the back-off window.
 * - syntheticOfflineError(): a "Network Error" the existing fallbacks already match.
 */

const OFFLINE_BACKOFF_MS = 20000;

let lastFailureAt = 0;
let lastSuccessAt = 0;

export function markOffline() {
  lastFailureAt = Date.now();
}

export function markOnline() {
  lastSuccessAt = Date.now();
  lastFailureAt = 0;
}

export function isLikelyOffline() {
  if (lastFailureAt === 0) return false;
  return Date.now() - lastFailureAt < OFFLINE_BACKOFF_MS;
}

export function syntheticOfflineError() {
  const err = new Error('Network Error (cached offline)');
  err.code = 'OFFLINE_CACHED';
  err.isAxiosError = true;
  err.config = {};
  return err;
}

export function isNetworkError(err) {
  if (!err) return false;
  if (err.code === 'OFFLINE_CACHED') return true;
  const m = err.message || '';
  if (m === 'Network Error') return true;
  if (m.includes('Network')) return true;
  if (m.includes('timeout')) return true;
  if (m.includes('ECONNABORTED')) return true;
  return false;
}
