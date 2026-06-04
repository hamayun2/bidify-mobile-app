import React, { useContext } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { AuthContext } from '../context/AuthContext';
import { linking } from './linking';
import AuthStack from './AuthStack';
import AppStack from './AppStack';
import AuthBootSplash from '../components/AuthBootSplash';

const Stack = createNativeStackNavigator();

/**
 * Root routing: wait for auth bootstrap, then unauthenticated → AuthStack; authenticated → AppStack.
 */
export default function RootNavigator() {
  const { isAuthenticated, user, isLoading } = useContext(AuthContext);
  const showMainApp = Boolean(isAuthenticated);

  const navigationContainerKey = showMainApp
    ? `app-${user?.id || 'session'}`
    : 'auth';

  if (isLoading) {
    return <AuthBootSplash />;
  }

  return (
    <NavigationContainer linking={linking} key={navigationContainerKey}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {showMainApp ? (
          <Stack.Screen name="AppStack" component={AppStack} />
        ) : (
          <Stack.Screen name="AuthStack" component={AuthStack} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
