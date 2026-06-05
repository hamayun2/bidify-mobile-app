require('./loadEnv');

const path = require('path');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { store, seedIfEmpty, persist } = require('./store');
const authRouter = require('./routes/auth');
const listingsRouter = require('./routes/listings');
const chatRouter = require('./routes/chat');
const walletRouter = require('./routes/wallet');
const paymentsRouter = require('./routes/payments');
const auctionsRouter = require('./routes/auctions');
const escrowRouter = require('./routes/escrow');
const disputeRouter = require('./routes/dispute');
const otpRouter = require('./routes/otp');
const supportRouter = require('./routes/support');
const adminDisputesRouter = require('./routes/adminDisputes');
const accountRouter = require('./routes/account');
const { handleAccountDelete } = require('./routes/account');
const bidsRouter = require('./routes/bids');
const profileRouter = require('./routes/profile');
const usersRouter = require('./routes/users');
const registrationRouter = require('./routes/registration');
const supabaseAuthCallbackRouter = require('./routes/supabaseAuthCallback');
const { startAuctionResolverCron } = require('./auctionResolver');
const { startKycAutoVerifyCron } = require('./kycAutoVerifyCron');
const { isDeleteListingConfigured } = require('./services/deleteListing');
const { adminRequired, authRequired } = require('./authMiddleware');
const { serializeListing } = require('./listingHelpers');
const { isStripeTestConfigured } = require('./stripePayments');
const { isSupabaseWalletSyncConfigured } = require('./supabaseWallet');
const { isSupabaseWalletDataConfigured } = require('./services/supabaseWalletData');
const { stripeWebhookHttpHandler } = require('./stripeWebhookHttp');
const { getLanIpv4Addresses, warnIfApiPublicUrlMismatch } = require('./networkHost');

seedIfEmpty();

const app = express();
const PORT = Number(process.env.PORT) || 4000;
/** Bind all interfaces so phones/browsers on LAN can reach the API (not 127.0.0.1-only). */
const LISTEN_HOST = process.env.HOST || process.env.LISTEN_HOST || '0.0.0.0';

warnIfApiPublicUrlMismatch();

app.use(cors({ origin: true, credentials: true }));

// Stripe webhooks need raw body (must be registered BEFORE express.json()).
const webhookRaw = express.raw({ type: 'application/json' });
const WEBHOOK_PATHS = [
  '/api/payments/stripe/webhook', // ← use this with: stripe listen --forward-to localhost:4000/api/payments/stripe/webhook
  '/payments/stripe/webhook',
  '/api/webhook', // alias
];
WEBHOOK_PATHS.forEach((p) => app.post(p, webhookRaw, stripeWebhookHttpHandler));

app.use(express.json({ limit: '2mb' }));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

