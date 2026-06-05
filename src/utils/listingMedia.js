/**
 * Normalize listing image fields from various backend JSON shapes so the app
 * always gets absolute `image` + `images[]` URLs React Native can load.
 */
import { getApiOrigin, isLoopbackHost } from '../config/apiBase';
import { isTunnelWebHost } from '../services/supabase/authRedirect';
import { Platform } from 'react-native';

/**
 * Static file origin for `/uploads/...` paths (Express auxiliary server).
 * Override with EXPO_PUBLIC_API_STATIC_URL when CDN/static host differs from API.
 */
export function getStaticOrigin() {
  const custom = (process.env.EXPO_PUBLIC_API_STATIC_URL || '').trim();
  if (custom) {
    try {
      const withProto = /^https?:\/\//i.test(custom) ? custom : `https://${custom}`;
      const u = new URL(withProto);
      return `${u.protocol}//${u.host}`;
    } catch {
      return custom.replace(/\/$/, '');
    }
  }
  return getApiOrigin();
}

export function isLocalDeviceMediaUri(uri) {
  if (!uri || typeof uri !== 'string') return false;
  const u = uri.trim();
  if (!u) return false;
  if (/^https?:\/\//i.test(u)) return false;
  if (u.startsWith('/')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(u)) return false;
  if (u.startsWith('file://')) return true;
  if (u.startsWith('content://')) return true;
  if (u.startsWith('blob:')) return true;
  if (u.startsWith('ph://')) return true;
  if (u.startsWith('assets-library://')) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return true;
  return false;
}

function encodeHttpUrlSpaces(urlStr) {
  if (!urlStr || typeof urlStr !== 'string' || !/\s/.test(urlStr)) return urlStr;
  return urlStr.replace(/\s/g, '%20');
}

function rewriteLoopbackMediaUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const loopback = isLoopbackHost(u.hostname) || u.hostname === '10.0.2.2';
    if (!loopback) return urlStr;

    const origin = getStaticOrigin();
    if (!origin) return urlStr;

    const base = /^https?:\/\//i.test(origin) ? origin : `http://${origin}`;
    const api = new URL(base);
    u.protocol = api.protocol;
    u.hostname = api.hostname;
    u.port = api.port;
    return u.toString();
  } catch {
    return urlStr;
  }
}

