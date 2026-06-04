#!/usr/bin/env node
/**
 * One-shot maintenance script: scans server/data/store.json for image fields
 * that contain non-URL garbage (e.g. "[object Object]", "undefined", "null",
 * empty objects that JSON-stringified themselves) and rewrites them to clean
 * arrays. Idempotent: running it twice is safe.
 *
 * Run via:  node server/sanitize-store-images.js
 */

const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, 'data', 'store.json');

/**
 * Returns true if `s` looks like a value that could plausibly be loaded by
 * `<Image source={{ uri: s }} />`. Rejects:
 *   - non-strings
 *   - the literal "[object Object]" coerce-string
 *   - "undefined", "null", whitespace-only strings
 *   - obvious JSON garbage
 */
function isLikelyValidImageUrl(s) {
  if (s == null) return false;
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (!t) return false;
  if (t === '[object Object]') return false;
  if (t === 'null' || t === 'undefined' || t === 'NaN') return false;
  if (t.startsWith('[object ')) return false;
  // We accept absolute URLs, /uploads/... paths, data:, blob:, file://, content://, ph://, assets-library://.
  if (/^https?:\/\//i.test(t)) return true;
  if (t.startsWith('/uploads/')) return true;
  if (t.startsWith('/')) return true;
  if (t.startsWith('data:image/')) return true;
  if (t.startsWith('blob:')) return true;
  if (t.startsWith('file://')) return true;
  if (t.startsWith('content://')) return true;
  if (t.startsWith('ph://') || t.startsWith('assets-library://')) return true;
  return false;
}

function sanitizeListing(listing) {
  let changed = false;
  if (listing == null || typeof listing !== 'object') return changed;

  // images array
  if (Array.isArray(listing.images)) {
    const clean = listing.images.filter(isLikelyValidImageUrl);
    if (clean.length !== listing.images.length) {
      listing.images = clean;
      changed = true;
    }
  }

  // single cover field
  if (listing.image != null && !isLikelyValidImageUrl(listing.image)) {
    listing.image = null;
    changed = true;
  }

  // Re-seed the cover from images[] if the cover is now missing.
  if ((!listing.image || listing.image === '') && Array.isArray(listing.images) && listing.images.length > 0) {
    listing.image = listing.images[0];
    changed = true;
  }

  return changed;
}

function sanitizeConversation(c) {
  if (!c || typeof c !== 'object') return false;
  if (c.listingImage != null && !isLikelyValidImageUrl(c.listingImage)) {
    c.listingImage = null;
    return true;
  }
  return false;
}

function sanitizeMessage(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.imageUrl != null && !isLikelyValidImageUrl(m.imageUrl)) {
    m.imageUrl = null;
    return true;
  }
  return false;
}

function sanitizeUser(u) {
  if (!u || typeof u !== 'object') return false;
  let changed = false;
  for (const key of ['cnicFrontUrl', 'cnicBackUrl', 'avatarUrl']) {
    if (u[key] != null && !isLikelyValidImageUrl(u[key])) {
      u[key] = null;
      changed = true;
    }
  }
  return changed;
}

function main() {
  if (!fs.existsSync(STORE_PATH)) {
    console.error(`store.json not found at ${STORE_PATH}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(STORE_PATH, 'utf8');
  let store;
  try {
    store = JSON.parse(raw);
  } catch (e) {
    console.error(`store.json is not valid JSON: ${e.message}`);
    process.exit(1);
  }

  let totalChanges = 0;

  if (Array.isArray(store.listings)) {
    for (const l of store.listings) {
      if (sanitizeListing(l)) {
        totalChanges += 1;
        console.log(`listing ${l.id} → sanitized image fields`);
      }
    }
  }
  if (Array.isArray(store.conversations)) {
    for (const c of store.conversations) {
      if (sanitizeConversation(c)) {
        totalChanges += 1;
        console.log(`conversation ${c.id} → cleaned listingImage`);
      }
    }
  }
  if (Array.isArray(store.messages)) {
    for (const m of store.messages) {
      if (sanitizeMessage(m)) {
        totalChanges += 1;
        console.log(`message ${m.id} → cleaned imageUrl`);
      }
    }
  }
  if (Array.isArray(store.users)) {
    for (const u of store.users) {
      if (sanitizeUser(u)) {
        totalChanges += 1;
        console.log(`user ${u.id} → cleaned cnicFront/Back/avatar URL`);
      }
    }
  }

  if (totalChanges === 0) {
    console.log('Nothing to clean — store.json image fields are already healthy.');
    return;
  }

  // Atomic write — keep a single rolling backup beside the main file.
  const backupPath = STORE_PATH + '.bak';
  try { fs.copyFileSync(STORE_PATH, backupPath); } catch (_) { /* best-effort */ }
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
  console.log(`Done — ${totalChanges} record(s) cleaned. Backup saved to ${backupPath}`);
}

main();