app.use('/api/auth', authRouter);
app.use('/auth', supabaseAuthCallbackRouter);
app.use('/api/listings', listingsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/wallet', walletRouter);
app.use('/api/escrow', escrowRouter);
app.use('/api/dispute', disputeRouter);
app.use('/api/otp', otpRouter);
app.use('/api/payments', paymentsRouter);
app.use('/payments', paymentsRouter);
app.use('/api/auctions', auctionsRouter);
app.use('/api/support', supportRouter);
app.use('/api/admin', adminDisputesRouter);
/** Account deletion — register explicit paths (must match client POST …/api/account/delete). */
app.post('/api/account/delete', handleAccountDelete);
app.post('/account/delete', handleAccountDelete);
app.use('/api/account', accountRouter);
app.use('/account', accountRouter);
app.use('/api/bids', bidsRouter);
app.use('/api/profile', profileRouter);
app.use('/api/users', usersRouter);
app.use('/users', usersRouter);
app.use('/api/registration', registrationRouter);

app.get('/api/admin/listings', adminRequired, (req, res) => {
  res.json({ listings: store.listings.map((l) => serializeListing(req, l)) });
});

const DEFAULT_REJECT_REASON =
  'Sorry, your product is not according to our guidelines.';

app.patch('/api/admin/listings/:id', adminRequired, (req, res) => {
  const row = store.listings.find((l) => String(l.id) === String(req.params.id));
  if (!row) return res.status(404).json({ message: 'Listing not found' });
  const ms = req.body?.moderationStatus || req.body?.status;
  if (ms === 'rejected' || ms === 'approved') {
    row.moderationStatus = ms;
    row.status = ms === 'approved' ? 'active' : 'rejected';
    if (ms === 'rejected') {
      const provided = req.body?.rejectionReason;
      const trimmed = typeof provided === 'string' ? provided.trim() : '';
      row.rejectionReason = trimmed || DEFAULT_REJECT_REASON;
      row.rejectedAt = new Date().toISOString();
      row.approvedAt = null;
    } else {
      row.rejectionReason = null;
      row.rejectedAt = null;
      row.approvedAt = new Date().toISOString();
    }
    persist();
  }
  res.json({ listing: serializeListing(req, row) });
});

app.get('/api/admin/payments', adminRequired, (req, res) => {
  res.json({ payments: store.paymentLog });
});

// GET /api/admin/users — registered profiles + CNIC media URLs.
// We strip the password hash but include every other field stored at registration
// time, so the admin panel can render a unified profile card.
app.get('/api/admin/users', adminRequired, (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  const toAbs = (u) => {
    if (!u) return null;
    if (/^https?:\/\//i.test(u)) return u;
    return u.startsWith('/') ? `${origin}${u}` : `${origin}/${u}`;
  };
  const users = (store.users || []).map((u) => ({
    id: u.id,
    email: u.email,
    fullName: u.fullName || null,
    phone: u.phone || null,
    cnic: u.cnic || null,
    role: u.role || 'user',
    cnicFrontUrl: toAbs(u.cnicFrontUrl),
    cnicBackUrl: toAbs(u.cnicBackUrl),
    cnicVerifiedAt: u.cnicVerifiedAt || null,
    createdAt: u.createdAt || null,
    walletBalance: Number(u.walletBalance || 0),
  }));
  res.json({ users });
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

/** Route manifest — use to confirm escrow / dispute / OTP are mounted (not 404). */
app.get('/api/health/routes', (_req, res) => {
  res.json({
    ok: true,
    entry: 'server/index.js',
    mounted: [
      '/api/wallet',
      '/api/escrow',
      '/api/dispute',
      '/api/otp',
      '/api/bids',
      '/api/admin (disputes settle)',
      '/api/support (ai-dispute-handler)',
    ],
    escrow: [
      'GET /bundle',
      'GET /ledger',
      'GET /orders',
      'POST /buy',
      'POST /orders/:orderId/verify-otp',
      'GET /orders/:orderId/reveal-otp',
      'POST /resolve/:listingId',
      'POST /resolve-expired',
    ],
    otp: ['POST /verify', 'POST /verify-delivery', 'GET /reveal/:orderId'],
    dispute: ['POST /raise', 'POST /:orderId/raise'],
  });
});

app.listen(PORT, LISTEN_HOST, () => {
  const stripeOk = isStripeTestConfigured();
  const pk =
    process.env.STRIPE_TEST_PUBLISHABLE_KEY ||
    process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ||
    '';
  console.log(`Bidify API listening on http://${LISTEN_HOST}:${PORT} (all interfaces)`);
  console.log(`[network] Local:  http://127.0.0.1:${PORT}/api/health`);
  const lan = getLanIpv4Addresses();
  if (lan.length) {
    lan.forEach(({ ip, name }) => {
      console.log(`[network] LAN (${name}): http://${ip}:${PORT}/api/health`);
    });
  } else {
    console.warn('[network] No LAN IPv4 detected — mobile devices may not reach this API.');
  }
  console.log(`[routes] POST /api/account/delete (account deletion)`);
  console.log(
    stripeOk
      ? '[payments] Stripe TEST mode enabled (STRIPE_TEST_SECRET_KEY set)'
      : '[payments] Stripe TEST key missing — wallet Stripe uses instant sandbox until you set STRIPE_TEST_SECRET_KEY in server/.env'
  );
  console.log(
    `[payments] Stripe publishable: ${
      pk.startsWith('pk_test_') ? `${pk.slice(0, 14)}… (OK for Payment Sheet)` : 'not set'
    }`
  );
  console.log(`[payments] API_PUBLIC_URL=${process.env.API_PUBLIC_URL || '(auto from request host)'}`);
  console.log(
    isSupabaseWalletSyncConfigured()
      ? '[supabaseWallet] Supabase profile wallet sync ENABLED'
      : '[supabaseWallet] MISSING — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in root or server/.env'
  );
  console.log(
    isSupabaseWalletDataConfigured()
      ? '[escrow] /api/escrow — buy, orders, verify-otp, reveal-otp, bundle, ledger, resolve'
      : '[escrow] /api/escrow — workflow routes mounted; wallet reads need service role'
  );
  console.log('[dispute] /api/dispute — POST /raise, /:orderId/raise (mounted)');
  console.log('[otp] /api/otp — POST /verify, GET /reveal/:orderId (mounted)');
  console.log('[routes] Manifest: GET /api/health/routes');
  console.log(
    `[listings DELETE] supabaseDeleteConfigured: ${isDeleteListingConfigured()}`
  );
  console.log(
    process.env.STRIPE_WEBHOOK_SECRET
      ? '[stripe] Webhook secret loaded (whsec_…)'
      : '[stripe] STRIPE_WEBHOOK_SECRET missing — run npm run stripe:listen and copy whsec_ to .env'
  );
  console.log('[stripe] Webhook URL: POST http://127.0.0.1:' + PORT + '/api/payments/stripe/webhook');
  console.log('');
  console.log('>>> Starting auction resolver cron (npm run api terminal) <<<');
  startAuctionResolverCron();
  startKycAutoVerifyCron();
});
