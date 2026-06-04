import React from 'react';

/** Web: Stripe Payment Sheet is native-only; wallet uses hosted checkout. */
export default function StripeAppProvider({ children }) {
  return children;
}
