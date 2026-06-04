import React, { useContext, useEffect, useRef } from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { CommonActions, useNavigation } from '@react-navigation/native';
import MainTabNavigator from './MainTabNavigator';
import ListingDetailScreen from '../screens/ListingDetailScreen';
import PaymentCheckoutScreen from '../screens/PaymentCheckoutScreen';
import ChatScreen from '../screens/ChatScreen';
import WalletScreen from '../screens/WalletScreen';
import AdminScreen from '../screens/AdminScreen';
import ProfileScreen from '../screens/ProfileScreen';
import ProfileViewScreen from '../screens/ProfileViewScreen';
import AccountSettingsScreen from '../screens/AccountSettingsScreen';
import HelpSupportScreen from '../screens/HelpSupportScreen';
import MyOrdersScreen from '../screens/MyOrdersScreen';
import NotificationsScreen from '../screens/NotificationsScreen';
import DisputeSupportChatScreen from '../screens/DisputeSupportChatScreen';
import AdminDisputesScreen from '../screens/admin/AdminDisputesScreen';
import AdminSupportInboxScreen from '../screens/admin/AdminSupportInboxScreen';
import AdminSupportChatScreen from '../screens/admin/AdminSupportChatScreen';
import AdminUserDetailScreen from '../screens/admin/AdminUserDetailScreen';
import KycScanScreen from '../screens/KycScanScreen';
import KycSelfieScreen from '../screens/KycSelfieScreen';
import KycReviewStatusScreen from '../screens/KycReviewStatus';
import { AuthContext } from '../context/AuthContext';
import { isAdminUser } from '../utils/userRole';
import { premiumStackScreenOptions } from './stackHeader';
import { resetToAdminPanel } from './adminNavigation';

const Stack = createNativeStackNavigator();

function PostLoginDeepLink() {
  const navigation = useNavigation();
  const { consumePendingRoute, user, isLoading } = useContext(AuthContext);
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current || isLoading) return;
    const r = consumePendingRoute?.();
    const fallback = user?.id && isAdminUser(user) ? 'AdminPanel' : null;
    const targetName = typeof r === 'string' ? r : r?.name || fallback;
    const targetParams = typeof r === 'object' && r?.params ? r.params : undefined;
    if (targetName) {
      fired.current = true;
      setTimeout(() => {
        try {
          if (targetName === 'AdminPanel') {
            resetToAdminPanel(navigation);
          } else {
            navigation.dispatch(
              CommonActions.reset({
                index: 0,
                routes: [{ name: targetName, params: targetParams }],
              })
            );
          }
        } catch (_) {
          /* ignore */
        }
      }, 50);
    }
  }, [consumePendingRoute, navigation, user, isLoading]);
  return null;
}

function MainTabsWithDeepLink(props) {
  return (
    <>
      <PostLoginDeepLink />
      <MainTabNavigator {...props} />
    </>
  );
}

const AppStack = () => {
  return (
    <Stack.Navigator screenOptions={premiumStackScreenOptions()}>
      <Stack.Screen
        name="MainTabs"
        component={MainTabsWithDeepLink}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="ListingDetail"
        component={ListingDetailScreen}
        options={premiumStackScreenOptions({ title: 'Listing Details', headerBackTitle: 'Back' })}
      />
      <Stack.Screen
        name="PaymentCheckout"
        component={PaymentCheckoutScreen}
        options={premiumStackScreenOptions({ title: 'Checkout', headerBackTitle: 'Back' })}
      />
      <Stack.Screen
        name="Chat"
        component={ChatScreen}
        options={premiumStackScreenOptions({ title: 'Chat', headerBackTitle: 'Back' })}
      />
      <Stack.Screen
        name="Profile"
        component={ProfileScreen}
        options={premiumStackScreenOptions({ title: 'My Profile' })}
      />
      <Stack.Screen
        name="ProfileView"
        component={ProfileViewScreen}
        options={({ route }) =>
          premiumStackScreenOptions({
            title: route.params?.sellerName || 'Seller profile',
            headerBackTitle: 'Back',
          })
        }
      />
      <Stack.Screen
        name="PublicProfileView"
        component={ProfileViewScreen}
        options={({ route }) =>
          premiumStackScreenOptions({
            title: route.params?.sellerName || 'Seller profile',
            headerBackTitle: 'Back',
          })
        }
      />
      <Stack.Screen
        name="Wallet"
        component={WalletScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="MyOrders"
        component={MyOrdersScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="Notifications"
        component={NotificationsScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="DisputeSupportChat"
        component={DisputeSupportChatScreen}
        options={premiumStackScreenOptions({
          title: 'Admin Support',
          headerBackTitle: 'Orders',
        })}
      />
      <Stack.Screen
        name="AccountSettings"
        component={AccountSettingsScreen}
        options={premiumStackScreenOptions({ title: 'Account Settings' })}
      />
      <Stack.Screen
        name="KycScan"
        component={KycScanScreen}
        options={premiumStackScreenOptions({ title: 'CNIC Verification' })}
      />
      <Stack.Screen
        name="KycSelfie"
        component={KycSelfieScreen}
        options={premiumStackScreenOptions({ title: 'Face Verification' })}
      />
      <Stack.Screen
        name="KycReviewStatus"
        component={KycReviewStatusScreen}
        options={{ headerShown: false, gestureEnabled: false }}
      />
      <Stack.Screen
        name="HelpSupport"
        component={HelpSupportScreen}
        options={premiumStackScreenOptions({ title: 'Help & Support' })}
      />
      <Stack.Screen
        name="AdminPanel"
        component={AdminScreen}
        options={{
          ...premiumStackScreenOptions({ title: 'Admin Panel' }),
          headerBackVisible: false,
          gestureEnabled: false,
          headerLeft: () => null,
        }}
      />
      <Stack.Screen
        name="AdminDisputes"
        component={AdminDisputesScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="AdminSupportInbox"
        component={AdminSupportInboxScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="AdminSupportChat"
        component={AdminSupportChatScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="AdminUserDetail"
        component={AdminUserDetailScreen}
        options={{ headerShown: false }}
      />
    </Stack.Navigator>
  );
};

export default AppStack;
