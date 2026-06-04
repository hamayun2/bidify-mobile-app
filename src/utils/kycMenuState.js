/**
 * Profile → Identity Verification menu label and action by verification_status.
 */
export function getKycMenuState(verificationStatus, { isAdmin = false } = {}) {
  if (isAdmin) {
    return {
      title: 'Identity Verification (KYC)',
      action: 'none',
      disabled: true,
      subdued: true,
    };
  }

  const status = String(verificationStatus || 'unverified').toLowerCase();

  switch (status) {
    case 'verified':
      return {
        title: 'Account Verified',
        action: 'verified_alert',
        disabled: false,
        subdued: true,
      };
    case 'rejected':
    case 'failed':
      return {
        title: 'Retry KYC',
        action: 'kyc_retry',
        disabled: false,
        subdued: false,
      };
    case 'under_review':
    case 'pending':
      return {
        title: 'Under Review',
        action: 'none',
        disabled: true,
        subdued: true,
      };
    default:
      return {
        title: 'Complete KYC',
        action: 'kyc_start',
        disabled: false,
        subdued: false,
      };
  }
}
