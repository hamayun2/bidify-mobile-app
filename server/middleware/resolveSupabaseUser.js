const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const { store } = require('../store');

const JWT_SECRET = process.env.JWT_SECRET || 'bidify-dev-change-me';
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

function getAnonClient() {
  if (!SUPABASE_URL || !ANON_KEY) return null;
  return createClient(String(SUPABASE_URL).replace(/\/$/, ''), ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function findExpressUserById(id) {
  return store.users.find((u) => String(u.id) === String(id));
}

/**
 * Resolve authenticated seller from Supabase JWT or legacy Express JWT.
 * Sets req.authUser = { id, email, accessToken? }
 */
async function resolveAuthenticatedUser(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const token = m[1].trim();

  const anon = getAnonClient();
  if (anon) {
    const { data, error } = await anon.auth.getUser(token);
    if (!error && data?.user?.id) {
      return {
        id: String(data.user.id),
        email: data.user.email || '',
        accessToken: token,
        source: 'supabase',
      };
    }
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const expressUser = findExpressUserById(payload.sub);
    if (expressUser) {
      const profileId =
        expressUser.supabaseUserId && String(expressUser.supabaseUserId).trim()
          ? String(expressUser.supabaseUserId)
          : String(expressUser.id);
      return {
        id: profileId,
        email: expressUser.email || '',
        accessToken: token,
        source: 'express',
        expressUserId: String(expressUser.id),
      };
    }
  } catch {
    /* not express jwt */
  }

  return null;
}

async function authRequiredSupabaseOrExpress(req, res, next) {
  try {
    const authUser = await resolveAuthenticatedUser(req);
    if (!authUser?.id) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    req.authUser = authUser;
    req.user = {
      id: authUser.expressUserId || authUser.id,
      email: authUser.email,
      supabaseUserId: authUser.id,
    };
    return next();
  } catch (e) {
    console.error('[auth] resolveAuthenticatedUser', e?.message || e);
    return res.status(401).json({ message: 'Invalid session' });
  }
}

module.exports = {
  resolveAuthenticatedUser,
  authRequiredSupabaseOrExpress,
};
