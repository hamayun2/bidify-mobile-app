import * as Linking from 'expo-linking';
import { getPublicWebOrigin } from '../services/supabase/authRedirect';

const prefix = Linking.createURL('/');

function buildLinkingPrefixes() {
  const prefixes = [prefix, 'bidify://', 'exp://', 'http://localhost:8086'];
  const envTunnel = String(process.env.EXPO_PUBLIC_WEB_APP_URL || '').trim();
  if (envTunnel) {
    try {
      const withProto = /^https?:\/\//i.test(envTunnel) ? envTunnel : `https://${envTunnel}`;
      const envOrigin = new URL(withProto).origin.replace(/\/$/, '');
      if (envOrigin && !prefixes.includes(envOrigin)) {
        prefixes.unshift(envOrigin);
      }
    } catch {
      /* ignore malformed env */
    }
  }
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
          AuthCallback: 'auth/callback',
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
