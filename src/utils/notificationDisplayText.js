/**
 * English notification copy for the bell / toast.
 * Prefers stored body from DB (detailed Rs. + listing title); falls back for legacy Hindi rows.
 */

const TITLE_BY_TYPE = {
  wallet_bid_deduct: 'Bid Lock',
  wallet_bid_refund: 'Bid Refund',
  wallet_topup: 'Wallet Top-up',
};

const TITLE_MAP = {
  'बिड लॉक': 'Bid Lock',
  'बिड रिफंड': 'Bid Refund',
  'वॉलेट टॉप-अप': 'Wallet Top-up',
};

const BODY_MAP = {
  'आपके वॉलेट से बिड के लिए पैसे कट गए हैं।': null,
  'आपके वॉलेट से पैसे कट गए हैं': null,
  'आपकी बिड पर किसी और ने बोली लगाई है, पैसे वापस आ गए हैं। नई बिड लगाएं।': null,
  'आपकी बिड के पैसे वापस आ गए हैं': null,
  'आपके वॉलेट में पैसे जोड़ दिए गए हैं।': null,
};

function normalizeKey(s) {
  return String(s || '').trim();
}

function formatRs(amount) {
  const v = Number(amount);
  if (!Number.isFinite(v)) return null;
  return `Rs. ${Math.round(Math.abs(v)).toLocaleString('en-PK')}`;
}

function bodyFromMetadata(row) {
  const type = row?.metadata?.type;
  const amount = row?.metadata?.amount;
  const title = row?.metadata?.listing_title;
  const rs = formatRs(amount);
  if (!rs) return null;

  const listing = title && String(title).trim() ? `'${String(title).trim()}'` : "'Listing'";

  if (type === 'wallet_bid_deduct') {
    return `${rs} deducted for bid on ${listing}.`;
  }
  if (type === 'wallet_bid_refund') {
    return `${rs} successfully refunded to your Bidify Protection Account from ${listing}.`;
  }
  if (type === 'wallet_topup') {
    return `${rs} added to your Bidify Protection Account.`;
  }
  return null;
}

function isDetailedEnglishBody(body) {
  const s = normalizeKey(body);
  return s.length > 0 && /^Rs\.\s/i.test(s);
}

function localizeTitle(row) {
  const type = row?.metadata?.type;
  if (type && TITLE_BY_TYPE[type]) return TITLE_BY_TYPE[type];

  const raw = normalizeKey(row?.title);
  if (TITLE_MAP[raw]) return TITLE_MAP[raw];
  if (TITLE_BY_TYPE[raw]) return TITLE_BY_TYPE[raw];
  return raw || 'Notification';
}

function localizeBody(row) {
  const stored = normalizeKey(row?.body);
  if (isDetailedEnglishBody(stored)) return stored;

  const fromMeta = bodyFromMetadata(row);
  if (fromMeta) return fromMeta;

  if (stored && BODY_MAP[stored] === undefined && !/[\u0900-\u097F]/.test(stored)) {
    return stored;
  }

  const type = row?.metadata?.type;
  if (type === 'wallet_bid_deduct') return 'Wallet deduction successful.';
  if (type === 'wallet_bid_refund') return 'Your bid refund has been processed.';
  if (type === 'wallet_topup') return 'Funds have been added to your wallet.';

  return stored || 'You have a new notification.';
}

/** Returns English title/body for rendering in the app. */
export function getNotificationDisplayText(row) {
  return {
    title: localizeTitle(row),
    body: localizeBody(row),
  };
}
