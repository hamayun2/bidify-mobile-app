/** @deprecated Import from `../../services/authService` or `registrationService` */
export {
  checkAuthEmailExists,
  loginWithSupabase,
  signOutSupabase,
  signInWithEmail,
  signOut,
  requestSupabasePasswordReset,
} from '../authService';

export {
  registerWithSupabase,
  registerWithCnic,
  finalizePendingRegistrationIfNeeded,
  finalizePendingRegistration,
  isEmailAlreadyRegisteredMessage,
  resendSignupVerificationEmail,
} from '../registrationService';
