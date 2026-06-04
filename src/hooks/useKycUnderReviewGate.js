import { useCallback, useContext, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { AuthContext } from '../context/AuthContext';
import {
  isKycUnderReviewGateActive,
  readKycUnderReviewGateSync,
} from '../utils/kycBidLockStorage';

/**
 * True while `kyc_status === UNDER_REVIEW` and inside the 5-minute review window.
 */
export default function useKycUnderReviewGate() {
  const { user } = useContext(AuthContext);
  const [gateActive, setGateActive] = useState(() => readKycUnderReviewGateSync());

  const refreshGate = useCallback(async () => {
    const active = await isKycUnderReviewGateActive(user);
    setGateActive(active);
    return active;
  }, [user]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const active = await isKycUnderReviewGateActive(user);
        if (!cancelled) setGateActive(active);
      })();
      return () => {
        cancelled = true;
      };
    }, [user])
  );

  return { underReviewGate: gateActive, refreshGate };
}
