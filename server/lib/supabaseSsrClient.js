const { createServerClient } = require('@supabase/ssr');
const { parse: parseCookieHeader, serialize } = require('cookie');

function normalizeSupabaseUrl(raw) {
  return String(raw || '')
    .trim()
    .replace(/\/rest\/v1\/?$/i, '')
    .replace(/\/$/, '');
}

function readSupabaseEnv() {
  const url = normalizeSupabaseUrl(
    process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
  );
  const key =
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    '';
  return { url, key };
}

function cookieOptionsFromRequest(req) {
  const forwarded = String(req?.headers?.['x-forwarded-proto'] || '').toLowerCase();
  const onHttps = Boolean(req?.secure || forwarded === 'https');

  if (onHttps) {
    return {
      path: '/',
      sameSite: 'none',
      secure: true,
    };
  }

  return {
    path: '/',
    sameSite: 'lax',
  };
}

function parseRequestCookies(req) {
  const header = req?.headers?.cookie;
  if (!header || typeof header !== 'string') return [];
  const parsed = parseCookieHeader(header);
  return Object.keys(parsed).map((name) => ({
    name,
    value: parsed[name] ?? '',
  }));
}

/**
 * Express helper — createServerClient with cookie read/write on the same request/response.
 * Use on routes where the OAuth callback or session refresh hits the API host directly.
 */
function createSupabaseServerClient(req, res) {
  const { url, key } = readSupabaseEnv();
  if (!url || !key) {
    throw new Error('Supabase URL and anon key are required for createServerClient');
  }

  const baseCookieOptions = cookieOptionsFromRequest(req);

  return createServerClient(url, key, {
    cookieOptions: baseCookieOptions,
    cookies: {
      getAll() {
        return parseRequestCookies(req);
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          res.append(
            'Set-Cookie',
            serialize(name, value, {
              ...baseCookieOptions,
              ...options,
            })
          );
        });
      },
    },
  });
}

module.exports = {
  createSupabaseServerClient,
  readSupabaseEnv,
};
