import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import LoginScreen from '../screens/LoginScreen';
import AuthCallbackScreen from '../screens/AuthCallbackScreen';
import RegisterScreen from '../screens/RegisterScreen';
import CnicVerificationScreen from '../screens/CnicVerificationScreen';
import ForgotPasswordScreen from '../screens/ForgotPasswordScreen';
import OtpVerifyScreen from '../screens/OtpVerifyScreen';
import ResetPasswordScreen from '../screens/ResetPasswordScreen';
import KycScanScreen from '../screens/KycScanScreen';
import KycSelfieScreen from '../screens/KycSelfieScreen';
import KycReviewStatusScreen from '../screens/KycReviewStatus';

const Stack = createNativeStackNavigator();

const AuthStack = () => {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="AuthCallback" component={AuthCallbackScreen} />
      <Stack.Screen name="Register" component={RegisterScreen} />
      <Stack.Screen
        name="SignUp"
        component={RegisterScreen}
        options={{ animation: 'none' }}
      />
      <Stack.Screen name="KycScan" component={KycScanScreen} />
      <Stack.Screen name="KycSelfie" component={KycSelfieScreen} />
      <Stack.Screen name="KycReviewStatus" component={KycReviewStatusScreen} />
      <Stack.Screen name="CnicVerification" component={CnicVerificationScreen} />
      <Stack.Screen name="ForgotPassword" component={ForgotPasswordScreen} />
      <Stack.Screen name="OtpVerify" component={OtpVerifyScreen} />
      <Stack.Screen name="ResetPassword" component={ResetPasswordScreen} />
    </Stack.Navigator>
  );
};

export default AuthStack;
