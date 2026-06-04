import { isAdminUser } from './userRole';
import { showPlatformAlert } from './platformAlert';
import {
  formatBidLockRemainingMinutes,
  getKycBidLockRemainingMs,
  isKycUnderReviewGateActive,
} from './kycBidLockStorage';
import { resolveCnicFromRow, resolveCnicFromUser } from './profileDisplay';
import { isReviewWindowElapsed } from './kycStatusSync';

/** Mock NADRA approved range — must match server/mockNadraCnic.js */
export const MOCK_CNIC_RANGE_START = 3650123031300n;
export const MOCK_CNIC_RANGE_END = 3650123031399n;

export function isCnicInApprovedMockRange(cnicOrDigits) {
  const digits = String(cnicOrDigits || '').replace(/\D/g, '');
  if (digits.length !== 13) return false;
  try {
    const v = BigInt(digits);
    return v >= MOCK_CNIC_RANGE_START && v <= MOCK_CNIC_RANGE_END;
  } catch {
    return false;
  }
}

function hasKycSubmissionEvidence(row) {
  if (!row || typeof row !== 'object') return false;
  const submittedAt =
    row.verification_submitted_at ?? row.verificationSubmittedAt ?? null;
  if (submittedAt) return true;
  return !!(row.cnic_front_url && row.cnic_back_url);
}

export const KYC_BID_BLOCK_MESSAGE =
  '⚠️ Verification Required: Bidding is locked until your account verification is fully approved.';

export function buildKycUnderReviewBidLockMessage(remainingMinutes) {
  const mins = Math.max(1, Number(remainingMinutes) || 1);
  return `🔒 Bidding is restricted while your account profile is under review (Remaining: ${mins} mins).`;
}

export const KYC_WALLET_TOPUP_LOCKED_HINT =
  'Identity verification is in progress or failed. Please check your status.';

export const KYC_WALLET_TOPUP_VERIFIED_ONLY_HINT =
  'Wallet top-up is available only after your CNIC is verified.';

export const KYC_TOPUP_UNDER_REVIEW_MESSAGE =
  '🔒 Top-up is disabled during the 5-minute review process.';

export const KYC_BID_INPUT_PLACEHOLDER_LOCKED =
  '🔒 Verification necessary for bidding...';

export const KYC_BID_UNDER_REVIEW_WARNING =
  'For bidding, account verification is mandatory. Review takes up to 5 minutes.';

export const KYC_CHAT_LOCKED_HINT =
  '🔒 Chatting is locked until your KYC application is Verified.';

export function normalizeVerificationStatus(user) {
  const raw =
    user?.verification_status ??
    user?.verificationStatus ??
    'unverified';
  const s = String(raw || 'unverified').trim().toLowerCase();
  if (
    s === 'verified' ||
    s === 'under_review' ||
    s === 'pending' ||
    s === 'rejected' ||
    s === 'failed'
  ) {
    return s === 'failed' ? 'rejected' : s;
  }
  return 'unverified';
}

/**
 * DB column: profiles.verification_status (text).
 * Also infers status when the row is stale (CNIC saved but status still `unverified`).
 *
 * Server CNIC check (mockNadraCnic.js):
 *   SELECT * FROM profiles WHERE id = $userId
 *   digits := regexp_replace(cnic|cnic_number|id_card, '\D', '', 'g')
 *   IF length(digits) = 13 AND digits::bigint BETWEEN 3650123031300 AND 3650123031399
 *      THEN verification_status := 'verified' (after 5-min review window)
 */
export function resolveEffectiveVerificationStatus(rowOrUser) {
  if (!rowOrUser || typeof rowOrUser !== 'object') return 'unverified';
  if (isAdminUser(rowOrUser)) return 'verified';

  const dbStatus = normalizeVerificationStatus(rowOrUser);
  if (dbStatus === 'verified' || dbStatus === 'rejected') return dbStatus;

  const cnicDigits =
    resolveCnicFromRow(rowOrUser) || resolveCnicFromUser(rowOrUser);
  const hasCnic = cnicDigits.length === 13;
  const inRange = hasCnic && isCnicInApprovedMockRange(cnicDigits);
  const hasEvidence = hasKycSubmissionEvidence(rowOrUser);

  if (dbStatus === 'under_review' || dbStatus === 'pending') {
    if (inRange && isReviewWindowElapsed(rowOrUser)) return 'verified';
    return 'under_review';
  }

  // Stuck `unverified` in DB but profile has CNIC / KYC data
  if (hasEvidence) {
    if (inRange && isReviewWindowElapsed(rowOrUser)) return 'verified';
    return 'under_review';
  }

  if (hasCnic && inRange) {
    return 'verified';
  }

  if (hasCnic) {
    return 'under_review';
  }

  return 'unverified';
}

/**
 * User finished KYC submit (selfie sent) — must enter MainTabs, not onboarding stack.
 * Handles brief Auth hydration races where status is still `unverified` but submitted_at exists.
 */
export function hasCompletedKycOnboarding(user) {
  if (!user) return false;
  if (isAdminUser(user)) return true;

  const submittedAt =
    user.verification_submitted_at ?? user.verificationSubmittedAt ?? null;
  if (submittedAt) return true;

  const status = resolveEffectiveVerificationStatus(user);
  return status !== 'unverified';
}

/** True only when admin has approved KYC (`verified`). */
export function isKycVerified(user) {
  if (!user) return false;
  if (isAdminUser(user)) return true;
  return resolveEffectiveVerificationStatus(user) === 'verified';
}

/**
 * Must complete CNIC + selfie onboarding before main app.
 * ONLY true for strictly `unverified` with no submission timestamp.
 */
export function needsKycOnboarding(user) {
  if (!user) return false;
  if (isAdminUser(user)) return false;
  if (hasCompletedKycOnboarding(user)) return false;
  return resolveEffectiveVerificationStatus(user) === 'unverified';
}

/** RootNavigator: authenticated users who may render AppStack / MainTabs. */
export function canAccessMainApp(user, { kycReviewLockActive = false } = {}) {
  if (!user) return false;
  if (isAdminUser(user)) return true;
  if (kycReviewLockActive) return true;
  return hasCompletedKycOnboarding(user) || !needsKycOnboarding(user);
}

export function showKycBidBlockedAlert() {
  showPlatformAlert('Verification required', KYC_BID_BLOCK_MESSAGE);
}

export function showKycUnderReviewBidLockAlert(remainingMinutes) {
  showPlatformAlert(
    'Bidding restricted',
    buildKycUnderReviewBidLockMessage(remainingMinutes)
  );
}

export function showKycTopUpUnderReviewAlert() {
  showPlatformAlert('Top-up disabled', KYC_TOPUP_UNDER_REVIEW_MESSAGE);
}

/**
 * Blocks bidding when KYC is not verified and the 5-minute review lock is active.
 * @returns {Promise<boolean>} true if bid should be blocked
 */
export async function shouldBlockBidForKyc(user) {
  if (isKycVerified(user)) return false;
  if (await isKycUnderReviewGateActive(user)) {
    const remainingMs = await getKycBidLockRemainingMs(user);
    showKycUnderReviewBidLockAlert(formatBidLockRemainingMinutes(remainingMs));
    return true;
  }
  showKycBidBlockedAlert();
  return true;
}

/** @deprecated use showKycBidBlockedAlert */
export function showKycBlockedAlert() {
  showKycBidBlockedAlert();
}
