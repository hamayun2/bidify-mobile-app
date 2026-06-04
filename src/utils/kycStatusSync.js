import { normalizeVerificationStatus } from './kycVerification';

/** Must match server mockNadraCnic.js MOCK_NADRA_DELAY_MS (5 minutes). */
export const KYC_REVIEW_WINDOW_MS = 5 * 60 * 1000;

export function parseSubmittedAtMs(userOrRow) {
  const raw =
    userOrRow?.verification_submitted_at ??
    userOrRow?.verificationSubmittedAt ??
    null;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Milliseconds until the 5-minute Mock NADRA window ends (0 if already elapsed). */
export function getMsUntilReviewComplete(userOrRow, windowMs = KYC_REVIEW_WINDOW_MS) {
  const submittedMs = parseSubmittedAtMs(userOrRow);
  if (submittedMs == null) return windowMs;
  const elapsed = Date.now() - submittedMs;
  return Math.max(0, windowMs - elapsed);
}

export function isReviewWindowElapsed(userOrRow, windowMs = KYC_REVIEW_WINDOW_MS) {
  return getMsUntilReviewComplete(userOrRow, windowMs) <= 0;
}

export function isTerminalKycStatus(status) {
  const s = normalizeVerificationStatus({ verification_status: status });
  return s === 'verified' || s === 'rejected';
}
