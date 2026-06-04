/**
 * Auction listing duration options — keep in sync with create-listing end_time logic.
 * Values are stored on the listing payload and used to compute auction_end_time / end_time.
 */

export const AUCTION_DURATIONS = [
  { label: '1 Day', value: '1' },
  { label: '3 Days', value: '3' },
  { label: '5 Days', value: '5' },
  { label: '7 Days', value: '7' },
  { label: '12 Hours', value: '12h' },
  { label: '3 Minutes (Testing)', value: '3m' },
];

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * @param {string|number|null|undefined} durationValue — e.g. '3', '12h', '3m'
 * @param {number} [fromMs] — defaults to Date.now()
 * @returns {string} ISO end time
 */
export function computeAuctionEndIso(durationValue, fromMs = Date.now()) {
  const base = Number.isFinite(fromMs) ? fromMs : Date.now();
  const v = String(durationValue ?? '')
    .trim()
    .toLowerCase();

  if (v === '3m') {
    return new Date(base + 3 * MS_PER_MINUTE).toISOString();
  }
  if (v === '12h') {
    return new Date(base + 12 * MS_PER_HOUR).toISOString();
  }

  const days = parseInt(v, 10);
  const d = Number.isFinite(days) && days > 0 ? days : 3;
  return new Date(base + d * MS_PER_DAY).toISOString();
}

/**
 * Whole-day count for duration_days column (null for sub-day durations).
 * @param {string|number|null|undefined} durationValue
 * @returns {number|null}
 */
export function durationDaysForListing(durationValue) {
  const v = String(durationValue ?? '')
    .trim()
    .toLowerCase();
  if (v === '3m' || v === '12h') return null;
  const days = parseInt(v, 10);
  return Number.isFinite(days) && days > 0 ? days : null;
}

export function auctionDurationLabel(durationValue) {
  const found = AUCTION_DURATIONS.find((d) => d.value === String(durationValue));
  return found?.label ?? null;
}
