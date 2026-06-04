import client, { isAuxiliaryApiConfigured } from './client';

/**
 * Ask Express (service_role) to resolve all auctions past end time.
 * Works for any client — does not require caller to be a bidder.
 */
export async function resolveExpiredAuctionsViaApi(limit = 50) {
  if (!isAuxiliaryApiConfigured()) {
    throw new Error('Auction resolver API not configured (EXPO_PUBLIC_API_URL).');
  }
  const { data } = await client.post(
    '/escrow/resolve-expired',
    { limit },
    { timeout: 30_000 }
  );
  return data;
}
