const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const {
  supabaseRpc,
  isSupabaseWalletSyncConfigured,
  isUuid,
} = require('../supabaseWallet');

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  '';
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

const STORAGE_BUCKETS = ['cnic_images', 'listing_images'];

function getServiceClient() {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  return createClient(String(SUPABASE_URL).replace(/\/$/, ''), SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function getAnonClient() {
  if (!SUPABASE_URL || !ANON_KEY) return null;
  return createClient(String(SUPABASE_URL).replace(/\/$/, ''), ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function resolveUserFromBearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return { user: null, error: 'Missing Authorization bearer token.' };

  const token = m[1].trim();
  const anon = getAnonClient();
  if (!anon) return { user: null, error: 'Supabase anon key not configured on server.' };

  const { data, error } = await anon.auth.getUser(token);
  if (error || !data?.user?.id) {
    return { user: null, error: error?.message || 'Invalid or expired session.' };
  }
  return { user: data.user, accessToken: token };
}

async function listStoragePaths(admin, bucket, prefix) {
  const paths = [];
  const { data, error } = await admin.storage.from(bucket).list(prefix, { limit: 200 });
  if (error || !Array.isArray(data)) return paths;

  for (const item of data) {
    const name = item?.name;
    if (!name) continue;
    const full = prefix ? `${prefix}/${name}` : name;
    if (item.id == null && !name.includes('.')) {
      const nested = await listStoragePaths(admin, bucket, full);
      paths.push(...nested);
    } else {
      paths.push(full);
    }
  }
  return paths;
}

async function deleteUserStorage(admin, userId) {
  const uid = String(userId);
  let removed = 0;

  for (const bucket of STORAGE_BUCKETS) {
    const paths = await listStoragePaths(admin, bucket, uid);
    if (paths.length === 0) continue;

    const chunkSize = 50;
    for (let i = 0; i < paths.length; i += chunkSize) {
      const chunk = paths.slice(i, i + chunkSize);
      const { error } = await admin.storage.from(bucket).remove(chunk);
      if (error) {
        console.warn(`[account/delete] storage remove ${bucket}`, error.message);
      } else {
        removed += chunk.length;
      }
    }
  }

  const { data: supportObjs } = await admin.storage.from('listing_images').list('support-tickets', {
    limit: 200,
  });
  if (Array.isArray(supportObjs)) {
    for (const folder of supportObjs) {
      if (!folder?.name?.includes(uid)) continue;
      const subPaths = await listStoragePaths(admin, 'listing_images', `support-tickets/${folder.name}`);
      if (subPaths.length) {
        await admin.storage.from('listing_images').remove(subPaths);
        removed += subPaths.length;
      }
    }
  }

  return removed;
}

/**
 * POST /api/account/delete
 * Requires: Authorization: Bearer <supabase_access_token>
 * Deletes storage, database rows (RPC), and auth user (admin API).
 */
async function handleAccountDelete(req, res) {
  console.log('Incoming request to delete user:', {
    body: req.body || {},
    params: req.params || {},
    hasAuthHeader: Boolean(req.headers.authorization),
  });

  if (!isSupabaseWalletSyncConfigured()) {
    return res.status(503).json({
      ok: false,
      message: 'Account deletion requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY on the API server.',
    });
  }

  const { user, error: authErr } = await resolveUserFromBearer(req);
  if (!user?.id) {
    return res.status(401).json({ ok: false, message: authErr || 'Unauthorized' });
  }

  const userId = String(user.id);
  if (!isUuid(userId)) {
    return res.status(400).json({ ok: false, message: 'Invalid user id.' });
  }

  console.log('[account/delete] start', { userId });

  try {
    const admin = getServiceClient();
    if (!admin) {
      return res.status(503).json({
        ok: false,
        message: 'Supabase service client unavailable. Check SUPABASE_SERVICE_ROLE_KEY.',
      });
    }

    const storageRemoved = await deleteUserStorage(admin, userId);

    let rpcResult = null;
    let rpcError = null;
    try {
      rpcResult = await supabaseRpc(
        'delete_my_account',
        { p_user_id: userId },
        { logTag: 'account/delete' }
      );
    } catch (rpcErr) {
      rpcError = rpcErr?.message || String(rpcErr);
      console.warn('[account/delete] delete_my_account RPC failed', rpcError);
    }

    const { error: delAuthErr } = await admin.auth.admin.deleteUser(userId);
    if (delAuthErr) {
      const msg = String(delAuthErr.message || '').toLowerCase();
      const alreadyGone = msg.includes('not found') || msg.includes('user not found');
      if (!alreadyGone) {
        console.error('[account/delete] auth.admin.deleteUser', delAuthErr.message);
        return res.status(500).json({
          ok: false,
          message: delAuthErr.message || 'Could not remove auth user.',
        });
      }
    }

    console.log('[account/delete] success', { userId, storageRemoved, rpcError: !!rpcError });

    return res.json({
      ok: true,
      userId,
      storageObjectsRemoved: storageRemoved,
      database: rpcResult,
      rpcWarning: rpcError || undefined,
      message: 'Account deleted successfully.',
    });
  } catch (e) {
    console.error('[account/delete]', e?.message || e);
    return res.status(500).json({
      ok: false,
      message: e?.message || 'Account deletion failed.',
    });
  }
}

router.post('/delete', handleAccountDelete);

module.exports = router;
module.exports.handleAccountDelete = handleAccountDelete;
