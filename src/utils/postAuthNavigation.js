import { isAdminUser } from './userRole';
import { isKycVerified, needsKycOnboarding } from './kycVerification';
import { MAIN_APP_ROUTE } from './kycPostSubmitAuth';

/**
 * Decide where to send the user after sign-in (email, Google OAuth, session restore).
 * Does not alter onboarding screens — only picks the navigation target.
 *
 * @param {object|null} appUser Mapped app user from profiles + auth
 * @param {object|null} profileRow Raw profiles row (optional)
 * @returns {{ name: string, params?: object } | null}
 */
export function resolvePostAuthNavigation(appUser, profileRow = null) {
  if (!appUser?.id) return null;

  if (isAdminUser(appUser) || isAdminUser(profileRow)) {
    return { name: 'AdminPanel' };
  }

  const cnicVerifiedAt =
    profileRow?.cnic_verified_at ??
    profileRow?.cnicVerifiedAt ??
    appUser?.cnicVerifiedAt ??
    null;

  const verified =
    isKycVerified(appUser) ||
    isKycVerified(profileRow) ||
    (!!cnicVerifiedAt && isKycVerified({ ...appUser, cnicVerifiedAt }));

  if (verified) {
    return { name: MAIN_APP_ROUTE };
  }

  if (!profileRow || needsKycOnboarding(appUser)) {
    return { name: 'KycScan', params: { onboarding: true } };
  }

  return { name: MAIN_APP_ROUTE };
}
