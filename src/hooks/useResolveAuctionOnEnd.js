import { useEffect, useRef } from 'react';
import useCountdown from './useCountdown';
import { triggerResolveListingAuction, triggerResolveExpiredBatch } from '../services/auctionResolveScheduler';
import { isSupabaseConfigured } from '../services/supabaseClient';

/**
 * When an auction countdown hits zero, trigger escrow resolution.
 * Also pings the Express batch resolver when the API is configured.
 */
export default function useResolveAuctionOnEnd(listingId, endTimeIso, opts = {}) {
  const { enabled = true, skipIfResolved = true, onResolved, onError } = opts;
  const resolvedAt = opts.auctionResolvedAt;
  const { isEnded } = useCountdown(enabled && endTimeIso ? endTimeIso : '');
  const firedRef = useRef(false);

  useEffect(() => {
    firedRef.current = false;
  }, [listingId, endTimeIso]);

  useEffect(() => {
    if (!enabled || !listingId || !isEnded || !isSupabaseConfigured()) return;
    if (skipIfResolved && resolvedAt) return;
    if (firedRef.current) return;
    firedRef.current = true;

    void triggerResolveExpiredBatch();

    triggerResolveListingAuction(listingId, { force: true })
      .then((result) => {
        if (result) onResolved?.(result);
      })
      .catch((e) => {
        firedRef.current = false;
        onError?.(e);
      });
  }, [
    enabled,
    listingId,
    endTimeIso,
    isEnded,
    skipIfResolved,
    resolvedAt,
    onResolved,
    onError,
  ]);

  return { isEnded };
}
