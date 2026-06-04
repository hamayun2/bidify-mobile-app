const express = require('express');
const { store, getOrCreateWallet, recordWalletTx } = require('../store');
const { authRequired } = require('../authMiddleware');
const { creditProfileWalletTopup } = require('../supabaseWallet');
const { authRequiredSupabaseOrExpress } = require('../middleware/resolveSupabaseUser');
const {
  fetchWalletBundleForUser,
  isSupabaseWalletDataConfigured,
} = require('../services/supabaseWalletData');

const router = express.Router();

/**
 * GET /api/wallet — Supabase profiles + wallet_ledger + wallet_transactions when configured;
 * otherwise Express store.json ledger (legacy dev).
 */
router.get('/', authRequiredSupabaseOrExpress, async (req, res) => {
  const supabaseUid = req.authUser?.id || req.user?.supabaseUserId;

  if (isSupabaseWalletDataConfigured() && supabaseUid) {
    try {
      const bundle = await fetchWalletBundleForUser(supabaseUid);
      if (bundle) {
        return res.json({
          balance: bundle.balance,
          heldBalance: bundle.heldBalance,
          lockedBalance: bundle.lockedBalance,
          ledger: bundle.ledger,
          walletTransactions: bundle.walletTransactions,
          transactions: bundle.walletTransactions,
          source: 'supabase',
        });
      }
    } catch (e) {
      console.error('[wallet] Supabase bundle failed, falling back to Express store:', e?.message || e);
    }
  }

  const expressUserId = req.user?.expressUserId || req.user?.id;
  const wallet = getOrCreateWallet(expressUserId);
  res.json({
    balance: wallet.balance,
    heldBalance: 0,
    lockedBalance: 0,
    transactions: wallet.transactions,
    ledger: [],
    walletTransactions: [],
    source: 'express',
  });
});

router.post('/topup', authRequired, async (req, res) => {
  const amount = Math.floor(Number(req.body?.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ message: 'amount must be a positive number' });
  }
  if (amount > 1000000) {
    return res.status(400).json({ message: 'topup limit per call is 1,000,000' });
  }
  const { wallet, tx } = recordWalletTx(req.user.id, {
    kind: 'topup',
    amount,
    note: 'Manual top-up (dev / sandbox)',
  });
  let balance = wallet.balance;
  if (req.user.supabaseUserId) {
    try {
      const supa = await creditProfileWalletTopup(
        req.user.supabaseUserId,
        amount,
        `manual_${tx.id}`,
        'manual'
      );
      if (supa?.wallet_balance != null) balance = Number(supa.wallet_balance);
    } catch (e) {
      console.error('[wallet] Supabase profile sync failed:', e?.message || e);
    }
  }
  res.json({ balance, transaction: tx });
});

module.exports = router;
