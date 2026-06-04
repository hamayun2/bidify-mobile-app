/**
 * Link Supabase-authenticated users to the Express API (wallet, Stripe, chat).
 */
import client, { isAuxiliaryApiConfigured } from './client';

export async function bridgeExpressApiSession({ email, fullName, supabaseUserId }) {
  if (!isAuxiliaryApiConfigured()) return null;
  const em = String(email || '').trim();
  if (!em) return null;
  try {
    console.log('[Bidify/Express] bridge-login for', em);
    const res = await client.post(
      '/auth/bridge-login',
      {
        email: em,
        fullName: fullName || null,
        supabaseUserId: supabaseUserId || null,
      },
      { timeout: 8000 }
    );
    return res.data || null;
  } catch (e) {
    console.warn('[Bidify/Express] bridge-login failed:', e?.response?.data?.message || e?.message);
    return null;
  }
}
