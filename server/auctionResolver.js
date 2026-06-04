const {
  supabaseRpc,
  isSupabaseWalletSyncConfigured,
  getSupabaseKeyDiagnostics,
} = require('./supabaseWallet');

const INTERVAL_MS = Number(process.env.AUCTION_RESOLVER_INTERVAL_MS) || 60_000;
const BATCH_LIMIT = Number(process.env.AUCTION_RESOLVER_BATCH_LIMIT) || 50;

let timer = null;
let tickCount = 0;

async function resolveExpiredTick() {
  tickCount += 1;
  const tickNum = tickCount;
  const startedAt = new Date().toISOString();

  console.log('');
  console.log(`CRON TICK #${tickNum} @ ${startedAt}: Checking for expired auctions...`);

  if (!isSupabaseWalletSyncConfigured()) {
    const diag = getSupabaseKeyDiagnostics();
    console.log('RESOLUTION RESULT: ', { data: null, error: 'Supabase service role not configured' });
    console.error('[auctionResolver] FIX: set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in root .env or server/.env');
    console.error('[auctionResolver] key diagnostics:', diag);
    return null;
  }

  const diag = getSupabaseKeyDiagnostics();
  if (diag.usingAnonByMistake) {
    console.log('RESOLUTION RESULT: ', {
      data: null,
      error: 'SUPABASE_SERVICE_ROLE_KEY matches anon key — RPC will not resolve auctions',
    });
    console.error('[auctionResolver] Use Dashboard → Settings → API → service_role secret, not anon/publishable.');
    return null;
  }

  console.log('[auctionResolver] Supabase RPC auth:', diag);

  let data = null;
  let error = null;
  try {
    data = await supabaseRpc(
      'resolve_expired_auctions',
      { p_limit: BATCH_LIMIT },
      { logTag: 'auctionResolver' }
    );
    const count = Number(data?.resolved_count) || 0;
    console.log('RESOLUTION RESULT: ', { data, error: null });
    console.log(
      `[auctionResolver] tick #${tickNum} done — resolved_count=${count}, batch_limit=${BATCH_LIMIT}`
    );
    if (count > 0 && Array.isArray(data?.results)) {
      console.log('[auctionResolver] resolved listings:', JSON.stringify(data.results, null, 2));
    }
  } catch (e) {
    error = e?.message || String(e);
    console.log('RESOLUTION RESULT: ', { data: null, error });
    console.error(`[auctionResolver] tick #${tickNum} FAILED:`, e);
  }

  return data;
}

function startAuctionResolverCron() {
  if (timer) {
    console.warn('[auctionResolver] cron already running — skip duplicate start');
    return;
  }

  console.log('');
  console.log('============================================================');
  console.log('[auctionResolver] AUCTION CRON ACTIVE');
  console.log(`[auctionResolver] Watch THIS terminal for "CRON TICK" every ${Math.round(INTERVAL_MS / 1000)}s`);
  console.log(`[auctionResolver] Command: npm run api   (NOT the Expo terminal)`);
  console.log('[auctionResolver] startup diagnostics:', getSupabaseKeyDiagnostics());
  console.log('============================================================');
  console.log('');

  void resolveExpiredTick();
  timer = setInterval(() => {
    void resolveExpiredTick();
  }, INTERVAL_MS);
}

function stopAuctionResolverCron() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    tickCount = 0;
    console.log('[auctionResolver] cron stopped');
  }
}

module.exports = {
  startAuctionResolverCron,
  stopAuctionResolverCron,
  resolveExpiredTick,
};