/** When viewing via ngrok, rewrite LAN-only hosts in stored media URLs if we have a public API origin. */
function rewriteStaleDevMediaUrl(urlStr) {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return urlStr;
  const pageHost = window.location.hostname || '';
  if (!isTunnelWebHost(pageHost)) return urlStr;

  try {
    const u = new URL(urlStr);
    const origin = getStaticOrigin();
    if (!origin) return urlStr;

    const target = new URL(/^https?:\/\//i.test(origin) ? origin : `https://${origin}`);
    const urlIsDevHost =
      isLoopbackHost(u.hostname) ||
      u.hostname === '10.0.2.2' ||
      /^192\.168\.\d+\.\d+$/.test(u.hostname);

    if (urlIsDevHost && u.hostname !== target.hostname) {
      u.protocol = target.protocol;
      u.hostname = target.hostname;
      u.port = target.port;
      return u.toString();
    }
  } catch {
    /* ignore */
  }
  return urlStr;
}

/**
 * Reject obviously-garbage values BEFORE we build a request URL out of them.
 * Historic store rows occasionally contain `"[object Object]"` from an upload
 * where a JS object was string-coerced; building a URL out of that just sends
 * the user to a 404. Returning null short-circuits to the placeholder.
 */
function isGarbageImageString(s) {
  if (typeof s !== 'string') return true;
  const t = s.trim();
  if (!t) return true;
  if (t === '[object Object]') return true;
  if (t === 'null' || t === 'undefined' || t === 'NaN') return true;
  if (t.startsWith('[object ')) return true;
  return false;
}

export function resolveMediaUrl(input) {
  if (input == null) return null;
  // Defensive: never coerce non-strings. `String({obj})` would produce
  // `"[object Object]"` and turn into a real (broken) HTTP request.
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;
  if (isGarbageImageString(s)) return null;
  s = s.replace(/\\/g, '/');

  if (s.startsWith('data:image/')) return s;

  if (s.startsWith('//')) {
    return rewriteStaleDevMediaUrl(rewriteLoopbackMediaUrl(encodeHttpUrlSpaces(`https:${s}`)));
  }

  if (/^https?:\/\//i.test(s)) {
    return rewriteStaleDevMediaUrl(rewriteLoopbackMediaUrl(encodeHttpUrlSpaces(s)));
  }

  if (s.startsWith('file://')) return s;
  if (s.startsWith('content://')) return s;
  if (s.startsWith('blob:')) return s;
  if (/^[a-zA-Z]:[\\/]/.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;

  // At this point `s` is a bare path like `/uploads/x.jpg` or `photo.jpg`.
  // Bare paths only make sense when the auxiliary Express server is
  // configured. If it isn't, we refuse to invent a host — return null so
  // SmartImage drops in the fallback art.
  const base = getStaticOrigin().replace(/\/$/, '');
  if (!base) return null;

  if (/^[^/]+\.(jpe?g|png|gif|webp|avif)$/i.test(s)) {
    return rewriteStaleDevMediaUrl(
      rewriteLoopbackMediaUrl(encodeHttpUrlSpaces(`${base}/uploads/${s}`))
    );
  }

  const path = s.startsWith('/') ? s : `/${s}`;
  return rewriteStaleDevMediaUrl(rewriteLoopbackMediaUrl(encodeHttpUrlSpaces(`${base}${path}`)));
}

function pushUniqueUrls(seen, out, raw) {
  const url = resolveMediaUrl(raw);
  if (url && !seen.has(url)) {
    seen.add(url);
    out.push(url);
  }
}

/** Pull one URL from nested media objects (Strapi, Cloudinary shapes, plain { url }). */
function extractUrlFromMediaNode(node) {
  if (node == null) return null;
  if (typeof node === 'string' || typeof node === 'number') {
    const s = String(node).trim();
    return s || null;
  }
  if (Array.isArray(node)) {
    for (const el of node) {
      const u = extractUrlFromMediaNode(el);
      if (u) return u;
    }
    return null;
  }
  if (typeof node !== 'object') return null;

  // Strapi v4 / v5: { data: { attributes: { url } } } or data: [{ attributes }]
  const d = node.data;
  if (d != null) {
    if (Array.isArray(d) && d.length > 0) {
      const first = d[0];
      const attrs = first?.attributes;
      if (attrs?.url) return attrs.url;
      const fmt = attrs?.formats;
      if (fmt?.large?.url) return fmt.large.url;
      if (fmt?.medium?.url) return fmt.medium.url;
      if (fmt?.small?.url) return fmt.small.url;
    } else if (typeof d === 'object' && d.attributes?.url) {
      const attrs = d.attributes;
      if (attrs.url) return attrs.url;
      const fmt = attrs.formats;
      if (fmt?.large?.url) return fmt.large.url;
      if (fmt?.medium?.url) return fmt.medium.url;
    }
  }

  const direct =
    node.url ||
    node.src ||
    node.uri ||
    node.path ||
    node.secure_url ||
    node.Location ||
    node.location ||
    node.href ||
    node.link ||
    node.publicUrl ||
    node.public_url ||
    node.filepath ||
    node.filePath ||
    node.filename ||
    node.storagePath ||
    node.storage_path ||
    node.cdnUrl ||
    node.cdn_url ||
    node.signedUrl ||
    node.signed_url;

  if (typeof node.file === 'string' && node.file.trim()) return node.file.trim();

  const fmt = node.formats;
  if (fmt && typeof fmt === 'object') {
    for (const k of ['large', 'medium', 'small', 'thumbnail']) {
      if (fmt[k]?.url) return fmt[k].url;
    }
  }

  if (node.image && typeof node.image === 'object') {
    const inner = extractUrlFromMediaNode(node.image);
    if (inner) return inner;
  }

  return null;
}

/** comma-separated absolute/relative image URLs in one DB column */
function maybeSplitCommaMediaUrls(s) {
  const t = s.trim();
  if (!t.includes(',') || t.startsWith('[') || t.startsWith('{')) return null;
  const parts = t
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const allPaths = parts.every(
    (p) => /^https?:\/\//i.test(p) || p.startsWith('/') || /^[\w.-]+\.(jpg|jpeg|png|gif|webp)$/i.test(p)
  );
  return allPaths ? parts : null;
}

/** Collect every image URL reachable from a value (arrays, JSON strings, nested objects). */
function collectMediaValues(seen, out, value, depth = 0) {
  if (value == null || depth > 12) return;

  if (typeof value === 'string') {
    const t = value.trim();
    if (!t) return;
    // Filter known-bad coerce strings so we never even try to load them.
    if (isGarbageImageString(t)) return;
    if (t.startsWith('[') || t.startsWith('{')) {
      try {
        collectMediaValues(seen, out, JSON.parse(t), depth + 1);
      } catch {
        // The string isn't JSON; only fall back to it if it doesn't look like
        // a stringified object brace soup.
        if (!t.startsWith('[object ')) pushUniqueUrls(seen, out, t);
      }
      return;
    }
    const split = maybeSplitCommaMediaUrls(t);
    if (split) {
      for (const p of split) pushUniqueUrls(seen, out, p);
      return;
    }
    pushUniqueUrls(seen, out, t);
    return;
  }

  if (typeof value === 'number') {
    pushUniqueUrls(seen, out, value);
    return;
  }

  if (Array.isArray(value)) {
    for (const el of value) {
      if (el != null && typeof el === 'object' && !Array.isArray(el)) {
        const u = extractUrlFromMediaNode(el);
        if (u) pushUniqueUrls(seen, out, u);
        else collectMediaValues(seen, out, el, depth + 1);
      } else {
        collectMediaValues(seen, out, el, depth + 1);
      }
    }
    return;
  }

  if (typeof value === 'object') {
    const u = extractUrlFromMediaNode(value);
    if (u) {
      pushUniqueUrls(seen, out, u);
      return;
    }

    const nestedKeys = [
      'images',
      'imageUrls',
      'photos',
      'attachments',
      'media',
      'pictures',
      'gallery',
      'files',
      'urls',
      'listingImages',
      'productImages',
      'carousel',
    ];
    for (const k of nestedKeys) {
      if (value[k] != null) collectMediaValues(seen, out, value[k], depth + 1);
    }

    // Shallow string scan: uploads paths / absolute URLs only (avoid arbitrary text)
    if (depth <= 4) {
      for (const v of Object.values(value)) {
        if (typeof v === 'string') {
          const x = v.trim();
          if (
            /^https?:\/\//i.test(x) ||
            x.startsWith('/uploads/') ||
            x.startsWith('uploads/') ||
            x.startsWith('/api/uploads/') ||
            x.startsWith('/api/files/') ||
            x.startsWith('/storage/') ||
            x.startsWith('/static/') ||
            x.startsWith('/public/')
          ) {
            pushUniqueUrls(seen, out, x);
          }
        }
      }
    }
  }
}

const LISTING_ARRAY_MEDIA_KEYS = [
  'images',
  'imageUrls',
  'image_urls',
  'photos',
  'attachments',
  'media',
  'pictures',
  'gallery',
  'listingImages',
  'productImages',
  'files',
  'image_paths',
  'imagePaths',
  'photo_urls',
  'photoUrls',
];

const LISTING_SINGLE_MEDIA_KEYS = [
  'image',
  'thumbnail',
  'thumbnailUrl',
  'thumbnail_url',
  'coverImage',
  'cover_image',
  'cover',
  'photo',
  'picture',
  'imageUrl',
  'imageURL',
  'imgUrl',
  'img',
  'mainImage',
  'primaryImage',
  'mainPhoto',
  'heroImage',
  'featuredImage',
  'banner',
  'photoUrl',
  'pictureUrl',
  'featured_image',
  'featuredImageUrl',
  'imagePath',
  'image_path',
];

/** Normalized: pending | approved | rejected (legacy listings without flags → approved). */
export function getListingModerationStatus(listing) {
  if (!listing || typeof listing !== 'object') return 'approved';

  const raw =
    listing.moderationStatus ??
    listing.moderation_status ??
    listing.approvalStatus ??
    listing.approval_status ??
    listing.listingStatus ??
    listing.listing_status ??
    listing.reviewStatus ??
    listing.review_status ??
    listing.status;

  if (raw == null || raw === '') {
    if (listing.isApproved === false || listing.published === false) return 'pending';
    if (listing.isApproved === true || listing.published === true) return 'approved';
    return 'approved';
  }

  const s = String(raw).toLowerCase();

  if (
    s.includes('pending') ||
    s.includes('awaiting') ||
    s.includes('review') ||
    s.includes('submitted') ||
    s === 'draft' ||
    s === 'queued'
  ) {
    return 'pending';
  }
  if (
    s.includes('reject') ||
    s.includes('declined') ||
    s.includes('denied') ||
    s === 'banned'
  ) {
    return 'rejected';
  }
  if (
    s.includes('approv') ||
    s.includes('active') ||
    s.includes('live') ||
    s.includes('publish') ||
    s === 'accepted' ||
    s === 'ok' ||
    s === 'ended' ||
    s === 'sold' ||
    s === 'expired'
  ) {
    return 'approved';
  }
  return 'approved';
}

export function isListingPubliclyVisible(listing) {
  return getListingModerationStatus(listing) === 'approved';
}

/**
 * Marketplace home feed — include approved listings and legacy active rows (global catalog).
 */
export function isListingMarketplaceVisible(listing) {
  if (!listing) return false;
  const mod = getListingModerationStatus(listing);
  if (mod === 'rejected') return false;
  if (mod === 'approved') return true;
  const st = String(listing.status || listing.moderationStatus || '').toLowerCase();
  return (
    st === 'active' ||
    st === 'sold' ||
    st === 'approved' ||
    st === 'ended' ||
    st === 'expired'
  );
}

/**
 * Listing kind helpers.
 *
 * New canonical values for `listing.type`:
 *   - 'auction'  → bidding, timing, automated payment for winner (or optional buy-now during auction)
 *   - 'standard' → direct listing; no automated payment button, buyer uses "Chat with Seller"
 *
 * Legacy support: existing listings stored as `type: 'buynow'` are treated as 'standard'.
 */
export function isAuctionListing(listing) {
  const t = listing?.type ?? listing?.listing_type;
  return t === 'auction';
}

export function isStandardListing(listing) {
  const t = listing?.type;
  return t === 'standard' || t === 'buynow';
}

export function getListingKind(listing) {
  return isAuctionListing(listing) ? 'auction' : 'standard';
}

function flattenListingRecord(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  let x = { ...raw };

  if (x.data != null && typeof x.data === 'object' && !Array.isArray(x.data)) {
    const d = x.data;
    if (d.attributes != null && typeof d.attributes === 'object' && !Array.isArray(d.attributes)) {
      const id = d.id != null ? d.id : d.documentId;
      x = {
        ...d.attributes,
        id: id != null ? id : d.attributes.id ?? d.attributes.documentId,
      };
    } else {
      x = { ...d };
    }
  }

  if (x.attributes != null && typeof x.attributes === 'object' && !Array.isArray(x.attributes)) {
    const { attributes: attrs, ...rest } = x;
    x = { ...rest, ...attrs };
  }

  return x;
}

function collectFromLikelyMediaKeys(obj, seen, out, depth = 0) {
  if (obj == null || depth > 8) return;
  if (typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const el of obj) {
      collectFromLikelyMediaKeys(el, seen, out, depth + 1);
    }
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (
      /^(url|uri|src|thumbnail|image|photo|picture|cover|banner|avatar|media|gallery|cdn|signed|attachment|filepath|filePath|storage_path|storagePath)$/i.test(
        k
      ) ||
      /(image|photo|picture|thumbnail|cover|media|gallery|banner|avatar|attachment|cdn|signed|filepath)/i.test(
        k
      ) ||
      (k.length < 48 &&
        /(^|_|\/)path$/i.test(k) &&
        !/(xpath|jsonpath|sidebar)/i.test(k))
    ) {
      collectMediaValues(seen, out, v, depth + 1);
    }
  }
}

export function normalizeListing(listing) {
  if (!listing || typeof listing !== 'object') return listing;

  const flat = flattenListingRecord(listing);
  const l = { ...flat };
  const rawId = l.id ?? l._id;
  if (rawId != null && String(rawId).trim() !== '') {
    l.id = String(rawId);
  }

  const seen = new Set();
  const urls = [];

  for (const key of LISTING_ARRAY_MEDIA_KEYS) {
    if (l[key] != null) collectMediaValues(seen, urls, l[key]);
  }

  for (const key of LISTING_SINGLE_MEDIA_KEYS) {
    if (l[key] != null) collectMediaValues(seen, urls, l[key]);
  }

  const already = new Set([...LISTING_ARRAY_MEDIA_KEYS, ...LISTING_SINGLE_MEDIA_KEYS]);
  for (const key of Object.keys(l)) {
    if (already.has(key)) continue;
    if (/^(image|img|photo|picture|thumbnail|cover|media|gallery|attachment|file)/i.test(key)) {
      if (l[key] != null) collectMediaValues(seen, urls, l[key]);
    }
  }

  if (urls.length === 0) {
    collectFromLikelyMediaKeys(l, seen, urls);
  }

  const primary = urls[0] || null;

  if (l.sellerId == null && l.seller_id != null) {
    l.sellerId = String(l.seller_id);
  }

  const out = {
    ...l,
    image: primary,
    images: urls.length > 0 ? urls : primary ? [primary] : [],
  };
  if (out.sellerId == null && out.seller_id != null) {
    out.sellerId = String(out.seller_id);
  }
  const rawType = out.listing_type ?? out.type;
  if (rawType === 'auction') {
    out.type = 'auction';
  } else if (rawType === 'buynow') {
    out.type = 'standard';
  } else if (rawType != null && out.type == null) {
    out.type = rawType;
  }
  out.moderationStatus = getListingModerationStatus(out);
  return out;
}

export function getListingRowKey(item, index = 0) {
  if (!item || typeof item !== 'object') return `listing-${index}`;
  const id = item.id ?? item._id;
  if (id != null && String(id).trim() !== '') return `listing-${String(id)}`;
  const t = item.title != null ? String(item.title).slice(0, 48) : '';
  const p = item.price != null ? String(item.price) : '';
  return `listing-${index}-${t}-${p}`;
}

export function getListingCoverUri(listing) {
  if (!listing || typeof listing !== 'object') return null;
  if (listing.image != null) {
    const s = listing.image;
    if (typeof s === 'string' && s.trim()) return resolveMediaUrl(s.trim());
    if (typeof s === 'object') {
      const raw = extractUrlFromMediaNode(s);
      if (raw) return resolveMediaUrl(raw);
    }
  }
  if (Array.isArray(listing.images) && listing.images.length > 0) {
    const x = listing.images[0];
    if (typeof x === 'string' && x.trim()) return resolveMediaUrl(x.trim());
    if (x && typeof x === 'object') {
      const raw = extractUrlFromMediaNode(x);
      if (raw) return resolveMediaUrl(raw);
    }
  }
  return null;
}

/**
 * Home / card cover — mirrors ListingDetail gallery URL resolution so thumbnails
 * match the detail screen (real uploads first, no curated stock overrides).
 */
export function resolveListingCoverForDisplay(listing) {
  if (!listing || typeof listing !== 'object') return null;

  const l = normalizeListing(listing);
  const candidates = [];

  if (Array.isArray(l.images) && l.images.length > 0) {
    candidates.push(...l.images);
  } else if (l.image != null) {
    candidates.push(l.image);
  }

  for (const key of [
    'image_url',
    'imageUrl',
    'image_urls',
    'thumbnail_url',
    'thumbnailUrl',
    'cover_image',
    'coverImage',
  ]) {
    if (l[key] != null) candidates.push(l[key]);
  }

  const seen = new Set();
  for (const raw of candidates) {
    const resolved = resolveMediaUrl(raw);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      return resolved;
    }
  }

  return getListingCoverUri(l);
}

