/**
 * Persistent JSON-file backed store for dev / local pairing with BidifyMobile.
 *
 * Why persistent: in-memory stores lose all users + listings on every restart,
 * which makes "my email is not registered" failures the moment the API is
 * touched. We now read on boot from `server/data/store.json` and atomically
 * write back on every mutation via a 250 ms debounced flush.
 *
 * To start fresh, delete `server/data/store.json` (or set `STORE_RESET=1`).
 *
 * For production you can swap `readFromDisk` / `scheduleWrite` for your
 * database (e.g. Supabase) — route handlers stay the same shape.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

const DEFAULTS = {
  users: [],
  listings: [],
  paymentLog: [],
  conversations: [],
  messages: [],
  wallets: {}, // userId -> { balance, transactions: [] }
  passwordOtps: {}, // email -> { code, expiresAt, attempts, resetToken?, resetTokenExpiresAt? }
  nextUserId: 1,
  nextListingId: 100,
  nextConversationId: 1,
  nextMessageId: 1,
  nextWalletTxId: 1,
};

function loadFromDisk() {
  try {
    if (process.env.STORE_RESET === '1') {
      console.log('[store] STORE_RESET=1 — starting with empty store.');
      return { ...DEFAULTS, ...emptyCollections() };
    }
    if (!fs.existsSync(STORE_FILE)) return { ...DEFAULTS, ...emptyCollections() };
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    if (!raw.trim()) return { ...DEFAULTS, ...emptyCollections() };
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULTS, ...emptyCollections(), ...parsed };
    console.log(
      `[store] loaded from ${STORE_FILE} (users: ${merged.users.length}, listings: ${merged.listings.length})`
    );
    return merged;
  } catch (e) {
    console.warn('[store] failed to load store.json — starting fresh:', e.message);
    return { ...DEFAULTS, ...emptyCollections() };
  }
}

/** Fresh references so we never share arrays/maps with `DEFAULTS`. */
function emptyCollections() {
  return {
    users: [],
    listings: [],
    paymentLog: [],
    conversations: [],
    messages: [],
    wallets: {},
    passwordOtps: {},
  };
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const store = loadFromDisk();

/** Atomic, debounced disk flush so we don't fsync on every mutation. */
let flushTimer = null;
let lastWriteOK = true;
let lastBackupHour = -1;

/**
 * Keep a rolling hourly backup so any external script that corrupts
 * store.json (e.g. a buggy PowerShell test) can be rolled back without
 * data loss.
 */
function maybeWriteBackup() {
  try {
    const now = new Date();
    const hour = now.getUTCHours();
    if (hour === lastBackupHour) return;
    lastBackupHour = hour;
    const backupDir = path.join(DATA_DIR, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const name = `store-${now.toISOString().slice(0, 13).replace(/[-:T]/g, '')}.json`;
    fs.copyFileSync(STORE_FILE, path.join(backupDir, name));
    // prune: keep last 24
    const all = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith('store-'))
      .sort();
    while (all.length > 24) {
      const old = all.shift();
      try { fs.unlinkSync(path.join(backupDir, old)); } catch (_) { /* ignore */ }
    }
  } catch (_) {
    /* backups are best-effort; never break the main flow */
  }
}

function scheduleWrite() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      const tmp = `${STORE_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
      fs.renameSync(tmp, STORE_FILE);
      lastWriteOK = true;
      maybeWriteBackup();
    } catch (e) {
      if (lastWriteOK) console.warn('[store] flush failed:', e.message);
      lastWriteOK = false;
    }
  }, 250);
}

// Wrap mutating array/object methods so callers can write `store.users.push(u)`
// without thinking about persistence.
function wrapArrayMutators(arr) {
  if (!arr || arr.__wrapped) return arr;
  for (const m of ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse']) {
    const orig = arr[m].bind(arr);
    arr[m] = (...args) => {
      const r = orig(...args);
      scheduleWrite();
      return r;
    };
  }
  Object.defineProperty(arr, '__wrapped', { value: true, enumerable: false });
  return arr;
}
['users', 'listings', 'paymentLog', 'conversations', 'messages'].forEach((k) =>
  wrapArrayMutators(store[k])
);

/** Public: call after mutating wallets / passwordOtps / `nextXxxId` etc. */
function persist() {
  scheduleWrite();
}

// No welcome bonus — every new wallet starts at zero.
// Users must top up via the wallet flow (Stripe / EasyPaisa / JazzCash).
const STARTING_WALLET_BALANCE = 0;

function getOrCreateWallet(userId) {
  const key = String(userId);
  if (!store.wallets[key]) {
    store.wallets[key] = {
      balance: STARTING_WALLET_BALANCE,
      transactions: [],
    };
    persist();
  }
  return store.wallets[key];
}

/**
 * One-time migration: strip any legacy `signup_bonus` transactions from
 * existing wallets and reduce the balance by the same amount (clamped at 0).
 * Idempotent — running again does nothing because the rows are already gone.
 */
function stripLegacyWelcomeBonus() {
  let changed = false;
  for (const key of Object.keys(store.wallets || {})) {
    const w = store.wallets[key];
    if (!w || !Array.isArray(w.transactions)) continue;
    const bonusTxs = w.transactions.filter((t) => t && t.kind === 'signup_bonus');
    if (bonusTxs.length === 0) continue;
    const bonusTotal = bonusTxs.reduce(
      (sum, t) => sum + Math.abs(Number(t.amount) || 0),
      0
    );
    w.transactions = w.transactions.filter((t) => t && t.kind !== 'signup_bonus');
    w.balance = Math.max(0, Number(w.balance || 0) - bonusTotal);
    changed = true;
  }
  if (changed) persist();
}

/**
 * Hard one-shot reset: zero every existing wallet's balance and clear its
 * transaction history. Runs ONCE — guarded by `store.flags.walletsResetAt`.
 * After that flag is set, this function returns immediately even if balances
 * grow again (which they will, from real top-ups). This means future top-ups
 * via Stripe / EasyPaisa / JazzCash are preserved forever.
 *
 * The wallet system stays fully intact — only the existing pre-reset balances
 * are wiped.
 */
function resetAllWalletsOnce() {
  if (!store.flags) store.flags = {};
  if (store.flags.walletsResetAt) return; // already done — never touch wallets again
  for (const key of Object.keys(store.wallets || {})) {
    const w = store.wallets[key];
    if (!w) continue;
    w.balance = 0;
    w.transactions = [];
  }
  store.flags.walletsResetAt = new Date().toISOString();
  persist();
}

function recordWalletTx(userId, entry) {
  const wallet = getOrCreateWallet(userId);
  const sign = entry.kind === 'token_paid' || entry.kind === 'win_hold' ? -1 : 1;
  wallet.balance = Math.max(0, wallet.balance + sign * Math.abs(Number(entry.amount) || 0));
  const tx = {
    id: String(store.nextWalletTxId++),
    createdAt: new Date().toISOString(),
    balanceAfter: wallet.balance,
    ...entry,
    amount: Math.abs(Number(entry.amount) || 0),
  };
  wallet.transactions.unshift(tx);
  if (wallet.transactions.length > 200) wallet.transactions.length = 200;
  persist();
  return { wallet, tx };
}

function seedIfEmpty() {
  // Always make sure an admin account exists so the operator never gets
  // locked out after a fresh `STORE_RESET=1` boot. Default credentials are
  // intentionally simple for dev — change them via the wallet UI / change-password
  // flow before any deployment.
  seedAdminAccountIfMissing();

  // Wipe legacy welcome-bonus credits from any wallet that was created before
  // we removed the bonus. Idempotent — safe to run on every boot.
  stripLegacyWelcomeBonus();

  // Operator-requested clean slate: zero every existing wallet exactly once.
  // After it runs, future top-ups are preserved forever (flag in store.flags).
  resetAllWalletsOnce();

  if (store.listings.length > 0) return;

  const endTime = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  store.listings.push({
    id: '1',
    title: 'Vintage Rolex Submariner (seed)',
    description: 'Sample approved listing from API seed.',
    price: 1000000,
    type: 'auction',
    currentBid: 1000000,
    sellerId: 'seed-seller',
    moderationStatus: 'approved',
    status: 'active',
    endTime,
    image: 'https://images.unsplash.com/photo-1523170335258-f5ed11844a49?auto=format&fit=crop&w=800&q=80',
    images: [
      'https://images.unsplash.com/photo-1523170335258-f5ed11844a49?auto=format&fit=crop&w=800&q=80',
    ],
    createdAt: new Date().toISOString(),
  });

  store.listings.push({
    id: '2',
    title: 'Antique Persian Rug (seed)',
    description:
      'Hand-knotted Persian rug, approx. 8x10 ft. Sample buy-now listing from API seed.',
    price: 85000,
    buyNowPrice: 85000,
    type: 'buynow',
    category: 'Antiques',
    sellerId: 'seed-seller',
    moderationStatus: 'approved',
    status: 'active',
    image: 'https://images.unsplash.com/photo-1600166898405-da9535204843?auto=format&fit=crop&w=800&q=80',
    images: [
      'https://images.unsplash.com/photo-1600166898405-da9535204843?auto=format&fit=crop&w=800&q=80',
    ],
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  });
  persist();
}

function seedAdminAccountIfMissing() {
  const adminEmail = 'admin@bidify.com';
  if (store.users.some((u) => u.email && u.email.toLowerCase() === adminEmail)) return;
  // bcrypt hash for "admin1234" (cost=10). Pre-computed so we don't need to
  // require bcrypt synchronously inside the store module.
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync('admin1234', 10);
  store.users.push({
    id: String(store.nextUserId++),
    email: adminEmail,
    passwordHash: hash,
    fullName: 'Bidify Admin',
    role: 'admin',
  });
  console.log('[store] seeded admin account: admin@bidify.com / admin1234');
  persist();
}

// Flush any pending writes when the process is asked to stop.
function gracefulShutdown() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (e) {
    console.warn('[store] shutdown flush failed:', e.message);
  }
}
process.on('SIGINT', () => {
  gracefulShutdown();
  process.exit(0);
});
process.on('SIGTERM', () => {
  gracefulShutdown();
  process.exit(0);
});
process.on('beforeExit', gracefulShutdown);

module.exports = {
  store,
  seedIfEmpty,
  getOrCreateWallet,
  recordWalletTx,
  persist,
  STARTING_WALLET_BALANCE,
  STORE_FILE,
};
