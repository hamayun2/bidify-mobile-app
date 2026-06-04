import * as Linking from 'expo-linking';

const prefix = Linking.createURL('/');

export const linking = {
  prefixes: [prefix, 'bidify://', 'http://localhost:8086', 'exp://'],
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
