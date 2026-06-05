const express = require('express');
const { createSupabaseServerClient, readSupabaseEnv } = require('../lib/supabaseSsrClient');

const router = express.Router();

/**
 * Server-side OAuth callback (same host as API only).
 * Expo web OAuth should use /auth/callback on the Expo host with createBrowserClient.
 */
router.get('/callback', async (req, res) => {
  const { url } = readSupabaseEnv();
  if (!url) {
    return res.status(503).json({ message: 'Supabase is not configured on the API server.' });
  }

  const code = typeof req.query?.code === 'string' ? req.query.code : null;
  const oauthError = typeof req.query?.error === 'string' ? req.query.error : null;

  if (oauthError) {
    const desc =
      typeof req.query?.error_description === 'string'
        ? decodeURIComponent(req.query.error_description.replace(/\+/g, ' '))
        : oauthError;
    return res.status(400).json({ message: desc || oauthError });
  }

  if (!code) {
    return res.status(400).json({ message: 'Missing authorization code.' });
  }

  try {
    const supabase = createSupabaseServerClient(req, res);
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.error('[Bidify/auth/callback] exchangeCodeForSession', error.message);
      return res.status(400).json({ message: error.message || 'Auth callback failed.' });
    }

    const redirectBase =
      String(process.env.EXPO_PUBLIC_WEB_APP_URL || process.env.PAYMENT_RETURN_URL || '').trim() ||
      '/';
    const target = redirectBase.startsWith('http')
      ? `${redirectBase.replace(/\/$/, '')}/`
      : '/';

    return res.redirect(302, target);
  } catch (e) {
    console.error('[Bidify/auth/callback]', e?.message || e);
    return res.status(500).json({ message: 'Auth callback failed.' });
  }
});

module.exports = router;
