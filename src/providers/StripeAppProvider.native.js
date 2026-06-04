import React from 'react';
import { StripeProvider } from '@stripe/stripe-react-native';
import { getStripePublishableKey } from '../services/stripePaymentSheet';

export default function StripeAppProvider({ children }) {
  const publishableKey = getStripePublishableKey();
  if (!publishableKey) {
    if (__DEV__) {
      console.warn(
        '[Bidify/Stripe] EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY not set — Payment Sheet disabled; wallet uses browser checkout.'
      );
    }
    return children;
  }
  if (__DEV__) {
    console.log('[Bidify/Stripe] StripeProvider init OK', {
      keyPrefix: `${publishableKey.slice(0, 12)}…`,
      testMode: publishableKey.startsWith('pk_test_'),
    });
  }
  return (
    <StripeProvider publishableKey={publishableKey} urlScheme="bidify" merchantIdentifier="merchant.com.bidify.app">
      {children}
    </StripeProvider>
  );
}
