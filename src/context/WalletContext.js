import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import {
  fetchWalletLedgerForUser,
  mapLedgerRowsToActivity,
} from '../services/walletLedgerService';
import { fetchProfileWallet, resolveWalletUserId } from '../services/profileWalletService';
import { isSupabaseConfigured } from '../services/supabaseClient';
import { isAuxiliaryApiConfigured } from '../api/client';
import { getWalletAPI } from '../api/wallet';
import useAuth from '../hooks/useAuth';

export const WalletContext = createContext(null);

export function WalletProvider({ children }) {
  const { user, isAuthenticated, refreshProfile } = useAuth();
  const [balance, setBalance] = useState(0);
  const [heldBalance, setHeldBalance] = useState(0);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!isAuthenticated || !user?.id) {
      setBalance(0);
      setHeldBalance(0);
      setTransactions([]);
      return { balance: 0, heldBalance: 0 };
    }
    setLoading(true);
    setError(null);
    try {
      if (!isSupabaseConfigured() && !isAuxiliaryApiConfigured()) {
        setError('Supabase is not configured — wallet balance unavailable.');
        setBalance(0);
        setHeldBalance(0);
        setTransactions([]);
        return { balance: 0, heldBalance: 0 };
      }

      const walletUserId = isSupabaseConfigured()
        ? await resolveWalletUserId(user.id)
        : String(user.id || '').trim();

      let walletBalance = 0;
      let held = 0;
      let activity = [];
      let loadedFromApi = false;
      let balanceFromDirectProfile = false;

      if (isSupabaseConfigured() && walletUserId) {
        const pwDirect = await fetchProfileWallet(walletUserId);
        walletBalance = pwDirect.walletBalance;
        held = pwDirect.heldBalance;
        balanceFromDirectProfile = !pwDirect.missingProfile;
      }

      if (isAuxiliaryApiConfigured()) {
        try {
          const apiWallet = await getWalletAPI();
          console.log('[Bidify/Wallet] GET /api/wallet response', {
            walletUserId,
            source: apiWallet?.source,
            balance: apiWallet?.balance,
            heldBalance: apiWallet?.heldBalance,
            offline: apiWallet?.offline,
            balanceFromDirectProfile,
          });
          if (!apiWallet?.offline && apiWallet?.source === 'supabase') {
            if (!balanceFromDirectProfile) {
              walletBalance = Number(apiWallet.balance) || 0;
              held = Number(apiWallet.heldBalance) || 0;
            }
            const ledgerRows = Array.isArray(apiWallet.ledger) ? apiWallet.ledger : [];
            activity = mapLedgerRowsToActivity(ledgerRows);
            loadedFromApi = true;
          }
        } catch (e) {
          if (__DEV__) console.warn('[Bidify/WalletContext] API wallet fallback', e?.message);
        }
      }

      if (!loadedFromApi) {
        if (!isSupabaseConfigured() || !walletUserId) {
          const pw = await fetchProfileWallet(user.id);
          walletBalance = pw.walletBalance;
          held = pw.heldBalance;
        }

        const uid = walletUserId || user.id;
        const ledgerRows = await fetchWalletLedgerForUser(uid, 60).catch(() => []);
        activity = mapLedgerRowsToActivity(ledgerRows);
      }

      setBalance(walletBalance);
      setHeldBalance(held);
      setTransactions(activity);

      if (typeof refreshProfile === 'function') {
        try {
          await refreshProfile();
        } catch (e) {
          console.warn('[Bidify/WalletContext] refreshProfile after wallet', e?.message);
        }
      }

      return { balance: walletBalance, heldBalance: held };
    } catch (e) {
      console.error('[Bidify/WalletContext] refresh FAILED', e?.message);
      setError(e?.message || 'Could not load wallet');
      return null;
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, user?.id, refreshProfile]);

  const value = useMemo(
    () => ({ balance, heldBalance, transactions, loading, error, refresh }),
    [balance, heldBalance, transactions, loading, error, refresh]
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}