const LIST_PAYLOAD_ARRAY_KEYS = [
  'listings',
  'data',
  'results',
  'items',
  'rows',
  'docs',
  'records',
  'payload',
  'list',
  'content',
  'body',
  'products',
  'auctions',
];

const NEST_WRAPPER_KEYS = [
  'data',
  'payload',
  'response',
  'result',
  'body',
  'content',
  'attributes',
  'listing',
  '_doc',
];

function isListingLikeObject(obj) {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (obj.title != null || obj.name != null || obj.description != null) return true;
  if (
    obj.price != null ||
    obj.startingBid != null ||
    obj.startingPrice != null ||
    obj.currentBid != null ||
    obj.buyNowPrice != null
  )
    return true;
  if ((obj.id != null || obj._id != null) && Object.keys(obj).length >= 3) return true;
  if (typeof obj.type === 'string' && /auction|buy|sell|listing/i.test(obj.type)) return true;
  return false;
}

function findListingArrayDeep(root, depth = 0, maxDepth = 14) {
  if (root == null || depth > maxDepth) return null;

  if (Array.isArray(root)) {
    if (root.length > 0 && isListingLikeObject(root[0])) return root;
    for (const el of root) {
      const got = findListingArrayDeep(el, depth + 1, maxDepth);
      if (got && got.length) return got;
    }
    return null;
  }

  if (typeof root !== 'object') return null;

  if (Array.isArray(root.edges)) {
    const nodes = root.edges.map((e) => (e && e.node != null ? e.node : null)).filter(Boolean);
    if (nodes.length > 0 && isListingLikeObject(nodes[0])) return nodes;
  }

  for (const v of Object.values(root)) {
    if (v != null && typeof v === 'object') {
      const got = findListingArrayDeep(v, depth + 1, maxDepth);
      if (got && got.length) return got;
    }
  }
  return null;
}

