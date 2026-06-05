import * as Linking from 'expo-linking';
import { getPublicWebOrigin } from '../services/supabase/authRedirect';

const prefix = Linking.createURL('/');

function buildLinkingPrefixes() {
  const prefixes = [prefix, 'bidify://', 'exp://', 'http://localhost:8086'];
  const webOrigin = getPublicWebOrigin();
  if (webOrigin && !prefixes.includes(webOrigin)) {
    prefixes.unshift(webOrigin);
  }
  return [...new Set(prefixes.filter(Boolean))];
}

export const linking = {
  prefixes: buildLinkingPrefixes(),
  config: {
    screens: {
      AuthStack: {
        screens: {
          Login: 'login',
          Register: 'register',
          ForgotPassword: 'forgot-password',
          OtpVerify: 'otp',
          ResetPassword: 'reset-password',
          KycScan: 'kyc/scan',
          KycSelfie: 'kyc/selfie',
          KycReviewStatus: 'kyc/status',
        },
      },
      AppStack: {
        screens: {
          MainTabs: '',
          ListingDetail: 'listing/:listingId',
          Wallet: 'wallet',
          Profile: 'profile',
        },
      },
    },
  },
};
