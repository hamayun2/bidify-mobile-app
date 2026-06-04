/**
 * Upload seed images → Supabase Storage (listing_images) → insert approved listings.
 *
 * Usage (from project root):
 *   node scripts/seed-demo-listings.mjs
 *
 * Required in .env (root):
 *   EXPO_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   (Dashboard → Settings → API → service_role)
 *   EXPO_PUBLIC_SUPABASE_ANON_KEY (optional fallback for profile lookup)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === '') process.env[key] = val;
  }
}

loadEnvFile(path.join(ROOT, '.env'));
loadEnvFile(path.join(ROOT, 'server', '.env'));

const BUCKET = 'listing_images';
const ADMIN_EMAIL = 'admin@bidify.com';
const ADMIN_PASSWORD = process.env.EXPO_PUBLIC_BUILTIN_ADMIN_PASSWORD || 'admin1234';

/** Legacy Cursor workspace copies (optional fallback). */
const CURSOR_ASSETS = path.join(
  'C:',
  'Users',
  'hamay',
  '.cursor',
  'projects',
  'd-BidifyMobile',
  'assets'
);

const DEFAULT_AUCTION_IMAGE = path.join(
  CURSOR_ASSETS,
  'c__Users_hamay_AppData_Roaming_Cursor_User_workspaceStorage_7eaa7536a68b06382df930e5d0e3577a_images_Screenshot_2025-09-30_120040-836516eb-cf3e-46dc-93aa-803cac919219.png'
);
const DEFAULT_STANDARD_IMAGE = path.join(
  CURSOR_ASSETS,
  'c__Users_hamay_AppData_Roaming_Cursor_User_workspaceStorage_7eaa7536a68b06382df930e5d0e3577a_images_Screenshot__2_-b33514ab-17b3-4756-ab2c-87b9426adfc8.png'
);

function log(step, msg, extra) {
  const line = `[Bidify/Seed/${step}] ${msg}`;
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
}

function resolveImagePath(envVar, localName, defaultPath) {
  if (process.env[envVar] && fs.existsSync(process.env[envVar])) {
    return process.env[envVar];
  }
  const local = path.join(ROOT, 'assets', 'seed', localName);
  if (fs.existsSync(local)) {
    log('ImageUpload', `Using bundled seed file: ${local}`);
    return local;
  }
  if (fs.existsSync(defaultPath)) {
    log('ImageUpload', `Using fallback path: ${defaultPath}`);
    return defaultPath;
  }
  return null;
}

function readAppJsonUrl() {
  try {
    const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
    return app?.expo?.extra?.supabaseUrl?.trim() || '';
  } catch {
    return '';
  }
}

async function uploadListingImage(supabase, sellerId, localPath, objectName) {
  const buf = fs.readFileSync(localPath);
  const ext = path.extname(localPath).toLowerCase() || '.png';
  const contentType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const storagePath = `seed/${sellerId}/${objectName}${ext}`;

  log('ImageUpload', `Uploading ${path.basename(localPath)} → ${BUCKET}/${storagePath}`, {
    bytes: buf.length,
  });

  const { error } = await supabase.storage.from(BUCKET).upload(storagePath, buf, {
    contentType,
    upsert: true,
  });
  if (error) {
    console.error('[Bidify/Seed/ImageUpload] FAILED', error);
    throw new Error(error.message || 'Storage upload failed');
  }

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  const publicUrl = pub?.publicUrl;
  if (!publicUrl) throw new Error('Could not resolve public URL after upload');
  log('ImageUpload', 'OK — public URL', publicUrl);
  return publicUrl;
}

async function ensureAdminUserId(supabase) {
  log('DB', `Ensure admin ${ADMIN_EMAIL}`);
  const { data, error } = await supabase.auth.admin.listUsers({ perPage: 200 });
  if (error) {
    console.error('[Bidify/Seed/DB] auth.admin.listUsers FAILED', error);
    throw error;
  }
  let user = data?.users?.find((u) => String(u.email || '').toLowerCase() === ADMIN_EMAIL);
  if (!user?.id) {
    log('DB', 'Creating admin auth user');
    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: 'Bidify Admin' },
    });
    if (createErr) {
      console.error('[Bidify/Seed/DB] auth.admin.createUser FAILED', createErr);
      throw createErr;
    }
    user = created.user;
    log('DB', 'Admin user created', user.id);
  } else {
    log('DB', 'Admin user exists', user.id);
  }
  const { error: rpcErr } = await supabase.rpc('promote_builtin_admin', {
    p_email: ADMIN_EMAIL,
    p_user_id: user.id,
  });
  if (rpcErr) console.warn('[Bidify/Seed/DB] promote_builtin_admin', rpcErr.message);
  return user.id;
}

async function detectListingsSchema(supabase) {
  const { error: cleanErr } = await supabase.from('listings').select('listing_type').limit(0);
  if (!cleanErr) return 'clean';
  const { error: legacyErr } = await supabase.from('listings').select('type').limit(0);
  if (!legacyErr) return 'legacy';
  throw new Error(
    'Could not detect listings schema (expected listing_type or type column). Run supabase/CLEAN_SLATE_SCHEMA.sql or supabase/schema.sql in the SQL Editor.'
  );
}

