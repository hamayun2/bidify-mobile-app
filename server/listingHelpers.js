const { store } = require('./store');

function publicBase(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:4000';
  const fromRequest = `${proto}://${host}`.replace(/\/$/, '');

  const env = process.env.API_PUBLIC_URL;
  if (!env || typeof env !== 'string' || !env.trim()) {
    return fromRequest;
  }

  const envBase = env.trim().replace(/\/$/, '');

  // Dev: avoid stale LAN IP in API_PUBLIC_URL when the API request hit localhost (fixes Stripe return ERR_CONNECTION_REFUSED on web).
  if (process.env.NODE_ENV !== 'production' && req) {
    try {
      const reqHost = String(req.get('host') || '').split(':')[0];
      const envUrl = new URL(envBase);
      const reqIsLocal = reqHost === 'localhost' || reqHost === '127.0.0.1';
      const envIsLan =
        /^192\.168\.\d+\.\d+$/.test(envUrl.hostname) ||
        /^10\.\d+\.\d+\.\d+$/.test(envUrl.hostname);
      if (reqIsLocal && (envIsLan || envUrl.hostname !== reqHost)) {
        return fromRequest;
      }
    } catch {
      /* use env */
    }
  }

  return envBase;
}

/**
 * Returns a path-only string (e.g. `/uploads/photo.jpg`) — NOT an absolute URL.
 * Absolute URLs are built at response time so that the host always matches the
 * client's current network, even after the dev box's IP changes.
 */
function uploadUrl(_req, filename) {
  if (!filename) return null;
  return `/uploads/${filename}`;
}

/**
 * True iff `s` is a string we can safely render with `<Image source={{uri:s}}/>`.
 * Strict guard against historical bad data like "[object Object]", "undefined",
 * stringified JSON, etc.
 */
function isUsableImageUrl(s) {
  if (s == null || typeof s !== 'string') return false;
  const t = s.trim();
  if (!t) return false;
  if (t === '[object Object]') return false;
  if (t === 'null' || t === 'undefined' || t === 'NaN') return false;
  if (t.startsWith('[object ')) return false;
  return true;
}

/** Normalize any stored URL into an absolute one using THIS request's host. */
function rewriteToCurrentHost(req, base, raw) {
  if (!isUsableImageUrl(raw)) return null;
  const t = raw.trim();
  if (t.startsWith('data:')) return t;
  if (t.startsWith('blob:')) return t;
  // Re-host any absolute URL whose path points at /uploads/ so old stored URLs
  // (with stale IP/hostname) automatically follow the current LAN address.
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      if (/^\/uploads\//i.test(u.pathname)) {
        return `${base}${u.pathname}${u.search || ''}`;
      }
    } catch (_) {
      /* fall through */
    }
    return t;
  }
  if (t.startsWith('/uploads/')) return `${base}${t}`;
  if (t.startsWith('/')) return `${base}${t}`;
  return `${base}/uploads/${t}`;
}

function serializeListing(req, row) {
  if (!row) return row;
  const base = publicBase(req);
  const sourceImages = Array.isArray(row.images)
    ? row.images.filter(isUsableImageUrl)
    : [];
  const sourceCover = isUsableImageUrl(row.image) ? row.image : null;
  if (sourceCover && !sourceImages.includes(sourceCover)) {
    sourceImages.unshift(sourceCover);
  }
  // De-duplicate after resolution so we don't return two URLs that point at
  // the same final file.
  const resolved = [];
  const seen = new Set();
  for (const u of sourceImages) {
    const r = rewriteToCurrentHost(req, base, u);
    if (r && !seen.has(r)) {
      seen.add(r);
      resolved.push(r);
    }
  }
  const image = resolved[0] || null;
  return { ...row, image, images: resolved };
}

function recordPayment(entry) {
  const row = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    createdAt: new Date().toISOString(),
    ...entry,
  };
  store.paymentLog.unshift(row);
  if (store.paymentLog.length > 500) store.paymentLog.length = 500;
  return row;
}

module.exports = {
  publicBase,
  uploadUrl,
  serializeListing,
  recordPayment,
};
