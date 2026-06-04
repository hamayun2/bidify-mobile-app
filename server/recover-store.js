/**
 * One-shot recovery script for server/data/store.json.
 *
 * Rebuilds the user accounts that were lost when a PowerShell-based test
 * round-tripped the store through ConvertTo-Json and truncated it. Reuses
 * the CNIC images that survived on disk in server/uploads/cnic/.
 *
 * Run:   node server/recover-store.js
 *
 * Effect:
 *   - Keeps the existing admin and seed listings.
 *   - Re-adds the real accounts (hamayun, shani, baba) plus the synthetic
 *     test accounts that had CNIC uploads (cnic_test, cnic_profile, zerotest).
 *   - Sets every restored account's password to a known string so the user
 *     can log back in; they can change it via Forgot Password afterwards.
 *   - Leaves wallet balances at 0 (matches the operator's request) and keeps
 *     the `walletsResetAt` flag so the one-shot reset will not run again.
 */
const fs = require('fs');
const path = require('path');
const bcrypt = require('./node_modules/bcryptjs');

const STORE = path.join(__dirname, 'data', 'store.json');
const TEMP_PASSWORD = 'Recover1234';

const recovered = [
  // id 4 — the operator's real Gmail account (no CNIC uploaded)
  {
    id: '4',
    email: 'hamayunawan2003@gmail.com',
    fullName: 'hamayun awan',
    role: 'user',
  },
  // id 5 — synthetic CNIC test
  {
    id: '5',
    email: 'cnic_test_890197@example.com',
    fullName: 'CNIC Test User',
    role: 'user',
    phone: '03001234567',
    cnic: '1234567890142',
    cnicFrontUrl: '/uploads/cnic/1778505284686-mxr7ma-front.jpg',
    cnicBackUrl: '/uploads/cnic/1778505284687-ab73xz-back.jpg',
    cnicVerifiedAt: '2026-05-11T13:14:44.894Z',
  },
  // id 6 — synthetic profile-verify
  {
    id: '6',
    email: 'cnic_profile_713694@example.com',
    fullName: 'Profile Verify User',
    role: 'user',
    phone: '03331122334',
    cnic: '1212121212199',
    cnicFrontUrl: '/uploads/cnic/1778506688394-j4eluq-profile-front.jpg',
    cnicBackUrl: '/uploads/cnic/1778506688395-uh9t81-profile-back.jpg',
    cnicVerifiedAt: '2026-05-11T13:38:08.502Z',
  },
  // id 7 — REAL: shani
  {
    id: '7',
    email: 'shani@gmail.com',
    fullName: 'shani',
    role: 'user',
    phone: '03006957440',
    cnic: '3650123031256',
    cnicFrontUrl: '/uploads/cnic/1778509931370-5fnv92-cnicFront.png',
    cnicBackUrl: '/uploads/cnic/1778509931383-mhff5n-cnicBack.png',
    cnicVerifiedAt: '2026-05-11T14:32:11.506Z',
  },
  // id 8 — REAL: baba
  {
    id: '8',
    email: 'baba@gmail.com',
    fullName: 'baba',
    role: 'user',
    phone: '03006957440',
    cnic: '3650123031257',
    cnicFrontUrl: '/uploads/cnic/1778521771379-7qb6pk-cnicFront.png',
    cnicBackUrl: '/uploads/cnic/1778521771381-bb00vc-cnicBack.png',
    cnicVerifiedAt: '2026-05-11T17:49:31.505Z',
  },
];

function main() {
  const raw = fs.readFileSync(STORE, 'utf8');
  const store = JSON.parse(raw);

  // Sanity guard: never wipe the admin
  if (!Array.isArray(store.users)) store.users = [];
  const admin = store.users.find((u) => u.role === 'admin' || u.email === 'admin@bidify.com');
  if (!admin) {
    throw new Error('Refusing to run — admin row missing from current store');
  }

  const hash = bcrypt.hashSync(TEMP_PASSWORD, 10);
  const existing = new Set(store.users.map((u) => String(u.email).toLowerCase()));

  let added = 0;
  for (const u of recovered) {
    if (existing.has(String(u.email).toLowerCase())) continue;
    store.users.push({
      ...u,
      passwordHash: hash,
      createdAt: new Date().toISOString(),
    });
    added += 1;
  }

  // Make sure nextUserId is at least one past the highest id we just restored.
  const maxId = store.users.reduce((m, u) => Math.max(m, Number(u.id) || 0), 0);
  store.nextUserId = Math.max(Number(store.nextUserId) || 0, maxId + 1);

  // Wallets stay empty / zero — matches the operator's wishes.
  if (!store.wallets) store.wallets = {};
  for (const u of store.users) {
    if (!store.wallets[u.id]) store.wallets[u.id] = { balance: 0, transactions: [] };
  }

  // Keep the one-shot wallet-reset flag so it never runs again.
  if (!store.flags) store.flags = {};
  if (!store.flags.walletsResetAt) {
    store.flags.walletsResetAt = new Date().toISOString();
  }

  const tmp = `${STORE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, STORE);

  console.log(`Recovery complete. Restored ${added} account(s). All passwords set to: ${TEMP_PASSWORD}`);
  console.log('Users now in store:');
  for (const u of store.users) {
    console.log(`  id=${u.id}  ${u.email}  role=${u.role}  cnic=${u.cnic || '-'}`);
  }
}

main();
