import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import KycScanScreen from '../screens/KycScanScreen';
import KycSelfieScreen from '../screens/KycSelfieScreen';
import KycReviewStatusScreen from '../screens/KycReviewStatus';
import { premiumStackScreenOptions } from './stackHeader';

const Stack = createNativeStackNavigator();

/**
 * Mandatory post-signup KYC flow while `profiles.verification_status === 'unverified'`.
 */
export default function KycOnboardingStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        ...premiumStackScreenOptions(),
        headerBackVisible: false,
        gestureEnabled: false,
      }}
    >
      <Stack.Screen
        name="KycScan"
        component={KycScanScreen}
        initialParams={{ onboarding: true }}
        options={{ title: 'CNIC Verification', headerBackVisible: false }}
      />
      <Stack.Screen
        name="KycSelfie"
        component={KycSelfieScreen}
        initialParams={{ onboarding: true }}
        options={{ title: 'Face Verification', headerBackVisible: false, gestureEnabled: true }}
      />
      <Stack.Screen
        name="KycReviewStatus"
        component={KycReviewStatusScreen}
        options={{ headerShown: false, gestureEnabled: false }}
      />
    </Stack.Navigator>
  );
}