export function unwrapListingsPayload(data) {
  if (data == null) return [];
  if (Array.isArray(data)) {
    if (data.length === 0) return [];
    return isListingLikeObject(data[0]) ? data : findListingArrayDeep(data) || [];
  }
  if (typeof data !== 'object') return [];

  if (isListingLikeObject(data)) return [data];

  for (const k of LIST_PAYLOAD_ARRAY_KEYS) {
    const v = data[k];
    if (!Array.isArray(v) || v.length === 0) continue;
    if (isListingLikeObject(v[0])) return v;
  }

  for (const k of NEST_WRAPPER_KEYS) {
    const v = data[k];
    if (v != null && typeof v === 'object') {
      const got = unwrapListingsPayload(v);
      if (got.length > 0) return got;
    }
  }

  const deep = findListingArrayDeep(data);
  if (deep && deep.length > 0) return deep;

  for (const k of LIST_PAYLOAD_ARRAY_KEYS) {
    const v = data[k];
    if (Array.isArray(v) && v.length === 0) return [];
  }

  return [];
}

export function unwrapOneListing(data) {
  if (!data || typeof data !== 'object') return data;
  if (data.listing && typeof data.listing === 'object') return data.listing;
  if (data.items && Array.isArray(data.items) && data.items.length === 1)
    return data.items[0];
  if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
    const inner = data.data;
    if (inner.listing && typeof inner.listing === 'object') return inner.listing;
    if (inner.item && typeof inner.item === 'object') return inner.item;
    if (inner.result && typeof inner.result === 'object') return inner.result;
    return inner;
  }
  return data;
}
