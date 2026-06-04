import { useCallback, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';

/** Re-evaluate time-based auction filters while a screen is focused (e.g. tab moves Active → Ended). */
export function useAuctionClockTick(intervalMs = 30000) {
  const [tick, setTick] = useState(() => Date.now());

  useFocusEffect(
    useCallback(() => {
      setTick(Date.now());
      const id = setInterval(() => setTick(Date.now()), intervalMs);
      return () => clearInterval(id);
    }, [intervalMs])
  );

  return tick;
}