function buildListingRow(schema, { sellerId, title, description, price, listingType, category, imageUrl, endTime, currentBid }) {
  if (schema === 'clean') {
    const row = {
      seller_id: sellerId,
      title,
      description,
      price,
      listing_type: listingType,
      category,
      image_url: imageUrl,
      status: 'active',
    };
    if (listingType === 'auction') {
      row.current_bid = currentBid ?? price;
      row.auction_end_time = endTime;
    }
    return row;
  }

  const row = {
    seller_id: sellerId,
    title,
    description,
    price,
    type: listingType,
    category,
    image_urls: [imageUrl],
    moderation_status: 'approved',
    seller_name: 'Bidify Admin',
    user_email: ADMIN_EMAIL,
    username: 'bidify_admin',
    approved_at: new Date().toISOString(),
  };
  if (listingType === 'auction') {
    row.current_bid = currentBid ?? price;
    row.end_time = endTime;
    row.duration_days = 7;
    row.buy_now_price = Math.round(price * 2.5);
  } else {
    row.buy_now_price = price;
  }
  return row;
}

async function upsertListing(supabase, row) {
  const typeLabel = row.listing_type ?? row.type;
  log('DB', `Upsert listing: ${row.title}`, {
    listing_type: typeLabel,
    category: row.category,
  });

  const { data: existing } = await supabase
    .from('listings')
    .select('id')
    .eq('title', row.title)
    .maybeSingle();

  if (existing?.id) {
    const { data, error } = await supabase
      .from('listings')
      .update({ ...row, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select('*')
      .single();
    if (error) {
      console.error('[Bidify/Seed/DB] update FAILED', error);
      throw error;
    }
    log('DB', 'Updated existing listing', data.id);
    return data;
  }

  const { data, error } = await supabase.from('listings').insert(row).select('*').single();
  if (error) {
    console.error('[Bidify/Seed/DB] insert FAILED', error);
    throw error;
  }
  log('DB', 'Inserted listing', data.id);
  return data;
}

async function main() {
  console.log('\n========== Bidify demo seed ==========\n');

  const supabaseUrl =
    process.env.EXPO_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    readAppJsonUrl();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl) {
    console.error('[Bidify/Seed] Missing EXPO_PUBLIC_SUPABASE_URL in .env');
    process.exit(1);
  }
  const sk = String(serviceKey || '').trim();
  const keyOk = sk.startsWith('eyJ') || sk.startsWith('sb_secret_');
  if (!sk || sk.includes('YOUR_') || !keyOk) {
    console.error(
      '[Bidify/Seed] Missing or invalid SUPABASE_SERVICE_ROLE_KEY in root .env\n' +
        '  Dashboard → Settings → API → service_role secret (eyJ… or sb_secret_…)'
    );
    process.exit(1);
  }

  log('StripeInit', 'Checking server Stripe env (run API separately)');
  const stripeSk = process.env.STRIPE_TEST_SECRET_KEY || '';
  const pk =
    process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ||
    process.env.STRIPE_TEST_PUBLISHABLE_KEY ||
    '';
  log('StripeInit', `Secret key: ${stripeSk.startsWith('sk_test_') ? 'sk_test_… OK' : 'MISSING or invalid'}`);
  log('StripeInit', `Publishable: ${pk.startsWith('pk_test_') ? 'pk_test_… OK' : 'MISSING or invalid'}`);

  const auctionPath = resolveImagePath(
    'SEED_AUCTION_IMAGE',
    'auction-image.png',
    DEFAULT_AUCTION_IMAGE
  );
  const standardPath = resolveImagePath(
    'SEED_STANDARD_IMAGE',
    'standard-image.png',
    DEFAULT_STANDARD_IMAGE
  );

  if (!auctionPath || !standardPath) {
    console.error('[Bidify/Seed] Image files not found.');
    console.error('  Auction:', auctionPath || '(missing)');
    console.error('  Standard:', standardPath || '(missing)');
    process.exit(1);
  }

  log('Setup', 'Supabase URL', supabaseUrl);
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const sellerId = await ensureAdminUserId(supabase);
  const listingsSchema = await detectListingsSchema(supabase);
  log('Setup', `Listings schema: ${listingsSchema}`);

  const auctionUrl = await uploadListingImage(
    supabase,
    sellerId,
    auctionPath,
    'demo-auction-gantt'
  );
  const standardUrl = await uploadListingImage(
    supabase,
    sellerId,
    standardPath,
    'demo-standard-screenshot'
  );

  const endTime = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  await upsertListing(
    supabase,
    buildListingRow(listingsSchema, {
      sellerId,
      title: 'Project Schedule Gantt Chart — Live Auction',
      description:
        'Gantt roadmap (Oct 2025 – May 2026). Live auction — bid before the timer ends.',
      price: 85000,
      listingType: 'auction',
      category: 'Arts',
      imageUrl: auctionUrl,
      endTime,
      currentBid: 85000,
    })
  );

  await upsertListing(
    supabase,
    buildListingRow(listingsSchema, {
      sellerId,
      title: 'UI / Streaming Layout Reference — Buy Now',
      description: 'Fixed-price standard listing. Chat with seller — no bidding.',
      price: 12000,
      listingType: 'standard',
      category: 'Arts',
      imageUrl: standardUrl,
    })
  );

  await supabase.rpc('promote_builtin_admin', { p_email: ADMIN_EMAIL, p_user_id: sellerId });

  console.log('\n========== Seed complete ==========');
  console.log('Auction image:', auctionUrl);
  console.log('Standard image:', standardUrl);
  console.log('Restart Expo and open Home — use chips: Auction, Standard, or Arts.\n');
}

main().catch((e) => {
  console.error('[Bidify/Seed] FATAL', e?.message || e);
  process.exit(1);
});
